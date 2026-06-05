-- 0027_credentials_ratings_and_audit.sql
-- Epic G / story PMB-155 — credentials schema, RBAC, audit-log writes.
-- Source: spec Rev. 3 §4 Epic G; parent PMB-92; the existing
-- tenant-agnostic `user_credentials` table from migration 0006.
--
-- Three things, shipped together:
--
--   1. `user_credentials` gets `ratings text[]` (multi-value, e.g.
--      "Airframe", "Powerplant", a Repairman's per-make/model rating)
--      and `created_by_user_id` (the admin who created or last
--      attributed-created the row). Existing rows backfill to `{}` and
--      NULL respectively.
--
--   2. New `user_credential_changes` audit table — tenant-scoped,
--      RLS-enabled, append-only. One row per create/update/revoke.
--      Records actor, target user, action, and before/after JSONB
--      snapshots so an auditor can reconstruct what state existed at
--      sign-off time (FAA recordkeeping under 14 CFR §43.9, §91.417).
--
--   3. New permission `credential.manage` (admin-only) + grants. Self
--      reads stay permission-free at the application layer (a member
--      may always read their own credentials regardless of role).
--
-- Tenant-scope reading: PMB-155 asked for "tenant scope on every row".
-- The existing `user_credentials` table is *deliberately* tenant-agnostic
-- (an A&P number belongs to the human, not to a tenant — see the comment
-- on migration 0006). This migration keeps that contract. The audit row
-- is the tenant-scoped artifact: it captures which org's admin touched
-- the row, when, and what the before/after state was. Admin CRUD
-- endpoints enforce "this admin can only touch credentials for users
-- who are members of *this* tenant" at the application boundary
-- (membership table is already RLS-pinned to the current tenant).

-- ---------------------------------------------------------------------------
-- user_credentials — add ratings + created_by_user_id
-- ---------------------------------------------------------------------------

ALTER TABLE user_credentials
  ADD COLUMN ratings text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE user_credentials
  ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- user_credential_changes — tenant-scoped, append-only audit
-- ---------------------------------------------------------------------------

CREATE TABLE user_credential_changes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Nullable so a future hard-delete audit row can survive after the
  -- credential row is gone. Today the service soft-revokes only, so this
  -- is always populated; the nullable shape just avoids painting us into
  -- a corner later.
  user_credential_id   uuid REFERENCES user_credentials(id) ON DELETE SET NULL,
  target_user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_user_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action               text NOT NULL,
  before_snapshot      jsonb,
  after_snapshot       jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_credential_changes_action_check
    CHECK (action IN ('create', 'update', 'revoke')),
  CONSTRAINT user_credential_changes_snapshot_shape
    CHECK (
      (action = 'create' AND before_snapshot IS NULL AND after_snapshot IS NOT NULL)
      OR (action = 'update' AND before_snapshot IS NOT NULL AND after_snapshot IS NOT NULL)
      OR (action = 'revoke' AND before_snapshot IS NOT NULL AND after_snapshot IS NOT NULL)
    )
);

CREATE INDEX user_credential_changes_tenant_idx
  ON user_credential_changes (tenant_id);
CREATE INDEX user_credential_changes_target_idx
  ON user_credential_changes (target_user_id, created_at DESC);
CREATE INDEX user_credential_changes_credential_idx
  ON user_credential_changes (user_credential_id, created_at DESC);

-- Audit rows are append-only. Belt-and-braces: the application layer
-- never updates them, and `tenant_app` has no UPDATE/DELETE grant; if
-- either fails the trigger refuses.
CREATE OR REPLACE FUNCTION user_credential_changes_block_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'user_credential_changes is append-only; row % cannot be modified', OLD.id
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER user_credential_changes_block_update
BEFORE UPDATE ON user_credential_changes
FOR EACH ROW
EXECUTE FUNCTION user_credential_changes_block_update();

ALTER TABLE user_credential_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credential_changes FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON user_credential_changes
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT ON user_credential_changes TO tenant_app;

-- ---------------------------------------------------------------------------
-- credential.manage permission — admin-only
--
-- Mechanics, pilots, managers, and read_only roles do NOT receive this
-- permission. Self-reads of one's own credentials are gated at the
-- application layer (caller user_id == target user_id) without a
-- permission check; cross-user reads require `credential.manage`.
-- ---------------------------------------------------------------------------

INSERT INTO app_permissions (code, description)
VALUES (
  'credential.manage',
  'Create, update, and revoke credentials for users in the organization (admin).'
);

INSERT INTO app_role_permissions (role_code, permission_code)
VALUES ('admin', 'credential.manage');
