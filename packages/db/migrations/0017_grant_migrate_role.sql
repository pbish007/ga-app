-- 0017_grant_migrate_role.sql
-- PMB-70 — make the CI migrate path usable.
--
-- The `DB migrate (production)` GitHub Actions workflow connects with the
-- DATABASE_URL_DIRECT repo secret, which (per PMB-70 diagnosis) authenticates
-- as the Neon role `authenticator`. That role has USAGE but NOT CREATE on
-- schema `public`, owns nothing, and cannot read `schema_migrations`, so
-- migrate.sh fails at `CREATE TABLE IF NOT EXISTS schema_migrations` with
-- `ERROR 42501: permission denied for schema public`.
--
-- The runtime path (Vercel DATABASE_URL_DIRECT) connects as `neondb_owner`,
-- which owns every table (incl. schema_migrations) and holds CREATE on public
-- via membership in pg_database_owner. This migration is applied via that
-- privileged runtime connection (current_user = neondb_owner) and grants the
-- CI `authenticator` role exactly the privileges migrate.sh needs.
--
-- Same class of grant gap as 0016_grant_tenant_app_membership.sql.
-- Idempotent: re-granting an already-held privilege is a no-op.
--
-- Scope note: this grants table CREATE (enough to create schema_migrations and
-- the tables of new migrations) but NOT ownership of existing neondb_owner
-- tables, so a future migration that ALTERs an existing table would still need
-- to run as the owner. The durable fix for that is to point the
-- DATABASE_URL_DIRECT GitHub secret at `neondb_owner` (the role the runtime
-- already uses); see PMB-70 for the follow-up.

-- Lets authenticator run `CREATE TABLE IF NOT EXISTS schema_migrations` (the
-- CREATE acl is checked even when the table already exists) and create the
-- tables of future migrations. USAGE is already held; re-granting is a no-op.
GRANT USAGE, CREATE ON SCHEMA public TO authenticator;

-- Lets authenticator read the applied-ledger (to skip already-applied files)
-- and record newly applied files. schema_migrations is owned by neondb_owner,
-- so the connecting owner role can grant these.
GRANT SELECT, INSERT ON schema_migrations TO authenticator;
