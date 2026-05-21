-- 0007_create_aircraft.sql
-- Epic B / story B1.1 — aircraft profile (PMB-11).
-- Source: spec Rev. 3 §4 Epic B, §6 ("Do This Now" — B1/K2 row);
-- regime contract: ADR-002 on PMB-8.
--
-- The aircraft table is where the K2 regime seam makes its operational
-- debut. EVERY aircraft row carries `regime_id` from this first
-- migration — NOT NULL, NO DEFAULT, REFERENCES regimes(id). Adding a
-- second regime (e.g. CARS) later is then a data project, not a
-- schema migration.
--
-- Tenant scoping:
--   * tenant_id REFERENCES organizations(id) ON DELETE CASCADE — when
--     an org is deleted, its aircraft go with it.
--   * Registration (N-number) is unique per tenant via a UNIQUE index
--     on (tenant_id, lower(registration)) — two different tenants may
--     each track an aircraft with the same registration (e.g. a club
--     and a shop both have records for the same airframe).
--   * RLS enabled + forced; policy added below as `app_isolation`,
--     gated by the same `app.current_tenant_id` GUC + `tenant_app`
--     role as the rest of the tenant tables (migration 0004).
--
-- The compliance engine (Epic D) reads `airframe_total_time` and
-- `time_source` to compute when hour-based inspections (e.g. 100-hour)
-- are due, so both are first-class columns rather than free-text.

CREATE TABLE aircraft (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  regime_id             uuid NOT NULL REFERENCES regimes(id) ON DELETE RESTRICT,
  registration          text NOT NULL,
  make                  text NOT NULL,
  model                 text NOT NULL,
  serial_number         text NOT NULL,
  year_manufactured     integer,
  category              text NOT NULL,
  aircraft_class        text NOT NULL,
  airframe_total_time   numeric(10, 2) NOT NULL DEFAULT 0,
  time_source           text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aircraft_time_source_check
    CHECK (time_source IN ('hobbs', 'tach')),
  CONSTRAINT aircraft_airframe_total_time_nonneg
    CHECK (airframe_total_time >= 0),
  CONSTRAINT aircraft_year_manufactured_range
    CHECK (year_manufactured IS NULL OR (year_manufactured BETWEEN 1900 AND 2100))
);

-- N-number uniqueness scoped per tenant. Lowercased so 'N12345' and
-- 'n12345' collide.
CREATE UNIQUE INDEX aircraft_tenant_registration_unique
  ON aircraft (tenant_id, lower(registration));

CREATE INDEX aircraft_tenant_idx ON aircraft (tenant_id);
CREATE INDEX aircraft_regime_idx ON aircraft (regime_id);

ALTER TABLE aircraft ENABLE ROW LEVEL SECURITY;
ALTER TABLE aircraft FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON aircraft
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON aircraft TO tenant_app;
