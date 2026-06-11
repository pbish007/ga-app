-- 0026: lakeFS OSS metadata schema on the FAA Supabase project.
-- @scope: faa-supabase
--
-- Creates an empty `lakefs` schema. lakeFS will own everything inside it and
-- auto-create its tables on first boot. Kept idempotent so re-running via
-- faa-db-migrate.yml is safe.
--
-- Related: PMB-139 (deploy opensource lakeFS).

create schema if not exists lakefs;
