-- 0024_create_tenant_provisioning_audit.sql
-- PMB-117 (V1 Managed onboarding S3) — append-only audit log for every
-- tenant-provisioning attempt.
--
-- One row per `provisionTenant` invocation. The row is INSERTed in
-- `result_status = 'in_progress'` before the org/membership tx opens, and
-- UPDATEd to `'done'` (with `created_tenant_id`, `result_snapshot`, `completed_at`)
-- or `'failed'` (with `error`, `completed_at`) when the attempt resolves.
-- Survives a compliance audit and tells operators who provisioned what,
-- when, and with what config.
--
-- Shape (per task PMB-117). Note: the issue body names the FK column
-- `tenant_id`, but a column literally named `tenant_id` is the project's
-- marker for a tenant-scoped row (`packages/db/tests/force-rls-lint.test.ts`
-- enforces ENABLE+FORCE RLS on every such table). This audit log is NOT
-- tenant-scoped — it is a system-only log keyed *by* the tenant created
-- in each attempt. We therefore name the column `created_tenant_id` to
-- keep the FORCE-RLS invariant sharp; the JS schema mirrors the rename.
--
--   tenant_provisioning_audit (
--     id                 uuid PK
--     created_tenant_id  uuid NULL  — resolved on success; NULL while in_progress
--                                  and on failures that happened before the
--                                  org row landed
--     idempotency_key text NULL  — UNIQUE when set; NULL is the "no key"
--                                  shape (self-service signup)
--     actor_user_id   uuid NULL  — the platform admin (admin path) or the
--                                  new self-service user (after they exist)
--     actor_kind      text       — self-service | platform-admin | grandfathered
--     input_snapshot  jsonb      — what the caller asked for (org_name,
--                                  org_type, regime_id?, primary admin email,
--                                  seats, provisioned_by). Password material
--                                  NEVER lands here — the service strips it
--                                  before writing.
--     result_status   text       — in_progress | done | failed
--     result_snapshot jsonb NULL — on success: { created_tenant_id,
--                                  primary_admin_user_id, invitations_sent,
--                                  warnings? }
--     error           jsonb NULL — on failure: { code, message }
--     created_at      timestamptz
--     completed_at    timestamptz NULL
--   )
--
-- NOT TENANT-SCOPED. The audit lives on the system connection and is
-- deliberately NOT exposed to `tenant_app`. A request that has already
-- entered a tenant tx must NEVER be able to read or write the audit log.
-- The runtime grants below mirror the platform_admins pattern from 0023:
-- the bare `tenant_runtime` connection holds SELECT/INSERT/UPDATE so the
-- service can write the in_progress row + close it out; tenant_app holds
-- no grant. The grants smoke (PMB-31 / PMB-74 harness pattern) asserts
-- the absence of the tenant_app grant.
--
-- Append-only semantics. Rows are never DELETEd. The two state transitions
-- (`in_progress -> done` and `in_progress -> failed`) are the only legal
-- updates the service issues; both set `completed_at` and one of
-- `result_snapshot` / `error`. The CHECK on `result_status` keeps SQL-level
-- corruption from inventing a third terminal state.

-- ---------------------------------------------------------------------------
-- tenant_provisioning_audit
-- ---------------------------------------------------------------------------

CREATE TABLE tenant_provisioning_audit (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_tenant_id        uuid REFERENCES organizations(id) ON DELETE SET NULL,
  idempotency_key  text,
  actor_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_kind       text NOT NULL,
  input_snapshot   jsonb NOT NULL,
  result_status    text NOT NULL DEFAULT 'in_progress',
  result_snapshot  jsonb,
  error            jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT tenant_provisioning_audit_status_check
    CHECK (result_status IN ('in_progress', 'done', 'failed')),
  CONSTRAINT tenant_provisioning_audit_actor_kind_check
    CHECK (actor_kind IN ('self-service', 'platform-admin', 'grandfathered'))
);

-- Idempotency key is UNIQUE only when non-NULL. Self-service signup leaves
-- the key NULL — each attempt gets its own audit row, multiple failed signup
-- retries are recorded distinctly. The admin API (C3) sets a stable key
-- per intended tenant so a retried POST returns the prior result.
CREATE UNIQUE INDEX tenant_provisioning_audit_idempotency_key_unique
  ON tenant_provisioning_audit (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Newest-first audit viewer (C3) reads against this index.
CREATE INDEX tenant_provisioning_audit_created_at_idx
  ON tenant_provisioning_audit (created_at DESC);

-- ---------------------------------------------------------------------------
-- Grants
--
-- tenant_runtime (the bare web-app connection role) needs:
--   * SELECT — idempotency lookup before insert; admin-API listing in C3.
--   * INSERT — write the in_progress row at the start of provisionTenant.
--   * UPDATE — flip the row to done/failed at the end.
--
-- No DELETE. The table is append-only at the application layer; deletes
-- happen via parent FK cascade only when an organization is removed (and
-- even then we keep the row by `ON DELETE SET NULL` on created_tenant_id).
--
-- tenant_app gets NO grant. A tenant_app session that somehow reached the
-- audit table would `permission denied for table …` — the loud failure
-- mode we want.
--
-- pglite tests have no `tenant_runtime` role; the DO guard makes the grant
-- a no-op there. 0018 (which creates the role) ran earlier in the same
-- migration sweep on real Postgres, so the guard is defensive.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tenant_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON tenant_provisioning_audit TO tenant_runtime;
  END IF;
END
$$;
