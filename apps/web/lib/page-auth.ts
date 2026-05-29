import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";

import {
  hasPermission,
  type MembershipWithPermissions,
  type Permission,
} from "@ga/accounts";
import { schema, type OrgType } from "@ga/db";

import { loadSession, SESSION_COOKIE_NAME, type SessionRecord } from "./auth/session";
import { buildLoadMembership } from "./auth/withRequest";
import { getDb } from "./db";
import {
  runAsIdentityOnProductionDb,
  runAsTenantOnProductionDb,
  type RequestTenantTx,
} from "./tenant-tx";

const { organizationMemberships, organizations } = schema;

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
async function loadPageSession(): Promise<SessionRecord | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE_NAME);
  if (!raw) return null;
  const req = new Request("https://internal.invalid/", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${raw.value}` },
  });
  return loadSession(req, { db: getDb(), secret: requireSessionSecret() });
}

/**
 * Session for the current request, or null. Public wrapper around the
 * cookie + HMAC pipeline so the home page and `/orgs` index can branch
 * on auth without a permission/tenant check.
 */
export async function getOptionalSession(): Promise<SessionRecord | null> {
  return loadPageSession();
}

/**
 * Require a signed-in user for a page that has no tenant in its URL
 * (the `/orgs` index). Redirects to /login when there is no session.
 */
export async function requireUser(): Promise<{ userId: string; email: string }> {
  const session = await loadPageSession();
  if (!session) redirect("/login");
  return { userId: session.user.id, email: session.user.email };
}

export interface UserOrganization {
  tenantId: string;
  name: string;
  orgType: OrgType;
  role: string;
}

/**
 * Every organization the user is a member of, with their role. Reads the
 * membership × organization join inside an *identity* transaction
 * (tenant_app + `app.current_user_id` set LOCAL). The `app_self_membership`
 * policy (migration 0019) restricts visibility to the authenticated user's
 * own rows — exactly what `/orgs` needs to route a user into their org
 * without a typed tenant id.
 *
 * Why the role switch: under the non-bypass `tenant_runtime` connection
 * (PMB-74), reading `organization_memberships` directly on the connection
 * would fail (no grant) or return zero rows (FORCE-RLS, no GUC). The
 * identity tx + policy is the secure-by-default path.
 */
export async function listUserOrganizations(
  userId: string,
): Promise<UserOrganization[]> {
  const db = getDb();
  return runAsIdentityOnProductionDb(db, userId, async (tx) => {
    const rows = await tx
      .select({
        tenantId: organizationMemberships.tenantId,
        role: organizationMemberships.role,
        name: organizations.name,
        orgType: organizations.orgType,
      })
      .from(organizationMemberships)
      .innerJoin(
        organizations,
        eq(organizations.id, organizationMemberships.tenantId),
      )
      .where(eq(organizationMemberships.userId, userId))
      .orderBy(organizations.name);
    return rows.map((r) => ({
      tenantId: r.tenantId,
      name: r.name,
      orgType: r.orgType,
      role: r.role,
    }));
  });
}

export interface OrgNavContext {
  userId: string;
  email: string;
  tenantId: string;
  orgName: string;
  orgType: OrgType;
  role: string;
}

/**
 * Resolve the nav context (org name + the user's role) for an org-scoped
 * layout. Returns a discriminated result so the layout can redirect to
 * /login (no session) or /orgs (signed in but not a member of this org).
 */
export async function loadOrgNavContext(
  tenantId: string,
): Promise<
  | { ok: true; ctx: OrgNavContext }
  | { ok: false; reason: "no-session" | "not-member" }
> {
  if (!UUID_RE.test(tenantId)) return { ok: false, reason: "not-member" };
  const session = await loadPageSession();
  if (!session) return { ok: false, reason: "no-session" };
  const db = getDb();
  // Membership × organization join runs as tenant_app inside the tenant tx —
  // app_isolation gates the membership row, and tenant_app holds SELECT on
  // organizations (granted in migration 0019). Under the non-bypass
  // tenant_runtime connection this is the only path that returns rows; on the
  // legacy bypass-class connection it's equally safe (a tighter envelope, no
  // visibility change).
  const row = await runAsTenantOnProductionDb(db, tenantId, async (tx) => {
    const [r] = await tx
      .select({
        role: organizationMemberships.role,
        name: organizations.name,
        orgType: organizations.orgType,
      })
      .from(organizationMemberships)
      .innerJoin(
        organizations,
        eq(organizations.id, organizationMemberships.tenantId),
      )
      .where(
        and(
          eq(organizationMemberships.userId, session.user.id),
          eq(organizationMemberships.tenantId, tenantId),
        ),
      )
      .limit(1);
    return r ?? null;
  });
  if (!row) return { ok: false, reason: "not-member" };
  return {
    ok: true,
    ctx: {
      userId: session.user.id,
      email: session.user.email,
      tenantId,
      orgName: row.name,
      orgType: row.orgType,
      role: row.role,
    },
  };
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
 * Redirects to /login on no-session, to /orgs on a tenant/permission
 * mismatch (so the user lands on their own org list rather than the
 * marketing home).
 */
export async function runPage<T>(
  tenantId: string,
  permission: Permission,
  fn: (tx: RequestTenantTx, ctx: PageContext) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) redirect("/orgs");
  const session = await loadPageSession();
  if (!session) redirect("/login");

  const db = getDb();
  const { loadPermissionsMatrix } = await import("@ga/accounts");
  const matrix = await loadPermissionsMatrix(db);
  const loadMembership = buildLoadMembership(db, matrix);

  const membership = await loadMembership(session.user.id, tenantId);
  if (!membership) redirect("/orgs");
  if (!hasPermission(membership, permission)) redirect("/orgs");

  return runAsTenantOnProductionDb(db, tenantId, (tx) =>
    fn(tx, { tenantId, userId: session.user.id, membership }),
  );
}
