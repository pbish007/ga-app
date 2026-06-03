import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import {
  ORG_TYPES,
  TENANT_APP_ROLE,
  USER_CONTEXT_GUC,
  schema,
  type OrgType,
} from "@ga/db";

const { organizations } = schema;
import {
  EmailAlreadyExists,
  IdempotencyConflict,
  InvalidRegime,
  ProvisioningError,
  TenantProvisioningService,
  ValidationError,
  type AccountsDb,
  type ProvisionTenantDeps,
} from "@ga/accounts";

import {
  buildSetCookieHeader,
  createSessionCookieValue,
} from "./session";

/**
 * Minimum password length for self-service signup. The credential here
 * gates access to maintenance records, so we set a floor rather than
 * accept trivially short passwords. Mirrors the validation in
 * `provisionTenant` so we can fail-fast before opening the audit row.
 */
const MIN_PASSWORD_LENGTH = 8;

export interface SignupDeps {
  db: AccountsDb;
  secret: string;
  /** Override the issued-at / created-at clock in tests. */
  now?: () => Date;
}

function isOrgType(value: unknown): value is OrgType {
  return (
    typeof value === "string" && (ORG_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Production wiring for the membership INSERT inside the provisioning
 * transaction. `provisionTenant` opens ONE transaction covering the user,
 * the organization, and the admin-membership write; this hook pins the
 * `app.current_user_id` GUC + drops the effective role to `tenant_app`
 * before the membership INSERT runs, so the `app_self_membership_insert`
 * policy on the production `tenant_runtime` role admits the row.
 *
 * The user + org INSERTs earlier in the same tx run on the bare
 * connection role (tenant_runtime in prod, the bootstrap superuser in
 * pglite tests). LOCAL settings unwind at COMMIT/ROLLBACK so the role
 * cannot leak to the next pooled request.
 */
const productionMembershipTx: NonNullable<
  ProvisionTenantDeps["withMembershipTx"]
> = async (tx, userId, fn) => {
  await tx.execute(
    sql`select set_config(${USER_CONTEXT_GUC}, ${userId}, true)`,
  );
  await tx.execute(sql.raw(`set local role ${TENANT_APP_ROLE}`));
  return fn();
};

/**
 * POST handler for `/api/auth/signup` — the board-decided self-service
 * V1 onboarding path. Delegates the tenant creation to the shared
 * `TenantProvisioningService` (PMB-117) so signup and the admin API
 * (C3) execute the same atomic user + org + admin-membership write
 * against the same audit log.
 *
 * Behaviour preserved from the inlined version:
 *   * Email must be a valid syntax + a NEW identity (existing email →
 *     409 with the "sign in instead" message).
 *   * Password floor of 8 characters.
 *   * Organization name + a valid `OrgType` are required.
 *   * Defaults to the FAA regime via the K2 seam.
 *   * On success: issues the same signed session cookie the login flow
 *     uses so the caller is signed in.
 *
 * Newly added (PMB-117):
 *   * Every attempt — success OR failure — is recorded in the
 *     `tenant_provisioning_audit` table with `actor_kind =
 *     'self-service'`. Self-service signup leaves `idempotency_key` NULL
 *     (each attempt is its own row).
 */
export async function handleSignup(
  req: Request,
  deps: SignupDeps,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "expected JSON body" }, { status: 400 });
  }

  const raw = body as {
    email?: unknown;
    password?: unknown;
    org_name?: unknown;
    org_type?: unknown;
  };

  const email =
    typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  const password = typeof raw.password === "string" ? raw.password : "";
  const orgName = typeof raw.org_name === "string" ? raw.org_name.trim() : "";
  const orgType = raw.org_type;

  // Validate at the handler boundary so the typed 400s the route shape
  // already promises stay byte-stable. ValidationError thrown by the
  // service is mapped to the same 400 below, but we'd rather skip the
  // audit-row write for malformed inputs.
  if (!email || !email.includes("@") || email.length > 320) {
    return NextResponse.json(
      { error: "a valid email is required" },
      { status: 400 },
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      {
        error: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      },
      { status: 400 },
    );
  }
  if (!orgName) {
    return NextResponse.json(
      { error: "organization name is required" },
      { status: 400 },
    );
  }
  if (!isOrgType(orgType)) {
    return NextResponse.json(
      {
        error: `organization type must be one of: ${ORG_TYPES.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const now = deps.now ? deps.now() : new Date();
  const service = new TenantProvisioningService({
    db: deps.db,
    withMembershipTx: productionMembershipTx,
    now: deps.now,
  });

  let result: Awaited<ReturnType<typeof service.provisionTenant>>;
  try {
    result = await service.provisionTenant({
      orgName,
      orgType,
      primaryAdmin: { email, password },
      provisionedBy: { kind: "self-service" },
    });
  } catch (err) {
    return mapProvisioningError(err);
  }

  const iat = Math.floor(now.getTime() / 1000);
  const cookie = createSessionCookieValue(
    { userId: result.primaryAdminUserId, iat },
    deps.secret,
  );
  // Fetch the org's display fields for the response. The provisioning
  // result envelope is audit-shaped (ids + counts); a single read here
  // keeps the API contract stable.
  const [org] = await deps.db
    .select({
      id: organizations.id,
      name: organizations.name,
      orgType: organizations.orgType,
    })
    .from(organizations)
    .where(eq(organizations.id, result.tenantId))
    .limit(1);
  const res = NextResponse.json({
    user: { id: result.primaryAdminUserId, email },
    organization: org
      ? { id: org.id, name: org.name, org_type: org.orgType }
      : { id: result.tenantId, name: orgName, org_type: orgType },
    tenant_id: result.tenantId,
  });
  res.headers.append("Set-Cookie", buildSetCookieHeader(cookie));
  return res;
}

function mapProvisioningError(err: unknown): Response {
  if (err instanceof EmailAlreadyExists) {
    return NextResponse.json(
      { error: "an account with this email already exists — sign in instead" },
      { status: 409 },
    );
  }
  if (err instanceof IdempotencyConflict) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: 409 },
    );
  }
  if (err instanceof InvalidRegime) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: 400 },
    );
  }
  if (err instanceof ValidationError) {
    return NextResponse.json(
      { error: err.message, code: err.code, field: err.field },
      { status: 400 },
    );
  }
  if (err instanceof ProvisioningError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: 400 },
    );
  }
  throw err;
}
