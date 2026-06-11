import { NextResponse } from "next/server";

import {
  isValidNNumber,
  lookupAircraftSearch,
  normalizeNNumberInput,
  type LookupAircraftDeps,
} from "./faa/lookup";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export interface FaaSearchHandlerDeps {
  lookupDeps: LookupAircraftDeps;
}

/**
 * Tenant-scoped FAA Registry prefix search by N-number. Mirrors the R4
 * lookup handler's posture: input shape validation at the boundary,
 * `lookup_unavailable` envelope on FAA-side errors (PMB-237).
 *
 * The route handler enforces auth + `aircraft.write`; this module
 * handles parsing `q` and `limit`, normalizing the N-number prefix
 * (tolerant of a leading `N`), and clamping `limit` to ≤ 25 so a wide
 * picklist request can never DOS the Supabase pool.
 */
export async function handleFaaSearch(
  request: Request,
  ctx: FaaSearchHandlerDeps,
): Promise<Response> {
  const url = new URL(request.url);

  const rawQ = url.searchParams.get("q") ?? "";
  const normalized = normalizeNNumberInput(rawQ);
  if (!isValidNNumber(normalized)) {
    return NextResponse.json(
      {
        error:
          "q must be 1–5 alphanumeric characters (with or without leading N)",
      },
      { status: 400 },
    );
  }

  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit)) {
      return NextResponse.json(
        { error: "limit must be a positive integer" },
        { status: 400 },
      );
    }
    const parsed = Number.parseInt(rawLimit, 10);
    if (parsed < 1) {
      return NextResponse.json(
        { error: "limit must be a positive integer" },
        { status: 400 },
      );
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  try {
    const result = await lookupAircraftSearch(ctx.lookupDeps, {
      q: normalized,
      limit,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "FAA search failed";
    return NextResponse.json(
      {
        kind: "lookup_unavailable",
        error_kind: "server_error",
        message,
      },
      { status: 503 },
    );
  }
}
