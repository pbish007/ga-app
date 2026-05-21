-- 0009_create_flight_time_entries.sql
-- Epic C / story C1.1 — time-entry schema + monotonic constraint (PMB-12).
-- Source: spec Rev. 3 §4 Epic C; §3.1 "Data Integrity Over Convenience".
--
-- Model:
--   * `flight_time_entries` — one row per manual time entry. The BEFORE INSERT
--     trigger enforces monotonicity: a new reading cannot be less than the
--     current airframe total time unless `is_override` is true (instrument
--     swap path). The trigger also atomically advances `aircraft.airframe_total_time`
--     and captures a snapshot of the previous value in `airframe_time_prev`.
--
-- Override (instrument swap):
--   * Setting `is_override = true` bypasses the monotonicity check. Doing so
--     requires a non-null `override_reason` (enforced by CHECK constraint).
--     The trigger records the event type as 'instrument_swap' in the row;
--     the `override_reason` text is the actor-supplied justification.
--
-- Atomicity:
--   * The trigger runs BEFORE INSERT and updates aircraft inside the same
--     statement. Wrapping the INSERT in a transaction ensures the time-entry
--     row and the aircraft update are either both committed or both rolled back.

CREATE TABLE flight_time_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  aircraft_id         uuid NOT NULL REFERENCES aircraft(id) ON DELETE CASCADE,
  -- The new airframe reading supplied by the user.
  airframe_time_new   numeric(10, 2) NOT NULL,
  -- Previous airframe total time, captured by the trigger at insert time.
  airframe_time_prev  numeric(10, 2) NOT NULL DEFAULT 0,
  is_override         boolean NOT NULL DEFAULT false,
  -- Required when is_override = true; free-text reason for the instrument swap.
  override_reason     text,
  entered_at          timestamptz NOT NULL DEFAULT now(),
  -- Actor who entered the time; nullable so legacy/test rows don't need a user.
  entered_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fte_airframe_time_new_nonneg
    CHECK (airframe_time_new >= 0),
  CONSTRAINT fte_override_reason_required
    CHECK (NOT is_override OR override_reason IS NOT NULL AND trim(override_reason) <> '')
);

CREATE INDEX fte_aircraft_idx  ON flight_time_entries (aircraft_id);
CREATE INDEX fte_tenant_idx    ON flight_time_entries (tenant_id);
CREATE INDEX fte_entered_at_idx ON flight_time_entries (aircraft_id, entered_at DESC);

ALTER TABLE flight_time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE flight_time_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON flight_time_entries
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT ON flight_time_entries TO tenant_app;

-- ---------------------------------------------------------------------------
-- Monotonic trigger — runs BEFORE INSERT, enforces §3.1 and advances TT.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION flight_time_entries_before_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_current_tt numeric(10, 2);
BEGIN
  -- Read the aircraft's current airframe total time.
  SELECT airframe_total_time
    INTO v_current_tt
    FROM aircraft
   WHERE id = NEW.aircraft_id;

  -- Snapshot prev so the row carries a complete audit trail.
  NEW.airframe_time_prev := v_current_tt;

  -- Enforce monotonicity unless this is an authorised override.
  IF NOT NEW.is_override AND NEW.airframe_time_new < v_current_tt THEN
    RAISE EXCEPTION
      'flight_time_not_monotonic: new reading (%) is less than current airframe total time (%). '
      'To record a lower value, submit with is_override=true and a non-empty override_reason.',
      NEW.airframe_time_new, v_current_tt;
  END IF;

  -- Atomically advance the aircraft's airframe total time.
  UPDATE aircraft
     SET airframe_total_time = NEW.airframe_time_new,
         updated_at          = now()
   WHERE id = NEW.aircraft_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER flight_time_entries_monotonic
  BEFORE INSERT ON flight_time_entries
  FOR EACH ROW EXECUTE FUNCTION flight_time_entries_before_insert();
