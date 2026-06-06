import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { organizations, users } from "./accounts.js";
import { aircraft } from "./aircraft.js";
import { documents } from "./documents.js";

/**
 * The closed state machine an import job traverses (PMB-157 / parent
 * PMB-95). The DB CHECK constraint is the authoritative list; this
 * `as const` literal is the application mirror — the two MUST stay in
 * sync, and the schema test (`import-jobs-schema.test.ts`) asserts that.
 *
 *   pending     — header row inserted; the upload may still be streaming.
 *   validating  — the parse + map + per-row validator is running.
 *   ready       — every row validated; the operator may commit.
 *   committing  — the C5 commit pipeline is writing live rows.
 *   committed   — terminal success; committed_at + committed_by set.
 *   failed      — terminal failure; error_summary populated.
 *   cancelled   — terminal user-initiated stop; rows preserved.
 */
export const IMPORT_JOB_STATES = [
  "pending",
  "validating",
  "ready",
  "committing",
  "committed",
  "failed",
  "cancelled",
] as const;
export type ImportJobState = (typeof IMPORT_JOB_STATES)[number];

/**
 * Tables the V1 importer is allowed to write live rows into. The CHECK
 * constraint on `import_job_rows.target_table` mirrors this list.
 */
export const IMPORT_JOB_TARGET_TABLES = [
  "aircraft",
  "maintenance_entries",
  "components",
  "flight_time_entries",
] as const;
export type ImportJobTargetTable = (typeof IMPORT_JOB_TARGET_TABLES)[number];

/**
 * Per-row validation status. Drives the importer UI (per-cell error
 * highlighting) and the commit gate (only 'valid' rows commit). The
 * C5 commit pipeline (PMB-161) flips a row from 'valid' to 'committed'
 * inside the single commit transaction alongside the live INSERT and
 * the `committed_record_id` write.
 */
export const IMPORT_JOB_ROW_VALIDATION_STATUSES = [
  "pending",
  "valid",
  "invalid",
  "committed",
] as const;
export type ImportJobRowValidationStatus =
  (typeof IMPORT_JOB_ROW_VALIDATION_STATUSES)[number];

export const importJobs = pgTable(
  "import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    aircraftId: uuid("aircraft_id").references(
      (): AnyPgColumn => aircraft.id,
      { onDelete: "cascade" },
    ),
    state: text("state").$type<ImportJobState>().notNull().default("pending"),
    importKind: text("import_kind").notNull(),
    sourceDocumentId: uuid("source_document_id").references(() => documents.id, {
      onDelete: "restrict",
    }),
    sourceFilename: text("source_filename").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    errorSummary: jsonb("error_summary"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    committedByUserId: uuid("committed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantCreatedIdx: index("import_jobs_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
    tenantStateIdx: index("import_jobs_tenant_state_idx").on(
      t.tenantId,
      t.state,
    ),
    aircraftIdx: index("import_jobs_aircraft_idx")
      .on(t.tenantId, t.aircraftId)
      .where(sql`${t.aircraftId} is not null`),
    stateCheck: check(
      "import_jobs_state_check",
      sql`${t.state} in ('pending', 'validating', 'ready', 'committing', 'committed', 'failed', 'cancelled')`,
    ),
    importKindNonempty: check(
      "import_jobs_import_kind_nonempty",
      sql`length(trim(${t.importKind})) > 0`,
    ),
    sourceFilenameNonempty: check(
      "import_jobs_source_filename_nonempty",
      sql`length(trim(${t.sourceFilename})) > 0`,
    ),
    rowCountNonneg: check(
      "import_jobs_row_count_nonneg",
      sql`${t.rowCount} >= 0`,
    ),
    committedConsistency: check(
      "import_jobs_committed_consistency",
      sql`(${t.committedAt} is null and ${t.committedByUserId} is null)
          or (${t.committedAt} is not null and ${t.committedByUserId} is not null)`,
    ),
  }),
);

export const importJobRows = pgTable(
  "import_job_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    importJobId: uuid("import_job_id")
      .notNull()
      .references(() => importJobs.id, { onDelete: "cascade" }),
    sourceRowNumber: integer("source_row_number").notNull(),
    sourcePayload: jsonb("source_payload").notNull(),
    mappedPayload: jsonb("mapped_payload"),
    validationStatus: text("validation_status")
      .$type<ImportJobRowValidationStatus>()
      .notNull()
      .default("pending"),
    validationErrors: jsonb("validation_errors"),
    targetTable: text("target_table").$type<ImportJobTargetTable>(),
    committedRecordId: uuid("committed_record_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    jobRowUnique: uniqueIndex("import_job_rows_job_row_unique").on(
      t.importJobId,
      t.sourceRowNumber,
    ),
    tenantIdx: index("import_job_rows_tenant_idx").on(t.tenantId),
    committedRecordIdx: index("import_job_rows_committed_record_idx")
      .on(t.tenantId, t.targetTable, t.committedRecordId)
      .where(sql`${t.committedRecordId} is not null`),
    sourceRowNumberOneIndexed: check(
      "import_job_rows_source_row_number_one_indexed",
      sql`${t.sourceRowNumber} >= 1`,
    ),
    validationStatusCheck: check(
      "import_job_rows_validation_status_check",
      sql`${t.validationStatus} in ('pending', 'valid', 'invalid', 'committed')`,
    ),
    targetTableCheck: check(
      "import_job_rows_target_table_check",
      sql`${t.targetTable} is null
          or ${t.targetTable} in ('aircraft', 'maintenance_entries', 'components', 'flight_time_entries')`,
    ),
  }),
);

export type ImportJob = typeof importJobs.$inferSelect;
export type NewImportJob = typeof importJobs.$inferInsert;
export type ImportJobRow = typeof importJobRows.$inferSelect;
export type NewImportJobRow = typeof importJobRows.$inferInsert;
