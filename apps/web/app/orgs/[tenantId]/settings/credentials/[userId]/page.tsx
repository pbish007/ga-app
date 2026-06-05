import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";

import { schema } from "@ga/db";

import { runPage } from "../../../../../../lib/page-auth";
import { pageShellStyles as s } from "../../../../../../lib/page-shell";

import { UserCredentialsClient } from "./UserCredentialsClient";
import type {
  CredentialDto,
  CredentialTypeDto,
} from "../../../../../../components/credentials/types";

export const dynamic = "force-dynamic";

const {
  organizations,
  organizationMemberships,
  users,
  userCredentials,
  regimeCredentialTypes,
} = schema;

interface PageParams {
  tenantId: string;
  userId: string;
}

interface PageData {
  member: { email: string; role: string };
  defaultRegimeId: string;
  credentials: CredentialDto[];
  credentialTypes: CredentialTypeDto[];
  /** Map credential id → display name for the type. */
  typeNames: Record<string, string>;
}

export default async function UserCredentialDetailPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { tenantId, userId } = await params;

  const data = await runPage(
    tenantId,
    "credential.manage",
    async (tx): Promise<PageData | null> => {
      const member = await tx
        .select({
          email: users.email,
          role: organizationMemberships.role,
          defaultRegimeId: organizations.defaultRegimeId,
        })
        .from(organizationMemberships)
        .innerJoin(users, eq(users.id, organizationMemberships.userId))
        .innerJoin(
          organizations,
          eq(organizations.id, organizationMemberships.tenantId),
        )
        .where(
          and(
            eq(organizationMemberships.tenantId, tenantId),
            eq(organizationMemberships.userId, userId),
          ),
        )
        .limit(1);

      const row = member[0];
      if (!row) return null;

      const credentialRows = await tx
        .select({
          credential: userCredentials,
          typeName: regimeCredentialTypes.name,
        })
        .from(userCredentials)
        .innerJoin(
          regimeCredentialTypes,
          eq(
            regimeCredentialTypes.id,
            userCredentials.regimeCredentialTypeId,
          ),
        )
        .where(eq(userCredentials.userId, userId))
        .orderBy(desc(userCredentials.createdAt));

      const types = await tx
        .select({
          id: regimeCredentialTypes.id,
          code: regimeCredentialTypes.code,
          name: regimeCredentialTypes.name,
          authorizesSignoff: regimeCredentialTypes.authorizesSignoff,
        })
        .from(regimeCredentialTypes)
        .where(eq(regimeCredentialTypes.regimeId, row.defaultRegimeId))
        .orderBy(regimeCredentialTypes.name);

      const typeNames: Record<string, string> = {};
      const credentials: CredentialDto[] = credentialRows
        .filter((r) => r.credential.revokedAt === null)
        .map((r) => {
          typeNames[r.credential.id] = r.typeName;
          return {
            id: r.credential.id,
            user_id: r.credential.userId,
            regime_credential_type_id: r.credential.regimeCredentialTypeId,
            certificate_number: r.credential.certificateNumber,
            ratings: r.credential.ratings ?? [],
            issued_on: r.credential.issuedOn,
            expires_on: r.credential.expiresOn,
            revoked_at: r.credential.revokedAt
              ? (r.credential.revokedAt as Date).toISOString()
              : null,
            created_by_user_id: r.credential.createdByUserId,
            created_at: (r.credential.createdAt as Date).toISOString(),
            updated_at: (r.credential.updatedAt as Date).toISOString(),
          };
        });

      return {
        member: { email: row.email, role: row.role },
        defaultRegimeId: row.defaultRegimeId,
        credentials,
        credentialTypes: types.map((t) => ({
          id: t.id,
          code: t.code,
          name: t.name,
          authorizes_signoff: t.authorizesSignoff,
        })),
        typeNames,
      };
    },
  );

  if (!data) notFound();

  return (
    <main style={s.main}>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link
          href={`/orgs/${tenantId}/settings/credentials`}
          style={s.link}
          data-testid="credential-detail-back"
        >
          ← Back to Credentials
        </Link>
      </p>
      <h1 style={s.h1}>{data.member.email}</h1>
      <p style={s.muted}>Role: {data.member.role}</p>

      <UserCredentialsClient
        tenantId={tenantId}
        userId={userId}
        userDisplayName={data.member.email}
        initialCredentials={data.credentials}
        credentialTypes={data.credentialTypes}
        initialTypeNames={data.typeNames}
      />

      <p
        style={{
          ...s.legalCaution,
          marginTop: "2.5rem",
        }}
      >
        ℹ All credential changes are recorded in the audit log.
      </p>
    </main>
  );
}
