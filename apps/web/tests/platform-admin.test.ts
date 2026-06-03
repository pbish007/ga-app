import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  schema as dbSchema,
  setupTestSuite,
  type TestDb,
} from "@ga/db";
import { passwordHasher } from "@ga/accounts";

import {
  SESSION_COOKIE_NAME,
  buildLoadSession,
  createPlatformAdminCache,
  createSessionCookieValue,
  isPlatformAdmin,
  requirePlatformAdmin,
} from "../lib/auth";

const { organizations, organizationMemberships, platformAdmins, regimes, users } =
  dbSchema;

const SECRET =
  "test-only-secret-test-only-secret-test-only-secret-32+bytes";

interface Seed {
  adminUserId: string;
  adminEmail: string;
  tenantUserId: string;
  tenantUserEmail: string;
  revokedAdminUserId: string;
  password: string;
}

async function seed(db: TestDb): Promise<Seed> {
  const [faa] = await db.select().from(regimes);
  if (!faa) throw new Error("FAA regime seed missing");
  const [org] = await db
    .insert(organizations)
    .values({ name: "Tenant Org", orgType: "club", defaultRegimeId: faa.id })
    .returning();
  if (!org) throw new Error("seed org failed");

  const password = "correct horse battery staple";
  const hash = await passwordHasher.hash(password);

  const [admin, tenantUser, revoked] = await db
    .insert(users)
    .values([
      { email: "admin@example.test", passwordHash: hash },
      { email: "pilot@example.test", passwordHash: hash },
      { email: "revoked@example.test", passwordHash: hash },
    ])
    .returning();
  if (!admin || !tenantUser || !revoked) throw new Error("seed users failed");

  // Tenant-side user is an admin in their org — proves that being an
  // organization admin does NOT make you a platform admin.
  await db.insert(organizationMemberships).values({
    tenantId: org.id,
    userId: tenantUser.id,
    role: "admin",
  });

  // Live platform admin.
  await db.insert(platformAdmins).values({
    userId: admin.id,
    note: "test seed",
  });

  // Revoked platform admin — was granted, then revoked. Gate must treat
  // them as not-admin even though the row exists.
  await db.insert(platformAdmins).values({
    userId: revoked.id,
    revokedAt: new Date("2026-01-01T00:00:00Z"),
    note: "test seed (revoked)",
  });

  return {
    adminUserId: admin.id,
    adminEmail: admin.email,
    tenantUserId: tenantUser.id,
    tenantUserEmail: tenantUser.email,
    revokedAdminUserId: revoked.id,
    password,
  };
}

function authedRequest(userId: string, iat = Math.floor(Date.now() / 1000)) {
  const cookie = createSessionCookieValue({ userId, iat }, SECRET);
  return new Request("https://example.test/api/admin/things", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
  });
}

describe("isPlatformAdmin (PMB-116)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  let s: Seed;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  beforeEach(async () => {
    s = await seed(db);
  });
  afterEach(async () => {
    await reset();
  });

  it("returns true for a live platform admin", async () => {
    expect(await isPlatformAdmin(s.adminUserId, { db })).toBe(true);
  });

  it("returns false for a user with NO platform_admins row (tenant-only admin)", async () => {
    // tenantUser holds the org-scoped `admin` role; that does NOT make them
    // a platform admin. This is the central distinction the table exists
    // to draw.
    expect(await isPlatformAdmin(s.tenantUserId, { db })).toBe(false);
  });

  it("returns false for an admin whose row has been revoked", async () => {
    expect(await isPlatformAdmin(s.revokedAdminUserId, { db })).toBe(false);
  });

  it("returns false for an unknown user id", async () => {
    expect(
      await isPlatformAdmin("00000000-0000-0000-0000-000000000000", { db }),
    ).toBe(false);
  });

  it("memoizes through the per-request cache (one DB lookup per userId)", async () => {
    const cache = createPlatformAdminCache();
    expect(await isPlatformAdmin(s.adminUserId, { db, cache })).toBe(true);
    expect(cache.has(s.adminUserId)).toBe(true);

    // Mutate the table to revoke. A subsequent call WITH the cache should
    // still report true (cache hit). Without the cache, it must report false.
    await db
      .update(platformAdmins)
      .set({ revokedAt: new Date() })
      // drizzle eq import would be heavy here — raw filter is fine.
      // Use cache to assert memoization; uncached call verifies write took.
      ;
    expect(await isPlatformAdmin(s.adminUserId, { db, cache })).toBe(true);
    // Fresh cache reflects the new state.
    expect(
      await isPlatformAdmin(s.adminUserId, {
        db,
        cache: createPlatformAdminCache(),
      }),
    ).toBe(false);
  });
});

describe("requirePlatformAdmin gate (PMB-116)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  let s: Seed;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  beforeEach(async () => {
    s = await seed(db);
  });
  afterEach(async () => {
    await reset();
  });

  function deps() {
    return {
      loadSession: buildLoadSession({ db, secret: SECRET }),
      db,
    };
  }

  it("401 with no session cookie", async () => {
    const res = await requirePlatformAdmin(
      new Request("https://example.test/api/admin/things"),
      deps(),
    );
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  it("403 for an authenticated tenant-only user (no platform_admins row)", async () => {
    const res = await requirePlatformAdmin(
      authedRequest(s.tenantUserId),
      deps(),
    );
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
  });

  it("403 for an authenticated user whose admin row is revoked", async () => {
    const res = await requirePlatformAdmin(
      authedRequest(s.revokedAdminUserId),
      deps(),
    );
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
  });

  it("returns a typed context for an authenticated live platform admin", async () => {
    const res = await requirePlatformAdmin(
      authedRequest(s.adminUserId),
      deps(),
    );
    // Success branch is the typed envelope, not a Response.
    expect(res).not.toBeInstanceOf(Response);
    expect(res).toMatchObject({
      userId: s.adminUserId,
      email: s.adminEmail,
    });
  });

  it("shares the cache across sibling gate calls in one request", async () => {
    const cache = createPlatformAdminCache();
    const d = { ...deps(), cache };
    // First call populates the cache.
    const first = await requirePlatformAdmin(authedRequest(s.adminUserId), d);
    expect(first).not.toBeInstanceOf(Response);
    expect(cache.get(s.adminUserId)).toBe(true);

    // A subsequent call inside the same "request" stays consistent even if
    // the row mutates underneath.
    await db
      .update(platformAdmins)
      .set({ revokedAt: new Date() })
      ;
    const second = await requirePlatformAdmin(authedRequest(s.adminUserId), d);
    // Still admin because the cache short-circuited the DB read.
    expect(second).not.toBeInstanceOf(Response);
  });
});
