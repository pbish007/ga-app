-- 0036_faa_public_schema_rls.sql
-- @scope: faa-supabase
-- PMB-232 — close the FAA Supabase `rls_disabled_in_public` advisor finding.
--
-- Target: FAA Supabase project `idjhuqubjgjloywsfgtu`.
-- Applied via faa-db-migrate.yml, not the tenant Neon migrator.
--
-- Inventory (run 27222049102 of faa-public-schema-inventory.yml):
--   - 1 partitioned table  public.kv
--   - 100 child partitions public.kv_0 … public.kv_99
--   - 1 view               public.kv_v
--   These are all owned by `postgres` and were created on first boot of the
--   lakeFS OSS deployment (PMB-139) — lakeFS's Postgres KV driver uses
--   `public.kv` by default. Migration 0026_lakefs_metadata_schema created the
--   `lakefs` schema for future use but lakeFS still wrote its KV partitions
--   to `public`.
--
--   Supabase's Security Advisor flagged every one of those 102 relations
--   because Supabase auto-exposes `public` via PostgREST under the anon key.
--   The current state per inventory:
--     - rowsecurity = false on every relation
--     - 0 RLS policies in public.*
--     - 1428 explicit grants (SELECT/INSERT/UPDATE/DELETE/REFERENCES/TRIGGER
--       /TRUNCATE) on every `kv*` relation to both `anon` and `authenticated`
--     - 0 USAGE grants to anon/authenticated on the public *schema*
--
--   So in practice anon can't reach these tables today (no schema USAGE), but
--   the table-level grants + RLS-off mean any future schema-USAGE grant would
--   immediately expose the entire lakeFS KV store. Defense-in-depth lockdown.
--
-- Strategy:
--   For every relation in `public` (tables + partitions + views + matviews):
--     1. ENABLE ROW LEVEL SECURITY (no-op on views/matviews; ALTER TABLE
--        IF EXISTS skips them gracefully via the kind check).
--     2. Add NO policies → deny-by-default for non-owner roles. lakeFS
--        connects as `postgres` (superuser) per the lakefs-faa-deploy.yml
--        derivation of LAKEFS_DATABASE_POSTGRES_CONNECTION_STRING from
--        FAA_DATABASE_URL, and superusers bypass RLS unconditionally — so
--        the live lakeFS service is unaffected.
--     3. REVOKE ALL ... FROM anon, authenticated, public on every relation
--        (table + view) — strips the 1428 implicit Supabase grants.
--   At the schema level:
--     4. REVOKE USAGE ON SCHEMA public FROM anon, authenticated — keeps the
--        current effective state explicit so a future GRANT can't silently
--        re-open access.
--
-- Idempotency: dynamic SQL with IF EXISTS-equivalent checks; REVOKE on
-- already-revoked privileges is a no-op. Safe to re-run via faa-db-migrate.

do $mig$
declare
  r record;
begin
  -- 1+2: Enable RLS on every table-like relation in public.
  -- (relkind: r = table, p = partitioned table)
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r','p')
  loop
    execute format('alter table public.%I enable row level security', r.relname);
  end loop;

  -- 3: Revoke all table-level privileges on every relation in public.
  -- (relkind: r = table, p = partitioned table, v = view, m = matview, f = foreign)
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r','p','v','m','f')
  loop
    execute format(
      'revoke all on table public.%I from anon, authenticated, public',
      r.relname
    );
  end loop;
end
$mig$;

-- 4: Schema-level USAGE lockdown. Inventory shows no current USAGE grant
-- to anon/authenticated, so this is making the current state explicit and
-- repeatable. The `postgres` superuser retains USAGE implicitly.
revoke usage on schema public from anon, authenticated;

-- Belt-and-suspenders for any future relation created in public: revoke the
-- default privileges that Supabase auto-grants on new objects. These DEFAULT
-- PRIVILEGES are scoped to the role that creates objects in `public`. lakeFS
-- runs as `postgres`, so we scope to that role. Idempotent.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, public;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, public;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, public;
