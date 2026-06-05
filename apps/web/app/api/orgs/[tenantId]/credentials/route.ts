import { withRequest } from "../../../../../lib/auth";
import {
  handleCredentialsCreate,
  handleCredentialsList,
} from "../../../../../lib/credentials-handler";
import { buildRequestDeps } from "../../../../../lib/request-deps";
import type { AccountsDb } from "@ga/accounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/orgs/{tenantId}/credentials?userId={uuid}
 *
 * Read access policy lives in the handler: admins (credential.manage)
 * can target any tenant member; non-admins can only target themselves.
 * The route deliberately does NOT declare a permission so the self-read
 * path doesn't need an admin role.
 */
export async function GET(request: Request): Promise<Response> {
  const deps = await buildRequestDeps();
  return withRequest(deps, {}, (req, ctx) =>
    handleCredentialsList(req, {
      tenantId: ctx.tenantId,
      db: ctx.tx as unknown as AccountsDb,
      user: ctx.user,
      membership: ctx.membership,
    }),
  )(request);
}

/**
 * POST /api/orgs/{tenantId}/credentials — admin-only.
 */
export async function POST(request: Request): Promise<Response> {
  const deps = await buildRequestDeps();
  return withRequest(deps, { permission: "credential.manage" }, (req, ctx) =>
    handleCredentialsCreate(req, {
      tenantId: ctx.tenantId,
      db: ctx.tx as unknown as AccountsDb,
      user: ctx.user,
      membership: ctx.membership,
    }),
  )(request);
}
