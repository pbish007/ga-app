-- 0001_create_regimes.sql
-- Regulatory Regime Framework spine (PMB-8 / Epic K, spec Rev. 3 §3.2, §4 Epic K, §6).
--
-- Creates the `regimes` table and its five child template/reference tables,
-- then seeds exactly one regime row (FAA) with its FAA-specific templates,
-- directive sources, credential types, return-to-service templates, and
-- retention rules.
--
-- A second regime (e.g. Canada CARS) can be added as pure data — see the
-- regime-package test `regime.test.ts` and the ADR on PMB-8.
--
-- `gen_random_uuid()` is built into Postgres 13+ core; no extension required.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

CREATE TABLE regimes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  jurisdiction    text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE regime_inspection_program_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regime_id       uuid NOT NULL REFERENCES regimes(id) ON DELETE RESTRICT,
  code            text NOT NULL,
  name            text NOT NULL,
  cadence_kind    text NOT NULL,
  interval_value  numeric,
  interval_unit   text,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX regime_inspection_program_templates_code
  ON regime_inspection_program_templates (regime_id, code);

CREATE TABLE regime_directive_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regime_id       uuid NOT NULL REFERENCES regimes(id) ON DELETE RESTRICT,
  code            text NOT NULL,
  name            text NOT NULL,
  source_uri      text,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX regime_directive_sources_code
  ON regime_directive_sources (regime_id, code);

CREATE TABLE regime_credential_types (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regime_id       uuid NOT NULL REFERENCES regimes(id) ON DELETE RESTRICT,
  code            text NOT NULL,
  name            text NOT NULL,
  authorizes_signoff boolean NOT NULL DEFAULT false,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX regime_credential_types_code
  ON regime_credential_types (regime_id, code);

CREATE TABLE regime_rts_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regime_id       uuid NOT NULL REFERENCES regimes(id) ON DELETE RESTRICT,
  code            text NOT NULL,
  name            text NOT NULL,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX regime_rts_templates_code
  ON regime_rts_templates (regime_id, code);

CREATE TABLE regime_retention_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regime_id       uuid NOT NULL REFERENCES regimes(id) ON DELETE RESTRICT,
  record_kind     text NOT NULL,
  retention_period_kind  text NOT NULL,
  retention_period_value integer,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX regime_retention_rules_record_kind
  ON regime_retention_rules (regime_id, record_kind);

-- ---------------------------------------------------------------------------
-- Seed: FAA (Federal Aviation Administration, United States).
-- Every regulatory citation below points to the source-of-truth document.
-- App code MUST NOT contain literal "FAA" strings for behavior; it reads
-- the regime row by id and the templates/sources/types/etc. from these
-- child tables.
-- ---------------------------------------------------------------------------

INSERT INTO regimes (code, name, jurisdiction)
VALUES ('FAA', 'Federal Aviation Administration', 'United States of America');

-- Inspection program templates (14 CFR §§91.409, 91.411, 91.413, 91.207).
INSERT INTO regime_inspection_program_templates
  (regime_id, code, name, cadence_kind, interval_value, interval_unit, description)
SELECT id, 'annual', 'Annual Inspection',
       'calendar', 12, 'months',
       '14 CFR §91.409(a)(1): required every 12 calendar months for most aircraft.'
  FROM regimes WHERE code = 'FAA';

INSERT INTO regime_inspection_program_templates
  (regime_id, code, name, cadence_kind, interval_value, interval_unit, description)
SELECT id, '100_hour', '100-Hour Inspection',
       'hourly', 100, 'hours',
       '14 CFR §91.409(b): required when aircraft is carrying persons (other than crew) for hire or given for hire.'
  FROM regimes WHERE code = 'FAA';

INSERT INTO regime_inspection_program_templates
  (regime_id, code, name, cadence_kind, interval_value, interval_unit, description)
SELECT id, 'progressive', 'Progressive Inspection',
       'custom', NULL, NULL,
       '14 CFR §91.409(d): FAA-approved alternative to the annual/100-hour cycle.'
  FROM regimes WHERE code = 'FAA';

INSERT INTO regime_inspection_program_templates
  (regime_id, code, name, cadence_kind, interval_value, interval_unit, description)
SELECT id, 'transponder', 'Transponder & Mode S Test',
       'calendar', 24, 'months',
       '14 CFR §91.413: required every 24 calendar months for transponder-equipped aircraft.'
  FROM regimes WHERE code = 'FAA';

INSERT INTO regime_inspection_program_templates
  (regime_id, code, name, cadence_kind, interval_value, interval_unit, description)
SELECT id, 'pitot_static', 'Pitot-Static System Test',
       'calendar', 24, 'months',
       '14 CFR §91.411: required every 24 calendar months for IFR-operated aircraft.'
  FROM regimes WHERE code = 'FAA';

INSERT INTO regime_inspection_program_templates
  (regime_id, code, name, cadence_kind, interval_value, interval_unit, description)
SELECT id, 'altimeter', 'Altimeter System Test',
       'calendar', 24, 'months',
       '14 CFR §91.411: required every 24 calendar months for IFR-operated aircraft.'
  FROM regimes WHERE code = 'FAA';

INSERT INTO regime_inspection_program_templates
  (regime_id, code, name, cadence_kind, interval_value, interval_unit, description)
SELECT id, 'elt', 'ELT Inspection',
       'calendar', 12, 'months',
       '14 CFR §91.207: emergency locator transmitter inspection every 12 calendar months; battery replacement tracked separately.'
  FROM regimes WHERE code = 'FAA';

-- Directive sources.
INSERT INTO regime_directive_sources
  (regime_id, code, name, source_uri, description)
SELECT id, 'ad', 'Airworthiness Directive',
       'https://www.faa.gov/regulations_policies/airworthiness_directives/',
       'Mandatory FAA-issued airworthiness directives. Compliance is regulatory.'
  FROM regimes WHERE code = 'FAA';

INSERT INTO regime_directive_sources
  (regime_id, code, name, source_uri, description)
SELECT id, 'sb', 'Manufacturer Service Bulletin',
       NULL,
       'Manufacturer-issued service bulletins; compliance may be mandatory for commercial operators or via AD reference.'
  FROM regimes WHERE code = 'FAA';

-- Credential types (14 CFR Part 65).
INSERT INTO regime_credential_types
  (regime_id, code, name, authorizes_signoff, description)
SELECT id, 'ap', 'Airframe & Powerplant (A&P)', true,
       'FAA A&P mechanic; may approve return to service for most preventive and routine maintenance (14 CFR §43.7).'
  FROM regimes WHERE code = 'FAA';

INSERT INTO regime_credential_types
  (regime_id, code, name, authorizes_signoff, description)
SELECT id, 'ia', 'Inspection Authorization (IA)', true,
       'A&P with Inspection Authorization; required for annual inspections and major repair/alteration approval (14 CFR §65.95).'
  FROM regimes WHERE code = 'FAA';

INSERT INTO regime_credential_types
  (regime_id, code, name, authorizes_signoff, description)
SELECT id, 'repairman', 'Repairman Certificate', true,
       'Limited repairman certificate; scope set by the certificate (e.g., light-sport, experimental) (14 CFR §65.103).'
  FROM regimes WHERE code = 'FAA';

-- Return-to-service templates. Regulatory wording lives here, never in app code.
INSERT INTO regime_rts_templates
  (regime_id, code, name, body)
SELECT id, 'standard', 'Standard FAA Return-to-Service',
       'I certify that this aircraft has been inspected in accordance with {{inspection_program_name}} and was determined to be in airworthy condition.'
  FROM regimes WHERE code = 'FAA';

INSERT INTO regime_rts_templates
  (regime_id, code, name, body)
SELECT id, 'annual', 'FAA Annual Inspection Sign-off',
       'I certify that this aircraft has been inspected in accordance with an annual inspection and was determined to be in airworthy condition.'
  FROM regimes WHERE code = 'FAA';

INSERT INTO regime_rts_templates
  (regime_id, code, name, body)
SELECT id, '100_hour', 'FAA 100-Hour Inspection Sign-off',
       'I certify that this aircraft has been inspected in accordance with a 100-hour inspection and was determined to be in airworthy condition.'
  FROM regimes WHERE code = 'FAA';

-- Retention rules (14 CFR §91.417).
INSERT INTO regime_retention_rules
  (regime_id, record_kind, retention_period_kind, retention_period_value, description)
SELECT id, 'maintenance_log', 'years', 1,
       '14 CFR §91.417(b)(1): minimum 1 year, or until work is repeated/superseded.'
  FROM regimes WHERE code = 'FAA';

INSERT INTO regime_retention_rules
  (regime_id, record_kind, retention_period_kind, retention_period_value, description)
SELECT id, 'annual_inspection', 'lifetime', NULL,
       '14 CFR §91.417(b)(2): retained for the life of the aircraft.'
  FROM regimes WHERE code = 'FAA';

INSERT INTO regime_retention_rules
  (regime_id, record_kind, retention_period_kind, retention_period_value, description)
SELECT id, 'major_repair', 'lifetime', NULL,
       '14 CFR §91.417(b)(2): retained for the life of the aircraft.'
  FROM regimes WHERE code = 'FAA';

INSERT INTO regime_retention_rules
  (regime_id, record_kind, retention_period_kind, retention_period_value, description)
SELECT id, 'ad_compliance', 'lifetime', NULL,
       '14 CFR §91.417(b)(2): airworthiness directive compliance records retained for the life of the aircraft.'
  FROM regimes WHERE code = 'FAA';
