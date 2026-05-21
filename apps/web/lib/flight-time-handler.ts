import { NextResponse } from "next/server";

import type { FlightTimeEntry } from "@ga/db";
import {
  AircraftNotFoundError,
  AircraftService,
  FlightTimeMonotonicError,
  FlightTimeService,
  FlightTimeValidationError,
  type AircraftDb,
} from "@ga/aircraft";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serializeEntry(e: FlightTimeEntry) {
  return {
    id: e.id,
    aircraft_id: e.aircraftId,
    airframe_time_new: Number(e.airframeTimeNew),
    airframe_time_prev: Number(e.airframeTimePrev),
    is_override: e.isOverride,
    override_reason: e.overrideReason ?? null,
    entered_at: e.enteredAt.toISOString(),
    entered_by_user_id: e.enteredByUserId ?? null,
    created_at: e.createdAt.toISOString(),
  };
}

interface LogTimeBody {
  airframe_time_new?: unknown;
  is_override?: unknown;
  override_reason?: unknown;
}

export async function handleFlightTimeCreate(
  request: Request,
  ctx: {
    tenantId: string;
    userId: string;
    db: AircraftDb;
    params: { id: string };
  },
): Promise<Response> {
  const aircraftId = ctx.params.id?.toLowerCase() ?? "";
  if (!UUID_RE.test(aircraftId)) {
    return NextResponse.json(
      { error: "path parameter `id` must be a canonical UUID" },
      { status: 400 },
    );
  }

  let body: LogTimeBody;
  try {
    body = (await request.json()) as LogTimeBody;
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON" },
      { status: 400 },
    );
  }

  const rawTt = body.airframe_time_new;
  if (rawTt === undefined || rawTt === null) {
    return NextResponse.json(
      { error: "airframe_time_new is required" },
      { status: 400 },
    );
  }
  const airframeTimeNew = Number(rawTt);
  if (!Number.isFinite(airframeTimeNew) || airframeTimeNew < 0) {
    return NextResponse.json(
      { error: "airframe_time_new must be a non-negative number" },
      { status: 400 },
    );
  }

  const isOverride = body.is_override === true;
  const overrideReason =
    typeof body.override_reason === "string"
      ? body.override_reason.trim() || null
      : null;

  if (isOverride && !overrideReason) {
    return NextResponse.json(
      { error: "override_reason is required when is_override is true" },
      { status: 400 },
    );
  }

  const aircraftSvc = new AircraftService(ctx.db);
  try {
    await aircraftSvc.getById(ctx.tenantId, aircraftId);
  } catch (err) {
    if (err instanceof AircraftNotFoundError) {
      return NextResponse.json({ error: "aircraft not found" }, { status: 404 });
    }
    throw err;
  }

  const ftSvc = new FlightTimeService(ctx.db);
  try {
    const entry = await ftSvc.logFlightTime({
      tenantId: ctx.tenantId,
      aircraftId,
      airframeTimeNew,
      isOverride,
      overrideReason: overrideReason ?? undefined,
      enteredByUserId: ctx.userId,
    });
    return NextResponse.json(serializeEntry(entry), { status: 201 });
  } catch (err) {
    if (err instanceof FlightTimeValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof FlightTimeMonotonicError) {
      return NextResponse.json(
        {
          error: `new reading (${err.newReading}) is less than current airframe total time (${err.currentTt}). Submit with is_override=true and an override_reason to record an instrument swap.`,
          code: "not_monotonic",
          new_reading: err.newReading,
          current_tt: err.currentTt,
        },
        { status: 422 },
      );
    }
    throw err;
  }
}

export async function handleFlightTimeList(
  _request: Request,
  ctx: {
    tenantId: string;
    db: AircraftDb;
    params: { id: string };
  },
): Promise<Response> {
  const aircraftId = ctx.params.id?.toLowerCase() ?? "";
  if (!UUID_RE.test(aircraftId)) {
    return NextResponse.json(
      { error: "path parameter `id` must be a canonical UUID" },
      { status: 400 },
    );
  }
  const ftSvc = new FlightTimeService(ctx.db);
  const entries = await ftSvc.listForAircraft(ctx.tenantId, aircraftId);
  return NextResponse.json(
    { entries: entries.map(serializeEntry) },
    { status: 200 },
  );
}
