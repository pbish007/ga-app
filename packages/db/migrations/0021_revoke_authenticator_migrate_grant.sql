-- 0021_revoke_authenticator_migrate_grant.sql
-- PMB-72 — retire the authenticator grant from 0017.
--
-- Background: 0017_grant_migrate_role.sql granted the Neon `authenticator` role
-- CREATE on schema public + SELECT, INSERT on schema_migrations so the
-- `DB migrate (production)` GH Actions workflow (which authenticated via the
-- DATABASE_URL_DIRECT secret as `authenticator`) could create
-- schema_migrations and the tables of new migrations.
--
-- The durable fix per PMB-72 was to point the DATABASE_URL_DIRECT GH secret at
-- `neondb_owner` (the role the runtime already uses, which OWNS every table
-- including schema_migrations). The board completed the rotation 2026-06-03
-- and a no-op db-migrate dispatch confirmed the new secret authenticates and
-- can read the ledger. This migration revokes the 0017 grants now that
-- `authenticator` is no longer the CI migrator role.
--
-- USAGE on schema public was already held by `authenticator` BEFORE 0017
-- (Neon platform default); 0017's GRANT USAGE was a no-op. We do NOT revoke
-- USAGE here — only the privileges 0017 added.
--
-- Same `pg_roles` guard as 0017 so the pglite test harness (which has no
-- `authenticator` role) keeps skipping cleanly. Idempotent: revoking a
-- privilege not currently held is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticator') THEN
    REVOKE CREATE ON SCHEMA public FROM authenticator;
    REVOKE SELECT, INSERT ON schema_migrations FROM authenticator;
  END IF;
END
$$;
