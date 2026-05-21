-- 0012_create_squawks.sql
-- Epic E / story E1.1 — squawk schema + severity ladder (PMB-13).
-- Source: spec Rev. 3 §4 Epic E.
--
-- A squawk is a pilot-side discrepancy report. The MVP definition (epic
-- E1) requires:
--
--   * description (free text)
--   * occurred_at  (date the discrepancy was observed; pilots back-fill
--                   the next morning so "now" is wrong)
--   * reporter     (user_id; nullable so a CSV import or a future
--                   delegated entry path is not blocked)
--   * severity     (controlled vocabulary, ladder below)
--   * optional photos via documents (J2.1 generic store)
--
-- Severity ladder (`squawk_severity_check`):
--   * informational — note only; no airworthiness impact.
--   * deferred      — discrepancy acknowledged, work deferred per MEL/
--                     operator policy; aircraft is still airworthy.
--   * grounding     — discrepancy renders the aircraft NOT airworthy.
--                     E1.3 propagates this to the dashboard airworthiness
--                     indicator (an open grounding squawk flips the
--                     aircraft to "overdue"-equivalent, i.e. not airworthy).
--
-- An additional `status` column ('open' | 'resolved') is the gate for
-- propagation: only `status = 'open'` grounding squawks count against
-- airworthiness. Resolving a squawk requires `resolved_at` and
-- `resolved_by_user_id`; a resolution_notes column captures the corrective
-- action narrative. Resolution does not delete the squawk — the audit
-- trail is permanent (spec §3.1 "Data Integrity Over Convenience").
--
-- Photos live in `documents` (J2.1). The `squawk_photos` join table
-- preserves the multi-photo-per-squawk shape without overloading the
-- documents row with a polymorphic FK. The join row carries tenant_id
-- for RLS and a UNIQUE(squawk_id, document_id) so the same blob cannot
-- be attached twice.

-- ---------------------------------------------------------------------------
-- squawks
-- ---------------------------------------------------------------------------

CREATE TABLE squawks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  aircraft_id            uuid NOT NULL REFERENCES aircraft(id) ON DELETE CASCADE,
  description            text NOT NULL,
  occurred_at            timestamptz NOT NULL,
  reporter_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  severity               text NOT NULL,
  status                 text NOT NULL DEFAULT 'open',
  resolved_at            timestamptz,
  resolved_by_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution_notes       text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT squawks_severity_check
    CHECK (severity IN ('informational', 'deferred', 'grounding')),
  CONSTRAINT squawks_status_check
    CHECK (status IN ('open', 'resolved')),
  CONSTRAINT squawks_description_nonempty
    CHECK (length(trim(description)) > 0),
  -- A resolved squawk must carry a resolved_at; an open squawk must not.
  CONSTRAINT squawks_resolved_shape
    CHECK (
      (status = 'open'      AND resolved_at IS NULL  AND resolved_by_user_id IS NULL)
      OR
      (status = 'resolved'  AND resolved_at IS NOT NULL)
    )
);

CREATE INDEX squawks_tenant_idx       ON squawks (tenant_id);
CREATE INDEX squawks_aircraft_idx     ON squawks (aircraft_id);
CREATE INDEX squawks_aircraft_open_idx
  ON squawks (aircraft_id) WHERE status = 'open';
-- Partial index targeting the "is this aircraft grounded?" lookup
-- that E1.3 propagation runs on every dashboard render.
CREATE INDEX squawks_aircraft_grounding_open_idx
  ON squawks (aircraft_id)
  WHERE status = 'open' AND severity = 'grounding';
CREATE INDEX squawks_occurred_at_idx ON squawks (aircraft_id, occurred_at DESC);

ALTER TABLE squawks ENABLE ROW LEVEL SECURITY;
ALTER TABLE squawks FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON squawks
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON squawks TO tenant_app;

-- ---------------------------------------------------------------------------
-- squawk_photos — join table to documents (J2.1 generic store)
-- ---------------------------------------------------------------------------

CREATE TABLE squawk_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  squawk_id     uuid NOT NULL REFERENCES squawks(id) ON DELETE CASCADE,
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX squawk_photos_squawk_document_unique
  ON squawk_photos (squawk_id, document_id);
CREATE INDEX squawk_photos_tenant_idx   ON squawk_photos (tenant_id);
CREATE INDEX squawk_photos_squawk_idx   ON squawk_photos (squawk_id);
CREATE INDEX squawk_photos_document_idx ON squawk_photos (document_id);

ALTER TABLE squawk_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE squawk_photos FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON squawk_photos
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON squawk_photos TO tenant_app;
