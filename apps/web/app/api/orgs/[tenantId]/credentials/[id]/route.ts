import { withRequest } from "../../../../../../lib/auth";
import {
  handleCredentialsRevoke,
  handleCredentialsUpdate,
} from "../../../../../../lib/credentials-handler";
import { buildRequestDeps } from "../../../../../../lib/request-deps";
import type { AccountsDb } from "@ga/accounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * PATCH /api/orgs/{tenantId}/credentials/{id} — admin-only update.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ tenantId: string; id: string }> },
): Promise<Response> {
  const params = await context.params;
  const deps = await buildRequestDeps();
  return withRequest(deps, { permission: "credential.manage" }, (req, ctx) =>
    handleCredentialsUpdate(req, {
      tenantId: ctx.tenantId,
      db: ctx.tx as unknown as AccountsDb,
      user: ctx.user,
      membership: ctx.membership,
      params: { id: params.id },
    }),
  )(request);
}

/**
 * DELETE /api/orgs/{tenantId}/credentials/{id} — admin-only soft-revoke.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ tenantId: string; id: string }> },
): Promise<Response> {
  const params = await context.params;
  const deps = await buildRequestDeps();
  return withRequest(deps, { permission: "credential.manage" }, (req, ctx) =>
    handleCredentialsRevoke(req, {
      tenantId: ctx.tenantId,
      db: ctx.tx as unknown as AccountsDb,
      user: ctx.user,
      membership: ctx.membership,
      params: { id: params.id },
    }),
  )(request);
}
