-- 0016_grant_tenant_app_membership.sql
-- Epic A / PMB-61 — make the tenant RLS path usable at runtime.
--
-- Migrations 0002–0015 created the `tenant_app` role and granted table
-- privileges TO it, but never granted membership in `tenant_app` back to
-- the application's connection role. Postgres requires the connecting
-- role to be a MEMBER of `tenant_app` before it may `SET ROLE tenant_app`.
--
-- Without this grant, every tenant-scoped request fails at
-- `runAsTenantOnProductionDb` (`set local role tenant_app`) with:
--   ERROR 42501: permission denied to set role "tenant_app"
-- which 500s the aircraft / compliance / squawk / maintenance pages even
-- for an authenticated, authorized member. (Identity reads — login,
-- /orgs, membership lookup — bypass RLS on the connection role and so
-- worked; only the role-switch path was broken.)
--
-- `current_user` is the application/migration role (the same role the
-- runtime connects as via DATABASE_URL). It created `tenant_app`, so it
-- holds ADMIN OPTION on that role and may grant membership to itself.
-- Idempotent: re-granting an existing membership is a no-op.

GRANT tenant_app TO current_user;

-- The regime catalog is global, read-only reference data. Tenant-scoped
-- code paths run as `tenant_app` and must read it: aircraft creation
-- resolves the default regime (regimes); the compliance engine reads
-- inspection programs + intervals; sign-off reads credential types and
-- return-to-service templates. Migration 0001 created these tables but
-- never granted `tenant_app` SELECT, so those paths failed with
--   ERROR 42501: permission denied for table regime_*
-- once the role switch (above) started working. Read-only by design —
-- the app never writes the regime catalog at runtime.
GRANT SELECT ON regimes                              TO tenant_app;
GRANT SELECT ON regime_inspection_program_templates  TO tenant_app;
GRANT SELECT ON regime_inspection_program_intervals  TO tenant_app;
GRANT SELECT ON regime_credential_types              TO tenant_app;
GRANT SELECT ON regime_rts_templates                 TO tenant_app;
GRANT SELECT ON regime_directive_sources             TO tenant_app;
GRANT SELECT ON regime_retention_rules               TO tenant_app;

-- The sign-off flow verifies the signing user exists (a belt-and-braces
-- check on top of the FK) by selecting users.id as `tenant_app`. Grant
-- only the id column — `users` is global identity with no RLS, so the
-- password hash and verification timestamps stay unreadable to the
-- tenant role.
GRANT SELECT (id) ON users TO tenant_app;
