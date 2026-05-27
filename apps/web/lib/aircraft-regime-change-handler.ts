import { NextResponse } from "next/server";

import type { AircraftRegimeChange } from "@ga/db";
import {
  AircraftRegimeChangeAircraftNotFoundError,
  AircraftRegimeChangeRegimeNotFoundError,
  AircraftRegimeChangeService,
  AircraftRegimeChangeValidationError,
  type AircraftDb,
  type ChangeRegimeResult,
} from "@ga/aircraft";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serializeChange(c: AircraftRegimeChange) {
  return {
    id: c.id,
    aircraft_id: c.aircraftId,
    tenant_id: c.tenantId,
    from_regime_id: c.fromRegimeId,
    to_regime_id: c.toRegimeId,
    actor_user_id: c.actorUserId,
    reason: c.reason,
    created_at: c.createdAt.toISOString(),
  };
}

function serializeResult(result: ChangeRegimeResult) {
  return {
    aircraft: {
      id: result.aircraft.id,
      regime_id: result.aircraft.regimeId,
      updated_at: result.aircraft.updatedAt.toISOString(),
    },
    change: serializeChange(result.change),
  };
}

interface ChangeRegimeBody {
  to_regime_id?: unknown;
  reason?: unknown;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * POST /api/orgs/{tenantId}/aircraft/{id}/regime — change the
 * regulatory regime of an aircraft, writing an audit row in the same
 * transaction. The route is gated by the `aircraft.change_regime`
 * permission (admin only per PMB-10 RBAC matrix); see PMB-18.
 */
export async function handleAircraftChangeRegime(
  request: Request,
  ctx: {
    tenantId: string;
    db: AircraftDb;
    actorUserId: string;
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

  let body: ChangeRegimeBody;
  try {
    body = (await request.json()) as ChangeRegimeBody;
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON" },
      { status: 400 },
    );
  }

  const toRegimeIdRaw = asString(body.to_regime_id);
  const reason = asString(body.reason);

  const missing: string[] = [];
  if (!toRegimeIdRaw) missing.push("to_regime_id");
  if (!reason) missing.push("reason");
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `missing or invalid fields: ${missing.join(", ")}` },
      { status: 400 },
    );
  }

  const toRegimeId = toRegimeIdRaw!.toLowerCase();
  if (!UUID_RE.test(toRegimeId)) {
    return NextResponse.json(
      { error: "to_regime_id must be a canonical UUID" },
      { status: 400 },
    );
  }

  const svc = new AircraftRegimeChangeService(ctx.db);
  try {
    const result = await svc.change({
      tenantId: ctx.tenantId,
      aircraftId,
      toRegimeId,
      actorUserId: ctx.actorUserId,
      reason: reason!,
    });
    return NextResponse.json(serializeResult(result), { status: 200 });
  } catch (err) {
    if (err instanceof AircraftRegimeChangeAircraftNotFoundError) {
      return NextResponse.json(
        { error: "aircraft not found" },
        { status: 404 },
      );
    }
    if (err instanceof AircraftRegimeChangeRegimeNotFoundError) {
      return NextResponse.json(
        { error: "target regime not found" },
        { status: 404 },
      );
    }
    if (err instanceof AircraftRegimeChangeValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

/**
 * GET /api/orgs/{tenantId}/aircraft/{id}/regime — list the regime
 * change history for an aircraft, newest first. Read-only, gated by
 * `aircraft.read`.
 */
export async function handleAircraftRegimeHistory(
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

  const svc = new AircraftRegimeChangeService(ctx.db);
  const rows = await svc.listForAircraft(ctx.tenantId, aircraftId);
  return NextResponse.json(
    { changes: rows.map(serializeChange) },
    { status: 200 },
  );
}
