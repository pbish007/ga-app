/**
 * POST /api/orgs/{tenantId}/notifications/{id}/seen
 *
 * "Mark seen" handler for the in-app alert surface (H1.4, PMB-17).
 * Bound to the form on /orgs/[tenantId]/alerts. Redirects back to the
 * alerts page on success.
 *
 * `aircraft.read` is the right permission to bind here: in-app alerts
 * are always-on (no role gate), but you must at least be a member of
 * the tenant. Every role we ship has `aircraft.read`.
 */

import { NextResponse } from "next/server";

import { markNotificationSeen } from "@ga/notifications";

import { withRequest } from "../../../../../../../lib/auth";
import { buildRequestDeps } from "../../../../../../../lib/request-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ tenantId: string; id: string }> },
): Promise<Response> {
  const params = await context.params;
  const deps = await buildRequestDeps();
  return withRequest(deps, { permission: "aircraft.read" }, async (req, ctx) => {
    await markNotificationSeen(ctx.tx, ctx.user.id, params.id);
    return NextResponse.redirect(
      new URL(`/orgs/${ctx.tenantId}/alerts`, req.url),
      { status: 303 },
    );
  })(request);
}
