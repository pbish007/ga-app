import { withRequest } from "../../../../../../lib/auth";
import { handleMaintenanceEntryGet } from "../../../../../../lib/maintenance-entry-handler";
import { buildRequestDeps } from "../../../../../../lib/request-deps";
import type { AircraftDb } from "@ga/aircraft";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ tenantId: string; entryId: string }> },
): Promise<Response> {
  const params = await context.params;
  const deps = await buildRequestDeps();
  return withRequest(deps, { permission: "aircraft.read" }, (req, ctx) =>
    handleMaintenanceEntryGet(req, {
      tenantId: ctx.tenantId,
      db: ctx.tx as unknown as AircraftDb,
      params: { entryId: params.entryId },
    }),
  )(request);
}
