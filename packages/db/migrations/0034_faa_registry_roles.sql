-- FAA Registry: pipeline-vs-runtime role separation (PMB-110 AC4).
-- Lives in the FAA Supabase project (FAA_DATABASE_URL), NOT the tenant DB.
--
-- Least-privilege boundary:
--   * faa_registry_pipeline_rw — GH Actions ingest/transform/pg-load job.
--     Full DML on faa_registry.* + USAGE on sequences. No DDL.
--   * faa_registry_runtime_ro — read-only role for the maintenance app's
--     downstream FAA lookups. SELECT only; no DML, no DDL, no sequence USAGE.
--
-- Both roles are NOINHERIT NOLOGIN role *templates* — the actual login users
-- (e.g. the Supabase pooler account that GH Actions connects as) are GRANTed
-- one of these roles and inherit its privileges via SET ROLE / role membership.
-- That lets us rotate the login secret without touching ACLs.
--
-- This migration is forward-only and idempotent:
--   * `do $$ … create role … $$` blocks check pg_roles before creating.
--   * GRANTs are unconditional and safe to re-run.
--   * Future tables added to faa_registry will inherit the privileges via
--     the per-schema default privileges block at the bottom.
--
-- Activation (rotation of the FAA_DATABASE_URL secret to use the new
-- pipeline role) is tracked separately under PMB-110's R2-OIDC follow-up
-- so we can stage the secret swap without breaking today's cron.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'faa_registry_pipeline_rw') then
    create role faa_registry_pipeline_rw noinherit nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'faa_registry_runtime_ro') then
    create role faa_registry_runtime_ro noinherit nologin;
  end if;
end $$;

-- Schema-level visibility (without USAGE the role cannot resolve any object).
grant usage on schema faa_registry to faa_registry_pipeline_rw, faa_registry_runtime_ro;

-- Pipeline: full DML on every table in the schema, USAGE on sequences for
-- bigserial PKs (pipeline_runs.id, aircraft_registry_history.id, etc.).
grant select, insert, update, delete on all tables in schema faa_registry
  to faa_registry_pipeline_rw;
grant usage, select on all sequences in schema faa_registry
  to faa_registry_pipeline_rw;

-- Runtime: read-only on tables. No sequence USAGE — runtime never inserts.
grant select on all tables in schema faa_registry to faa_registry_runtime_ro;

-- Future-proof: any new table added to faa_registry by a future migration
-- (running as the schema owner) inherits the same grants automatically.
-- This is the standard postgres "default privileges" pattern.
alter default privileges in schema faa_registry
  grant select, insert, update, delete on tables to faa_registry_pipeline_rw;
alter default privileges in schema faa_registry
  grant usage, select on sequences to faa_registry_pipeline_rw;
alter default privileges in schema faa_registry
  grant select on tables to faa_registry_runtime_ro;
