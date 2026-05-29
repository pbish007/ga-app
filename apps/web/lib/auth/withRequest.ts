import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { schema } from "@ga/db";
import {
  attachPermissions,
  hasPermission,
  type AccountsDb,
  type MembershipWithPermissions,
  type Permission,
  type PermissionsMatrix,
} from "@ga/accounts";
import type { DocumentsDb } from "@ga/storage";

import { runAsTenantOnProductionDb } from "../tenant-tx";
import { loadSession, type SessionDeps, type SessionUser } from "./session";

const { organizationMemberships } = schema;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Header carrying the active tenant id. The URL-segment form
 * `/api/orgs/{tenantId}/...` is also recognized by the default
 * resolver. Either is fine; we accept both so single-tenant flows
 * (header) and tenant-scoped REST routes (URL) can share middleware.
 */
export const TENANT_HEADER = "x-tenant-id";

const ORG_SEGMENT_RE = /\/orgs\/([0-9a-f-]{36})(?:\/|$)/i;

/**
 * Everything a wrapped handler needs without having to re-resolve it.
 * `tx` is the per-request tenant-scoped transaction handle, so queries
 * issued inside the handler run under `set local role tenant_app` and
 * `set local app.current_tenant_id = <tenant>` (RLS enforced).
 */
export interface RequestContext<Tx> {
  user: SessionUser;
  tenantId: string;
  membership: MembershipWithPermissions;
  tx: Tx;
}

export type TenantTxFn<Tx> = <T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
) => Promise<T>;

export interface WithRequestDeps<Tx> {
  /** Session loader (HMAC verify + user fetch). */
  loadSession: (req: Request) => Promise<Awaited<ReturnType<typeof loadSession>>>;
  /**
   * Resolve a (userId, tenantId) → membership-with-permissions. Returns
   * null when the user is not a member of the tenant. The default
   * implementation lives in `loadMembershipWithPermissions` below.
   */
  loadMembership: (
    userId: string,
    tenantId: string,
  ) => Promise<MembershipWithPermissions | null>;
  /**
   * Open a transaction with the tenant GUC + `tenant_app` role pinned
   * LOCAL — typically `runAsTenant` from `@ga/db`.
   */
  runAsTenant: TenantTxFn<Tx>;
}

export interface WithRequestOptions {
  /**
   * Permission code required to execute the handler. Omit for routes
   * that only need authenticated tenant membership (read-only views
   * of the tenant root, etc.).
   */
  permission?: Permission;
  /**
   * Override the default tenant resolution (header → URL segment).
   * Returning `null` causes a 400.
   */
  resolveTenantId?: (req: Request) => string | null;
}

/**
 * Wrap a Route Handler with the auth pipeline:
 *
 *   1. `loadSession`        → 401 if missing/invalid.
 *   2. `resolveTenantId`    → 400 if missing/invalid format.
 *   3. `loadMembership`     → 403 if the user is not a member.
 *   4. `requirePermission`  → 403 if the role lacks `options.permission`.
 *   5. `runAsTenant`        → the handler runs inside the tenant tx.
 *
 * Errors thrown by the handler bubble (Next renders 500). The handler
 * receives a context with the user, tenant id, membership (with the
 * resolved permission set), and the tenant-scoped transaction handle.
 */
export function withRequest<Tx>(
  deps: WithRequestDeps<Tx>,
  options: WithRequestOptions,
  handler: (req: Request, ctx: RequestContext<Tx>) => Promise<Response>,
): (req: Request) => Promise<Response> {
  const resolveTenantId = options.resolveTenantId ?? defaultResolveTenantId;
  return async (req) => {
    const session = await deps.loadSession(req);
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const tenantId = resolveTenantId(req);
    if (!tenantId || !UUID_RE.test(tenantId)) {
      return NextResponse.json(
        { error: "missing or invalid tenant id" },
        { status: 400 },
      );
    }
    const membership = await deps.loadMembership(
      session.user.id,
      tenantId.toLowerCase(),
    );
    if (!membership) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (options.permission && !hasPermission(membership, options.permission)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return await deps.runAsTenant(tenantId.toLowerCase(), (tx) =>
      handler(req, {
        user: session.user,
        tenantId: tenantId.toLowerCase(),
        membership,
        tx,
      }),
    );
  };
}

function defaultResolveTenantId(req: Request): string | null {
  const header = req.headers.get(TENANT_HEADER);
  if (header && header.trim() !== "") return header.trim();
  const url = new URL(req.url);
  const match = url.pathname.match(ORG_SEGMENT_RE);
  return match?.[1] ?? null;
}

/**
 * Default `loadMembership` implementation. Queries the
 * `organization_memberships` table by (user, tenant) and attaches the
 * permission set via the in-memory matrix.
 *
 * The read runs inside `runAsTenantOnProductionDb` (tenant_app role +
 * `app.current_tenant_id` set LOCAL), so RLS is enforced as a database
 * property — the connection role no longer needs to bypass RLS for this
 * lookup to succeed. (PMB-74 — required so the runtime DATABASE_URL can
 * repoint at the non-bypass `tenant_runtime` role.)
 *
 * Production callers wire this up once per process with the
 * application's db handle + cached matrix; tests construct it inline
 * against the pglite test db.
 */
export function buildLoadMembership(
  db: AccountsDb,
  matrix: PermissionsMatrix,
): (
  userId: string,
  tenantId: string,
) => Promise<MembershipWithPermissions | null> {
  return async (userId, tenantId) => {
    return runAsTenantOnProductionDb(db as DocumentsDb, tenantId, async (tx) => {
      const [m] = await tx
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.userId, userId),
            eq(organizationMemberships.tenantId, tenantId),
          ),
        )
        .limit(1);
      return m ? attachPermissions(m, matrix) : null;
    });
  };
}

/**
 * Bind a `SessionDeps` to a request-shape loader so callers can build
 * the full deps object without re-passing the secret/db on every
 * route.
 */
export function buildLoadSession(
  deps: SessionDeps,
): (req: Request) => ReturnType<typeof loadSession> {
  return (req) => loadSession(req, deps);
}
