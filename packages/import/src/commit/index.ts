import { commitImportJob, type CommitImportJobInput } from "./commit-import-job.js";
import { commitManualRow } from "./commit-manual-row.js";
import type {
  CommitManualRowInput,
  CommitResult,
  ImportDb,
  ManualRowResult,
} from "./types.js";

export {
  ImportJobCommitFailedError,
  ImportJobHasInvalidRowsError,
  ImportJobNotCommitableError,
  ManualRowValidationError,
} from "./types.js";
export { RowInsertError } from "./inserters.js";
export type {
  CommitImportJobInput,
  CommitManualRowInput,
  CommitResult,
  ImportDb,
  ManualRowResult,
};

/**
 * Stateful façade for the C5 commit pipeline (PMB-161).
 *
 *   * `commitImportJob` — the spreadsheet path. Single-tx commit of
 *     every staged row, all-or-nothing, idempotent on retry of an
 *     already-committed job.
 *   * `commitManualRow` — the reuse path. Wraps a single
 *     operator-supplied row in a one-row import job and runs the same
 *     validator + inserter so manual entries inherit the same audit
 *     trail (source_import_row_id traceability, signed-off shape,
 *     state machine evidence).
 *
 * The service is constructed with a Drizzle database handle and
 * remains stateless beyond that handle — tests instantiate one per
 * test file; production code can instantiate at module load.
 */
export class IngestionService {
  constructor(private readonly db: ImportDb) {}

  commitImportJob(input: CommitImportJobInput): Promise<CommitResult> {
    return commitImportJob(this.db, input);
  }

  commitManualRow(input: CommitManualRowInput): Promise<ManualRowResult> {
    return commitManualRow(this.db, input);
  }
}

export { commitImportJob, commitManualRow };
