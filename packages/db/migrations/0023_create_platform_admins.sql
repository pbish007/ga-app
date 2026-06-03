-- 0023_create_platform_admins.sql
-- PMB-116 — Platform-admin identity primitive (V1 Managed onboarding S1).
--
-- Background. `admin` in `organization_memberships` is a TENANT-SCOPED role
-- (one org's administrator). There is no schema concept today for "this user
-- is a Paperclip-side platform operator who can drive cross-tenant onboarding
-- and managed flows." The onboarding stack (C2 provisioning service, C3 admin
-- API, C8/C9 admin UI) all need a single source of truth to gate on; this
-- table is that source.
--
-- Shape (per task PMB-116):
--   platform_admins (
--     user_id            uuid  PK   — global identity, one row per admin
--     granted_by_user_id uuid       — who promoted them (NULL for bootstrap)
--     granted_at         tstz       — when the grant landed
--     revoked_at         tstz NULL  — append-only revocation (NULL = active)
--     note               text       — free-text audit note
--   )
--
-- Append-only semantics. The app layer never DELETEs from this table — it sets
-- `revoked_at` instead so historical inspection of who held the role and when
-- is preserved. The runtime gate (`isPlatformAdmin`) treats a row with
-- `revoked_at IS NOT NULL` as "not an admin".
--
-- NOT TENANT-SCOPED. Platform-admin is a global identity property in the same
-- bucket as `users` and `app_roles` — no RLS, no `tenant_id`, no
-- `app_isolation` policy. The table is deliberately NOT exposed to the
-- `tenant_app` role: a request that has dropped into a tenant tx must NEVER
-- be able to read platform-admin status. The auth path reads it on the bare
-- `tenant_runtime` connection (outside any tenant tx) before deciding whether
-- to admit the caller into an admin route. Grants smoke (PMB-31 / PMB-74
-- harness pattern) asserts the absence of the tenant_app grant.
--
-- Bootstrap. `PLATFORM_ADMIN_BOOTSTRAP_EMAIL` (an environment variable, passed
-- into the migration session as the `app.platform_admin_bootstrap_email` GUC
-- by `packages/db/scripts/migrate.sh`) names the first platform admin. The DO
-- block at the bottom inserts the matching `users.id` if and only if:
--   * the GUC is set and non-empty (no-op when unset — including pglite tests),
--   * a user with that lower(email) exists, and
--   * the user is not already in `platform_admins` (ON CONFLICT DO NOTHING).
-- Idempotency drill: re-running this migration with the same env set must be
-- a no-op once the row exists. The `ON CONFLICT (user_id)` clause guarantees
-- that property; the test suite locks it in.

-- ---------------------------------------------------------------------------
-- platform_admins
-- ---------------------------------------------------------------------------

CREATE TABLE platform_admins (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  note               text
);

-- Index the live-admin lookup. The gate query is
-- `SELECT 1 FROM platform_admins WHERE user_id = $1 AND revoked_at IS NULL`
-- which already uses the PK, but a partial index over the active rows lets
-- future "list active admins" reads stay cheap and documents the active-row
-- shape explicitly.
CREATE INDEX platform_admins_active_idx
  ON platform_admins (user_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Grants
--
-- Read-only to `tenant_runtime` (the bare connection role). The auth gate
-- runs SELECT before any tenant tx begins. tenant_runtime is NOINHERIT and
-- is a MEMBER of tenant_app (one-way), so this grant does NOT leak to
-- tenant_app: a query that has executed `SET LOCAL ROLE tenant_app` runs
-- AS tenant_app and gets `permission denied` on this table — exactly the
-- "tenant tx cannot see platform-admin status" property we want.
--
-- Writes (INSERT / UPDATE for grant / revoke) come from the C3 admin API and
-- will be added in that ticket. We grant only what the C1 gate needs.
--
-- The `pg_roles` guard mirrors 0017/0021 so pglite (which has no
-- tenant_runtime role unless 0018 ran first) is safe. 0018 ran before this
-- migration in the same suite, so the guard is defensive, not load-bearing.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tenant_runtime') THEN
    GRANT SELECT ON platform_admins TO tenant_runtime;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Bootstrap from PLATFORM_ADMIN_BOOTSTRAP_EMAIL
--
-- Reads the value out of the `app.platform_admin_bootstrap_email` session
-- GUC. `current_setting(..., true)` returns NULL when unset (missing_ok),
-- so the DO block is a no-op in any environment that did not opt in. The
-- runtime is the migration session itself, so this insert runs as the
-- migrator/owner role and does not depend on the `tenant_runtime` GRANT.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bootstrap_email  text := current_setting('app.platform_admin_bootstrap_email', true);
  target_user_id   uuid;
BEGIN
  IF bootstrap_email IS NULL OR length(btrim(bootstrap_email)) = 0 THEN
    RETURN;
  END IF;
  SELECT id INTO target_user_id
    FROM users
   WHERE lower(email) = lower(btrim(bootstrap_email))
   LIMIT 1;
  IF target_user_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO platform_admins (user_id, note)
       VALUES (target_user_id, 'bootstrap from PLATFORM_ADMIN_BOOTSTRAP_EMAIL')
  ON CONFLICT (user_id) DO NOTHING;
END
$$;
