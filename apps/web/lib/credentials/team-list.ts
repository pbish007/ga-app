import { and, eq, isNull } from "drizzle-orm";

import type { AccountsDb } from "@ga/accounts";
import { schema } from "@ga/db";

import type { CredentialLike } from "../credential-state";

const {
  organizationMemberships,
  users,
  userCredentials,
  regimeCredentialTypes,
} = schema;

export interface TeamCredentialSummaryRow {
  userId: string;
  email: string;
  role: string;
  credentials: Array<CredentialLike & { typeName: string }>;
}

export interface TenantMemberCredentialRow {
  userId: string;
  typeName: string;
  expiresOn: string | null;
  revokedAt: Date | null;
}

/**
 * Active (non-revoked) credentials belonging to users who are members of
 * `tenantId`, joined to their credential type name.
 *
 * Tenant scoping is enforced at SQL level by joining `user_credentials`
 * through `organization_memberships` filtered to `tenantId`. The underlying
 * `user_credentials` table is tenant-agnostic by design (migrations 0006,
 * 0027 — "credentials follow the person"), so without the membership join
 * the read would return rows for users in any tenant — including users
 * who are not members of the requested tenant. PMB-174 closes that
 * defense-in-depth gap (BOLA, OWASP API #1). Exported separately so the
 * regression test can assert the SQL filter directly.
 */
export async function selectTenantMemberCredentials(
  tx: AccountsDb,
  tenantId: string,
): Promise<TenantMemberCredentialRow[]> {
  return tx
    .select({
      userId: userCredentials.userId,
      typeName: regimeCredentialTypes.name,
      expiresOn: userCredentials.expiresOn,
      revokedAt: userCredentials.revokedAt,
    })
    .from(userCredentials)
    .innerJoin(
      regimeCredentialTypes,
      eq(regimeCredentialTypes.id, userCredentials.regimeCredentialTypeId),
    )
    .innerJoin(
      organizationMemberships,
      and(
        eq(organizationMemberships.userId, userCredentials.userId),
        eq(organizationMemberships.tenantId, tenantId),
      ),
    )
    .where(isNull(userCredentials.revokedAt));
}

/**
 * Team-list credential summary for a tenant's admin settings page.
 *
 * Tenant scoping happens at the SQL layer in
 * {@link selectTenantMemberCredentials}; the bucketing below is a
 * presentation step, not a security boundary.
 */
export async function loadTeamCredentialSummary(
  tx: AccountsDb,
  tenantId: string,
): Promise<TeamCredentialSummaryRow[]> {
  const members = await tx
    .select({
      userId: users.id,
      email: users.email,
      role: organizationMemberships.role,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(eq(organizationMemberships.tenantId, tenantId))
    .orderBy(users.email);

  if (members.length === 0) return [];

  const credentials = await selectTenantMemberCredentials(tx, tenantId);

  const byUser = new Map<
    string,
    Array<{ typeName: string; expiresOn: string | null; revokedAt: null }>
  >();
  for (const c of credentials) {
    const list = byUser.get(c.userId) ?? [];
    list.push({
      typeName: c.typeName,
      expiresOn: c.expiresOn,
      revokedAt: null,
    });
    byUser.set(c.userId, list);
  }

  return members.map((m) => ({
    userId: m.userId,
    email: m.email,
    role: m.role,
    credentials: byUser.get(m.userId) ?? [],
  }));
}
