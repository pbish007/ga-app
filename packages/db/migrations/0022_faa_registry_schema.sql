-- FAA Registry schema (PMB-104 R0)
-- @scope: faa-supabase
-- Lives in a separate Supabase project (FAA_DATABASE_URL), NOT the tenant DB.
-- This migration is checked into the monorepo for documentation and can be
-- applied to the FAA Supabase project via the provisioning runbook.

create schema if not exists faa_registry;

-- Current snapshot: one row per N-number, upserted daily
create table faa_registry.aircraft_registry_current (
  n_number          text primary key,        -- FAA N-number without leading N
  serial_number     text,
  mfr_mdl_code      text,                    -- FK into acftref
  eng_mfr_mdl       text,                    -- FK into engines
  year_mfr          smallint,
  type_registrant   smallint,
  name              text,
  street            text,
  street2           text,
  city              text,
  state             text,
  zip_code          text,
  region            text,
  county            text,
  country           text,
  last_action_date  date,
  cert_issue_date   date,
  certification     text,
  type_aircraft     smallint,
  type_engine       smallint,
  status_code       text,
  mode_s_code       text,
  fract_owner       text,
  air_worth_date    date,
  other_names_1     text,
  other_names_2     text,
  other_names_3     text,
  other_names_4     text,
  other_names_5     text,
  expiration_date   date,
  unique_id         text,
  kit_mfr           text,
  kit_model         text,
  mode_s_code_hex   text,
  snapshot_date     date not null,
  updated_at        timestamptz not null default now()
);

-- Full history: one row per (n_number, snapshot_date)
create table faa_registry.aircraft_registry_history (
  id                bigserial primary key,
  n_number          text not null,
  snapshot_date     date not null,
  row_data          jsonb not null,
  unique (n_number, snapshot_date)
);

-- Change log: field-level diffs between adjacent snapshots
create table faa_registry.aircraft_changes (
  id                bigserial primary key,
  n_number          text not null,
  detected_date     date not null,
  field_name        text not null,
  old_value         text,
  new_value         text,
  created_at        timestamptz not null default now()
);
create index on faa_registry.aircraft_changes (n_number, detected_date desc);

-- Tracks each daily snapshot: R2 ETag fingerprints + record counts
create table faa_registry.snapshot_manifest (
  snapshot_date     date primary key,
  r2_prefix         text not null,            -- e.g. raw/2026-06-03
  master_etag       text,
  acftref_etag      text,
  engine_etag       text,
  dealer_etag       text,
  dereg_etag        text,
  master_count      integer,
  dereg_count       integer,
  created_at        timestamptz not null default now()
);

-- Pipeline run log: one row per GH Actions trigger
create table faa_registry.pipeline_runs (
  id                bigserial primary key,
  run_id            text unique,              -- GH Actions run ID
  snapshot_date     date,
  status            text not null check (status in ('running','done','failed')),
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  error_message     text,
  records_upserted  integer,
  changes_detected  integer
);
