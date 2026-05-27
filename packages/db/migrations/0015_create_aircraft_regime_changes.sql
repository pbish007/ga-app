-- 0015_create_aircraft_regime_changes.sql
-- Epic K / story K2.2 — Audit trail on regime change (PMB-18).
-- Source: spec Rev. 3 §3.2 Epic K, ADR-002 on PMB-8, PMB-10 RBAC matrix.
--
-- Changing an aircraft's `regime_id` is a restricted, audited action.
-- This migration ships three pieces of the same feature together so the
-- audit, the retention rule, and the permission grant move as one unit:
--
--   1. `aircraft_regime_changes` — append-only audit log capturing
--      actor, from/to regime, timestamp, and reason for every change to
--      `aircraft.regime_id`. Tenant-scoped + RLS + grant to `tenant_app`.
--      Rows are immutable once written; the table has no UPDATE grant.
--
--   2. `regime_retention_rules` — new FAA row with record_kind
--      `regime_change`, set to `lifetime` per 14 CFR §91.417(b)(2)
--      principle (records that establish the airworthiness baseline
--      ride with the aircraft for its life). Read by J4 retention work
--      in V1; the application reads the rule, never literals.
--
--   3. `app_permissions` + `app_role_permissions` — new permission code
--      `aircraft.change_regime`, granted only to `admin`. The regime
--      seam is a high-blast-radius write: it changes which jurisdiction
--      governs every downstream inspection, sign-off, and retention
--      calculation for the aircraft, so it does not inherit the
--      `aircraft.write` grant.

-- ---------------------------------------------------------------------------
-- aircraft_regime_changes
-- ---------------------------------------------------------------------------

CREATE TABLE aircraft_regime_changes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  aircraft_id       uuid NOT NULL REFERENCES aircraft(id) ON DELETE CASCADE,
  from_regime_id    uuid NOT NULL REFERENCES regimes(id) ON DELETE RESTRICT,
  to_regime_id      uuid NOT NULL REFERENCES regimes(id) ON DELETE RESTRICT,
  actor_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aircraft_regime_changes_distinct_regimes
    CHECK (from_regime_id <> to_regime_id),
  CONSTRAINT aircraft_regime_changes_reason_nonempty
    CHECK (length(trim(reason)) > 0)
);

CREATE INDEX aircraft_regime_changes_tenant_idx
  ON aircraft_regime_changes (tenant_id);
CREATE INDEX aircraft_regime_changes_aircraft_idx
  ON aircraft_regime_changes (aircraft_id, created_at DESC);

-- Audit rows are append-only. The trigger is belt-and-braces: the
-- application layer never updates them, and tenant_app has no UPDATE
-- grant (see GRANT below), but if either fails the trigger refuses.
CREATE OR REPLACE FUNCTION aircraft_regime_changes_block_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'aircraft_regime_changes is append-only; row % cannot be modified', OLD.id
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER aircraft_regime_changes_block_update
BEFORE UPDATE ON aircraft_regime_changes
FOR EACH ROW
EXECUTE FUNCTION aircraft_regime_changes_block_update();

ALTER TABLE aircraft_regime_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE aircraft_regime_changes FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON aircraft_regime_changes
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT ON aircraft_regime_changes TO tenant_app;

-- ---------------------------------------------------------------------------
-- Retention rule for the new record kind.
-- Seed for every existing regime so the application can read a rule by
-- (regime_id, 'regime_change') without a fallback. Today that's FAA;
-- when CARS or another regime is added (data-only), the new regime
-- migration ships its own retention rows the same way.
-- ---------------------------------------------------------------------------

INSERT INTO regime_retention_rules
  (regime_id, record_kind, retention_period_kind, retention_period_value, description)
SELECT id, 'regime_change', 'lifetime', NULL,
       '14 CFR §91.417(b)(2) principle: records establishing the regulatory regime of the aircraft are retained for the life of the aircraft.'
  FROM regimes WHERE code = 'FAA'
ON CONFLICT (regime_id, record_kind) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Permission grant: aircraft.change_regime → admin only.
-- The K2 seam is high-blast-radius — changing regime changes every
-- downstream compliance computation. PMB-10 RBAC matrix says admin
-- gets everything; we explicitly do NOT grant this to manager or
-- mechanic even though both hold `aircraft.write`.
-- ---------------------------------------------------------------------------

INSERT INTO app_permissions (code, description) VALUES
  ('aircraft.change_regime',
   'Change the regulatory regime of an aircraft. High-blast-radius write — admin only.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO app_role_permissions (role_code, permission_code) VALUES
  ('admin', 'aircraft.change_regime')
ON CONFLICT (role_code, permission_code) DO NOTHING;
