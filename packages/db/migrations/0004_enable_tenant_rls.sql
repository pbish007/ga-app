-- 0004_enable_tenant_rls.sql
-- Epic A / story A1.2 — tenant Row Level Security (PMB-31).
-- Source: spec Rev. 3 §4 Epic A; tenant isolation harness from J3.2 (PMB-9).
--
-- Make tenant isolation a property of the database, not the app.
--
--   1. `tenant_app` role (NOSUPERUSER NOBYPASSRLS) is the role every
--      application connection MUST `SET ROLE` to after authentication.
--      Superuser direct queries are migration-only.
--   2. Each tenant-scoped table gets an `app_isolation` policy that
--      compares its `tenant_id` to `current_setting('app.current_tenant_id',
--      true)`. The `true` (missing_ok) flag makes an unset GUC return NULL,
--      and `NULL = anything` is NULL, so an unset context yields zero rows
--      — i.e. the database fails closed.
--   3. Policies pin both USING (read-side gate) and WITH CHECK (write-side
--      gate). A tenant cannot read rows it does not own, and it cannot
--      insert/update a row into another tenant's id.
--
-- Tables policed here:
--   * organization_memberships, invitations, email_outbox — A1.1 (0002).
--   * documents — J2.1 (0003). The 0003 migration explicitly defers its
--     USING/WITH CHECK and the tenant_app grant to "PMB-10 / A1.2"; this
--     migration closes that gap so we don't leave a table in the
--     RLS-enabled-but-no-policy posture longer than necessary.
--
-- Tables intentionally NOT policed:
--   * organizations — a user's session lists the orgs they belong to via
--     `organization_memberships`, which is the gated table. Putting RLS on
--     organizations would block the membership join.
--   * users — global identity, not tenant-scoped. Reachable only by the
--     membership / invitations joins (which are gated).
--   * regimes (+ children) — global, regime-keyed reference data. The
--     regime spine is read-only from the app's perspective in MVP.
--
-- email_outbox has a NULLable tenant_id (system mail). The policy hides
-- NULL-tenant rows from tenant_app sessions — system mail is drained by a
-- future background worker connecting as a different role.

-- ---------------------------------------------------------------------------
-- tenant_app role
--
-- Idempotent because some migration runners replay 0000-N on a fresh
-- database created from a snapshot that already has the role. Wrapping
-- the CREATE ROLE in a DO block keeps re-runs harmless.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tenant_app') THEN
    CREATE ROLE tenant_app NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO tenant_app;

-- ---------------------------------------------------------------------------
-- organization_memberships
-- ---------------------------------------------------------------------------

CREATE POLICY app_isolation ON organization_memberships
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON organization_memberships TO tenant_app;

-- ---------------------------------------------------------------------------
-- invitations
-- ---------------------------------------------------------------------------

CREATE POLICY app_isolation ON invitations
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO tenant_app;

-- ---------------------------------------------------------------------------
-- email_outbox
--
-- tenant_id is nullable for system mail. NULL never equals the GUC, so
-- system rows are invisible to tenant_app — by design.
-- ---------------------------------------------------------------------------

CREATE POLICY app_isolation ON email_outbox
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON email_outbox TO tenant_app;

-- ---------------------------------------------------------------------------
-- documents (J2.1 deferred-policy gap)
-- ---------------------------------------------------------------------------

CREATE POLICY app_isolation ON documents
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO tenant_app;
