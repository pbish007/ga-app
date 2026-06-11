import { withRequest } from "../../../../../../../lib/auth";
import { handleFaaSearch } from "../../../../../../../lib/faa-search-handler";
import { getFaaSql } from "../../../../../../../lib/faa/client";
import { buildRequestDeps } from "../../../../../../../lib/request-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/orgs/{tenantId}/faa/aircraft/search?q=<prefix>&limit=<n>
 *
 * Tenant-scoped FAA Registry prefix search. Same auth posture as the
 * R4 single-tail lookup — `aircraft.write` (form-fill posture), tenant
 * URL segment drives the membership/permission check. FAA data is
 * global; the tenant scoping is for RBAC, not data isolation.
 */
export async function GET(
  request: Request,
  _context: { params: Promise<{ tenantId: string }> },
): Promise<Response> {
  const deps = await buildRequestDeps();
  return withRequest(deps, { permission: "aircraft.write" }, (req) =>
    handleFaaSearch(req, {
      lookupDeps: { sql: getFaaSql() },
    }),
  )(request);
}
