import { withRequest } from "../../../../../../../lib/auth";
import {
  handleAircraftChangeRegime,
  handleAircraftRegimeHistory,
} from "../../../../../../../lib/aircraft-regime-change-handler";
import { buildRequestDeps } from "../../../../../../../lib/request-deps";
import type { AircraftDb } from "@ga/aircraft";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ tenantId: string; id: string }> },
): Promise<Response> {
  const params = await context.params;
  const deps = await buildRequestDeps();
  return withRequest(
    deps,
    { permission: "aircraft.change_regime" },
    (req, ctx) =>
      handleAircraftChangeRegime(req, {
        tenantId: ctx.tenantId,
        db: ctx.tx as unknown as AircraftDb,
        actorUserId: ctx.user.id,
        params: { id: params.id },
      }),
  )(request);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ tenantId: string; id: string }> },
): Promise<Response> {
  const params = await context.params;
  const deps = await buildRequestDeps();
  return withRequest(deps, { permission: "aircraft.read" }, (req, ctx) =>
    handleAircraftRegimeHistory(req, {
      tenantId: ctx.tenantId,
      db: ctx.tx as unknown as AircraftDb,
      params: { id: params.id },
    }),
  )(request);
}
