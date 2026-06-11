-- FAA Registry: SCD-2 aircraft_registry redesign (PMB-203 R2).
-- @scope: faa-supabase
-- Lives in the FAA Supabase project (FAA_DATABASE_URL), NOT the tenant DB.
--
-- Drop+recreate is safe because the 0022 tables hold zero rows today
-- (no R1 transform has ever populated them). Forward-only; the next
-- migration that reverts this would re-create the 0022 shape.
--
-- pg_trgm is preinstalled on Supabase; we still issue CREATE EXTENSION
-- IF NOT EXISTS for portability against fresh local databases.

create extension if not exists pg_trgm;

drop table if exists faa_registry.aircraft_registry_history;
drop table if exists faa_registry.aircraft_registry_current;

create table faa_registry.aircraft_registry_current (
  n_number          text primary key,
  serial_number     text,
  mfr_mdl_code      text,
  eng_mfr_mdl       text,
  year_mfr          smallint,
  type_registrant   smallint,
  owner_name        text,                    -- was `name` in 0022
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
  airworthiness_date date,                   -- was `air_worth_date` in 0022
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

  -- Joined from ACFTREF on mfr_mdl_code
  mfr_name          text,
  model_name        text,
  aircraft_type     text,
  ac_cat_code       smallint,
  ac_weight_class   text,
  no_engines        smallint,
  no_seats          smallint,
  ac_cruising_speed integer,

  -- Joined from ENGINE on eng_mfr_mdl
  eng_mfr_name      text,
  eng_model_name    text,
  eng_type          smallint,
  eng_horsepower    integer,
  eng_thrust        integer,

  -- Bookkeeping
  snapshot_date     date not null,
  updated_at        timestamptz not null default now()
);

-- SCD-2 history: full row-body history with valid_from/valid_to/is_current.
-- Mirrors `_current`'s data columns (no PK / updated_at on history rows).
create table faa_registry.aircraft_registry_history (
  id                bigserial primary key,
  n_number          text not null,
  valid_from        date not null,
  valid_to          date,
  is_current        boolean not null,

  -- Mirror of _current's data columns
  serial_number     text,
  mfr_mdl_code      text,
  eng_mfr_mdl       text,
  year_mfr          smallint,
  type_registrant   smallint,
  owner_name        text,
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
  airworthiness_date date,
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
  mfr_name          text,
  model_name        text,
  aircraft_type     text,
  ac_cat_code       smallint,
  ac_weight_class   text,
  no_engines        smallint,
  no_seats          smallint,
  ac_cruising_speed integer,
  eng_mfr_name      text,
  eng_model_name    text,
  eng_type          smallint,
  eng_horsepower    integer,
  eng_thrust        integer,

  unique (n_number, valid_from)
);

create index aircraft_registry_history_nn_valid_from
  on faa_registry.aircraft_registry_history (n_number, valid_from desc);

create index aircraft_registry_history_nn_current
  on faa_registry.aircraft_registry_history (n_number)
  where is_current;

-- GIN indexes on _current for owner-name / serial-number lookups.
create index aircraft_registry_current_owner_name_trgm
  on faa_registry.aircraft_registry_current
  using gin (owner_name gin_trgm_ops);

create index aircraft_registry_current_serial_trgm
  on faa_registry.aircraft_registry_current
  using gin (serial_number gin_trgm_ops);

create index aircraft_registry_current_owner_name_tsv
  on faa_registry.aircraft_registry_current
  using gin (to_tsvector('english', coalesce(owner_name, '')));
