import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";

import {
  PROVISIONING_ACTOR_KINDS,
  PROVISIONING_RESULT_STATUSES,
  schema as dbSchema,
  type ProvisioningActorKind,
  type ProvisioningResultStatus,
} from "@ga/db";

import { isPlatformAdmin } from "../../../lib/auth/platform-admin";
import { getDb } from "../../../lib/db";
import { getOptionalSession } from "../../../lib/page-auth";
import { pageShellStyles as s } from "../../../lib/page-shell";

export const dynamic = "force-dynamic";

const { organizations, tenantProvisioningAudit, users } = dbSchema;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_COLOR: Record<string, string> = {
  done: "#065f46",
  in_progress: "#92400e",
  failed: "#b91c1c",
};

const ACTOR_KIND_LABEL: Record<ProvisioningActorKind, string> = {
  "self-service": "Self-service",
  "platform-admin": "Platform admin",
  grandfathered: "Grandfathered",
};

const PAGE_SIZE = 50;

interface Search {
  after?: string;
  actorKind?: string;
  resultStatus?: string;
  from?: string;
  to?: string;
}

function isActorKind(v: string | undefined): v is ProvisioningActorKind {
  return (
    !!v && (PROVISIONING_ACTOR_KINDS as readonly string[]).includes(v)
  );
}

function isResultStatus(v: string | undefined): v is ProvisioningResultStatus {
  return (
    !!v && (PROVISIONING_RESULT_STATUSES as readonly string[]).includes(v)
  );
}

/**
 * Parse an ISO-ish date input from the filter form. Accepts `YYYY-MM-DD`
 * and full ISO. Returns null on anything we can't parse so the URL doesn't
 * silently filter on garbage.
 */
function parseDate(v: string | undefined): Date | null {
  if (!v) return null;
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) return null;
  return t;
}

function buildQuery(
  base: Record<string, string | undefined>,
  patch: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  const merged = { ...base, ...patch };
  for (const [k, v] of Object.entries(merged)) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getOptionalSession();
  if (!session) redirect("/login?next=/admin/audit");
  const db = getDb();
  const ok = await isPlatformAdmin(session.user.id, { db });
  if (!ok) redirect("/orgs");

  const sp = (await searchParams) as Search;
  const actorFilter = isActorKind(sp.actorKind) ? sp.actorKind : undefined;
  const statusFilter = isResultStatus(sp.resultStatus)
    ? sp.resultStatus
    : undefined;
  const fromDate = parseDate(sp.from);
  const toDate = parseDate(sp.to);
  const afterId =
    typeof sp.after === "string" && UUID_RE.test(sp.after) ? sp.after : undefined;

  let afterCreatedAt: Date | null = null;
  if (afterId) {
    const [cursor] = await db
      .select({ createdAt: tenantProvisioningAudit.createdAt })
      .from(tenantProvisioningAudit)
      .where(eq(tenantProvisioningAudit.id, afterId))
      .limit(1);
    if (cursor) afterCreatedAt = cursor.createdAt;
  }

  const conditions = [] as ReturnType<typeof eq>[];
  if (actorFilter)
    conditions.push(eq(tenantProvisioningAudit.actorKind, actorFilter));
  if (statusFilter)
    conditions.push(eq(tenantProvisioningAudit.resultStatus, statusFilter));
  if (fromDate)
    conditions.push(gte(tenantProvisioningAudit.createdAt, fromDate));
  if (toDate) conditions.push(lt(tenantProvisioningAudit.createdAt, toDate));
  if (afterCreatedAt)
    conditions.push(gt(tenantProvisioningAudit.createdAt, afterCreatedAt));

  const whereExpr =
    conditions.length === 0
      ? sql`true`
      : conditions.length === 1
        ? conditions[0]!
        : and(...conditions)!;

  // limit + 1 to compute hasMore without a second query.
  const rows = await db
    .select({
      id: tenantProvisioningAudit.id,
      createdTenantId: tenantProvisioningAudit.createdTenantId,
      idempotencyKey: tenantProvisioningAudit.idempotencyKey,
      actorUserId: tenantProvisioningAudit.actorUserId,
      actorKind: tenantProvisioningAudit.actorKind,
      resultStatus: tenantProvisioningAudit.resultStatus,
      createdAt: tenantProvisioningAudit.createdAt,
      completedAt: tenantProvisioningAudit.completedAt,
    })
    .from(tenantProvisioningAudit)
    .where(whereExpr)
    .orderBy(asc(tenantProvisioningAudit.createdAt))
    .limit(PAGE_SIZE + 1);

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const nextAfter = hasMore ? page[page.length - 1]?.id ?? null : null;

  const tenantIds = Array.from(
    new Set(
      page.map((r) => r.createdTenantId).filter((v): v is string => !!v),
    ),
  );
  const actorIds = Array.from(
    new Set(page.map((r) => r.actorUserId).filter((v): v is string => !!v)),
  );

  const tenantNames = new Map<string, string>();
  if (tenantIds.length > 0) {
    const tenantRows = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(inArray(organizations.id, tenantIds));
    for (const t of tenantRows) tenantNames.set(t.id, t.name);
  }

  const actorEmails = new Map<string, string>();
  if (actorIds.length > 0) {
    const actorRows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, actorIds));
    for (const u of actorRows) actorEmails.set(u.id, u.email);
  }

  // Build the filter base used by pagination + reset links. Carry filters
  // forward but drop `after` (we replace it).
  const filterBase = {
    actorKind: actorFilter,
    resultStatus: statusFilter,
    from: sp.from,
    to: sp.to,
  };

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
          ← Tenants
        </Link>
      </nav>
      <h1 style={s.h1}>Provisioning audit</h1>
      <p style={s.muted}>
        Append-only log of every tenant-provisioning attempt — self-service
        signups, platform-admin provisions, and grandfathered legacy rows.
      </p>

      <form
        method="GET"
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(160px, 1fr)) auto",
          gap: "0.75rem",
          alignItems: "end",
          margin: "1.25rem 0",
        }}
      >
        <label style={s.field}>
          <span style={s.label}>Actor kind</span>
          <select
            name="actorKind"
            defaultValue={actorFilter ?? ""}
            style={s.select}
          >
            <option value="">All</option>
            {PROVISIONING_ACTOR_KINDS.map((k) => (
              <option key={k} value={k}>
                {ACTOR_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label style={s.field}>
          <span style={s.label}>Result</span>
          <select
            name="resultStatus"
            defaultValue={statusFilter ?? ""}
            style={s.select}
          >
            <option value="">All</option>
            {PROVISIONING_RESULT_STATUSES.map((rs) => (
              <option key={rs} value={rs}>
                {rs}
              </option>
            ))}
          </select>
        </label>
        <label style={s.field}>
          <span style={s.label}>From</span>
          <input
            type="date"
            name="from"
            defaultValue={sp.from ?? ""}
            style={s.input}
          />
        </label>
        <label style={s.field}>
          <span style={s.label}>To (exclusive)</span>
          <input
            type="date"
            name="to"
            defaultValue={sp.to ?? ""}
            style={s.input}
          />
        </label>
        <button type="submit" style={{ ...s.button, alignSelf: "end" }}>
          Apply
        </button>
      </form>

      {page.length === 0 ? (
        <p style={s.muted}>No audit rows match the current filters.</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>When</th>
                <th style={s.th}>Tenant</th>
                <th style={s.th}>Actor</th>
                <th style={s.th}>Kind</th>
                <th style={s.th}>Result</th>
                <th style={s.th}>Audit ID</th>
              </tr>
            </thead>
            <tbody>
              {page.map((r) => (
                <tr key={r.id}>
                  <td style={s.td}>
                    <time dateTime={r.createdAt.toISOString()}>
                      {r.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                    </time>
                  </td>
                  <td style={s.td}>
                    {r.createdTenantId ? (
                      <Link
                        href={`/admin/tenants/${r.createdTenantId}`}
                        style={s.link}
                      >
                        {tenantNames.get(r.createdTenantId) ??
                          r.createdTenantId.slice(0, 8) + "…"}
                      </Link>
                    ) : (
                      <span style={{ color: "#999" }}>—</span>
                    )}
                  </td>
                  <td style={s.td}>
                    {r.actorUserId
                      ? actorEmails.get(r.actorUserId) ?? r.actorUserId
                      : "—"}
                  </td>
                  <td style={s.td}>
                    {ACTOR_KIND_LABEL[r.actorKind] ?? r.actorKind}
                  </td>
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
                    {r.id.slice(0, 8)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "1rem",
          flexWrap: "wrap",
          marginTop: "1rem",
          fontSize: "0.9rem",
        }}
      >
        <span style={s.muted}>
          {page.length} row{page.length === 1 ? "" : "s"} shown
          {afterId ? " · paginated" : ""}.
        </span>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          {afterId ? (
            <Link
              href={`/admin/audit${buildQuery(filterBase, { after: undefined })}`}
              style={s.link}
            >
              ← Start over
            </Link>
          ) : null}
          {nextAfter ? (
            <Link
              href={`/admin/audit${buildQuery(filterBase, { after: nextAfter })}`}
              style={s.link}
            >
              Next page →
            </Link>
          ) : null}
        </div>
      </div>
    </main>
  );
}
