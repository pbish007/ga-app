-- seed-qa-platform-admin.sql
-- PMB-129 — Seed a dedicated platform-admin user for QA / smoke runs.
--
-- The fresh-tenant smoke (PMB-121, .github/workflows/smoke.yml) and the
-- PMB-129 end-to-end verification of /admin/tenants/new both need a known
-- platform-admin session. The legitimate bootstrap email (the CEO) does not
-- have a published password, so we seed a separate dedicated identity:
--
--   email = qa-smoke-admin@gaapp.io
--
-- This script is idempotent — re-running it is a no-op (or password rotate)
-- and never touches any other rows. It reads two session GUCs:
--
--   app.qa_platform_admin_email          → target email (required)
--   app.qa_platform_admin_password_hash  → scrypt$salt$derived (required)
--
-- Both are passed in via the db-seed-qa-admin.yml workflow's PGOPTIONS.
-- Never commit a plain password or hash into the repo.

DO $$
DECLARE
  qa_email     text := current_setting('app.qa_platform_admin_email', true);
  qa_hash      text := current_setting('app.qa_platform_admin_password_hash', true);
  target_id    uuid;
BEGIN
  IF qa_email IS NULL OR length(btrim(qa_email)) = 0 THEN
    RAISE EXCEPTION 'app.qa_platform_admin_email GUC is required';
  END IF;
  IF qa_hash IS NULL OR length(btrim(qa_hash)) = 0 THEN
    RAISE EXCEPTION 'app.qa_platform_admin_password_hash GUC is required';
  END IF;
  IF qa_hash NOT LIKE 'scrypt$%$%' THEN
    RAISE EXCEPTION 'app.qa_platform_admin_password_hash must be scrypt$salt$derived';
  END IF;

  -- Upsert the user. The unique index is on the expression lower(email);
  -- ON CONFLICT cannot infer that, so we do a SELECT-then-INSERT-or-UPDATE
  -- in two steps inside this DO block (still race-safe within a single tx).
  SELECT id INTO target_id
    FROM users
   WHERE lower(email) = lower(qa_email)
   LIMIT 1;

  IF target_id IS NULL THEN
    INSERT INTO users (email, password_hash, password_changed_at)
         VALUES (qa_email, qa_hash, now())
    RETURNING id INTO target_id;
  ELSE
    UPDATE users
       SET password_hash       = qa_hash,
           password_changed_at = now(),
           updated_at          = now()
     WHERE id = target_id;
  END IF;

  -- Grant platform_admins (active row). If a revoked row exists, un-revoke it.
  INSERT INTO platform_admins (user_id, note)
       VALUES (target_id, 'seeded by seed-qa-platform-admin.sql (PMB-129)')
  ON CONFLICT (user_id) DO UPDATE
        SET revoked_at = NULL,
            note       = 'seeded by seed-qa-platform-admin.sql (PMB-129)';

  RAISE NOTICE 'qa platform admin ready: % (user_id=%)', qa_email, target_id;
END
$$;
