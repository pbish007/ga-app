import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { schema } from "@ga/db";
import type { AccountsDb } from "@ga/accounts";

import { loadSession, type SessionDeps } from "./session.js";

const { platformAdmins } = schema;

/**
 * Resolve whether the supplied `userId` is currently a platform admin.
 *
 * Looks up `platform_admins` by primary key and treats `revoked_at IS NULL`
 * as the live-admin condition. The read runs on the bare DB handle — NOT
 * inside a tenant tx — because the table is deliberately not granted to
 * `tenant_app` (see migration 0023). A request that has already entered
 * `runAsTenantOnProductionDb` must call this BEFORE switching roles.
 *
 * Per-request caching. Callers may pass a cache `Map` to memoize the result
 * for the lifetime of a single request. The web app builds a fresh map per
 * request and threads it through; tests construct one inline. The cache key
 * is the userId itself.
 */
export type PlatformAdminCache = Map<string, boolean>;

export interface IsPlatformAdminDeps {
  db: AccountsDb;
  /** Optional per-request cache. Omitted in cold calls (e.g. tests). */
  cache?: PlatformAdminCache;
}

export async function isPlatformAdmin(
  userId: string,
  deps: IsPlatformAdminDeps,
): Promise<boolean> {
  if (deps.cache?.has(userId)) {
    return deps.cache.get(userId) === true;
  }
  const [row] = await deps.db
    .select({ userId: platformAdmins.userId })
    .from(platformAdmins)
    .where(
      and(eq(platformAdmins.userId, userId), isNull(platformAdmins.revokedAt)),
    )
    .limit(1);
  const result = !!row;
  deps.cache?.set(userId, result);
  return result;
}

/**
 * Build a fresh per-request cache. The web app wires this into the request
 * pipeline so multiple gate calls during a single request share one DB read.
 */
export function createPlatformAdminCache(): PlatformAdminCache {
  return new Map();
}

export interface RequirePlatformAdminDeps {
  /** Session loader (HMAC verify + user fetch). */
  loadSession: (req: Request) => Promise<Awaited<ReturnType<typeof loadSession>>>;
  db: AccountsDb;
  /** Optional per-request cache shared with sibling gate calls. */
  cache?: PlatformAdminCache;
}

/**
 * Outcome of a successful `requirePlatformAdmin` call. Mirrors the
 * envelope shape of `requireSignoff` / `withRequest`: on success the route
 * receives a typed context; on failure the caller returns the Response
 * unchanged. The route then proceeds outside any tenant tx — admin routes
 * are explicitly cross-tenant and never set `app.current_tenant_id`.
 */
export interface PlatformAdminContext {
  userId: string;
  email: string;
}

/**
 * 401 when no valid session is present. 403 when the session is valid but
 * the user is not a platform admin. `null` (caller proceeds) is never
 * returned — success is the typed `PlatformAdminContext`. This matches
 * the shape used by C3 admin routes: deny by default, type-narrow on
 * success.
 *
 * NOT TENANT-AWARE. Admin routes are global by construction. Wrap with
 * `withRequest` if a route also needs a tenant context; otherwise call
 * this gate at the top of the handler and run the handler's queries on
 * the bare DB (not in a tenant tx — tenant_app has no grant on
 * `platform_admins`).
 */
export async function requirePlatformAdmin(
  req: Request,
  deps: RequirePlatformAdminDeps,
): Promise<PlatformAdminContext | Response> {
  const session = await deps.loadSession(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const ok = await isPlatformAdmin(session.user.id, {
    db: deps.db,
    cache: deps.cache,
  });
  if (!ok) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return { userId: session.user.id, email: session.user.email };
}

export type { SessionDeps };
