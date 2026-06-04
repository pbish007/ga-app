-- 0025_grandfather_tenant_provisioning_audit.sql
-- PMB-119 (V1 Managed onboarding S5) — backfill the audit trail.
--
-- One-shot: for every row that already exists in `organizations` at the
-- time this migration applies, INSERT a synthetic `tenant_provisioning_audit`
-- row marking the tenant as grandfathered. This makes the audit trail
-- complete on day 1 of [C2] (TenantProvisioningService) — the audit-list
-- endpoint from [C3] (admin API) will surface every tenant, not just the
-- ones provisioned through the new service.
--
-- Shape of each backfilled row (matches the contract in PMB-119):
--   actor_kind       = 'grandfathered'
--   actor_user_id    = NULL                   (no admin attribution exists)
--   idempotency_key  = 'grandfather:' || id   (UNIQUE — re-runs are no-ops)
--   input_snapshot   = { source: 'grandfather', orgName, orgType, regimeId }
--   result_status    = 'done'
--   result_snapshot  = { tenantId }
--   created_at       = organizations.created_at
--   completed_at     = organizations.created_at
--   created_tenant_id = organizations.id
--   error            = NULL
--
-- Idempotency
-- -----------
-- The partial UNIQUE INDEX `tenant_provisioning_audit_idempotency_key_unique`
-- (from 0024) covers non-NULL idempotency keys. `ON CONFLICT DO NOTHING`
-- against that index makes a second apply of this migration a strict no-op:
-- every key collides with the already-inserted row.
--
-- This matters because the apply-on-deploy migration runner records
-- `schema_migrations` rows after a successful single-transaction apply,
-- but a partial run that errors mid-way leaves nothing recorded and would
-- re-run on the next deploy. The ON CONFLICT clause keeps that safe.
--
-- The migration also guards against rows where `tenant_provisioning_audit`
-- already has any audit row for the tenant (e.g. one was inserted by an
-- early call to provisionTenant() on the same tenant_id pre-grandfather)
-- by keying solely on the synthetic `grandfather:` idempotency key — those
-- pre-existing rows don't collide, and the grandfather row stands beside
-- them in the audit log.
--
-- Tenants grandfathered by this migration on first apply
-- ------------------------------------------------------
-- The exact list is environment-dependent (each environment has its own
-- demo + pre-C2-signup tenants). Per PMB-119, the deploying operator
-- captures the set with the verifier:
--
--   SELECT a.created_tenant_id, o.name, o.org_type, o.created_at
--     FROM tenant_provisioning_audit a
--     JOIN organizations o ON o.id = a.created_tenant_id
--    WHERE a.actor_kind = 'grandfathered'
--    ORDER BY o.created_at;
--
-- The commit body for the deploy that lands this migration records the
-- result for traceability.

INSERT INTO tenant_provisioning_audit (
  created_tenant_id,
  idempotency_key,
  actor_user_id,
  actor_kind,
  input_snapshot,
  result_status,
  result_snapshot,
  error,
  created_at,
  completed_at
)
SELECT
  o.id                                AS created_tenant_id,
  'grandfather:' || o.id::text        AS idempotency_key,
  NULL                                AS actor_user_id,
  'grandfathered'                     AS actor_kind,
  jsonb_build_object(
    'source',   'grandfather',
    'orgName',  o.name,
    'orgType',  o.org_type,
    'regimeId', o.default_regime_id
  )                                   AS input_snapshot,
  'done'                              AS result_status,
  jsonb_build_object('tenantId', o.id) AS result_snapshot,
  NULL                                AS error,
  o.created_at                        AS created_at,
  o.created_at                        AS completed_at
FROM organizations o
ON CONFLICT (idempotency_key)
  WHERE idempotency_key IS NOT NULL
  DO NOTHING;
