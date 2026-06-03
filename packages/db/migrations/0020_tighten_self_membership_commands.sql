-- 0020_tighten_self_membership_commands.sql
-- PMB-77 — tighten `app_self_membership` to FOR SELECT + FOR INSERT only.
--
-- Migration 0019 created `app_self_membership` on `organization_memberships`
-- without an explicit FOR clause, which Postgres defaults to FOR ALL. The
-- runtime auth path only needs the policy for:
--   * SELECT — cross-tenant `listUserOrganizations` (the /orgs list).
--   * INSERT — signup self-membership row (handleSignup).
-- No current handler issues UPDATE or DELETE against `organization_memberships`
-- on the bare tenant_app session — 0019's own commit message says so.
--
-- Under FOR ALL the policy ALSO governs UPDATE and DELETE. The user-keyed
-- USING / WITH CHECK then matches the existing-row's user_id against
-- `app.current_user_id` for every command on which RLS applies. Given a SQLi
-- primitive inside a tenant_app transaction (the only reachable attacker
-- model, since the GUC is server-set), that broadens the per-statement blast
-- radius of self-membership tampering — most notably a single
-- `UPDATE organization_memberships SET role='admin' WHERE user_id=<self>`
-- escalating across every tenant the attacker is already a member of, instead
-- of one tenant per GUC swap under `app_isolation`.
--
-- Splitting the policy into FOR SELECT + FOR INSERT removes that amplification
-- with no functional cost: UPDATE/DELETE on this table then fall through to
-- `app_isolation` alone, which is exactly where they were before 0019.
--
-- Idempotent: drop the old policy if present, then create the two scoped
-- policies if not already present. A re-run on a database that already has
-- this migration applied is a no-op.

-- ---------------------------------------------------------------------------
-- Drop the FOR ALL policy from 0019 if it still exists.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS app_self_membership ON organization_memberships;

-- ---------------------------------------------------------------------------
-- Recreate as two narrowly scoped permissive policies.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.organization_memberships'::regclass
      AND polname = 'app_self_membership_read'
  ) THEN
    CREATE POLICY app_self_membership_read ON organization_memberships
      FOR SELECT
      USING (user_id::text = current_setting('app.current_user_id', true));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.organization_memberships'::regclass
      AND polname = 'app_self_membership_insert'
  ) THEN
    CREATE POLICY app_self_membership_insert ON organization_memberships
      FOR INSERT
      WITH CHECK (user_id::text = current_setting('app.current_user_id', true));
  END IF;
END
$$;
