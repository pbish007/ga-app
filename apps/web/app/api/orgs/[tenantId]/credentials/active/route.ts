import { withRequest } from "../../../../../../lib/auth";
import { handleCredentialsListActive } from "../../../../../../lib/credentials-handler";
import { buildRequestDeps } from "../../../../../../lib/request-deps";
import type { AccountsDb } from "@ga/accounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/orgs/{tenantId}/credentials/active?userId={uuid}&regimeId={uuid}
 *
 * Sign-off-time read consumed by the FE credential card. Returns
 * non-revoked, unexpired credentials joined to their credential-type
 * row (so the card renders without N+1). Self-read for any membership
 * role; cross-user read requires `credential.manage`.
 */
export async function GET(request: Request): Promise<Response> {
  const deps = await buildRequestDeps();
  return withRequest(deps, {}, (req, ctx) =>
    handleCredentialsListActive(req, {
      tenantId: ctx.tenantId,
      db: ctx.tx as unknown as AccountsDb,
      user: ctx.user,
      membership: ctx.membership,
    }),
  )(request);
}
