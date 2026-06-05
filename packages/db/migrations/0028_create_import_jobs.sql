-- 0028_create_import_jobs.sql
-- PMB-157 / C1 — V1 spreadsheet/paper importer staging schema (parent PMB-95).
-- Source: PMB-95 design summary; spec Rev. 3 §3.1 (data integrity), §6 G2/J4
-- (generic naming + per-record retention).
--
-- Two new tables stage an operator-supplied import end-to-end before the
-- commit pipeline (C2–C6) writes live rows:
--
--   * import_jobs       — the job header. One row per upload attempt.
--                         Tenant-scoped, FORCE RLS. Drives a small state
--                         machine: pending → validating → ready →
--                         committing → committed | failed | cancelled.
--                         Append-only at the data layer — no DELETE grant
--                         to tenant_app. Cancellation is a state flip, not
--                         a row removal, so the source spreadsheet remains
--                         auditable forever.
--
--   * import_job_rows   — one row per source spreadsheet row. The raw
--                         payload (source_payload) is the verbatim cells
--                         as parsed; mapped_payload is the post-mapping
--                         shape; validation_status / validation_errors
--                         track per-row validation. source_row_number is
--                         1-indexed and unique within a job so error
--                         messages can quote "row 17" the way an operator
--                         would say it. Also append-only.
--
-- Row-level traceability hook — every live table the importer can write
-- gains a nullable `source_import_row_id` column. The column is NULL for
-- every row the operator (or the front door) created interactively; it
-- carries the originating import_job_rows.id only when the importer
-- created the row. ON DELETE SET NULL so that a future
-- import_jobs/import_job_rows housekeeping (e.g. a privacy-driven hard
-- delete of the staging tables for a tenant offboarding) cannot orphan
-- the live records that survived the import. The live row stays; the
-- breadcrumb to its origin disappears.
--
-- The four target tables for V1 are aircraft, maintenance_entries,
-- components, flight_time_entries. Squawks and notifications are not in
-- scope per the parent plan (PMB-95) — those are operational entities,
-- not historical records to be backfilled from paper logs.
--
-- documents.document_type catalog extension. The "catalog" lives in
-- regime_retention_rules (J4 seam — per-regime retention horizon, NOT a
-- code constant). We seed an `import_source` record_kind for the FAA
-- regime with `lifetime` retention: the operator-supplied source file
-- backstops every record it produced, and 14 CFR §91.417(b)(2) requires
-- those records for the life of the aircraft. Adding a future regime
-- (EASA, ICAO operator) is a follow-on INSERT against the same record_kind.

-- ---------------------------------------------------------------------------
-- import_jobs
-- ---------------------------------------------------------------------------

CREATE TABLE import_jobs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Optional. NULL when the importer creates the aircraft itself
  -- (C2 spreadsheet shape `aircraft.csv`); set when an import targets
  -- entries against a pre-existing aircraft (maintenance, flight time,
  -- components).
  aircraft_id           uuid REFERENCES aircraft(id) ON DELETE CASCADE,
  -- State machine. The CHECK is the authoritative list; the service
  -- layer mirrors it in TypeScript via an `as const` literal.
  state                 text NOT NULL DEFAULT 'pending',
  -- Coarse kind hint for the UI/listing surface. The per-row
  -- target_table on import_job_rows carries the authoritative
  -- destination; this is purely descriptive ("Aircraft + history" vs
  -- "Maintenance entries").
  import_kind           text NOT NULL,
  -- The operator-uploaded file lives in the J2.1 documents store with
  -- document_type='import_source'. Held by RESTRICT so the staging
  -- chain stays intact: you cannot drop the source file out from under
  -- a job that still references it.
  source_document_id    uuid REFERENCES documents(id) ON DELETE RESTRICT,
  source_filename       text NOT NULL,
  row_count             integer NOT NULL DEFAULT 0,
  -- On state='failed' this carries a small summary the UI can render
  -- without rescanning the row table (e.g. { code, message, row_count_invalid }).
  error_summary         jsonb,
  created_by_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Set when state flips to 'committed'. The two columns move together;
  -- the CHECK below keeps a partial commit from looking like a complete one.
  committed_at          timestamptz,
  committed_by_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_jobs_state_check
    CHECK (state IN (
      'pending',
      'validating',
      'ready',
      'committing',
      'committed',
      'failed',
      'cancelled'
    )),
  CONSTRAINT import_jobs_import_kind_nonempty
    CHECK (length(trim(import_kind)) > 0),
  CONSTRAINT import_jobs_source_filename_nonempty
    CHECK (length(trim(source_filename)) > 0),
  CONSTRAINT import_jobs_row_count_nonneg
    CHECK (row_count >= 0),
  CONSTRAINT import_jobs_committed_consistency
    CHECK (
      (committed_at IS NULL AND committed_by_user_id IS NULL)
      OR (committed_at IS NOT NULL AND committed_by_user_id IS NOT NULL)
    )
);

-- Newest-first listing per tenant (the importer index page).
CREATE INDEX import_jobs_tenant_created_idx
  ON import_jobs (tenant_id, created_at DESC);
-- Open-jobs sweep per tenant (e.g. "any imports still pending validation?").
CREATE INDEX import_jobs_tenant_state_idx
  ON import_jobs (tenant_id, state);
-- Reverse-lookup from an aircraft to its historic imports.
CREATE INDEX import_jobs_aircraft_idx
  ON import_jobs (tenant_id, aircraft_id)
  WHERE aircraft_id IS NOT NULL;

ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON import_jobs
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

-- Append-only at the grant layer: SELECT/INSERT/UPDATE only.
-- No DELETE — cancellation is a state flip ('cancelled'), not a row removal,
-- and the source file + staged rows stay readable for the audit horizon.
GRANT SELECT, INSERT, UPDATE ON import_jobs TO tenant_app;

-- ---------------------------------------------------------------------------
-- import_job_rows
-- ---------------------------------------------------------------------------

CREATE TABLE import_job_rows (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  import_job_id         uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  -- 1-indexed to match the row numbers a spreadsheet operator sees in
  -- Excel / Google Sheets. UNIQUE per (job, source_row_number) so error
  -- messages and re-validation can address rows by their natural id.
  source_row_number     integer NOT NULL,
  -- Verbatim cells as parsed from the upload (column-name → string).
  -- Preserved untouched for audit and for re-validation if mapping
  -- rules change.
  source_payload        jsonb NOT NULL,
  -- Post-mapping shape, structured against the target table's columns.
  -- NULL while the row is still in 'pending' validation.
  mapped_payload        jsonb,
  validation_status     text NOT NULL DEFAULT 'pending',
  -- On validation_status='invalid' carries an array of
  -- { field, message, code? } so the UI can highlight cells.
  validation_errors     jsonb,
  -- Which live table this row maps to. Authoritative; the parent job's
  -- import_kind is just a UI hint.
  target_table          text,
  -- The id of the live row this staged row materialized into on commit.
  -- NULL until state='committed' and the commit tx wrote the live row.
  committed_record_id   uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_job_rows_source_row_number_one_indexed
    CHECK (source_row_number >= 1),
  CONSTRAINT import_job_rows_validation_status_check
    CHECK (validation_status IN ('pending', 'valid', 'invalid')),
  -- Closed vocabulary: matches the four V1 target tables. Future
  -- importer targets land here in a follow-on migration.
  CONSTRAINT import_job_rows_target_table_check
    CHECK (
      target_table IS NULL
      OR target_table IN (
        'aircraft',
        'maintenance_entries',
        'components',
        'flight_time_entries'
      )
    )
);

CREATE UNIQUE INDEX import_job_rows_job_row_unique
  ON import_job_rows (import_job_id, source_row_number);
-- Tenant sweep (e.g. tenant truncation in tests; tenant offboarding).
CREATE INDEX import_job_rows_tenant_idx
  ON import_job_rows (tenant_id);
-- Reverse-lookup from a live record back to its source row. Sparse: only
-- rows that have committed carry a record id.
CREATE INDEX import_job_rows_committed_record_idx
  ON import_job_rows (tenant_id, target_table, committed_record_id)
  WHERE committed_record_id IS NOT NULL;

ALTER TABLE import_job_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_job_rows FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON import_job_rows
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

-- Append-only at the grant layer. Same rationale as import_jobs.
GRANT SELECT, INSERT, UPDATE ON import_job_rows TO tenant_app;

-- ---------------------------------------------------------------------------
-- Row-level traceability hook on the four live tables.
--
-- Nullable. NULL for every interactive (front-door) row and for every
-- row that pre-dates the importer. Set ONLY by the C5 commit pipeline
-- on rows it inserts. ON DELETE SET NULL keeps the live row alive if
-- the staging row ever gets purged.
-- ---------------------------------------------------------------------------

ALTER TABLE aircraft
  ADD COLUMN source_import_row_id uuid
    REFERENCES import_job_rows(id) ON DELETE SET NULL;

ALTER TABLE maintenance_entries
  ADD COLUMN source_import_row_id uuid
    REFERENCES import_job_rows(id) ON DELETE SET NULL;

ALTER TABLE components
  ADD COLUMN source_import_row_id uuid
    REFERENCES import_job_rows(id) ON DELETE SET NULL;

ALTER TABLE flight_time_entries
  ADD COLUMN source_import_row_id uuid
    REFERENCES import_job_rows(id) ON DELETE SET NULL;

-- Reverse-lookup indexes from a staged row → the live row(s) it produced.
-- Partial: live (interactive) rows leave the column NULL.
CREATE INDEX aircraft_source_import_row_idx
  ON aircraft (source_import_row_id)
  WHERE source_import_row_id IS NOT NULL;
CREATE INDEX maintenance_entries_source_import_row_idx
  ON maintenance_entries (source_import_row_id)
  WHERE source_import_row_id IS NOT NULL;
CREATE INDEX components_source_import_row_idx
  ON components (source_import_row_id)
  WHERE source_import_row_id IS NOT NULL;
CREATE INDEX flight_time_entries_source_import_row_idx
  ON flight_time_entries (source_import_row_id)
  WHERE source_import_row_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- documents.document_type catalog extension (G2/J4 seam).
--
-- The "catalog" of document types is the regime_retention_rules table —
-- each (regime, record_kind) row says how long that kind must be
-- retained. Code reads the row by `record_kind` and never hardcodes a
-- retention literal. Extending the catalog therefore = inserting a new
-- record_kind row per regime.
--
-- FAA: `import_source` retains for `lifetime`. Per 14 CFR §91.417(b)(2)
-- the operator-supplied source file backstops every record it produced
-- (maintenance log, annual sign-off, AD compliance), and those records
-- are themselves required for the life of the aircraft. The source must
-- outlive the records it underwrites, so `lifetime` is the conservative
-- choice. ON CONFLICT for idempotency.
-- ---------------------------------------------------------------------------

INSERT INTO regime_retention_rules
  (regime_id, record_kind, retention_period_kind, retention_period_value, description)
SELECT id, 'import_source', 'lifetime', NULL,
       '14 CFR §91.417(b)(2): operator-supplied source spreadsheet/log retained for the life of the aircraft, because every record it produced is itself retained for life.'
  FROM regimes WHERE code = 'FAA'
ON CONFLICT (regime_id, record_kind) DO NOTHING;
