import type { FaaSql } from "./client.js";
import type { FaaLookupResult, FaaAircraftLookupValue, FaaFreshness } from "./types.js";

/**
 * Tolerant N-number normalizer. Strips leading/trailing whitespace,
 * uppercases, and drops a leading 'N' so callers can paste either
 * "n12345" / "N12345" / "12345" and hit the same row. The FAA Registry
 * MASTER table stores tail numbers without the leading 'N' and
 * uppercase, which matches what we store on the decision log too.
 */
export function normalizeNNumberInput(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (trimmed.length === 0) return trimmed;
  return trimmed.startsWith("N") ? trimmed.slice(1) : trimmed;
}

const N_NUMBER_SHAPE = /^[A-Z0-9]{1,5}$/;

/**
 * FAA N-numbers are 1–5 chars after the leading 'N', alphanumeric,
 * uppercase. Reject anything outside that shape at the boundary so
 * the FAA query never sees attacker-controlled text — the column is
 * already bound as a parameter, but defense-in-depth is cheap.
 */
export function isValidNNumber(normalized: string): boolean {
  return N_NUMBER_SHAPE.test(normalized);
}

export interface LookupAircraftDeps {
  sql: FaaSql;
}

/**
 * Look up a single aircraft from the FAA Registry by N-number. Returns
 * a `match` with mapped fields + freshness, or `no_match` with the
 * same freshness so the FE can still render the pipeline timestamp.
 *
 * The freshness numbers come from the latest `snapshot_manifest` row
 * with a non-null `pg_loaded_at` — i.e. the most recent successful
 * load, not the most recent raw snapshot. This is the timestamp the
 * AC5 "Last synced from FAA: {date}" pill must show.
 *
 * Errors propagate: caller is responsible for mapping a thrown SQL
 * error into `AC4b` "FAA Registry unavailable" — that branch lives in
 * the route handler, not the lookup helper, so retries and 5xx
 * shaping stay together with HTTP concerns.
 */
export async function lookupAircraft(
  deps: LookupAircraftDeps,
  nNumber: string,
): Promise<FaaLookupResult> {
  const freshness = await loadFreshness(deps.sql);

  const rows = await deps.sql<Array<RawAircraftRow>>`
    select
      n_number,
      coalesce(mfr_name, '')        as make,
      coalesce(model_name, '')      as model,
      serial_number,
      year_mfr,
      coalesce(eng_mfr_name, '')    as engine_make,
      coalesce(eng_model_name, '')  as engine_model,
      owner_name,
      to_char(expiration_date, 'YYYY-MM-DD')     as expiration_date,
      to_char(airworthiness_date, 'YYYY-MM-DD')  as airworthiness_date,
      to_char(cert_issue_date, 'YYYY-MM-DD')     as cert_issue_date,
      status_code
    from faa_registry.aircraft_registry_current
    where n_number = ${nNumber}
    limit 1
  `;

  if (rows.length === 0) {
    return {
      kind: "no_match",
      n_number: nNumber,
      freshness,
    };
  }

  return {
    kind: "match",
    value: shapeAircraft(rows[0]!),
    freshness,
  };
}

interface RawAircraftRow {
  n_number: string;
  make: string;
  model: string;
  serial_number: string | null;
  year_mfr: number | null;
  engine_make: string;
  engine_model: string;
  owner_name: string | null;
  expiration_date: string | null;
  airworthiness_date: string | null;
  cert_issue_date: string | null;
  status_code: string | null;
}

function shapeAircraft(row: RawAircraftRow): FaaAircraftLookupValue {
  return {
    n_number: row.n_number,
    make: emptyToNull(row.make),
    model: emptyToNull(row.model),
    serial_number: row.serial_number,
    year_manufactured: row.year_mfr,
    engine_make: emptyToNull(row.engine_make),
    engine_model: emptyToNull(row.engine_model),
    owner_name: row.owner_name,
    expiration_date: row.expiration_date,
    airworthiness_date: row.airworthiness_date,
    cert_issue_date: row.cert_issue_date,
    status_code: row.status_code,
  };
}

function emptyToNull(value: string): string | null {
  return value.length === 0 ? null : value;
}

async function loadFreshness(sql: FaaSql): Promise<FaaFreshness> {
  // Most recent snapshot that the PG load completed for. If the
  // pipeline has never run on this DB we fall back to nulls; the FE
  // pill should read "FAA sync not yet run".
  // postgres-js hands `timestamptz` back as a JS Date by default; we
  // ask Postgres for an ISO-8601 string at the SQL layer so the JSON
  // shape is self-explanatory and doesn't depend on driver coercion.
  const rows = await sql<Array<{ snapshot_date: string | null; pg_loaded_at: string | null }>>`
    select
      to_char(snapshot_date, 'YYYY-MM-DD') as snapshot_date,
      to_char(pg_loaded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as pg_loaded_at
    from faa_registry.snapshot_manifest
    where pg_loaded_at is not null
    order by pg_loaded_at desc
    limit 1
  `;
  if (rows.length === 0) {
    return { snapshot_date: null, pg_loaded_at: null };
  }
  const row = rows[0]!;
  return {
    snapshot_date: row.snapshot_date,
    pg_loaded_at: row.pg_loaded_at,
  };
}
