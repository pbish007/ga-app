-- 0010_create_inspection_program_intervals.sql
-- Epic D / story D1.1 — inspection-program intervals (PMB-15).
-- Source: spec Rev. 3 §4 Epic D, §6 ("Do This Now" — D1 row).
--
-- A regime-owned program (annual, 100-hour, transponder, ...) can fire
-- on hour-based, calendar-based, cycle-based, or whichever-comes-first
-- intervals. Migration 0001 modelled the interval inline on the parent
-- template, which cannot represent the whichever-comes-first case
-- without ad-hoc encoding. This migration replaces that with a child
-- table that holds 1..N interval rows per program:
--
--   * intervals.length === 1 → single-interval program (e.g. annual).
--   * intervals.length >  1 → whichever-comes-first program.
--   * intervals.length === 0 → custom (operator defines per aircraft;
--     e.g. progressive inspection programs filed under §91.409(d)).
--
-- The interval engine (story D1.2) is regime-agnostic: it iterates the
-- interval rows, computes a due-at per interval, and takes the earliest.
-- App code does not branch on cadence_kind for behavior — that column
-- is a categorical hint for the operator UI.

CREATE TABLE regime_inspection_program_intervals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     uuid NOT NULL REFERENCES regime_inspection_program_templates(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  value           numeric NOT NULL,
  unit            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT regime_inspection_program_intervals_kind_check
    CHECK (kind IN ('hour', 'calendar', 'cycle')),
  CONSTRAINT regime_inspection_program_intervals_value_positive
    CHECK (value > 0)
);

CREATE UNIQUE INDEX regime_inspection_program_intervals_template_kind_unit
  ON regime_inspection_program_intervals (template_id, kind, unit);

CREATE INDEX regime_inspection_program_intervals_template_idx
  ON regime_inspection_program_intervals (template_id);

-- ---------------------------------------------------------------------------
-- Backfill: lift the inline (interval_value, interval_unit) on existing
-- single-interval rows into the new child table. The seeded FAA programs
-- from 0001 are annual/100-hour/transponder/pitot/altimeter/elt (single
-- intervals) and progressive (custom, no intervals).
-- ---------------------------------------------------------------------------

INSERT INTO regime_inspection_program_intervals (template_id, kind, value, unit)
SELECT id,
       CASE cadence_kind
         WHEN 'hourly'   THEN 'hour'
         WHEN 'calendar' THEN 'calendar'
       END,
       interval_value,
       interval_unit
  FROM regime_inspection_program_templates
 WHERE cadence_kind IN ('hourly', 'calendar')
   AND interval_value IS NOT NULL
   AND interval_unit  IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Renormalise cadence_kind into the post-migration categorical vocabulary.
-- ---------------------------------------------------------------------------

UPDATE regime_inspection_program_templates
   SET cadence_kind = CASE
     WHEN cadence_kind IN ('hourly', 'calendar') THEN 'single'
     ELSE 'custom'
   END;

ALTER TABLE regime_inspection_program_templates
  DROP COLUMN interval_value,
  DROP COLUMN interval_unit;

ALTER TABLE regime_inspection_program_templates
  ADD CONSTRAINT regime_inspection_program_templates_cadence_kind_check
  CHECK (cadence_kind IN ('single', 'whichever_comes_first', 'custom'));
