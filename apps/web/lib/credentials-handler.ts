import { NextResponse } from "next/server";

import {
  CredentialNotFoundError,
  CredentialNotInTenantError,
  CredentialService,
  type ActiveCredentialView,
  type AccountsDb,
  type MembershipWithPermissions,
} from "@ga/accounts";
import { hasPermission } from "@ga/accounts";
import type { UserCredential } from "@ga/db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asUuid(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  const lower = s.toLowerCase();
  return UUID_RE.test(lower) ? lower : null;
}

function asIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function asRatings(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

function serializeCredential(c: UserCredential) {
  return {
    id: c.id,
    user_id: c.userId,
    regime_credential_type_id: c.regimeCredentialTypeId,
    certificate_number: c.certificateNumber,
    ratings: c.ratings ?? [],
    issued_on: c.issuedOn,
    expires_on: c.expiresOn,
    revoked_at: c.revokedAt ? c.revokedAt.toISOString() : null,
    created_by_user_id: c.createdByUserId,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

function serializeActive(v: ActiveCredentialView) {
  return {
    id: v.id,
    user_id: v.userId,
    regime_credential_type_id: v.regimeCredentialTypeId,
    credential_type_code: v.credentialTypeCode,
    credential_type_name: v.credentialTypeName,
    authorizes_signoff: v.authorizesSignoff,
    certificate_number: v.certificateNumber,
    ratings: v.ratings,
    issued_on: v.issuedOn,
    expires_on: v.expiresOn,
  };
}

/**
 * Decide who the read query targets:
 *   * admin (credential.manage) — explicit `userId` query param (or self).
 *   * non-admin                 — self only; any explicit `userId` that
 *                                 isn't the caller is 403.
 *
 * Returns the resolved target user id, or a Response if the caller fails
 * the gate.
 */
function resolveReadTarget(
  request: Request,
  ctx: { user: { id: string }; membership: MembershipWithPermissions },
): { targetUserId: string } | Response {
  const url = new URL(request.url);
  const raw = url.searchParams.get("userId");
  if (!raw) return { targetUserId: ctx.user.id };
  const target = raw.toLowerCase();
  if (!UUID_RE.test(target)) {
    return NextResponse.json(
      { error: "query parameter `userId` must be a canonical UUID" },
      { status: 400 },
    );
  }
  if (target === ctx.user.id) return { targetUserId: target };
  if (!hasPermission(ctx.membership, "credential.manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return { targetUserId: target };
}

export interface CredentialsHandlerCtx {
  tenantId: string;
  db: AccountsDb;
  user: { id: string };
  membership: MembershipWithPermissions;
}

/**
 * GET /api/orgs/{tenantId}/credentials?userId={uuid}
 *
 * Admin can list any tenant member's credentials; non-admin can list
 * own only. Returns all rows (revoked + expired included) so the admin
 * UI can render the full history. Use the `/active` route for the
 * signoff-time read.
 */
export async function handleCredentialsList(
  request: Request,
  ctx: CredentialsHandlerCtx,
): Promise<Response> {
  const resolved = resolveReadTarget(request, ctx);
  if (resolved instanceof Response) return resolved;
  const svc = new CredentialService(ctx.db);
  try {
    const rows = await svc.listForTenantMember({
      tenantId: ctx.tenantId,
      targetUserId: resolved.targetUserId,
    });
    return NextResponse.json(
      { credentials: rows.map(serializeCredential) },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof CredentialNotInTenantError) {
      return NextResponse.json(
        { error: "user is not a member of this tenant" },
        { status: 404 },
      );
    }
    throw err;
  }
}

/**
 * GET /api/orgs/{tenantId}/credentials/active?userId={uuid}&regimeId={uuid}
 *
 * Sign-off-time read used by the FE credential card. Returns only
 * non-revoked, unexpired credentials joined to their credential-type
 * row, so the caller can render "is this signer credentialed for this
 * task right now?" without N+1. RBAC mirrors the list route.
 */
export async function handleCredentialsListActive(
  request: Request,
  ctx: CredentialsHandlerCtx,
): Promise<Response> {
  const resolved = resolveReadTarget(request, ctx);
  if (resolved instanceof Response) return resolved;
  const url = new URL(request.url);
  const regimeIdRaw = url.searchParams.get("regimeId");
  let regimeId: string | undefined;
  if (regimeIdRaw) {
    const lower = regimeIdRaw.toLowerCase();
    if (!UUID_RE.test(lower)) {
      return NextResponse.json(
        { error: "query parameter `regimeId` must be a canonical UUID" },
        { status: 400 },
      );
    }
    regimeId = lower;
  }
  const svc = new CredentialService(ctx.db);
  try {
    const rows = await svc.listActiveForTenantMember({
      tenantId: ctx.tenantId,
      targetUserId: resolved.targetUserId,
      regimeId,
    });
    return NextResponse.json(
      { credentials: rows.map(serializeActive) },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof CredentialNotInTenantError) {
      return NextResponse.json(
        { error: "user is not a member of this tenant" },
        { status: 404 },
      );
    }
    throw err;
  }
}

interface CreateBody {
  user_id?: unknown;
  regime_credential_type_id?: unknown;
  certificate_number?: unknown;
  ratings?: unknown;
  issued_on?: unknown;
  expires_on?: unknown;
}

/**
 * POST /api/orgs/{tenantId}/credentials
 *
 * Admin-only — gated upstream by `withRequest({ permission:
 * "credential.manage" })`. Creates a credential for a member of this
 * tenant and writes a `user_credential_changes` row in the same tx.
 */
export async function handleCredentialsCreate(
  request: Request,
  ctx: CredentialsHandlerCtx,
): Promise<Response> {
  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON" },
      { status: 400 },
    );
  }

  const targetUserId = asUuid(body.user_id);
  const regimeCredentialTypeId = asUuid(body.regime_credential_type_id);
  const issuedOn = asIsoDate(body.issued_on);
  const expiresOn =
    body.expires_on === undefined || body.expires_on === null
      ? null
      : asIsoDate(body.expires_on);
  const certificateNumber =
    body.certificate_number === undefined ? null : asString(body.certificate_number);
  const ratings = asRatings(body.ratings);

  const errors: string[] = [];
  if (!targetUserId) errors.push("user_id");
  if (!regimeCredentialTypeId) errors.push("regime_credential_type_id");
  if (!issuedOn) errors.push("issued_on");
  if (body.expires_on !== undefined && body.expires_on !== null && expiresOn === null) {
    errors.push("expires_on");
  }
  if (ratings === null) errors.push("ratings");
  if (errors.length > 0) {
    return NextResponse.json(
      { error: `missing or invalid fields: ${errors.join(", ")}` },
      { status: 400 },
    );
  }

  const svc = new CredentialService(ctx.db);
  try {
    const row = await svc.createForTenant({
      tenantId: ctx.tenantId,
      actorUserId: ctx.user.id,
      targetUserId: targetUserId!,
      regimeCredentialTypeId: regimeCredentialTypeId!,
      certificateNumber,
      ratings: ratings ?? [],
      issuedOn: issuedOn!,
      expiresOn,
    });
    return NextResponse.json(
      { credential: serializeCredential(row) },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof CredentialNotInTenantError) {
      return NextResponse.json(
        { error: "user is not a member of this tenant" },
        { status: 404 },
      );
    }
    throw err;
  }
}

interface UpdateBody {
  certificate_number?: unknown;
  ratings?: unknown;
  issued_on?: unknown;
  expires_on?: unknown;
}

/**
 * PATCH /api/orgs/{tenantId}/credentials/{id}
 *
 * Admin-only. Only present fields are updated; absent fields are left
 * untouched. Idempotent — re-sending the same patch produces the same
 * end state (with an additional audit row capturing the no-op diff).
 */
export async function handleCredentialsUpdate(
  request: Request,
  ctx: CredentialsHandlerCtx & { params: { id: string } },
): Promise<Response> {
  const credentialId = ctx.params.id?.toLowerCase() ?? "";
  if (!UUID_RE.test(credentialId)) {
    return NextResponse.json(
      { error: "path parameter `id` must be a canonical UUID" },
      { status: 400 },
    );
  }
  let body: UpdateBody;
  try {
    body = (await request.json()) as UpdateBody;
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON" },
      { status: 400 },
    );
  }

  const patch: {
    certificateNumber?: string | null;
    ratings?: string[];
    issuedOn?: string;
    expiresOn?: string | null;
  } = {};
  const errors: string[] = [];

  if ("certificate_number" in body) {
    patch.certificateNumber =
      body.certificate_number === null ? null : asString(body.certificate_number);
  }
  if ("ratings" in body) {
    const r = asRatings(body.ratings);
    if (r === null) errors.push("ratings");
    else patch.ratings = r;
  }
  if ("issued_on" in body) {
    const d = asIsoDate(body.issued_on);
    if (!d) errors.push("issued_on");
    else patch.issuedOn = d;
  }
  if ("expires_on" in body) {
    if (body.expires_on === null) patch.expiresOn = null;
    else {
      const d = asIsoDate(body.expires_on);
      if (!d) errors.push("expires_on");
      else patch.expiresOn = d;
    }
  }
  if (errors.length > 0) {
    return NextResponse.json(
      { error: `invalid fields: ${errors.join(", ")}` },
      { status: 400 },
    );
  }

  const svc = new CredentialService(ctx.db);
  try {
    const row = await svc.updateForTenant({
      tenantId: ctx.tenantId,
      actorUserId: ctx.user.id,
      credentialId,
      ...patch,
    });
    return NextResponse.json(
      { credential: serializeCredential(row) },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof CredentialNotFoundError) {
      return NextResponse.json({ error: "credential not found" }, { status: 404 });
    }
    if (err instanceof CredentialNotInTenantError) {
      return NextResponse.json(
        { error: "credential belongs to a user outside this tenant" },
        { status: 404 },
      );
    }
    throw err;
  }
}

/**
 * DELETE /api/orgs/{tenantId}/credentials/{id} — soft-revoke.
 *
 * Admin-only. Re-deleting an already-revoked row is a no-op (no second
 * audit row), preserving idempotency.
 */
export async function handleCredentialsRevoke(
  _request: Request,
  ctx: CredentialsHandlerCtx & { params: { id: string } },
): Promise<Response> {
  const credentialId = ctx.params.id?.toLowerCase() ?? "";
  if (!UUID_RE.test(credentialId)) {
    return NextResponse.json(
      { error: "path parameter `id` must be a canonical UUID" },
      { status: 400 },
    );
  }
  const svc = new CredentialService(ctx.db);
  try {
    const row = await svc.revokeForTenant({
      tenantId: ctx.tenantId,
      actorUserId: ctx.user.id,
      credentialId,
    });
    return NextResponse.json(
      { credential: serializeCredential(row) },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof CredentialNotFoundError) {
      return NextResponse.json({ error: "credential not found" }, { status: 404 });
    }
    if (err instanceof CredentialNotInTenantError) {
      return NextResponse.json(
        { error: "credential belongs to a user outside this tenant" },
        { status: 404 },
      );
    }
    throw err;
  }
}
