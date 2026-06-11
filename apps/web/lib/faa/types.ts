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

/**
 * Slim row returned from the prefix-search endpoint (PMB-237). The FE
 * picklist needs enough to disambiguate identical owners across model
 * years — n_number, make, model, owner_name, year — and nothing more.
 * Pulling the full lookup shape on every keystroke would inflate both
 * payload and Postgres CPU on the hot index path.
 */
export interface FaaAircraftSearchResult {
  n_number: string;
  make: string | null;
  model: string | null;
  owner_name: string | null;
  year_mfr: number | null;
}

export interface FaaSearchResponse {
  kind: "results";
  results: FaaAircraftSearchResult[];
  freshness: FaaFreshness;
}
