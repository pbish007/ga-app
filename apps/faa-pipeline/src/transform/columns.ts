/**
 * Single source of truth for `aircraft_registry_current` column order.
 *
 * Used by:
 * - gold.ts (output SELECT order MUST match this list)
 * - pg-load.ts (COPY column list + SCD-2 INSERT/UPDATE column lists)
 * - migration 0031_faa_registry_aircraft_scd2.sql (declared order)
 *
 * If you change this list, update the migration AND the gold.ts SELECT.
 */

/** Data columns shared between _current and _history (excludes PK/SCD bookkeeping). */
export const DATA_COLUMNS = [
  "serial_number",
  "mfr_mdl_code",
  "eng_mfr_mdl",
  "year_mfr",
  "type_registrant",
  "owner_name",
  "street",
  "street2",
  "city",
  "state",
  "zip_code",
  "region",
  "county",
  "country",
  "last_action_date",
  "cert_issue_date",
  "certification",
  "type_aircraft",
  "type_engine",
  "status_code",
  "mode_s_code",
  "fract_owner",
  "airworthiness_date",
  "other_names_1",
  "other_names_2",
  "other_names_3",
  "other_names_4",
  "other_names_5",
  "expiration_date",
  "unique_id",
  "kit_mfr",
  "kit_model",
  "mode_s_code_hex",
  "mfr_name",
  "model_name",
  "aircraft_type",
  "ac_cat_code",
  "ac_weight_class",
  "no_engines",
  "no_seats",
  "ac_cruising_speed",
  "eng_mfr_name",
  "eng_model_name",
  "eng_type",
  "eng_horsepower",
  "eng_thrust",
] as const;

/**
 * Full column order written by gold.ts: n_number first, then DATA_COLUMNS,
 * then snapshot_date + updated_at. MUST match aircraft_registry_current.
 */
export const CURRENT_COLUMNS = [
  "n_number",
  ...DATA_COLUMNS,
  "snapshot_date",
  "updated_at",
] as const;
