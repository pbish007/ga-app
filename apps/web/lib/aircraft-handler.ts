import { NextResponse } from "next/server";

import {
  AIRCRAFT_TIME_SOURCES,
  type Aircraft,
  type AircraftTimeSource,
  type Component,
  type ComponentInstallation,
} from "@ga/db";
import {
  AircraftNotFoundError,
  AircraftService,
  AircraftValidationError,
  ComponentService,
  type AircraftDb,
} from "@ga/aircraft";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AircraftHandlerDeps {
  db: AircraftDb;
}

function serializeAircraft(a: Aircraft) {
  return {
    id: a.id,
    tenant_id: a.tenantId,
    regime_id: a.regimeId,
    registration: a.registration,
    make: a.make,
    model: a.model,
    serial_number: a.serialNumber,
    year_manufactured: a.yearManufactured,
    category: a.category,
    aircraft_class: a.aircraftClass,
    airframe_total_time: Number(a.airframeTotalTime),
    time_source: a.timeSource,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
  };
}

function serializeInstalledComponent(row: {
  component: Component;
  installation: ComponentInstallation;
}) {
  const c = row.component;
  const i = row.installation;
  return {
    component: {
      id: c.id,
      kind: c.kind,
      serial_number: c.serialNumber,
      make: c.make,
      model: c.model,
      tbo_hours: c.tboHours == null ? null : Number(c.tboHours),
      tbo_calendar_months: c.tboCalendarMonths,
      cycle_limit: c.cycleLimit,
    },
    installation: {
      id: i.id,
      installed_at: i.installedAt.toISOString(),
      installed_at_aircraft_total_time: Number(i.installedAtAircraftTotalTime),
    },
  };
}

interface CreateAircraftBody {
  registration?: unknown;
  make?: unknown;
  model?: unknown;
  serial_number?: unknown;
  year_manufactured?: unknown;
  category?: unknown;
  aircraft_class?: unknown;
  time_source?: unknown;
  airframe_total_time?: unknown;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asTimeSource(value: unknown): AircraftTimeSource | null {
  if (typeof value !== "string") return null;
  return (AIRCRAFT_TIME_SOURCES as readonly string[]).includes(value)
    ? (value as AircraftTimeSource)
    : null;
}

function asOptionalNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined; // signal invalid
  return n;
}

/**
 * GET /api/orgs/{tenantId}/aircraft — list aircraft for the tenant.
 * Requires the `aircraft.read` permission.
 */
export async function handleAircraftList(
  _request: Request,
  ctx: { tenantId: string; db: AircraftDb },
): Promise<Response> {
  const service = new AircraftService(ctx.db);
  const rows = await service.listForTenant(ctx.tenantId);
  return NextResponse.json(
    { aircraft: rows.map(serializeAircraft) },
    { status: 200 },
  );
}

/**
 * POST /api/orgs/{tenantId}/aircraft — create an aircraft. Requires
 * `aircraft.write`. The regime defaults to FAA via DEFAULT_REGIME_CODE
 * (the K2 seam); callers do not set it.
 */
export async function handleAircraftCreate(
  request: Request,
  ctx: { tenantId: string; db: AircraftDb },
): Promise<Response> {
  let body: CreateAircraftBody;
  try {
    body = (await request.json()) as CreateAircraftBody;
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON" },
      { status: 400 },
    );
  }

  const registration = asString(body.registration);
  const make = asString(body.make);
  const model = asString(body.model);
  const serialNumber = asString(body.serial_number);
  const category = asString(body.category);
  const aircraftClass = asString(body.aircraft_class);
  const timeSource = asTimeSource(body.time_source);

  const missing: string[] = [];
  if (!registration) missing.push("registration");
  if (!make) missing.push("make");
  if (!model) missing.push("model");
  if (!serialNumber) missing.push("serial_number");
  if (!category) missing.push("category");
  if (!aircraftClass) missing.push("aircraft_class");
  if (!timeSource) missing.push("time_source");
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `missing or invalid fields: ${missing.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const yearRaw = asOptionalNumber(body.year_manufactured);
  if (yearRaw === undefined) {
    return NextResponse.json(
      { error: "year_manufactured must be a number when present" },
      { status: 400 },
    );
  }
  const ttRaw = asOptionalNumber(body.airframe_total_time);
  if (ttRaw === undefined) {
    return NextResponse.json(
      { error: "airframe_total_time must be a number when present" },
      { status: 400 },
    );
  }

  const service = new AircraftService(ctx.db);
  try {
    const row = await service.create({
      tenantId: ctx.tenantId,
      registration: registration!,
      make: make!,
      model: model!,
      serialNumber: serialNumber!,
      category: category!,
      aircraftClass: aircraftClass!,
      timeSource: timeSource!,
      yearManufactured: yearRaw ?? null,
      airframeTotalTime: ttRaw ?? 0,
    });
    return NextResponse.json(serializeAircraft(row), { status: 201 });
  } catch (err) {
    if (err instanceof AircraftValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
      return NextResponse.json(
        {
          error: `an aircraft with registration ${registration} already exists in this tenant`,
        },
        { status: 409 },
      );
    }
    throw err;
  }
}

/**
 * GET /api/orgs/{tenantId}/aircraft/{id} — fetch one aircraft with the
 * list of currently-installed components attached. Requires
 * `aircraft.read`.
 */
export async function handleAircraftGet(
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

  const service = new AircraftService(ctx.db);
  const componentService = new ComponentService(ctx.db);

  let aircraft: Aircraft;
  try {
    aircraft = await service.getById(ctx.tenantId, aircraftId);
  } catch (err) {
    if (err instanceof AircraftNotFoundError) {
      return NextResponse.json(
        { error: "aircraft not found" },
        { status: 404 },
      );
    }
    throw err;
  }
  const installed = await componentService.listInstalledOnAircraft(
    ctx.tenantId,
    aircraft.id,
  );

  return NextResponse.json(
    {
      ...serializeAircraft(aircraft),
      installed_components: installed.map(serializeInstalledComponent),
    },
    { status: 200 },
  );
}
