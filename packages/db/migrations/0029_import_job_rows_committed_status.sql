-- 0029_import_job_rows_committed_status.sql
-- PMB-161 / C5 — extend import_job_rows.validation_status with the
-- terminal 'committed' value.
--
-- The C1 schema (migration 0028) closed the validation lifecycle at
-- 'pending' → 'valid' | 'invalid'. The C5 commit pipeline (PMB-161)
-- needs a fourth value so the staging row can announce "this row's
-- live record exists" without a downstream reader having to JOIN on
-- committed_record_id IS NOT NULL.
--
-- The lifecycle now reads: pending → valid → committed, with 'invalid'
-- as a terminal off-ramp. The state flip happens inside the single
-- commit transaction alongside the live INSERT and the
-- committed_record_id write, so the two columns can never disagree.
--
-- Forward-only. Rollback is a follow-up migration that drops 'committed'
-- from the check (and is unsafe once any rows carry the new value, but
-- staging is short-lived per import).

ALTER TABLE import_job_rows
  DROP CONSTRAINT import_job_rows_validation_status_check;

ALTER TABLE import_job_rows
  ADD CONSTRAINT import_job_rows_validation_status_check
    CHECK (validation_status IN ('pending', 'valid', 'invalid', 'committed'));
