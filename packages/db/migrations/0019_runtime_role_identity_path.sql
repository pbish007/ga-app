-- 0019_runtime_role_identity_path.sql
-- PMB-74 — make the identity path (login / signup / /orgs / membership gate)
-- safe to run as the non-bypass `tenant_runtime` role.
--
-- Context — verified in PMB-75:
--   * Today's runtime DATABASE_URL connects as `neondb_owner`, which has
--     `rolbypassrls = true`. The identity-path reads of `organization_memberships`
--     (which is FORCE-RLS) outside the tenant tx work today *because of* that
--     attribute-level bypass — not via a permissive policy, not via a missing
--     FORCE, not via any other mechanism.
--   * Migration 0018 provisioned `tenant_runtime` (NOBYPASSRLS NOINHERIT). If
--     DATABASE_URL is repointed at it without this migration's policy + grants,
--     /login, /orgs, the membership gate, and signup membership inserts all
--     break for every tenant.
--
-- This migration adds the two pieces of standing DB state that the upcoming
-- auth-path refactor depends on:
--
--   A. A permissive `app_self_membership` policy on `organization_memberships`,
--      keyed on a new `app.current_user_id` GUC. Lets a `tenant_app` session
--      that has set the user GUC (but not necessarily a tenant GUC) read and
--      insert ONLY that user's own membership rows — exactly what
--      `listUserOrganizations` (cross-tenant org list) and `handleSignup`
--      (membership self-insert) need. Fail-closed when the GUC is unset
--      (NULL never matches anything).
--   B. The least-privilege direct grants `tenant_runtime` needs on the non-RLS
--      identity / RBAC tables the auth path reads or writes on the connection
--      role itself (outside any tenant tx). Plus `SELECT` on `organizations`
--      to `tenant_app`, which the in-tenant membership-with-org join now
--      depends on.
--
-- Both are SAFE TO APPLY AHEAD of the code refactor and the DATABASE_URL
-- repoint:
--   * `app_self_membership` is permissive (OR'd with `app_isolation`). It only
--     ever broadens visibility for a session that has set `app.current_user_id`
--     — and the current deployed code never sets it, so the policy is dormant.
--   * `tenant_runtime` has no password set, so nothing yet authenticates as it
--     and exercises the new grants. They are also no-ops on the current
--     `neondb_owner` connection (it already bypasses).
--   * The grant of `SELECT ON organizations TO tenant_app` is additive — no
--     existing tenant_app code depended on it being absent.
--
-- The auth-path refactor (signup / loadMembership / loadOrgNavContext /
-- listUserOrganizations) and the actual DATABASE_URL repoint land separately,
-- under SecurityEngineer review, after this migration is applied to prod.

-- ---------------------------------------------------------------------------
-- A. app_self_membership policy on organization_memberships
--
-- `app.current_user_id` is a session GUC set by the server from the
-- authenticated session. A user can therefore only ever assert themselves.
-- The policy gates BOTH reads (USING) and writes (WITH CHECK) so signup's
-- self-insert passes when `app.current_user_id = new user.id`, while a write
-- with any other `user_id` fails the WITH CHECK and is rejected.
--
-- Idempotent re-runs: PG has no `CREATE POLICY IF NOT EXISTS`; we wrap in a
-- DO block that skips when the policy is already present.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.organization_memberships'::regclass
      AND polname = 'app_self_membership'
  ) THEN
    CREATE POLICY app_self_membership ON organization_memberships
      USING      (user_id::text = current_setting('app.current_user_id', true))
      WITH CHECK (user_id::text = current_setting('app.current_user_id', true));
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- B1. tenant_runtime direct grants — non-RLS identity tables read/written on
--     the bare connection (outside the tenant tx)
--
-- Determined from an exhaustive audit of every getDb() call site outside
-- runAsTenantOnProductionDb (see ADR §2):
--   * users:          SELECT (loadSession, handleLogin), INSERT (handleSignup).
--   * organizations:  SELECT (org list / nav joins),    INSERT (handleSignup
--                                                       via OrganizationService).
--   * app_*:          SELECT only — read-only RBAC catalog, edited only by
--                     migrations.
--
-- No DELETE/UPDATE: no current handler issues either on these tables on the
-- connection role. Add them in a later migration if a handler is added — do
-- not over-grant ahead of need.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT ON users          TO tenant_runtime;
GRANT SELECT, INSERT ON organizations  TO tenant_runtime;
GRANT SELECT          ON app_roles            TO tenant_runtime;
GRANT SELECT          ON app_permissions      TO tenant_runtime;
GRANT SELECT          ON app_role_permissions TO tenant_runtime;

-- handleSignup → OrganizationService.create resolves the platform default
-- regime via RegimeClient.getByCode on the connection role before INSERTing
-- the new org. The regime catalog is global, read-only reference data (0001),
-- already granted to tenant_app via 0016; the same single-row read also
-- happens on the bare tenant_runtime connection. No write access here — the
-- child regime tables (intervals/templates/etc.) are read only inside the
-- tenant_app session and are not granted to tenant_runtime.
GRANT SELECT          ON regimes        TO tenant_runtime;

-- ---------------------------------------------------------------------------
-- B2. tenant_app direct grant on organizations
--
-- The refactored `loadMembership` / `loadOrgNavContext` / `listUserOrganizations`
-- run their reads inside a tenant_app transaction so RLS is enforced as a DB
-- property. Those reads join `organization_memberships` (granted in 0004 /
-- 0016 with the `app_isolation` policy) against `organizations` to expose the
-- org's name and type. tenant_app currently has no privilege on `organizations`
-- — without this grant the joined reads would error.
--
-- `organizations` is global identity (NOT tenant-scoped — it IS the tenant);
-- no RLS, so a SELECT grant exposes only the org rows the join already keys
-- on via the gated membership table. No exposure beyond the existing isolation
-- envelope.
-- ---------------------------------------------------------------------------

GRANT SELECT ON organizations TO tenant_app;
