import { and, eq, isNull, ne, sql } from "drizzle-orm";

import {
  TENANT_APP_ROLE,
  TENANT_CONTEXT_GUC,
  schema as dbSchema,
} from "@ga/db";

import { insertLiveRow } from "./inserters.js";
import {
  ImportJobCommitFailedError,
  ImportJobHasInvalidRowsError,
  ImportJobNotCommitableError,
  type CommitResult,
  type ImportDb,
  type ImportTx,
} from "./types.js";

const { importJobs, importJobRows } = dbSchema;

export interface CommitImportJobInput {
  tenantId: string;
  userId: string;
  /**
   * Regime the inserters consult for catalog lookups (RTS template
   * resolution for maintenance-entry sign-off, fallback regimeId for
   * aircraft inserts). The caller passes the regime id the import job
   * was created under.
   */
  regimeId: string;
  importJobId: string;
}

/**
 * The C5 commit pipeline (PMB-161). All-or-nothing single-tx commit:
 *
 *   1. Load `import_jobs` for the job, FOR UPDATE.
 *   2. If state is 'committed', return the idempotent no-op.
 *   3. Refuse anything that is not `ready` or `committing`.
 *   4. Load every `import_job_rows` row for the job. Refuse if any are
 *      not `valid` (or already `committed`, treated as a no-op replay).
 *   5. For each pending-valid row, INSERT into the target table with
 *      `source_import_row_id` set, then UPDATE the staging row's
 *      `committed_record_id` + `validation_status='committed'`.
 *   6. Boundary assertion: re-read the staging table and confirm no
 *      `valid` row remains uncommitted. (The CTO's guard query.)
 *   7. Flip `import_jobs.state='committed'`, set committed_at +
 *      committed_by_user_id.
 *
 * All steps share ONE transaction. If any throws, the whole tx rolls
 * back — no live rows, no state drift. A second, fresh transaction
 * then records `state='failed'` + an `error_summary` so the operator
 * can see the failure without crawling logs.
 */
export async function commitImportJob(
  db: ImportDb,
  input: CommitImportJobInput,
): Promise<CommitResult> {
  try {
    return await db.transaction(async (tx) => {
      await pinTenantTx(tx, input.tenantId);

      const job = await selectJobForUpdate(tx, input.importJobId);
      if (!job) {
        throw new ImportJobNotCommitableError(input.importJobId, "missing");
      }

      // Idempotent no-op: a committed job replays as success.
      if (job.state === "committed") {
        const rowsCommitted = await countCommittedRows(tx, input.importJobId);
        return {
          importJobId: input.importJobId,
          state: "committed",
          rowsCommitted,
          alreadyCommitted: true,
        };
      }

      // The commit gate is strictly `ready`. `committing` is an
      // intermediate that only exists within the commit tx and is
      // unobservable to another caller; treat any other state as
      // not-commitable.
      if (job.state !== "ready") {
        throw new ImportJobNotCommitableError(input.importJobId, job.state);
      }

      const rows = await tx
        .select()
        .from(importJobRows)
        .where(eq(importJobRows.importJobId, input.importJobId))
        .orderBy(importJobRows.sourceRowNumber);

      const invalid = rows.filter((r) => r.validationStatus === "invalid");
      if (invalid.length > 0) {
        throw new ImportJobHasInvalidRowsError(
          input.importJobId,
          invalid.length,
        );
      }
      const pending = rows.filter((r) => r.validationStatus === "pending");
      if (pending.length > 0) {
        throw new ImportJobHasInvalidRowsError(
          input.importJobId,
          pending.length,
        );
      }

      let rowsCommitted = 0;
      for (const row of rows) {
        // Per-row idempotency: a row already marked committed skips.
        // This covers the case where a prior commit attempt got
        // partway through inserting and crashed — in our single-tx
        // design this can only happen if the row state was somehow
        // pre-set, but we honor it defensively.
        if (
          row.validationStatus === "committed" &&
          row.committedRecordId !== null
        ) {
          rowsCommitted++;
          continue;
        }

        if (!row.targetTable) {
          throw new ImportJobHasInvalidRowsError(input.importJobId, 1);
        }
        const mapped = row.mappedPayload as Record<string, unknown> | null;
        if (!mapped) {
          throw new ImportJobHasInvalidRowsError(input.importJobId, 1);
        }

        const liveId = await insertLiveRow(
          {
            tx,
            tenantId: input.tenantId,
            regimeId: input.regimeId,
            importRowId: row.id,
            sourceRowNumber: row.sourceRowNumber,
            mapped,
          },
          row.targetTable,
        );

        await tx
          .update(importJobRows)
          .set({
            committedRecordId: liveId,
            validationStatus: "committed",
            updatedAt: new Date(),
          })
          .where(eq(importJobRows.id, row.id));

        rowsCommitted++;
      }

      // Boundary assertion (CTO guard, PMB-161): no `valid` row may
      // remain uncommitted when we flip the job state. The single-tx
      // design eliminates the failure mode "live rows exist but state
      // never flipped"; this assertion is the runtime equivalent.
      const remaining = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(importJobRows)
        .where(
          and(
            eq(importJobRows.importJobId, input.importJobId),
            eq(importJobRows.validationStatus, "valid"),
            isNull(importJobRows.committedRecordId),
          ),
        );
      const remainingCount = Number(remaining[0]?.count ?? 0);
      if (remainingCount !== 0) {
        throw new Error(
          `commit boundary assertion failed: ${remainingCount} valid row(s) still uncommitted before state flip`,
        );
      }

      // Flip the job. PMB-161 acceptance: state→'committed',
      // committed_at + committed_by_user_id populated together.
      await tx
        .update(importJobs)
        .set({
          state: "committed",
          committedAt: new Date(),
          committedByUserId: input.userId,
          updatedAt: new Date(),
        })
        .where(eq(importJobs.id, input.importJobId));

      return {
        importJobId: input.importJobId,
        state: "committed",
        rowsCommitted,
        alreadyCommitted: false,
      };
    });
  } catch (err) {
    // Both gate errors bypass the failure-recording path: the inner tx
    // rolled back, no live rows were written, and the job stays in
    // 'ready' so the operator can fix and retry without a state reset.
    // The HTTP handler maps these to 409/422 respectively (PMB-201).
    if (
      err instanceof ImportJobNotCommitableError ||
      err instanceof ImportJobHasInvalidRowsError
    ) {
      throw err;
    }
    await recordCommitFailure(db, input, err);
    throw new ImportJobCommitFailedError(input.importJobId, err);
  }
}

/**
 * Pin the tenant context on this transaction so RLS policies can match,
 * and drop role to `tenant_app` so even a misformed query inside the
 * tx cannot exfiltrate cross-tenant rows.
 *
 * Equivalent to the runtime `runAsTenantOnProductionDb` helper at the
 * web layer; we inline it here because the commit pipeline owns its
 * own transaction (one tx, atomic per PMB-161).
 */
async function pinTenantTx(tx: ImportTx, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select set_config(${TENANT_CONTEXT_GUC}, ${tenantId}, true)`,
  );
  await tx.execute(sql.raw(`set local role ${TENANT_APP_ROLE}`));
}

/**
 * Inner SELECT … FOR UPDATE on the job header. Drizzle's typed builder
 * (0.36) doesn't expose `.for("update")` ergonomically on the pglite
 * driver, so we drop to raw SQL. The lock prevents two concurrent
 * commit attempts from racing past the state check.
 */
async function selectJobForUpdate(
  tx: ImportTx,
  importJobId: string,
): Promise<{ id: string; state: string } | null> {
  const result = await tx.execute<{ id: string; state: string }>(
    sql`select id, state from import_jobs where id = ${importJobId} for update`,
  );
  const row = readRows<{ id: string; state: string }>(result)[0];
  if (!row) return null;
  return { id: row.id, state: row.state };
}

async function countCommittedRows(
  tx: ImportTx,
  importJobId: string,
): Promise<number> {
  const result = await tx.execute<{ count: string }>(
    sql`select count(*)::text as count from import_job_rows where import_job_id = ${importJobId} and validation_status = 'committed'`,
  );
  return Number(readRows<{ count: string }>(result)[0]?.count ?? 0);
}

/**
 * Normalize pglite's `{ rows: T[] }` and postgres-js's bare `T[]`
 * shapes so the caller can read rows the same way under either
 * driver. The runtime check is conservative — only Array.isArray
 * distinguishes a postgres-js RowList (which IS the array) from
 * pglite's wrapper object.
 */
function readRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/**
 * Record state='failed' + a structured `error_summary` in a SEPARATE,
 * fresh transaction. The original commit tx rolled back; this is what
 * makes the failure visible to the UI and to the operator.
 *
 * Best-effort: if this second tx also fails (e.g. the DB is down), we
 * swallow the secondary error so the original cause propagates. The
 * caller still sees {@link ImportJobCommitFailedError}; the operator
 * will see a still-`ready` job, which is the correct conservative
 * fallback (re-running the commit is safe).
 */
async function recordCommitFailure(
  db: ImportDb,
  input: CommitImportJobInput,
  cause: unknown,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await pinTenantTx(tx, input.tenantId);
      const summary = summarizeFailure(cause);
      await tx
        .update(importJobs)
        .set({
          state: "failed",
          errorSummary: summary,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(importJobs.id, input.importJobId),
            // Don't overwrite a state that already moved on; in
            // particular, never write 'failed' over 'committed'.
            ne(importJobs.state, "committed"),
            ne(importJobs.state, "cancelled"),
          ),
        );
    });
  } catch {
    // Intentional: swallow secondary failure, let primary cause win.
  }
}

interface FailureSummary {
  code: string;
  message: string;
  sourceRowNumber?: number;
  targetTable?: string;
}

function summarizeFailure(cause: unknown): FailureSummary {
  if (cause && typeof cause === "object" && "code" in cause) {
    const c = cause as {
      code?: unknown;
      message?: unknown;
      sourceRowNumber?: unknown;
      targetTable?: unknown;
    };
    return {
      code: String(c.code ?? "UNKNOWN"),
      message: String(c.message ?? cause),
      sourceRowNumber:
        typeof c.sourceRowNumber === "number" ? c.sourceRowNumber : undefined,
      targetTable:
        typeof c.targetTable === "string" ? c.targetTable : undefined,
    };
  }
  return {
    code: "UNKNOWN",
    message: (cause as Error)?.message ?? String(cause),
  };
}
