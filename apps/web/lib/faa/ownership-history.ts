import type { FaaSql } from "./client.js";
import type { FaaFreshness } from "./types.js";

/**
 * R3 change kinds emitted by the FAA change-detection pipeline
 * (`apps/faa-pipeline/src/transform/change-detect.ts`). Pinned here so
 * the FE renderer can switch on a stable union; new pipeline change
 * kinds must be added explicitly in both places.
 */
export type FaaAircraftChangeKind =
  | "new_registration"
  | "ownership_transfer"
  | "address_change"
  | "expiration_change"
  | "airworthiness_change"
  | "deregistration";

export const FAA_AIRCRAFT_CHANGE_KINDS: ReadonlyArray<FaaAircraftChangeKind> = [
  "new_registration",
  "ownership_transfer",
  "address_change",
  "expiration_change",
  "airworthiness_change",
  "deregistration",
];

export interface FaaOwnershipHistoryEvent {
  snapshot_date: string;
  change_kind: FaaAircraftChangeKind;
  /**
   * Pre-change values. `null` for `new_registration` (no prior state)
   * and for fields the kind doesn't carry. JSON-shaped: the pipeline
   * emits `{ owner_name }`, `{ street, city, ... }`, etc.
   */
  previous_value: Record<string, unknown> | null;
  /**
   * Post-change values. `null` for kinds that don't carry forward state
   * (none today, but reserved). For `deregistration` carries
   * `{ deregistered_on: "YYYY-MM-DD" }`.
   */
  new_value: Record<string, unknown> | null;
}

export interface FaaOwnershipHistoryResult {
  events: FaaOwnershipHistoryEvent[];
  freshness: FaaFreshness;
}

export interface LoadOwnershipHistoryDeps {
  sql: FaaSql;
}

/**
 * Load the per-tail change log for the FAA Ownership History panel.
 * Reads `faa_registry.aircraft_changes` (R3, PMB-107) ordered newest
 * first, plus the same `snapshot_manifest` freshness signal the lookup
 * endpoint uses so the panel can render a "last synced" indicator.
 *
 * Returns an empty `events` array for a tail that has never churned
 * (legitimate state for any aircraft that hasn't changed hands since
 * R3 started capturing) — not an error.
 */
export async function loadOwnershipHistory(
  deps: LoadOwnershipHistoryDeps,
  nNumber: string,
): Promise<FaaOwnershipHistoryResult> {
  const freshness = await loadFreshness(deps.sql);

  const rows = await deps.sql<Array<RawChangeRow>>`
    select
      to_char(snapshot_date, 'YYYY-MM-DD') as snapshot_date,
      change_type,
      old_value,
      new_value
    from faa_registry.aircraft_changes
    where n_number = ${nNumber}
    order by snapshot_date desc, id desc
  `;

  return {
    events: rows.map(shapeEvent),
    freshness,
  };
}

interface RawChangeRow {
  snapshot_date: string;
  change_type: string;
  old_value: unknown;
  new_value: unknown;
}

function shapeEvent(row: RawChangeRow): FaaOwnershipHistoryEvent {
  return {
    snapshot_date: row.snapshot_date,
    change_kind: row.change_type as FaaAircraftChangeKind,
    previous_value: shapeJson(row.old_value),
    new_value: shapeJson(row.new_value),
  };
}

function shapeJson(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

async function loadFreshness(sql: FaaSql): Promise<FaaFreshness> {
  // Mirrors `lookupAircraft` freshness — the most recent manifest row
  // that finished `pg-load`. The panel rendering and the prefill chip
  // therefore quote the same timestamp.
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
