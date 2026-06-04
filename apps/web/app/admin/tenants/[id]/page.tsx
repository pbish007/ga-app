import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { asc, desc, eq, inArray } from "drizzle-orm";

import { schema as dbSchema, type OrgType } from "@ga/db";

import { isPlatformAdmin } from "../../../../lib/auth/platform-admin";
import { getDb, getDirectDb } from "../../../../lib/db";
import { getOptionalSession } from "../../../../lib/page-auth";
import { pageShellStyles as s } from "../../../../lib/page-shell";
import { DEMO_ORG_NAME } from "../../../../lib/demo-seed";
import { ReseedDemoButton } from "./ReseedDemoButton";

export const dynamic = "force-dynamic";

const {
  organizationMemberships,
  organizations,
  regimes,
  tenantProvisioningAudit,
  users,
} = dbSchema;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORG_TYPE_LABEL: Record<OrgType, string> = {
  owner: "Owner / operator",
  club: "Flying club",
  school: "Flight school",
  shop: "Maintenance shop",
};

const STATUS_COLOR: Record<string, string> = {
  done: "#065f46",
  in_progress: "#92400e",
  failed: "#b91c1c",
};

/**
 * The reseed-demo button is gated client-side at the org-name level. Any
 * org carrying the demo marker — the canonical demo org or any org whose
 * name ends with "(Demo)" — counts as a demo tenant. Non-demo orgs see a
 * disabled button so the operator can't accidentally trash a real tenant.
 */
function isDemoOrg(name: string): boolean {
  return name === DEMO_ORG_NAME || /\(Demo\)\s*$/i.test(name.trim());
}

export default async function AdminTenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const session = await getOptionalSession();
  if (!session) redirect(`/login?next=/admin/tenants/${id}`);
  const db = getDb();
  const ok = await isPlatformAdmin(session.user.id, { db });
  if (!ok) redirect("/orgs");
  // Cross-tenant admin reads — owner-class connection (same rationale as
  // `apps/web/lib/admin/tenants-handler.ts`).
  const directDb = getDirectDb();

  const [tenant] = await directDb
    .select({
      id: organizations.id,
      name: organizations.name,
      orgType: organizations.orgType,
      defaultRegimeId: organizations.defaultRegimeId,
      createdAt: organizations.createdAt,
      updatedAt: organizations.updatedAt,
    })
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1);
  if (!tenant) notFound();

  const regimeRow = tenant.defaultRegimeId
    ? (
        await db
          .select({
            id: regimes.id,
            code: regimes.code,
            name: regimes.name,
            jurisdiction: regimes.jurisdiction,
          })
          .from(regimes)
          .where(eq(regimes.id, tenant.defaultRegimeId))
          .limit(1)
      )[0]
    : null;

  const memberships = await directDb
    .select({
      userId: organizationMemberships.userId,
      role: organizationMemberships.role,
      createdAt: organizationMemberships.createdAt,
      email: users.email,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(eq(organizationMemberships.tenantId, id))
    .orderBy(asc(organizationMemberships.createdAt));

  const auditRows = await db
    .select({
      id: tenantProvisioningAudit.id,
      idempotencyKey: tenantProvisioningAudit.idempotencyKey,
      actorUserId: tenantProvisioningAudit.actorUserId,
      actorKind: tenantProvisioningAudit.actorKind,
      resultStatus: tenantProvisioningAudit.resultStatus,
      createdAt: tenantProvisioningAudit.createdAt,
      completedAt: tenantProvisioningAudit.completedAt,
      error: tenantProvisioningAudit.error,
    })
    .from(tenantProvisioningAudit)
    .where(eq(tenantProvisioningAudit.createdTenantId, id))
    .orderBy(desc(tenantProvisioningAudit.createdAt))
    .limit(50);

  const actorIds = Array.from(
    new Set(auditRows.map((r) => r.actorUserId).filter((v): v is string => !!v)),
  );
  const actorEmails = new Map<string, string>();
  if (actorIds.length > 0) {
    const rows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, actorIds));
    for (const r of rows) actorEmails.set(r.id, r.email);
  }

  const demo = isDemoOrg(tenant.name);

  return (
    <main style={s.main}>
      <nav
        style={{
          display: "flex",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "1rem",
          fontSize: "0.9rem",
        }}
      >
        <Link href="/admin/tenants" style={s.link}>
          ← All tenants
        </Link>
        <Link href="/admin/audit" style={s.link}>
          Audit feed
        </Link>
      </nav>

      <h1 style={s.h1}>{tenant.name}</h1>
      <p style={s.muted}>
        Platform admin · signed in as {session.user.email}
      </p>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          gap: "0.5rem 1rem",
          margin: "1.25rem 0",
          fontSize: "0.95rem",
        }}
      >
        <span style={s.label}>Tenant ID</span>
        <code>{tenant.id}</code>
        <span style={s.label}>Type</span>
        <span>{ORG_TYPE_LABEL[tenant.orgType]}</span>
        <span style={s.label}>Regime</span>
        <span>
          {regimeRow
            ? `${regimeRow.name} (${regimeRow.jurisdiction}) · ${regimeRow.code}`
            : tenant.defaultRegimeId ?? "—"}
        </span>
        <span style={s.label}>Created</span>
        <span>{tenant.createdAt.toISOString()}</span>
        <span style={s.label}>Updated</span>
        <span>{tenant.updatedAt.toISOString()}</span>
        <span style={s.label}>Members</span>
        <span>
          {memberships.length} (
          {memberships.filter((m) => m.role === "admin").length} admin)
        </span>
      </section>

      <h2 style={s.h2}>Demo content</h2>
      <ReseedDemoButton
        tenantId={tenant.id}
        enabled={demo}
        disabledReason={
          demo
            ? undefined
            : "Reseed is only available for demo organizations (name ending in “(Demo)”)."
        }
      />

      <h2 style={s.h2}>Memberships</h2>
      {memberships.length === 0 ? (
        <p style={s.muted}>No memberships.</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Email</th>
                <th style={s.th}>Role</th>
                <th style={s.th}>Joined</th>
              </tr>
            </thead>
            <tbody>
              {memberships.map((m) => (
                <tr key={m.userId}>
                  <td style={s.td}>{m.email}</td>
                  <td style={s.td}>{m.role}</td>
                  <td style={s.td}>
                    <time dateTime={m.createdAt.toISOString()}>
                      {m.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={s.h2}>Recent provisioning audit</h2>
      {auditRows.length === 0 ? (
        <p style={s.muted}>No audit rows for this tenant.</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>When</th>
                <th style={s.th}>Actor</th>
                <th style={s.th}>Kind</th>
                <th style={s.th}>Status</th>
                <th style={s.th}>Idem. key</th>
                <th style={s.th}>Audit ID</th>
              </tr>
            </thead>
            <tbody>
              {auditRows.map((r) => (
                <tr key={r.id}>
                  <td style={s.td}>
                    <time dateTime={r.createdAt.toISOString()}>
                      {r.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                    </time>
                  </td>
                  <td style={s.td}>
                    {r.actorUserId
                      ? actorEmails.get(r.actorUserId) ?? r.actorUserId
                      : "—"}
                  </td>
                  <td style={s.td}>{r.actorKind}</td>
                  <td
                    style={{
                      ...s.td,
                      color: STATUS_COLOR[r.resultStatus] ?? "#222",
                      fontWeight: 600,
                    }}
                  >
                    {r.resultStatus}
                  </td>
                  <td style={{ ...s.td, fontFamily: "ui-monospace, monospace" }}>
                    {r.idempotencyKey ?? "—"}
                  </td>
                  <td style={{ ...s.td, fontFamily: "ui-monospace, monospace" }}>
                    {r.id.slice(0, 8)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
