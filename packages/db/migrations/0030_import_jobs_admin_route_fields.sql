-- 0030_import_jobs_admin_route_fields.sql
-- PMB-162 / C6 — extend import_jobs with the three fields the admin
-- routes (upload → parse → commit → status) need to thread durable
-- state across the job lifecycle.
--
-- Why these three live on the job header (not on rows, not free-text):
--
--   regime_id      — the C5 commit pipeline (commitImportJob) takes a
--                    regime id as input. The admin upload route
--                    resolves it from the operator's tenant (default
--                    regime) and stamps it on the job so parse + commit
--                    are deterministic without re-reading the tenant.
--   target_table   — closed vocabulary of the four V1 entities. Stamped
--                    at upload time so the parse step knows which C4
--                    validator to dispatch and the status route can
--                    present a per-entity error envelope. Matches the
--                    same vocabulary as import_job_rows.target_table.
--   mapping_config — operator-supplied JSON config that the C3 mapping
--                    engine consumes. Stored on the header so a failed
--                    parse can be retried without re-supplying the
--                    config, and so the operator UI (PMB-163) has a
--                    consistent source of truth.
--
-- All three are nullable for backward compatibility with rows the
-- earlier tests / commit-pipeline fixtures inserted directly (they
-- seed rows pre-validated and skip the parse step).
--
-- Forward-only. Rollback drops the columns; rows that never carried
-- these values are unaffected.

ALTER TABLE import_jobs
  ADD COLUMN regime_id      uuid REFERENCES regimes(id) ON DELETE RESTRICT,
  ADD COLUMN target_table   text,
  ADD COLUMN mapping_config jsonb;

-- Mirror the vocabulary CHECK that import_job_rows.target_table carries
-- (migration 0028) so a misformed admin upload can never stamp an
-- unsupported entity here.
ALTER TABLE import_jobs
  ADD CONSTRAINT import_jobs_target_table_check
    CHECK (
      target_table IS NULL
      OR target_table IN (
        'aircraft',
        'maintenance_entries',
        'components',
        'flight_time_entries'
      )
    );

-- Lookup by tenant + target_table is useful for the admin status grid
-- (list jobs per entity). Sparse — only set after admin uploads.
CREATE INDEX import_jobs_tenant_target_idx
  ON import_jobs (tenant_id, target_table)
  WHERE target_table IS NOT NULL;
