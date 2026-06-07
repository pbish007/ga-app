-- 0033_aircraft_faa_field_decisions.sql
-- PMB-109 (R4) — backend storage for per-field FAA prefill decisions.
-- Lives in the tenant DB (DATABASE_URL), NOT the FAA Supabase project.
--
-- Why a separate table (not columns on `aircraft`):
--   The UX pattern in PMB-112 settles on per-field decisions ("accept FAA
--   model, keep my serial, report owner wrong"). Stuffing this into the
--   aircraft row would mean one decision-column per FAA-prefillable
--   field × decision kind × hash-pin — a wide, sparse table that fights
--   the per-field grain. A side table keeps the aircraft row clean,
--   makes the audit shape obvious, and lets the field set grow without
--   another aircraft migration each time.
--
-- One row per (aircraft, field_key) holding the LATEST decision; older
-- decisions are overwritten by the UPSERT. The decision log doubles as
-- a sync-side anti-nag oracle (AC3 in the PMB-112 ux-pattern): when the
-- daily FAA sync sees a value differ, it compares against
-- last_declined_faa_value_hash to decide whether to re-open the chip.
--
-- The hash is stored as text (sha256 hex); we never need to compute it
-- in SQL — it's produced by the application before write — so a plain
-- text column is fine and keeps the schema portable to pglite tests.

CREATE TABLE aircraft_faa_field_decisions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  aircraft_id                 uuid NOT NULL REFERENCES aircraft(id) ON DELETE CASCADE,
  -- Denormalized to support pipeline-side sync queries that only know the
  -- N-number, without forcing a join through `aircraft`.
  n_number                    text NOT NULL,
  field_key                   text NOT NULL,
  decision                    text NOT NULL,
  -- The FAA value at the time of decision. NULL is legal when decision
  -- is `tenant_wins` over a now-empty FAA field (rare but possible if
  -- the registry value clears on a later sync — see AC3).
  faa_value                   text,
  -- sha256(faa_value) at decision time, lowercase hex. Required for the
  -- anti-nag invariant (AC3): the sync compares hash(new_faa_value) to
  -- this before re-opening a chip.
  faa_value_hash              text NOT NULL,
  -- The tenant-saved value at the time of decision. Helpful for the
  -- audit trail; not used for sync gating.
  tenant_value                text,
  report_reason               text,
  report_note                 text,
  decided_by_user_id          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decided_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aircraft_faa_field_decisions_decision_check
    CHECK (decision IN ('accepted_faa', 'tenant_wins', 'faa_reported_wrong')),

  CONSTRAINT aircraft_faa_field_decisions_report_reason_check
    CHECK (report_reason IS NULL OR report_reason IN ('registry_typo','stale_data','wrong_tail','other')),

  -- Shape invariant: reports must carry a reason; non-reports must not.
  -- The note is free-text, optional even for reports, and length-capped
  -- at 280 chars matching the UX spec's textarea limit.
  CONSTRAINT aircraft_faa_field_decisions_report_shape
    CHECK (
      (decision = 'faa_reported_wrong' AND report_reason IS NOT NULL)
      OR
      (decision <> 'faa_reported_wrong' AND report_reason IS NULL AND report_note IS NULL)
    ),

  CONSTRAINT aircraft_faa_field_decisions_report_note_len
    CHECK (report_note IS NULL OR char_length(report_note) <= 280),

  -- Hash must be 64 lowercase hex chars (sha256 hex).
  CONSTRAINT aircraft_faa_field_decisions_hash_shape
    CHECK (faa_value_hash ~ '^[0-9a-f]{64}$'),

  -- One latest decision per (aircraft, field). UPSERT key.
  CONSTRAINT aircraft_faa_field_decisions_aircraft_field_unique
    UNIQUE (aircraft_id, field_key)
);

CREATE INDEX aircraft_faa_field_decisions_tenant_idx
  ON aircraft_faa_field_decisions (tenant_id);
CREATE INDEX aircraft_faa_field_decisions_n_number_idx
  ON aircraft_faa_field_decisions (n_number);

ALTER TABLE aircraft_faa_field_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aircraft_faa_field_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY app_isolation ON aircraft_faa_field_decisions
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON aircraft_faa_field_decisions TO tenant_app;
