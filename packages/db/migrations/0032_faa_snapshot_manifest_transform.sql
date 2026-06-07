-- FAA Registry: extend snapshot_manifest with transform-pipeline bookkeeping
-- (PMB-203 R2). Lives in the FAA Supabase project (FAA_DATABASE_URL).
--
-- Idempotent: `add column if not exists` so re-runs against an already-
-- migrated DB are safe.
--
-- - bronze_written_at / gold_written_at / pg_loaded_at: stage timestamps,
--   set by the transform pipeline at the end of each stage. NULL => stage
--   not run yet for this snapshot_date.
-- - master_accepted / master_rejected: row counts emitted by bronze.ts,
--   for reconciliation against the raw MASTER record count.
-- - aircraft_history_inserts / aircraft_current_upserts: row counts
--   emitted by pg-load.ts after the SCD-2 transaction commits.

alter table faa_registry.snapshot_manifest
  add column if not exists bronze_written_at        timestamptz,
  add column if not exists gold_written_at          timestamptz,
  add column if not exists pg_loaded_at             timestamptz,
  add column if not exists master_accepted          integer,
  add column if not exists master_rejected          integer,
  add column if not exists aircraft_history_inserts integer,
  add column if not exists aircraft_current_upserts integer;
