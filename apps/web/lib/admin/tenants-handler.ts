import { randomBytes } from "node:crypto";

import { and, desc, eq, gt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import {
  ORG_TYPES,
  TENANT_APP_ROLE,
  USER_CONTEXT_GUC,
  schema as dbSchema,
  type AppRoleCode,
  type OrgType,
} from "@ga/db";
import {
  APP_ROLE_CODES,
} from "@ga/db";
import {
  EmailAlreadyExists,
  IdempotencyConflict,
  InvalidRegime,
  OutboxMailer,
  ProvisioningError,
  TenantProvisioningService,
  ValidationError,
  type AccountsDb,
  type ProvisionAdditionalSeat,
  type ProvisionTenantDeps,
  type ProvisionTenantInput,
} from "@ga/accounts";

import {
  createPlatformAdminCache,
  requirePlatformAdmin,
  type PlatformAdminContext,
  type SessionDeps,
} from "../auth/platform-admin";
import { buildLoadSession } from "../auth/withRequest";
import { seedDemoContent } from "../demo-seed";

const {
  organizationMemberships,
  organizations,
  tenantProvisioningAudit,
  users,
} = dbSchema;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Admin routes share one deps shape. The `db` here is the bare runtime
 * handle — NOT a tenant-scoped tx — because admin routes operate cross
 * tenant and the audit table is granted only to the bare runtime role
 * (see migration 0024). The handlers never enter `runAsTenant`.
 */
export interface AdminTenantsDeps {
  db: AccountsDb;
  /** Session HMAC secret. Same value used by login + signup. */
  secret: string;
  /** Origin used to build invite accept URLs (e.g. https://app.example). */
  acceptUrlBase: string;
  /** Override the clock in tests. */
  now?: () => Date;
}

/**
 * Production wiring for the membership INSERT inside the provisioning
 * transaction. Identical to the signup handler's version — we pin the
 * USER_CONTEXT GUC + SET LOCAL ROLE tenant_app so the membership row
 * satisfies the `app_self_membership_insert` RLS policy.
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

interface CreateTenantBody {
  orgName?: unknown;
  orgType?: unknown;
  regimeId?: unknown;
  primaryAdmin?: {
    email?: unknown;
    password?: unknown;
    generatePassword?: unknown;
  };
  additionalSeats?: unknown;
}

interface NormalizedCreateInput {
  orgName: string;
  orgType: OrgType;
  regimeId?: string;
  primaryAdmin: { email: string; password: string };
  additionalSeats: ProvisionAdditionalSeat[];
  /** True when the server generated the password (mode (a)). */
  generatedPassword: boolean;
}

/**
 * Snapshot the normalized input the way the audit row stores it (no
 * password, no derived fields the caller couldn't supply). Used to
 * compare a fresh request against a prior `done` attempt's snapshot when
 * the same `Idempotency-Key` is replayed with a different body.
 */
function fingerprintInput(
  input: NormalizedCreateInput,
  idempotencyKey: string,
  actorUserId: string,
): Record<string, unknown> {
  return {
    orgName: input.orgName,
    orgType: input.orgType,
    regimeId: input.regimeId ?? null,
    primaryAdmin: { email: input.primaryAdmin.email },
    additionalSeats: input.additionalSeats.map((s) => ({
      email: s.email.trim().toLowerCase(),
      role: s.role,
    })),
    provisionedBy: { kind: "platform-admin", actorUserId },
    idempotencyKey,
  };
}

function isOrgType(value: unknown): value is OrgType {
  return (
    typeof value === "string" && (ORG_TYPES as readonly string[]).includes(value)
  );
}

function isAppRole(value: unknown): value is AppRoleCode {
  return (
    typeof value === "string" &&
    (APP_ROLE_CODES as readonly string[]).includes(value)
  );
}

/**
 * Strong, URL-safe initial password emitted once when the caller chose
 * mode (a). 18 bytes of base64url ≈ 144 bits of entropy — well above the
 * service's 8-character floor. The handler echoes it back exactly once in
 * the create response; it is never re-emitted on a replay or subsequent
 * read (the audit log stores no password).
 */
function generateInitialPassword(): string {
  return randomBytes(18).toString("base64url");
}

interface ErrorBody {
  code: string;
  message: string;
  field?: string;
  priorAuditId?: string;
}

function jsonError(status: number, body: ErrorBody): Response {
  return NextResponse.json(body, { status });
}

function mapProvisioningError(err: unknown): Response {
  if (err instanceof EmailAlreadyExists) {
    return jsonError(409, { code: err.code, message: err.message });
  }
  if (err instanceof IdempotencyConflict) {
    return jsonError(409, {
      code: err.code,
      message: err.message,
      priorAuditId: err.priorAuditId,
    });
  }
  if (err instanceof InvalidRegime) {
    return jsonError(400, { code: err.code, message: err.message });
  }
  if (err instanceof ValidationError) {
    return jsonError(400, {
      code: err.code,
      message: err.message,
      field: err.field,
    });
  }
  if (err instanceof ProvisioningError) {
    return jsonError(400, { code: err.code, message: err.message });
  }
  // Anything else bubbles — Next renders a 500. The acceptance criteria
  // map *typed* errors to 4xx; untyped bugs are real 500s.
  throw err;
}

function parseAdditionalSeats(raw: unknown): ProvisionAdditionalSeat[] | Response {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    return jsonError(400, {
      code: "validation_error",
      message: "additionalSeats must be an array",
      field: "additionalSeats",
    });
  }
  const out: ProvisionAdditionalSeat[] = [];
  for (let i = 0; i < raw.length; i++) {
    const seat = raw[i];
    if (
      !seat ||
      typeof seat !== "object" ||
      typeof (seat as { email?: unknown }).email !== "string"
    ) {
      return jsonError(400, {
        code: "validation_error",
        message: `additionalSeats[${i}].email must be a string`,
        field: `additionalSeats[${i}].email`,
      });
    }
    if (!isAppRole((seat as { role?: unknown }).role)) {
      return jsonError(400, {
        code: "validation_error",
        message: `additionalSeats[${i}].role must be one of: ${APP_ROLE_CODES.join(", ")}`,
        field: `additionalSeats[${i}].role`,
      });
    }
    const seatRec = seat as { email: string; role: AppRoleCode };
    out.push({
      email: seatRec.email.trim().toLowerCase(),
      role: seatRec.role,
    });
  }
  return out;
}

/**
 * Tag the bare-DB platform-admin gate so callers don't reach into the
 * lower-level auth module just to satisfy the deps shape.
 */
async function gate(
  req: Request,
  deps: AdminTenantsDeps,
): Promise<PlatformAdminContext | Response> {
  const sessionDeps: SessionDeps = { db: deps.db, secret: deps.secret };
  return requirePlatformAdmin(req, {
    loadSession: buildLoadSession(sessionDeps),
    db: deps.db,
    cache: createPlatformAdminCache(),
  });
}

// ---------------------------------------------------------------------------
// POST /api/admin/tenants
// ---------------------------------------------------------------------------

export async function handleCreateTenant(
  req: Request,
  deps: AdminTenantsDeps,
): Promise<Response> {
  const ctx = await gate(req, deps);
  if (ctx instanceof Response) return ctx;

  let body: CreateTenantBody;
  try {
    body = (await req.json()) as CreateTenantBody;
  } catch {
    return jsonError(400, {
      code: "validation_error",
      message: "expected JSON body",
    });
  }

  const idempotencyKey = (req.headers.get("idempotency-key") ?? "").trim();

  // ---- Normalize + validate at the handler boundary ----------------------
  const orgName = typeof body.orgName === "string" ? body.orgName.trim() : "";
  if (!orgName) {
    return jsonError(400, {
      code: "validation_error",
      message: "orgName is required",
      field: "orgName",
    });
  }
  if (!isOrgType(body.orgType)) {
    return jsonError(400, {
      code: "validation_error",
      message: `orgType must be one of: ${ORG_TYPES.join(", ")}`,
      field: "orgType",
    });
  }
  if (
    body.regimeId !== undefined &&
    body.regimeId !== null &&
    typeof body.regimeId !== "string"
  ) {
    return jsonError(400, {
      code: "validation_error",
      message: "regimeId must be a string",
      field: "regimeId",
    });
  }
  const regimeId =
    typeof body.regimeId === "string" && body.regimeId.length > 0
      ? body.regimeId
      : undefined;

  const adminBody = body.primaryAdmin ?? {};
  const email =
    typeof adminBody.email === "string"
      ? adminBody.email.trim().toLowerCase()
      : "";
  if (!email || !email.includes("@") || email.length > 320) {
    return jsonError(400, {
      code: "validation_error",
      message: "primaryAdmin.email must be a valid email",
      field: "primaryAdmin.email",
    });
  }

  const rawPassword =
    typeof adminBody.password === "string" ? adminBody.password : "";
  const generatePassword = adminBody.generatePassword === true;
  if (rawPassword && generatePassword) {
    return jsonError(400, {
      code: "validation_error",
      message:
        "primaryAdmin.password and primaryAdmin.generatePassword are mutually exclusive",
      field: "primaryAdmin.password",
    });
  }
  let password: string;
  let generatedPassword = false;
  if (rawPassword) {
    if (rawPassword.length < 8) {
      return jsonError(400, {
        code: "validation_error",
        message: "primaryAdmin.password must be at least 8 characters",
        field: "primaryAdmin.password",
      });
    }
    password = rawPassword;
  } else if (generatePassword) {
    password = generateInitialPassword();
    generatedPassword = true;
  } else {
    return jsonError(400, {
      code: "validation_error",
      message:
        "primaryAdmin must include either password or generatePassword:true",
      field: "primaryAdmin.password",
    });
  }

  const seats = parseAdditionalSeats(body.additionalSeats);
  if (seats instanceof Response) return seats;

  const normalized: NormalizedCreateInput = {
    orgName,
    orgType: body.orgType,
    regimeId,
    primaryAdmin: { email, password },
    additionalSeats: seats,
    generatedPassword,
  };

  // ---- Idempotency body-fingerprint check --------------------------------
  // The service already replays a prior `done` row and rejects a non-`done`
  // prior with IdempotencyConflict. The handler adds the "different body
  // under the same key → 409" check the acceptance criteria call for.
  if (idempotencyKey) {
    const prior = await deps.db
      .select()
      .from(tenantProvisioningAudit)
      .where(eq(tenantProvisioningAudit.idempotencyKey, idempotencyKey))
      .limit(1);
    const priorRow = prior[0];
    if (priorRow && priorRow.resultStatus === "done") {
      const expected = fingerprintInput(
        normalized,
        idempotencyKey,
        ctx.userId,
      );
      const actual = priorRow.inputSnapshot as Record<string, unknown>;
      if (!sameSnapshot(expected, actual)) {
        return jsonError(409, {
          code: "idempotency_key_reused",
          message:
            "the supplied Idempotency-Key was previously used with a different request body",
          priorAuditId: priorRow.id,
        });
      }
      const snap = (priorRow.resultSnapshot ?? {}) as Record<string, unknown>;
      return NextResponse.json(
        {
          tenantId:
            typeof snap.tenantId === "string"
              ? snap.tenantId
              : priorRow.createdTenantId,
          primaryAdminUserId:
            typeof snap.primaryAdminUserId === "string"
              ? snap.primaryAdminUserId
              : null,
          auditId: priorRow.id,
        },
        { status: 200 },
      );
    }
  }

  const service = new TenantProvisioningService({
    db: deps.db,
    now: deps.now,
    withMembershipTx: productionMembershipTx,
    inviteMailer:
      seats.length > 0
        ? {
            mailer: new OutboxMailer(deps.db),
            acceptUrlBase: deps.acceptUrlBase,
          }
        : undefined,
  });

  const input: ProvisionTenantInput = {
    orgName: normalized.orgName,
    orgType: normalized.orgType,
    regimeId: normalized.regimeId,
    primaryAdmin: normalized.primaryAdmin,
    additionalSeats:
      normalized.additionalSeats.length > 0
        ? normalized.additionalSeats
        : undefined,
    // Always platform-admin from this surface — enforced server-side per
    // the acceptance criteria. The caller's `provisionedBy` field (if any)
    // is ignored.
    provisionedBy: { kind: "platform-admin", actorUserId: ctx.userId },
    idempotencyKey: idempotencyKey || undefined,
  };

  let result: Awaited<ReturnType<typeof service.provisionTenant>>;
  try {
    result = await service.provisionTenant(input);
  } catch (err) {
    return mapProvisioningError(err);
  }

  return NextResponse.json(
    {
      tenantId: result.tenantId,
      primaryAdminUserId: result.primaryAdminUserId,
      auditId: result.auditId,
      ...(generatedPassword ? { initialPassword: password } : {}),
    },
    { status: 201 },
  );
}

function sameSnapshot(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  // jsonb does NOT preserve insertion order — Postgres re-orders the
  // object keys when it stores them, so a naive JSON.stringify of the
  // freshly-read row would not match the freshly-built fingerprint
  // even when the logical content is identical. Canonicalize both sides
  // (sort keys alphabetically, recursively) before comparing.
  return canonicalize(a) === canonicalize(b);
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = sortValue(obj[k]);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// GET /api/admin/tenants
// ---------------------------------------------------------------------------

export async function handleListTenants(
  req: Request,
  deps: AdminTenantsDeps,
): Promise<Response> {
  const ctx = await gate(req, deps);
  if (ctx instanceof Response) return ctx;

  const rows = await deps.db
    .select({
      id: organizations.id,
      name: organizations.name,
      orgType: organizations.orgType,
      defaultRegimeId: organizations.defaultRegimeId,
      createdAt: organizations.createdAt,
    })
    .from(organizations)
    .orderBy(desc(organizations.createdAt));

  if (rows.length === 0) {
    return NextResponse.json({ tenants: [] });
  }

  // Per-tenant member counts + primary admin email. One query for counts +
  // one for the primary admins keeps this O(2) reads regardless of tenant
  // count. The "primary admin" is the earliest-created membership with
  // role=admin — a deterministic proxy for "the one we created at signup".
  const memberCountsRaw = await deps.db
    .select({
      tenantId: organizationMemberships.tenantId,
      total: sql<string>`count(*)::text`,
      admins: sql<string>`count(*) filter (where ${organizationMemberships.role} = 'admin')::text`,
    })
    .from(organizationMemberships)
    .groupBy(organizationMemberships.tenantId);

  const memberCounts = new Map<string, { total: number; admins: number }>();
  for (const row of memberCountsRaw) {
    memberCounts.set(row.tenantId, {
      total: Number(row.total),
      admins: Number(row.admins),
    });
  }

  // Primary admin per tenant: the earliest admin-role membership.
  // Pull all admin memberships ordered by createdAt asc and keep the first
  // per tenant. With one admin per tenant in the canonical case this is
  // one row per tenant; even with multiple admins, the loop preserves the
  // earliest one (the original primary).
  const adminRows = await deps.db
    .select({
      tenantId: organizationMemberships.tenantId,
      email: users.email,
      createdAt: organizationMemberships.createdAt,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(eq(organizationMemberships.role, "admin"))
    .orderBy(organizationMemberships.createdAt);
  const primaryAdminByTenant = new Map<string, string>();
  for (const row of adminRows) {
    if (!primaryAdminByTenant.has(row.tenantId)) {
      primaryAdminByTenant.set(row.tenantId, row.email);
    }
  }

  return NextResponse.json({
    tenants: rows.map((t) => ({
      id: t.id,
      name: t.name,
      orgType: t.orgType,
      regimeId: t.defaultRegimeId,
      primaryAdminEmail: primaryAdminByTenant.get(t.id) ?? null,
      createdAt: t.createdAt,
      memberCount: memberCounts.get(t.id)?.total ?? 0,
      adminCount: memberCounts.get(t.id)?.admins ?? 0,
    })),
  });
}

// ---------------------------------------------------------------------------
// GET /api/admin/tenants/:id
// ---------------------------------------------------------------------------

export async function handleGetTenant(
  req: Request,
  deps: AdminTenantsDeps,
  params: { id: string },
): Promise<Response> {
  const ctx = await gate(req, deps);
  if (ctx instanceof Response) return ctx;

  if (!UUID_RE.test(params.id)) {
    return jsonError(400, {
      code: "validation_error",
      message: "tenant id must be a uuid",
      field: "id",
    });
  }

  const [tenant] = await deps.db
    .select()
    .from(organizations)
    .where(eq(organizations.id, params.id))
    .limit(1);
  if (!tenant) {
    return jsonError(404, {
      code: "not_found",
      message: "tenant not found",
    });
  }

  const memberships = await deps.db
    .select({
      userId: organizationMemberships.userId,
      role: organizationMemberships.role,
      createdAt: organizationMemberships.createdAt,
      email: users.email,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(eq(organizationMemberships.tenantId, params.id));

  const audit = await deps.db
    .select({
      id: tenantProvisioningAudit.id,
      idempotencyKey: tenantProvisioningAudit.idempotencyKey,
      actorUserId: tenantProvisioningAudit.actorUserId,
      actorKind: tenantProvisioningAudit.actorKind,
      resultStatus: tenantProvisioningAudit.resultStatus,
      createdAt: tenantProvisioningAudit.createdAt,
      completedAt: tenantProvisioningAudit.completedAt,
    })
    .from(tenantProvisioningAudit)
    .where(eq(tenantProvisioningAudit.createdTenantId, params.id))
    .orderBy(desc(tenantProvisioningAudit.createdAt))
    .limit(50);

  return NextResponse.json({
    tenant: {
      id: tenant.id,
      name: tenant.name,
      orgType: tenant.orgType,
      regimeId: tenant.defaultRegimeId,
      createdAt: tenant.createdAt,
      updatedAt: tenant.updatedAt,
    },
    memberships: memberships.map((m) => ({
      userId: m.userId,
      email: m.email,
      role: m.role,
      createdAt: m.createdAt,
    })),
    recentAudit: audit,
  });
}

// ---------------------------------------------------------------------------
// GET /api/admin/audit?after=<auditId>&limit=<n>
// ---------------------------------------------------------------------------

const AUDIT_PAGE_SIZE = 50;

export async function handleListAudit(
  req: Request,
  deps: AdminTenantsDeps,
): Promise<Response> {
  const ctx = await gate(req, deps);
  if (ctx instanceof Response) return ctx;

  const url = new URL(req.url);
  const after = url.searchParams.get("after");
  const rawLimit = url.searchParams.get("limit");
  const limit = clampInt(rawLimit, 1, 200, AUDIT_PAGE_SIZE);

  let afterCreatedAt: Date | null = null;
  if (after) {
    if (!UUID_RE.test(after)) {
      return jsonError(400, {
        code: "validation_error",
        message: "after must be a uuid (audit row id)",
        field: "after",
      });
    }
    const [cursor] = await deps.db
      .select({ createdAt: tenantProvisioningAudit.createdAt })
      .from(tenantProvisioningAudit)
      .where(eq(tenantProvisioningAudit.id, after))
      .limit(1);
    if (!cursor) {
      return jsonError(400, {
        code: "validation_error",
        message: "after cursor not found",
        field: "after",
      });
    }
    afterCreatedAt = cursor.createdAt;
  }

  // ascending by createdAt so the "after" cursor walks forward through the
  // log. Pair with limit+1 trick to compute hasMore without a second query.
  const rows = await deps.db
    .select({
      id: tenantProvisioningAudit.id,
      createdTenantId: tenantProvisioningAudit.createdTenantId,
      idempotencyKey: tenantProvisioningAudit.idempotencyKey,
      actorUserId: tenantProvisioningAudit.actorUserId,
      actorKind: tenantProvisioningAudit.actorKind,
      resultStatus: tenantProvisioningAudit.resultStatus,
      createdAt: tenantProvisioningAudit.createdAt,
      completedAt: tenantProvisioningAudit.completedAt,
      error: tenantProvisioningAudit.error,
    })
    .from(tenantProvisioningAudit)
    .where(
      afterCreatedAt
        ? gt(tenantProvisioningAudit.createdAt, afterCreatedAt)
        : sql`true`,
    )
    .orderBy(tenantProvisioningAudit.createdAt)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return NextResponse.json({
    audit: page,
    nextAfter: hasMore ? page[page.length - 1]?.id ?? null : null,
  });
}

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// ---------------------------------------------------------------------------
// POST /api/admin/tenants/:id/reseed-demo
// ---------------------------------------------------------------------------

export async function handleReseedDemo(
  req: Request,
  deps: AdminTenantsDeps,
  params: { id: string },
): Promise<Response> {
  const ctx = await gate(req, deps);
  if (ctx instanceof Response) return ctx;

  if (!UUID_RE.test(params.id)) {
    return jsonError(400, {
      code: "validation_error",
      message: "tenant id must be a uuid",
      field: "id",
    });
  }

  const [tenant] = await deps.db
    .select({ id: organizations.id, regimeId: organizations.defaultRegimeId })
    .from(organizations)
    .where(eq(organizations.id, params.id))
    .limit(1);
  if (!tenant) {
    return jsonError(404, {
      code: "not_found",
      message: "tenant not found",
    });
  }

  // Look up the earliest admin membership — the "primary admin" we seed
  // entries against. Required for entries that need an author/signer/pilot
  // user id, but the demo content we seed today only needs an aircraft +
  // subscriptions + an open squawk + a draft maintenance entry; the user
  // id falls out as the primary admin so the squawk has a reporter and
  // the draft entry has no signer.
  const [primaryAdmin] = await deps.db
    .select({ userId: organizationMemberships.userId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.tenantId, params.id),
        eq(organizationMemberships.role, "admin"),
      ),
    )
    .orderBy(organizationMemberships.createdAt)
    .limit(1);
  if (!primaryAdmin) {
    return jsonError(409, {
      code: "tenant_has_no_admin",
      message:
        "tenant must have at least one admin membership before demo content can be seeded",
    });
  }

  const result = await seedDemoContent({
    db: deps.db,
    tenantId: params.id,
    regimeId: tenant.regimeId,
    reporterUserId: primaryAdmin.userId,
    now: deps.now,
  });

  return NextResponse.json(
    {
      tenantId: params.id,
      aircraftId: result.aircraftId,
      seededAt: (deps.now ? deps.now() : new Date()).toISOString(),
    },
    { status: 200 },
  );
}
