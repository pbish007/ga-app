import { NextResponse } from "next/server";

import {
  AircraftNotFoundError,
  AircraftService,
  normalizeNNumber,
  type AircraftDb,
} from "@ga/aircraft";

import {
  isValidNNumber,
  normalizeNNumberInput,
} from "./faa/lookup";
import {
  loadOwnershipHistory,
  type LoadOwnershipHistoryDeps,
} from "./faa/ownership-history";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OwnershipHistoryHandlerDeps {
  tenantId: string;
  db: AircraftDb;
  faaDeps: LoadOwnershipHistoryDeps;
  params: { id: string };
}

/**
 * GET /api/orgs/{tenantId}/aircraft/{id}/faa-ownership-history
 *
 * Tenant-scoped change log for the panel. The aircraft membership +
 * tenant guard happens here, not in the FAA-side service: the FAA DB
 * has no tenant column. A cross-tenant request (tenant A asking for
 * tenant B's aircraft id) collapses to a 404 via the same
 * `AircraftNotFoundError` the rest of the profile uses — no leak.
 *
 * The N-number resolved off `aircraft.registration` is normalized with
 * the package-level helper from `@ga/aircraft` so the FAA query's
 * `where n_number = $1` matches the same canonical shape the decision
 * service stores against.
 */
export async function handleAircraftFaaOwnershipHistory(
  _request: Request,
  ctx: OwnershipHistoryHandlerDeps,
): Promise<Response> {
  const aircraftId = ctx.params.id?.toLowerCase() ?? "";
  if (!UUID_RE.test(aircraftId)) {
    return NextResponse.json(
      { error: "path parameter `id` must be a canonical UUID" },
      { status: 400 },
    );
  }

  const aircraftSvc = new AircraftService(ctx.db);
  let registration: string;
  try {
    const row = await aircraftSvc.getById(ctx.tenantId, aircraftId);
    registration = row.registration;
  } catch (err) {
    if (err instanceof AircraftNotFoundError) {
      return NextResponse.json({ error: "aircraft not found" }, { status: 404 });
    }
    throw err;
  }

  const nNumber = normalizeNNumber(registration);
  // `normalizeNNumber` from `@ga/aircraft` already trims + uppercases +
  // drops a leading 'N'. The lookup helper's shape check is a cheap
  // defense-in-depth — same check the lookup endpoint runs.
  const normalized = normalizeNNumberInput(nNumber);
  if (!isValidNNumber(normalized)) {
    return NextResponse.json(
      { events: [], freshness: { snapshot_date: null, pg_loaded_at: null } },
      { status: 200 },
    );
  }

  try {
    const result = await loadOwnershipHistory(ctx.faaDeps, normalized);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    // Same posture as the lookup endpoint: a downstream FAA outage is a
    // 503 with a stable error shape so the panel can render an
    // "FAA Registry unavailable" affordance.
    const message = err instanceof Error ? err.message : "FAA history load failed";
    return NextResponse.json(
      {
        error: "FAA Registry unavailable",
        message,
      },
      { status: 503 },
    );
  }
}
