-- 0011_create_aircraft_inspection_subscriptions.sql
-- Epic D / story D1.1 — aircraft inspection subscriptions (PMB-15).
-- Source: spec Rev. 3 §4 Epic D.
--
-- An aircraft "subscribes" to a regime-owned inspection program. The
-- subscription row carries the per-aircraft state the engine needs to
-- compute a due-at:
--
--   * last_complied_at       — when the program was most recently signed off.
--   * last_complied_airframe_time — airframe total time at last sign-off
--                                   (anchor for hour-based intervals).
--   * last_complied_cycles   — airframe cycles at last sign-off (anchor for
--                              cycle-based intervals; unused until cycles
--                              are tracked in Epic C V2+ but the slot is
--                              ready so the engine can be written once).
--
-- Due-soon thresholds are per-subscription (AC: "Due-soon thresholds are
-- configurable"), defaulting to 30 days and 10 hours. Operators commonly
-- want a wider buffer on the annual than on the 100-hour, so per-row is
-- the right grain.
--
-- The (aircraft_id, program_id) pair is unique — an aircraft is subscribed
-- to a given regime program at most once. Operators with a Part-91 plus a
-- Part-135 program on the same airframe model that as two regime programs.

CREATE TABLE aircraft_inspection_subscriptions (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  aircraft_id                   uuid NOT NULL REFERENCES aircraft(id) ON DELETE CASCADE,
  program_id                    uuid NOT NULL REFERENCES regime_inspection_program_templates(id) ON DELETE RESTRICT,
  last_complied_at              timestamptz,
  last_complied_airframe_time   numeric(10, 2),
  last_complied_cycles          integer,
  due_soon_days_threshold       integer NOT NULL DEFAULT 30,
  due_soon_hours_threshold      numeric(10, 2) NOT NULL DEFAULT 10,
  active                        boolean NOT NULL DEFAULT true,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ais_complied_airframe_nonneg
    CHECK (last_complied_airframe_time IS NULL OR last_complied_airframe_time >= 0),
  CONSTRAINT ais_complied_cycles_nonneg
    CHECK (last_complied_cycles IS NULL OR last_complied_cycles >= 0),
  CONSTRAINT ais_due_soon_days_positive
    CHECK (due_soon_days_threshold > 0),
  CONSTRAINT ais_due_soon_hours_positive
    CHECK (due_soon_hours_threshold > 0)
);

CREATE UNIQUE INDEX ais_aircraft_program_unique
  ON aircraft_inspection_subscriptions (aircraft_id, program_id);

CREATE INDEX ais_tenant_idx     ON aircraft_inspection_subscriptions (tenant_id);
CREATE INDEX ais_aircraft_idx   ON aircraft_inspection_subscriptions (aircraft_id);
CREATE INDEX ais_active_idx     ON aircraft_inspection_subscriptions (aircraft_id) WHERE active;

ALTER TABLE aircraft_inspection_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aircraft_inspection_subscriptions FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON aircraft_inspection_subscriptions
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON aircraft_inspection_subscriptions TO tenant_app;
