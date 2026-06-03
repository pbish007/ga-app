import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import {
  ORG_TYPES,
  schema as dbSchema,
  type OrgType,
} from "@ga/db";

import { isPlatformAdmin } from "../../../lib/auth/platform-admin";
import { getDb } from "../../../lib/db";
import { getOptionalSession } from "../../../lib/page-auth";
import { pageShellStyles as s } from "../../../lib/page-shell";

export const dynamic = "force-dynamic";

const {
  organizationMemberships,
  organizations,
  regimes,
  users,
} = dbSchema;

const ORG_TYPE_LABEL: Record<OrgType, string> = {
  owner: "Owner / operator",
  club: "Flying club",
  school: "Flight school",
  shop: "Maintenance shop",
};

interface Search {
  orgType?: string;
  regimeId?: string;
}

function isOrgType(v: string | undefined): v is OrgType {
  return !!v && (ORG_TYPES as readonly string[]).includes(v);
}

export default async function AdminTenantsListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getOptionalSession();
  if (!session) redirect("/login?next=/admin/tenants");
  const db = getDb();
  const ok = await isPlatformAdmin(session.user.id, { db });
  if (!ok) redirect("/orgs");

  const sp = (await searchParams) as Search;
  const orgTypeFilter = isOrgType(sp.orgType) ? sp.orgType : undefined;
  const regimeFilter =
    typeof sp.regimeId === "string" && sp.regimeId.length > 0
      ? sp.regimeId
      : undefined;

  const regimeRows = await db
    .select({
      id: regimes.id,
      code: regimes.code,
      name: regimes.name,
      jurisdiction: regimes.jurisdiction,
    })
    .from(regimes)
    .orderBy(asc(regimes.name));
  const regimeById = new Map(regimeRows.map((r) => [r.id, r]));

  const conditions = [];
  if (orgTypeFilter) conditions.push(eq(organizations.orgType, orgTypeFilter));
  if (regimeFilter)
    conditions.push(eq(organizations.defaultRegimeId, regimeFilter));
  const whereExpr =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : and(...conditions);

  const tenantRowsQuery = db
    .select({
      id: organizations.id,
      name: organizations.name,
      orgType: organizations.orgType,
      defaultRegimeId: organizations.defaultRegimeId,
      createdAt: organizations.createdAt,
    })
    .from(organizations)
    .orderBy(desc(organizations.createdAt));
  const tenantRows = whereExpr
    ? await tenantRowsQuery.where(whereExpr)
    : await tenantRowsQuery;

  const memberCountsRaw = await db
    .select({
      tenantId: organizationMemberships.tenantId,
      total: sql<string>`count(*)::text`,
      admins: sql<string>`count(*) filter (where ${organizationMemberships.role} = 'admin')::text`,
    })
    .from(organizationMemberships)
    .groupBy(organizationMemberships.tenantId);
  const memberCounts = new Map<string, { total: number; admins: number }>();
  for (const row of memberCountsRaw) {
    memberCounts.set(row.tenantId, {
      total: Number(row.total),
      admins: Number(row.admins),
    });
  }

  const adminRows = await db
    .select({
      tenantId: organizationMemberships.tenantId,
      email: users.email,
      createdAt: organizationMemberships.createdAt,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(eq(organizationMemberships.role, "admin"))
    .orderBy(organizationMemberships.createdAt);
  const primaryAdminByTenant = new Map<string, string>();
  for (const row of adminRows) {
    if (!primaryAdminByTenant.has(row.tenantId)) {
      primaryAdminByTenant.set(row.tenantId, row.email);
    }
  }

  function regimeLabel(id: string | null): string {
    if (!id) return "—";
    const r = regimeById.get(id);
    return r ? `${r.code} (${r.jurisdiction})` : id;
  }

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
        <Link href="/orgs" style={s.link}>
          ← Organizations
        </Link>
        <Link href="/admin/audit" style={s.link}>
          Audit feed
        </Link>
      </nav>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ ...s.h1, marginBottom: 0 }}>Tenants</h1>
        <Link href="/admin/tenants/new" style={s.buttonLink}>
          Provision tenant
        </Link>
      </div>
      <p style={s.muted}>
        Platform admin only — signed in as {session.user.email}.
      </p>

      <form
        method="GET"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr auto",
          gap: "0.75rem",
          alignItems: "end",
          margin: "1.25rem 0",
        }}
      >
        <label style={s.field}>
          <span style={s.label}>Org type</span>
          <select name="orgType" defaultValue={orgTypeFilter ?? ""} style={s.select}>
            <option value="">All</option>
            {ORG_TYPES.map((t) => (
              <option key={t} value={t}>
                {ORG_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label style={s.field}>
          <span style={s.label}>Regime</span>
          <select
            name="regimeId"
            defaultValue={regimeFilter ?? ""}
            style={s.select}
          >
            <option value="">All</option>
            {regimeRows.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.jurisdiction})
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          style={{ ...s.button, alignSelf: "end" }}
        >
          Apply
        </button>
      </form>

      {tenantRows.length === 0 ? (
        <p style={s.muted}>No tenants match the current filters.</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Organization</th>
                <th style={s.th}>Type</th>
                <th style={s.th}>Regime</th>
                <th style={s.th}>Primary admin</th>
                <th style={s.th}>Members</th>
                <th style={s.th}>Created</th>
              </tr>
            </thead>
            <tbody>
              {tenantRows.map((t) => {
                const counts = memberCounts.get(t.id);
                return (
                  <tr key={t.id}>
                    <td style={s.td}>
                      <Link href={`/admin/tenants/${t.id}`} style={s.link}>
                        {t.name}
                      </Link>
                    </td>
                    <td style={s.td}>{ORG_TYPE_LABEL[t.orgType]}</td>
                    <td style={s.td}>{regimeLabel(t.defaultRegimeId)}</td>
                    <td style={s.td}>
                      {primaryAdminByTenant.get(t.id) ?? "—"}
                    </td>
                    <td style={s.td}>
                      {counts ? `${counts.total} (${counts.admins} admin)` : "0"}
                    </td>
                    <td style={s.td}>
                      <time dateTime={t.createdAt.toISOString()}>
                        {t.createdAt.toISOString().slice(0, 10)}
                      </time>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ ...s.muted, marginTop: "1rem", fontSize: "0.85rem" }}>
        {tenantRows.length} tenant{tenantRows.length === 1 ? "" : "s"} shown.
      </p>
    </main>
  );
}
