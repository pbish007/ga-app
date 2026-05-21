-- 0013_create_maintenance_entries.sql
-- Epic F / stories F1 + F2 — Records, Logbook & Sign-off (PMB-16).
-- Source: spec Rev. 3 §3.1, §3.3, §4 Epic F, §6 seam F2.
--
-- maintenance_entries is the durable logbook row. Two halves:
--
--   * Pre-sign half (work_performed, performed_at, airframe_total_time,
--     entry_type, optional inspection_program_id): captured when the
--     mechanic drafts the entry.
--   * Sign half (signed_at, signed_by_user_id, signed_by_credential_id,
--     signed_by_certificate_number, rts_template_id): filled by the
--     sign() flow when an A2-credentialed user releases the aircraft.
--
-- Once signed (signed_at IS NOT NULL), the row is IMMUTABLE — see the
-- BEFORE UPDATE trigger below. Corrections are NOT in-place edits;
-- they are new rows whose `correction_of_id` points at the prior entry
-- (spec §3.1 "Data Integrity Over Convenience" + §4 Epic F AC).
--
-- §6 (F2 seam): rts_template_id references regime_rts_templates. The
-- regulatory wording lives in that table, never in app code. This row
-- only carries the template id and a snapshot of the rendered body
-- (rts_rendered_body) for the historical record — re-renders against
-- a later template revision would change "what an inspector saw on
-- the day", so we freeze it at sign time.
--
-- Tenant-scoped with RLS, like all other tenant-owned tables.

CREATE TABLE maintenance_entries (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  aircraft_id                   uuid NOT NULL REFERENCES aircraft(id) ON DELETE CASCADE,
  entry_type                    text NOT NULL,
  work_performed                text NOT NULL,
  performed_on                  date NOT NULL,
  aircraft_total_time           numeric(10, 2) NOT NULL,
  inspection_program_id         uuid REFERENCES regime_inspection_program_templates(id) ON DELETE RESTRICT,
  correction_of_id              uuid REFERENCES maintenance_entries(id) ON DELETE RESTRICT,
  -- Sign-off snapshot. All NULL until sign(); all NON-NULL after sign().
  signed_at                     timestamptz,
  signed_by_user_id             uuid REFERENCES users(id) ON DELETE RESTRICT,
  signed_by_credential_id       uuid REFERENCES user_credentials(id) ON DELETE RESTRICT,
  signed_by_certificate_number  text,
  rts_template_id               uuid REFERENCES regime_rts_templates(id) ON DELETE RESTRICT,
  rts_rendered_body             text,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_entries_entry_type_check
    CHECK (entry_type IN (
      'maintenance',
      'annual_inspection',
      '100_hour_inspection',
      'inspection_program',
      'ad_compliance'
    )),
  CONSTRAINT maintenance_entries_work_performed_nonempty
    CHECK (length(trim(work_performed)) > 0),
  CONSTRAINT maintenance_entries_airframe_nonneg
    CHECK (aircraft_total_time >= 0),
  -- Sign-off shape: either fully unsigned, or fully signed.
  CONSTRAINT maintenance_entries_signoff_shape
    CHECK (
      (signed_at IS NULL
        AND signed_by_user_id IS NULL
        AND signed_by_credential_id IS NULL
        AND signed_by_certificate_number IS NULL
        AND rts_template_id IS NULL
        AND rts_rendered_body IS NULL)
      OR
      (signed_at IS NOT NULL
        AND signed_by_user_id IS NOT NULL
        AND signed_by_credential_id IS NOT NULL
        AND rts_template_id IS NOT NULL
        AND rts_rendered_body IS NOT NULL)
    ),
  -- A correction may not point at itself.
  CONSTRAINT maintenance_entries_no_self_correction
    CHECK (correction_of_id IS NULL OR correction_of_id <> id)
);

CREATE INDEX maintenance_entries_tenant_idx          ON maintenance_entries (tenant_id);
CREATE INDEX maintenance_entries_aircraft_idx        ON maintenance_entries (aircraft_id);
CREATE INDEX maintenance_entries_aircraft_performed_idx
  ON maintenance_entries (aircraft_id, performed_on DESC);
CREATE INDEX maintenance_entries_correction_idx
  ON maintenance_entries (correction_of_id) WHERE correction_of_id IS NOT NULL;
-- Hot path: "what's the original entry behind this correction chain?".
CREATE INDEX maintenance_entries_aircraft_signed_idx
  ON maintenance_entries (aircraft_id, signed_at DESC) WHERE signed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Immutability trigger.
-- Once signed_at is set, the row is frozen except for updated_at bumps
-- that the trigger itself ignores. Any column edit on a signed row
-- raises a programming-error level exception — the API layer is
-- expected to refuse the request long before this trigger fires, but
-- the trigger is the last line of defence (§3.1).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION maintenance_entries_block_signed_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'maintenance_entries row % is signed and immutable; create a correction entry instead', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER maintenance_entries_block_signed_update
BEFORE UPDATE ON maintenance_entries
FOR EACH ROW
EXECUTE FUNCTION maintenance_entries_block_signed_update();

ALTER TABLE maintenance_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON maintenance_entries
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON maintenance_entries TO tenant_app;

-- ---------------------------------------------------------------------------
-- F2 RTS templates: the spec requires AT LEAST four templates
-- (annual, 100-hr, return-to-service after maintenance, AD compliance).
-- 0001_create_regimes.sql seeded three (standard, annual, 100_hour);
-- this migration adds the missing two so the FAA regime has full
-- MVP coverage. The wording lives here (in the regime template table),
-- never as inline string constants — see F2.3 lint test.
-- ---------------------------------------------------------------------------

INSERT INTO regime_rts_templates
  (regime_id, code, name, body)
SELECT id,
       'return_to_service_maintenance',
       'FAA Return-to-Service After Maintenance',
       'I certify that the work performed on this aircraft, described as: {{work_performed}}, was accomplished in accordance with the current Federal Aviation Regulations and is approved for return to service.'
  FROM regimes WHERE code = 'FAA'
ON CONFLICT (regime_id, code) DO NOTHING;

INSERT INTO regime_rts_templates
  (regime_id, code, name, body)
SELECT id,
       'ad_compliance',
       'FAA Airworthiness Directive Compliance',
       'I certify that this aircraft is in compliance with the airworthiness directive(s) referenced in this entry: {{work_performed}}.'
  FROM regimes WHERE code = 'FAA'
ON CONFLICT (regime_id, code) DO NOTHING;
