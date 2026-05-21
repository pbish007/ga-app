import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  hasPermission,
  type MembershipWithPermissions,
  type Permission,
} from "@ga/accounts";

import { loadSession, SESSION_COOKIE_NAME } from "./auth/session";
import { buildLoadMembership } from "./auth/withRequest";
import { getDb } from "./db";
import { runAsTenantOnProductionDb, type RequestTenantTx } from "./tenant-tx";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET must be set");
  return secret;
}

/**
 * Reads the session cookie from Next's RSC `cookies()` helper and
 * loads the session record. Returns null when the cookie is missing or
 * the signature fails — pages can redirect to login.
 */
async function loadPageSession() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE_NAME);
  if (!raw) return null;
  const req = new Request("https://internal.invalid/", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${raw.value}` },
  });
  return loadSession(req, { db: getDb(), secret: requireSessionSecret() });
}

export interface PageContext {
  tenantId: string;
  userId: string;
  membership: MembershipWithPermissions;
}

/**
 * Resolve session + tenant membership for a server component, then run
 * `fn` inside the tenant transaction so all queries pass through RLS.
 *
 * Redirects to /login on no-session, to / on permission failure. Both
 * are placeholder destinations until Epic A delivers proper UI flows.
 */
export async function runPage<T>(
  tenantId: string,
  permission: Permission,
  fn: (tx: RequestTenantTx, ctx: PageContext) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) redirect("/");
  const session = await loadPageSession();
  if (!session) redirect("/");

  const db = getDb();
  const { loadPermissionsMatrix } = await import("@ga/accounts");
  const matrix = await loadPermissionsMatrix(db);
  const loadMembership = buildLoadMembership(db, matrix);

  const membership = await loadMembership(session.user.id, tenantId);
  if (!membership) redirect("/");
  if (!hasPermission(membership, permission)) redirect("/");

  return runAsTenantOnProductionDb(db, tenantId, (tx) =>
    fn(tx, { tenantId, userId: session.user.id, membership }),
  );
}
