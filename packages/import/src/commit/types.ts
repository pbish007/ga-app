import type { PgliteDatabase } from "drizzle-orm/pglite";

import { schema as dbSchema } from "@ga/db";

import type { TargetEntity } from "../validators/types.js";

type Schema = typeof dbSchema;

/**
 * Drizzle database handle the C5 commit pipeline operates against.
 * Typed against pglite for static checks; the runtime shape is
 * identical across drivers (postgres-js callers pass through the same
 * Drizzle `PgDatabase` interface), so production-side wiring at the
 * web layer can cast at the boundary.
 *
 * The portability concession is deliberate: drizzle-orm 0.36 surfaces
 * a slightly different generic shape per driver and cross-driver
 * unions degrade the typed builder. Pglite is the package's only test
 * driver, so we keep static types narrow here and rely on the web
 * package's `DocumentsDb` boundary for the production cast.
 */
export type ImportDb = PgliteDatabase<Schema>;

/**
 * The transaction handle the inserters operate against. Inherits
 * the typed builder from the parent {@link ImportDb}.
 */
export type ImportTx = Parameters<Parameters<ImportDb["transaction"]>[0]>[0];

/**
 * Successful commit result for an import job. Returned by
 * {@link IngestionService.commitImportJob} and by
 * {@link IngestionService.commitManualRow} (single-row variant).
 *
 * `alreadyCommitted` is true when the job was found in state
 * 'committed' at the start of the call — the idempotent no-op path,
 * required by PMB-161 acceptance.
 */
export interface CommitResult {
  importJobId: string;
  state: "committed";
  rowsCommitted: number;
  alreadyCommitted: boolean;
}

/**
 * Result of the manual-row reuse path. The `recordId` is the live
 * row's id (e.g. the new aircraft/maintenance_entry/component/flight_time_entry).
 */
export interface ManualRowResult extends CommitResult {
  recordId: string;
}

/**
 * Thrown when the caller asks to commit a job that is not in a
 * commitable state.
 *
 * The C5 commit gate is `state === 'ready'`. Jobs in any other state
 * (still validating, already failed, cancelled) cannot enter the
 * commit transaction — the safe path is to surface a clear error to
 * the caller and leave the job untouched. Already-committed jobs are
 * handled by the idempotent no-op return, not by this error.
 */
export class ImportJobNotCommitableError extends Error {
  readonly code = "IMPORT_JOB_NOT_COMMITABLE" as const;
  constructor(
    readonly importJobId: string,
    readonly state: string,
  ) {
    super(`import job ${importJobId} is not commitable in state '${state}'`);
    this.name = "ImportJobNotCommitableError";
  }
}

/**
 * Thrown when one or more rows in a `ready` job carry a non-`valid`
 * validation_status at commit time. The commit gate is per-batch:
 * either every row is valid, or no row commits. We catch this before
 * the inserters run so the rollback path is cheap and the failure
 * message is specific.
 */
export class ImportJobHasInvalidRowsError extends Error {
  readonly code = "IMPORT_JOB_HAS_INVALID_ROWS" as const;
  constructor(
    readonly importJobId: string,
    readonly invalidCount: number,
  ) {
    super(
      `import job ${importJobId} cannot commit: ${invalidCount} row(s) are not valid`,
    );
    this.name = "ImportJobHasInvalidRowsError";
  }
}

/**
 * Thrown when a commit attempt fails mid-tx. The single-tx design
 * guarantees no live rows were written; the surrounding code records
 * `state='failed'` + `error_summary` in a separate, second transaction
 * after the rollback, then re-throws this so the caller can surface
 * the original cause.
 */
export class ImportJobCommitFailedError extends Error {
  readonly code = "IMPORT_JOB_COMMIT_FAILED" as const;
  constructor(
    readonly importJobId: string,
    readonly cause: unknown,
  ) {
    super(
      `import job ${importJobId} commit failed: ${(cause as Error)?.message ?? cause}`,
    );
    this.name = "ImportJobCommitFailedError";
  }
}

/**
 * Thrown by the manual-row reuse path when the supplied row fails the
 * same C4 validator the spreadsheet path uses. The caller gets the
 * validator's full error list so the UI can surface per-field problems.
 */
export class ManualRowValidationError extends Error {
  readonly code = "MANUAL_ROW_INVALID" as const;
  constructor(readonly errors: readonly {
    rowNumber: number;
    code: string;
    message: string;
    field?: string;
  }[]) {
    super(
      `manual row failed validation: ${errors.length} error(s) — ${errors
        .slice(0, 3)
        .map((e) => `${e.field ?? "row"}: ${e.message}`)
        .join("; ")}`,
    );
    this.name = "ManualRowValidationError";
  }
}

/**
 * Tagged input for {@link IngestionService.commitManualRow}. The
 * `entity` selects the validator + target table; `mapped` is the
 * already-mapped payload (identity from the operator-facing shape;
 * the caller's job to assemble).
 */
export interface CommitManualRowInput {
  tenantId: string;
  userId: string;
  /** The regime that supplies catalog (rts templates, registration grammar). */
  regimeId: string;
  regimeCode: string;
  entity: TargetEntity;
  /**
   * Pre-mapped payload to commit. Use the same field names the C3
   * mapping engine emits (see `target-fields.ts`).
   */
  mapped: Record<string, unknown>;
  /**
   * Optional source document id for digitized paper. NULL when the
   * paper-entry path has no scanned PDF behind it. The caller is
   * responsible for ensuring the document is the right kind
   * (document_type='import_source').
   */
  sourceDocumentId?: string | null;
  /**
   * Optional caller-supplied label that surfaces in the
   * import_jobs.source_filename column. Defaults to
   * `manual_entry:{entity}`.
   */
  label?: string;
}
