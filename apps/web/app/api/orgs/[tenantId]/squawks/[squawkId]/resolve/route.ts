import { withRequest } from "../../../../../../../lib/auth";
import { handleSquawkResolve } from "../../../../../../../lib/squawk-handler";
import { buildRequestDeps } from "../../../../../../../lib/request-deps";
import type { AircraftDb } from "@ga/aircraft";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ tenantId: string; squawkId: string }> },
): Promise<Response> {
  const params = await context.params;
  const deps = await buildRequestDeps();
  return withRequest(deps, { permission: "aircraft.write" }, (req, ctx) =>
    handleSquawkResolve(req, {
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      db: ctx.tx as unknown as AircraftDb,
      params: { squawkId: params.squawkId },
    }),
  )(request);
}
