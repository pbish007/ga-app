-- 0008_create_components.sql
-- Epic B / story B2.1 — components + installation history (PMB-11).
-- Source: spec Rev. 3 §4 Epic B; B2 acceptance criteria.
--
-- Model:
--   * `components` — the durable identity of a physical component
--     (engine, propeller, generic appliance). Owned by a tenant; carries
--     its applicable limits (TBO hours, calendar months, cycles).
--   * `component_installations` — one row per install/remove event,
--     pinning the component to an aircraft from `installed_at` to
--     `removed_at`. The active installation is the row with NULL
--     `removed_at`; a partial unique index ensures a component can be on
--     at most one aircraft at a time.
--
-- The install row captures the aircraft airframe total time AT the
-- moment of installation, so the compliance engine (Epic D) can compute
-- component time-since-install without replaying flight history.
--
-- Removing a component sets `removed_at` (and the matching aircraft
-- total time). The component row itself is never destroyed — the spec
-- requires that history is preserved across remove/reinstall.

CREATE TABLE components (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind                  text NOT NULL,
  serial_number         text NOT NULL,
  make                  text,
  model                 text,
  tbo_hours             numeric(10, 2),
  tbo_calendar_months   integer,
  cycle_limit           integer,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT components_kind_check
    CHECK (kind IN ('engine', 'propeller', 'appliance')),
  CONSTRAINT components_tbo_hours_pos
    CHECK (tbo_hours IS NULL OR tbo_hours > 0),
  CONSTRAINT components_tbo_calendar_pos
    CHECK (tbo_calendar_months IS NULL OR tbo_calendar_months > 0),
  CONSTRAINT components_cycle_limit_pos
    CHECK (cycle_limit IS NULL OR cycle_limit > 0)
);

-- Serial-number uniqueness is per-tenant and per-kind. The same serial
-- on an "engine" vs an "appliance" is allowed (rare but real); two
-- engines with the same serial in the same tenant is not.
CREATE UNIQUE INDEX components_tenant_kind_serial_unique
  ON components (tenant_id, kind, lower(serial_number));

CREATE INDEX components_tenant_idx ON components (tenant_id);

ALTER TABLE components ENABLE ROW LEVEL SECURITY;
ALTER TABLE components FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON components
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON components TO tenant_app;

-- ---------------------------------------------------------------------------
-- component_installations — install/remove history.
-- ---------------------------------------------------------------------------

CREATE TABLE component_installations (
  id                                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  component_id                       uuid NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  aircraft_id                        uuid NOT NULL REFERENCES aircraft(id) ON DELETE CASCADE,
  installed_at                       timestamptz NOT NULL,
  installed_at_aircraft_total_time   numeric(10, 2) NOT NULL,
  removed_at                         timestamptz,
  removed_at_aircraft_total_time     numeric(10, 2),
  notes                              text,
  created_at                         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT component_installations_removed_consistency
    CHECK ((removed_at IS NULL) = (removed_at_aircraft_total_time IS NULL)),
  CONSTRAINT component_installations_removed_after_installed
    CHECK (removed_at IS NULL OR removed_at >= installed_at),
  CONSTRAINT component_installations_install_tt_nonneg
    CHECK (installed_at_aircraft_total_time >= 0),
  CONSTRAINT component_installations_remove_tt_gte_install
    CHECK (removed_at_aircraft_total_time IS NULL
        OR removed_at_aircraft_total_time >= installed_at_aircraft_total_time)
);

-- A component can have at most one active installation. Partial unique
-- index because the constraint only applies to rows with NULL removed_at.
CREATE UNIQUE INDEX component_installations_active_unique
  ON component_installations (component_id)
  WHERE removed_at IS NULL;

CREATE INDEX component_installations_aircraft_active_idx
  ON component_installations (aircraft_id)
  WHERE removed_at IS NULL;

CREATE INDEX component_installations_component_idx
  ON component_installations (component_id);

CREATE INDEX component_installations_tenant_idx
  ON component_installations (tenant_id);

ALTER TABLE component_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE component_installations FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON component_installations
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON component_installations TO tenant_app;
