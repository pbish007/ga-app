-- 0018_create_tenant_runtime_role.sql
-- PMB-74 — provision the dedicated non-owner runtime login role.
--
-- The runtime web app connects today as a schema-owner-class role. Tenant
-- isolation then rests entirely on FORCE ROW LEVEL SECURITY returning zero
-- rows when the tenant GUC is unset (a *silent* fail-closed). This role is the
-- secure-by-default replacement: a non-owner login role that holds NO direct
-- privilege on any tenant table, so a request that forgets to `SET ROLE
-- tenant_app` fails *loudly* (`permission denied for table …`) instead of
-- relying on FORCE. See the PMB-74 design doc (#document-design).
--
-- Attributes:
--   * NOSUPERUSER NOBYPASSRLS — RLS always binds this role.
--   * NOINHERIT — load-bearing: it is a *member* of tenant_app (so it may
--     `SET ROLE tenant_app`) but does NOT automatically inherit tenant_app's
--     table grants. A missed role switch therefore has no table privilege and
--     errors, rather than silently inheriting the grant and falling back to the
--     FORCE-RLS zero-rows behaviour we are trying to stop depending on.
--   * NOCREATEDB NOCREATEROLE — no DDL/role authority on the request path.
--   * LOGIN with NO password — login-CAPABLE but cannot authenticate until a
--     password is set out-of-band at repoint time. Neon requires SCRAM auth,
--     so a password-less role cannot connect; the role is therefore inert
--     until the rollout step sets its password and repoints DATABASE_URL.
--
-- SCOPE OF THIS MIGRATION (deliberately minimal + safe to apply any time):
-- it only creates the role and grants schema USAGE + tenant_app membership.
-- The role is unused (no password, not yet the DATABASE_URL target) so this
-- changes NO runtime behaviour and touches NO RLS policy. The least-privilege
-- direct grants on the non-RLS identity tables the auth path reads on the
-- connection (users / organizations / app_* — see design doc), the
-- `app_self_membership` policy on organization_memberships, the app auth-path
-- refactor, the password, and the DATABASE_URL repoint all land together in the
-- SecurityEngineer-reviewed rollout, after the prod runtime-role verification.
--
-- Idempotent: re-running CREATE ROLE / GRANT is a no-op. Wrapping CREATE ROLE
-- in a DO block mirrors 0004's tenant_app creation so replays on a
-- snapshot-derived database stay harmless.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tenant_runtime') THEN
    CREATE ROLE tenant_runtime
      LOGIN
      NOSUPERUSER
      NOBYPASSRLS
      NOINHERIT
      NOCREATEDB
      NOCREATEROLE;
  END IF;
END
$$;

-- Must resolve table names and execute `SET ROLE tenant_app`; holds no table
-- privilege of its own.
GRANT USAGE ON SCHEMA public TO tenant_runtime;

-- Membership lets tenant_runtime `SET ROLE tenant_app`. Because tenant_runtime
-- is NOINHERIT, this grants the *ability to switch*, not the privileges
-- themselves — they apply only after an explicit `SET ROLE tenant_app`.
GRANT tenant_app TO tenant_runtime;
