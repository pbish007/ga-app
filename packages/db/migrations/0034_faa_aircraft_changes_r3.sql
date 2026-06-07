-- FAA Registry: R3 change-detection table (PMB-107).
-- Lives in the FAA Supabase project (FAA_DATABASE_URL), NOT the tenant DB.
--
-- Drop+recreate is safe because the 0022 `aircraft_changes` table holds
-- zero rows today (no change-detection job has ever run). Forward-only.
--
-- Schema deltas vs. 0022:
--   * `detected_date` -> `snapshot_date` (matches the rest of the pipeline).
--   * Added `change_type` text with CHECK constraint.
--   * `old_value` / `new_value` switched to jsonb so a single row can carry
--     multi-field address bundles (e.g. street + city + zip changing in one
--     transfer) and structured ownership records.
--   * Unique (n_number, snapshot_date, change_type) for idempotency.

drop table if exists faa_registry.aircraft_changes;

create table faa_registry.aircraft_changes (
  id            bigserial primary key,
  n_number      text not null,
  snapshot_date date not null,
  change_type   text not null check (change_type in (
    'new_registration',
    'ownership_transfer',
    'address_change',
    'expiration_change',
    'airworthiness_change',
    'deregistration'
  )),
  old_value     jsonb,
  new_value     jsonb,
  created_at    timestamptz not null default now(),
  unique (n_number, snapshot_date, change_type)
);

create index aircraft_changes_nn_snapshot_desc
  on faa_registry.aircraft_changes (n_number, snapshot_date desc);

create index aircraft_changes_snapshot_type
  on faa_registry.aircraft_changes (snapshot_date, change_type);

-- Extend snapshot_manifest with R3 bookkeeping. Same idempotent pattern as
-- 0032: ALL columns are nullable + `add column if not exists` so re-runs
-- against an already-migrated DB are safe.
alter table faa_registry.snapshot_manifest
  add column if not exists changes_detected_at          timestamptz,
  add column if not exists changes_total                integer,
  add column if not exists changes_new_registration     integer,
  add column if not exists changes_ownership_transfer   integer,
  add column if not exists changes_address_change       integer,
  add column if not exists changes_expiration_change    integer,
  add column if not exists changes_airworthiness_change integer,
  add column if not exists changes_deregistration       integer;
