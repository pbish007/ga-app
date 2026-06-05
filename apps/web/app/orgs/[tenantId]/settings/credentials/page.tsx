import Link from "next/link";
import { and, eq, isNull } from "drizzle-orm";

import { schema } from "@ga/db";

import { runPage } from "../../../../../lib/page-auth";
import { pageShellStyles as s } from "../../../../../lib/page-shell";

import { CredentialStatusBadge } from "../../../../../components/credentials/CredentialStatusBadge";
import {
  worstState,
  type CredentialLike,
} from "../../../../../lib/credential-state";

export const dynamic = "force-dynamic";

const {
  organizationMemberships,
  users,
  userCredentials,
  regimeCredentialTypes,
} = schema;

interface PageParams {
  tenantId: string;
}

interface TeamMemberRow {
  userId: string;
  email: string;
  role: string;
  credentials: Array<CredentialLike & { typeName: string }>;
}

export default async function CredentialsListPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { tenantId } = await params;

  const rows = await runPage(
    tenantId,
    "credential.manage",
    async (tx): Promise<TeamMemberRow[]> => {
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

      const credentials = await tx
        .select({
          userId: userCredentials.userId,
          typeName: regimeCredentialTypes.name,
          expiresOn: userCredentials.expiresOn,
          revokedAt: userCredentials.revokedAt,
        })
        .from(userCredentials)
        .innerJoin(
          regimeCredentialTypes,
          eq(
            regimeCredentialTypes.id,
            userCredentials.regimeCredentialTypeId,
          ),
        )
        .where(
          and(
            isNull(userCredentials.revokedAt),
            // Membership-scope is enforced by the read above; we just
            // pull the credentials and bucket them by user_id below.
          ),
        );

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
    },
  );

  return (
    <main style={s.main}>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link href={`/orgs/${tenantId}/aircraft`} style={s.link}>
          ← Back
        </Link>
      </p>
      <h1 style={s.h1}>Settings · Credentials</h1>
      <p style={s.muted}>
        Certificate records for compliance and signoff.
      </p>

      {rows.length === 0 ? (
        <p style={{ marginTop: "2rem" }}>
          No team members yet. Add people from the Team settings page.
        </p>
      ) : (
        <div style={{ ...s.tableWrap, marginTop: "1.5rem" }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Member</th>
                <th style={s.th}>Role</th>
                <th style={s.th}>Credentials</th>
                <th style={s.th}>Status</th>
                <th style={s.th} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const state = worstState(row.credentials);
                const summary =
                  row.credentials.length === 0
                    ? "(none)"
                    : row.credentials.map((c) => c.typeName).join(" · ");
                return (
                  <tr key={row.userId}>
                    <td style={s.td}>
                      <strong>{row.email}</strong>
                    </td>
                    <td style={s.td}>{row.role}</td>
                    <td style={s.td}>{summary}</td>
                    <td style={s.td}>
                      <CredentialStatusBadge state={state} />
                    </td>
                    <td style={s.td}>
                      <Link
                        href={`/orgs/${tenantId}/settings/credentials/${row.userId}`}
                        style={s.link}
                        data-testid={`credential-row-link-${row.userId}`}
                      >
                        Edit →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ ...s.muted, marginTop: "1.5rem", fontSize: "0.85rem" }}>
        Showing {rows.length} of {rows.length} team member
        {rows.length === 1 ? "" : "s"}
      </p>
    </main>
  );
}
