import { withRequest } from "../../../../../../../lib/auth";
import { handleFaaLookup } from "../../../../../../../lib/faa-lookup-handler";
import { getFaaSql } from "../../../../../../../lib/faa/client";
import { buildRequestDeps } from "../../../../../../../lib/request-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/orgs/{tenantId}/faa/aircraft/{nNumber}
 *
 * Tenant-scoped FAA Registry lookup. Returns the FAA snapshot for the
 * tail number, with freshness, or a `no_match` body when the registry
 * has no row. Authenticated tenant members with `aircraft.write`
 * (form-fill posture) may call.
 *
 * The endpoint is tenant-scoped not because the FAA data differs per
 * tenant (it doesn't — FAA data is global), but because the existing
 * RBAC + session middleware is keyed on the tenant URL segment. The
 * permission check is the load-bearing thing; the URL just routes
 * through the middleware that knows how to enforce it.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ tenantId: string; nNumber: string }> },
): Promise<Response> {
  const params = await context.params;
  const deps = await buildRequestDeps();
  return withRequest(deps, { permission: "aircraft.write" }, (req) =>
    handleFaaLookup(req, {
      lookupDeps: { sql: getFaaSql() },
      params: { nNumber: params.nNumber },
    }),
  )(request);
}
