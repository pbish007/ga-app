import { withRequest } from "../../../../../../../lib/auth";
import {
  handleAircraftFaaDecisionsList,
  handleAircraftFaaDecisionsRecord,
} from "../../../../../../../lib/aircraft-faa-decisions-handler";
import { buildRequestDeps } from "../../../../../../../lib/request-deps";
import type { AircraftDb } from "@ga/aircraft";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/orgs/{tenantId}/aircraft/{id}/faa-decisions
 * POST /api/orgs/{tenantId}/aircraft/{id}/faa-decisions
 *
 * Per-field FAA prefill decisions. GET returns the latest decision
 * per field for this aircraft (used to compute the chip state on
 * form open). POST records / overwrites a single field's decision.
 *
 * Read permission: `aircraft.read` is enough — the decisions are part
 * of the aircraft profile shape.
 *
 * Write permission: `aircraft.write` — the chip's three buttons are
 * write-equivalent in posture (they pin user intent against an
 * external source's value).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ tenantId: string; id: string }> },
): Promise<Response> {
  const params = await context.params;
  const deps = await buildRequestDeps();
  return withRequest(deps, { permission: "aircraft.read" }, (req, ctx) =>
    handleAircraftFaaDecisionsList(req, {
      tenantId: ctx.tenantId,
      decidedByUserId: ctx.user.id,
      db: ctx.tx as unknown as AircraftDb,
      params: { id: params.id },
    }),
  )(request);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ tenantId: string; id: string }> },
): Promise<Response> {
  const params = await context.params;
  const deps = await buildRequestDeps();
  return withRequest(deps, { permission: "aircraft.write" }, (req, ctx) =>
    handleAircraftFaaDecisionsRecord(req, {
      tenantId: ctx.tenantId,
      decidedByUserId: ctx.user.id,
      db: ctx.tx as unknown as AircraftDb,
      params: { id: params.id },
    }),
  )(request);
}
