/**
 * FE/BE shared types for the FAA Registry lookup endpoint (PMB-109).
 *
 * The mapped fields use the same canonical keys as the tenant `aircraft`
 * row + a small extension for fields the FAA carries that the tenant
 * doesn't model yet (engine make/model, owner). FE chip rendering maps
 * `field_key` from {@link FaaFieldKey} (defined in @ga/db) onto these
 * values; not every FAA field is necessarily prefillable on the form,
 * but the response carries them all so the chip can render an
 * informational "FAA says owner is X" preview.
 */

export interface FaaAircraftLookupValue {
  /** N-number without leading 'N', uppercase. */
  n_number: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  year_manufactured: number | null;
  engine_make: string | null;
  engine_model: string | null;
  owner_name: string | null;
  expiration_date: string | null;
  airworthiness_date: string | null;
  cert_issue_date: string | null;
  status_code: string | null;
}

export interface FaaFreshness {
  /**
   * Snapshot date the row was sourced from (YYYY-MM-DD). NULL means the
   * row exists but the loader did not stamp a date — should not happen
   * with the R2 pipeline but defended against here.
   */
  snapshot_date: string | null;
  /**
   * Timestamp the gold→PG load completed for the snapshot. Drives the
   * "Last synced from FAA: {date}" indicator on the form/profile (AC5
   * in PMB-109).
   */
  pg_loaded_at: string | null;
}

export type FaaLookupResult =
  | {
      kind: "match";
      value: FaaAircraftLookupValue;
      freshness: FaaFreshness;
    }
  | {
      kind: "no_match";
      /** Normalized N-number that was looked up. */
      n_number: string;
      freshness: FaaFreshness;
    };
