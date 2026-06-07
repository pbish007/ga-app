import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";

import { schema as dbSchema } from "@ga/db";

import { isPlatformAdmin } from "../../../../lib/auth/platform-admin";
import { getDb, getDirectDb } from "../../../../lib/db";
import { getOptionalSession } from "../../../../lib/page-auth";
import { pageShellStyles as s } from "../../../../lib/page-shell";

import { JobActions } from "./JobActions";

export const dynamic = "force-dynamic";

const { importJobs, importJobRows, organizations } = dbSchema;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATE_COLOR: Record<string, { bg: string; fg: string }> = {
  pending: { bg: "#f3f4f6", fg: "#374151" },
  validating: { bg: "#fef3c7", fg: "#92400e" },
  ready: { bg: "#dbeafe", fg: "#1e40af" },
  failed: { bg: "#fee2e2", fg: "#b91c1c" },
  committed: { bg: "#d1fae5", fg: "#065f46" },
};

const MAX_ERRORS_SHOWN = 200;

export default async function AdminImportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const session = await getOptionalSession();
  if (!session) redirect(`/login?next=/admin/imports/${id}`);
  const db = getDb();
  const ok = await isPlatformAdmin(session.user.id, { db });
  if (!ok) redirect("/orgs");
  const directDb = getDirectDb();

  const [job] = await directDb
    .select()
    .from(importJobs)
    .where(eq(importJobs.id, id))
    .limit(1);
  if (!job) notFound();

  const [tenant] = await directDb
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, job.tenantId as string))
    .limit(1);

  const counts = await directDb
    .select({
      total: sql<string>`count(*)::text`,
      valid: sql<string>`count(*) filter (where ${importJobRows.validationStatus} = 'valid')::text`,
      invalid: sql<string>`count(*) filter (where ${importJobRows.validationStatus} = 'invalid')::text`,
      committed: sql<string>`count(*) filter (where ${importJobRows.validationStatus} = 'committed')::text`,
    })
    .from(importJobRows)
    .where(eq(importJobRows.importJobId, id));

  const sp = await searchParams;
  const cursorRaw =
    typeof sp.errorCursor === "string" ? sp.errorCursor : "0";
  let cursor = Number.parseInt(cursorRaw, 10);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

  const errorRows = await directDb
    .select({
      sourceRowNumber: importJobRows.sourceRowNumber,
      validationErrors: importJobRows.validationErrors,
    })
    .from(importJobRows)
    .where(
      and(
        eq(importJobRows.importJobId, id),
        eq(importJobRows.validationStatus, "invalid"),
        sql`${importJobRows.sourceRowNumber} > ${cursor}`,
      ),
    )
    .orderBy(importJobRows.sourceRowNumber)
    .limit(MAX_ERRORS_SHOWN);

  const flatErrors: {
    sourceRowNumber: number;
    code: string;
    message: string;
    field?: string;
  }[] = [];
  for (const r of errorRows as {
    sourceRowNumber: number;
    validationErrors:
      | { code: string; message: string; field?: string; rowNumber?: number }[]
      | null;
  }[]) {
    if (!r.validationErrors) continue;
    for (const e of r.validationErrors) {
      flatErrors.push({
        sourceRowNumber: r.sourceRowNumber,
        code: e.code,
        message: e.message,
        field: e.field,
      });
    }
  }

  const total = Number((counts[0] as { total: string } | undefined)?.total ?? "0");
  const validCount = Number(
    (counts[0] as { valid: string } | undefined)?.valid ?? "0",
  );
  const invalidCount = Number(
    (counts[0] as { invalid: string } | undefined)?.invalid ?? "0",
  );
  const committedCount = Number(
    (counts[0] as { committed: string } | undefined)?.committed ?? "0",
  );

  const state = job.state as string;
  const stateColor = STATE_COLOR[state] ?? STATE_COLOR.pending!;
  const canRevalidate = state === "pending" || state === "failed" || state === "ready";
  const canCommit = state === "ready" && invalidCount === 0 && total > 0;

  const lastErrorRowNumber =
    errorRows.length > 0
      ? (errorRows[errorRows.length - 1] as { sourceRowNumber: number })
          .sourceRowNumber
      : null;
  const nextCursor =
    errorRows.length === MAX_ERRORS_SHOWN ? lastErrorRowNumber : null;

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
        <Link href="/admin/imports" style={s.link}>
          ← Imports
        </Link>
        <Link href="/admin/imports/new" style={s.link}>
          New import
        </Link>
      </nav>

      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", flexWrap: "wrap" }}>
        <h1 style={{ ...s.h1, marginBottom: 0 }}>Import job</h1>
        <span
          style={{
            background: stateColor.bg,
            color: stateColor.fg,
            padding: "0.2rem 0.6rem",
            borderRadius: 999,
            fontSize: "0.85rem",
            fontWeight: 600,
          }}
        >
          {state}
        </span>
      </div>
      <p style={s.muted}>
        Job ID: <code>{id}</code>
      </p>

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          gap: "0.35rem 1rem",
          margin: "1rem 0",
          fontSize: "0.95rem",
        }}
      >
        <dt style={{ fontWeight: 600 }}>Tenant</dt>
        <dd style={{ margin: 0 }}>
          {tenant ? (
            <Link href={`/admin/tenants/${tenant.id}`} style={s.link}>
              {tenant.name}
            </Link>
          ) : (
            <code>{String(job.tenantId)}</code>
          )}
        </dd>
        <dt style={{ fontWeight: 600 }}>Target table</dt>
        <dd style={{ margin: 0 }}>
          <code>{String(job.targetTable ?? "—")}</code>
        </dd>
        <dt style={{ fontWeight: 600 }}>Source file</dt>
        <dd style={{ margin: 0 }}>
          {String(job.sourceFilename ?? "—")}
        </dd>
        <dt style={{ fontWeight: 600 }}>Created</dt>
        <dd style={{ margin: 0 }}>
          <time dateTime={(job.createdAt as Date).toISOString()}>
            {(job.createdAt as Date).toISOString().slice(0, 19).replace("T", " ")}{" "}
            UTC
          </time>
        </dd>
        <dt style={{ fontWeight: 600 }}>Updated</dt>
        <dd style={{ margin: 0 }}>
          <time dateTime={(job.updatedAt as Date).toISOString()}>
            {(job.updatedAt as Date).toISOString().slice(0, 19).replace("T", " ")}{" "}
            UTC
          </time>
        </dd>
        {job.committedAt && (
          <>
            <dt style={{ fontWeight: 600 }}>Committed</dt>
            <dd style={{ margin: 0 }}>
              <time dateTime={(job.committedAt as Date).toISOString()}>
                {(job.committedAt as Date)
                  .toISOString()
                  .slice(0, 19)
                  .replace("T", " ")}{" "}
                UTC
              </time>
            </dd>
          </>
        )}
      </dl>

      <h2 style={s.h2}>Row totals</h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: "0.75rem",
        }}
      >
        <Counter label="Total" value={total} />
        <Counter label="Valid" value={validCount} color="#065f46" />
        <Counter label="Invalid" value={invalidCount} color="#b91c1c" />
        <Counter label="Committed" value={committedCount} color="#1e40af" />
      </div>

      <h2 style={s.h2}>Actions</h2>
      <JobActions
        jobId={id}
        canRevalidate={canRevalidate}
        canCommit={canCommit}
      />
      {!canCommit && state !== "committed" && invalidCount > 0 && (
        <p style={{ ...s.muted, marginTop: "0.5rem", fontSize: "0.85rem" }}>
          Commit is disabled because {invalidCount} row
          {invalidCount === 1 ? "" : "s"} {invalidCount === 1 ? "is" : "are"}{" "}
          invalid. Fix the source spreadsheet, start a new import, or re-run
          validation after editing the source.
        </p>
      )}

      {job.errorSummary != null && (
        <>
          <h2 style={s.h2}>Error summary</h2>
          <pre
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 6,
              padding: "0.75rem 1rem",
              fontSize: "0.85rem",
              overflowX: "auto",
            }}
          >
            {JSON.stringify(job.errorSummary, null, 2)}
          </pre>
        </>
      )}

      <h2 style={s.h2}>Row-level errors</h2>
      {invalidCount === 0 ? (
        <p style={s.muted}>No invalid rows.</p>
      ) : flatErrors.length === 0 ? (
        <p style={s.muted}>
          No invalid rows past row {cursor}.{" "}
          <Link href={`/admin/imports/${id}`} style={s.link}>
            Back to the start
          </Link>
        </p>
      ) : (
        <>
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Source row</th>
                  <th style={s.th}>Field</th>
                  <th style={s.th}>Code</th>
                  <th style={s.th}>Message</th>
                </tr>
              </thead>
              <tbody>
                {flatErrors.map((e, i) => (
                  <tr key={i}>
                    <td style={s.td}>{e.sourceRowNumber}</td>
                    <td style={s.td}>{e.field ?? "—"}</td>
                    <td style={s.td}>
                      <code>{e.code}</code>
                    </td>
                    <td style={s.td}>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ ...s.muted, marginTop: "0.5rem", fontSize: "0.85rem" }}>
            Showing {flatErrors.length} error
            {flatErrors.length === 1 ? "" : "s"} from rows after {cursor}.
            {nextCursor != null && (
              <>
                {" "}
                <Link
                  href={`/admin/imports/${id}?errorCursor=${nextCursor}`}
                  style={s.link}
                >
                  Next page →
                </Link>
              </>
            )}
          </p>
        </>
      )}
    </main>
  );
}

function Counter({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: "0.75rem 1rem",
      }}
    >
      <div style={{ fontSize: "0.85rem", color: "#666" }}>{label}</div>
      <div
        style={{
          fontSize: "1.5rem",
          fontWeight: 700,
          color: color ?? "#111827",
        }}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}
