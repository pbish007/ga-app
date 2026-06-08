import { withRequest } from "../../../../../../../lib/auth";
import { handleAircraftFaaOwnershipHistory } from "../../../../../../../lib/aircraft-faa-ownership-history-handler";
import { getFaaSql } from "../../../../../../../lib/faa/client";
import { buildRequestDeps } from "../../../../../../../lib/request-deps";
import type { AircraftDb } from "@ga/aircraft";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/orgs/{tenantId}/aircraft/{id}/faa-ownership-history
 *
 * Tenant-scoped FAA change-log read for the Ownership History panel
 * (PMB-215). Mirrors the auth posture of `faa-decisions`: `aircraft.read`
 * is enough — this is profile-shaped data, not a write.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ tenantId: string; id: string }> },
): Promise<Response> {
  const params = await context.params;
  const deps = await buildRequestDeps();
  return withRequest(deps, { permission: "aircraft.read" }, (req, ctx) =>
    handleAircraftFaaOwnershipHistory(req, {
      tenantId: ctx.tenantId,
      db: ctx.tx as unknown as AircraftDb,
      faaDeps: { sql: getFaaSql() },
      params: { id: params.id },
    }),
  )(request);
}
