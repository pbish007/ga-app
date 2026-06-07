import { NextResponse } from "next/server";

import {
  isValidNNumber,
  lookupAircraft,
  normalizeNNumberInput,
  type LookupAircraftDeps,
} from "./faa/lookup";
import type { FaaLookupResult } from "./faa/types";

export interface FaaLookupHandlerDeps {
  lookupDeps: LookupAircraftDeps;
  params: { nNumber: string };
}

/**
 * Tenant-scoped FAA lookup endpoint. The route handler enforces
 * authentication + the `aircraft.write` permission (you're filling
 * out an aircraft form). This module handles:
 *   - input shape validation (N-number)
 *   - the `match` / `no_match` HTTP body shape (AC4a)
 *   - the `lookup_unavailable` body shape on FAA-side errors (AC4b)
 *
 * The actual FAA SQL connection is injected via {@link FaaLookupHandlerDeps}
 * so tests can stub it without touching the singleton client.
 */
export async function handleFaaLookup(
  _request: Request,
  ctx: FaaLookupHandlerDeps,
): Promise<Response> {
  const normalized = normalizeNNumberInput(ctx.params.nNumber);
  if (!isValidNNumber(normalized)) {
    return NextResponse.json(
      { error: "n_number must be 1–5 alphanumeric characters (with or without leading N)" },
      { status: 400 },
    );
  }

  let result: FaaLookupResult;
  try {
    result = await lookupAircraft(ctx.lookupDeps, normalized);
  } catch (err) {
    // AC4b — degraded FAA service. We surface a stable shape so the FE
    // chip can render the "FAA Registry unavailable" pill without
    // sniffing HTTP status codes. 503 (not 500) because the failure
    // is downstream-not-our-fault.
    const message = err instanceof Error ? err.message : "FAA lookup failed";
    return NextResponse.json(
      {
        kind: "lookup_unavailable",
        n_number: normalized,
        error_kind: "server_error",
        message,
      },
      { status: 503 },
    );
  }

  if (result.kind === "no_match") {
    // AC4a — legitimate empty result, not an error.
    return NextResponse.json(
      {
        kind: "no_match",
        n_number: result.n_number,
        freshness: result.freshness,
      },
      { status: 200 },
    );
  }

  return NextResponse.json(
    {
      kind: "match",
      value: result.value,
      freshness: result.freshness,
    },
    { status: 200 },
  );
}
