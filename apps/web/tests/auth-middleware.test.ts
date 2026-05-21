import { beforeEach, describe, expect, it } from "vitest";

import {
  schema as dbSchema,
  runAsTenant,
  setupTestDb,
  type TestDb,
} from "@ga/db";
import {
  loadPermissionsMatrix,
  passwordHasher,
  type PermissionsMatrix,
} from "@ga/accounts";

import {
  SESSION_COOKIE_NAME,
  buildLoadMembership,
  buildLoadSession,
  createSessionCookieValue,
  handleLogin,
  withRequest,
} from "../lib/auth";

const { organizations, organizationMemberships, regimes, users } = dbSchema;

const SECRET =
  "test-only-secret-test-only-secret-test-only-secret-32+bytes";

interface Seed {
  tenantId: string;
  otherTenantId: string;
  userId: string;
  email: string;
  password: string;
}

async function seed(db: TestDb): Promise<Seed> {
  const [faa] = await db.select().from(regimes);
  if (!faa) throw new Error("FAA regime seed missing");
  const [orgA] = await db
    .insert(organizations)
    .values({ name: "Org A", orgType: "club", defaultRegimeId: faa.id })
    .returning();
  const [orgB] = await db
    .insert(organizations)
    .values({ name: "Org B", orgType: "shop", defaultRegimeId: faa.id })
    .returning();
  if (!orgA || !orgB) throw new Error("seed orgs failed");

  const password = "correct horse battery staple";
  const [user] = await db
    .insert(users)
    .values({
      email: "pilot@example.test",
      passwordHash: await passwordHasher.hash(password),
    })
    .returning();
  if (!user) throw new Error("seed user failed");

  // The user is a `pilot` (read-only) in Org A; not a member of Org B.
  await db.insert(organizationMemberships).values({
    tenantId: orgA.id,
    userId: user.id,
    role: "pilot",
  });

  return {
    tenantId: orgA.id,
    otherTenantId: orgB.id,
    userId: user.id,
    email: user.email,
    password,
  };
}

function buildDeps(db: TestDb, matrix: PermissionsMatrix) {
  return {
    loadSession: buildLoadSession({ db, secret: SECRET }),
    loadMembership: buildLoadMembership(db, matrix),
    runAsTenant: <T,>(
      tenantId: string,
      fn: (tx: Parameters<Parameters<TestDb["transaction"]>[0]>[0]) => Promise<T>,
    ) => runAsTenant(db, tenantId, fn),
  };
}

function authedRequest(
  url: string,
  opts: { userId: string; tenantId?: string; iat?: number } = {
    userId: "00000000-0000-0000-0000-000000000000",
  },
) {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const cookie = createSessionCookieValue(
    { userId: opts.userId, iat },
    SECRET,
  );
  const headers = new Headers({
    cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
  });
  if (opts.tenantId) headers.set("x-tenant-id", opts.tenantId);
  return new Request(url, { headers });
}

describe("withRequest middleware (PMB-33)", () => {
  let db: TestDb;
  let matrix: PermissionsMatrix;
  let s: Seed;

  beforeEach(async () => {
    db = await setupTestDb();
    matrix = await loadPermissionsMatrix(db);
    s = await seed(db);
  });

  it("401 when no session cookie is present", async () => {
    const deps = buildDeps(db, matrix);
    const handler = withRequest(deps, {}, async () => Response.json({ ok: true }));

    const req = new Request("https://example.test/api/aircraft", {
      headers: { "x-tenant-id": s.tenantId },
    });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it("403 when the tenant header is for an org the user is not a member of", async () => {
    const deps = buildDeps(db, matrix);
    const handler = withRequest(deps, {}, async () => Response.json({ ok: true }));

    const req = authedRequest("https://example.test/api/aircraft", {
      userId: s.userId,
      tenantId: s.otherTenantId,
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it("200 with proper membership + permission (tenant tx is scoped)", async () => {
    const deps = buildDeps(db, matrix);
    const handler = withRequest(
      deps,
      { permission: "aircraft.read" },
      async (_req, ctx) => {
        // The pilot role has aircraft.read by the A2.1 matrix.
        expect(ctx.tenantId).toBe(s.tenantId);
        expect(ctx.user.id).toBe(s.userId);
        expect(ctx.membership.role).toBe("pilot");
        expect(ctx.membership.permissions.has("aircraft.read")).toBe(true);
        // The tx must already be running inside `set local role tenant_app`
        // — proven by the fact that the tenant's own membership row is
        // visible while the other tenant's is not.
        const visible = await ctx.tx
          .select()
          .from(organizationMemberships);
        expect(visible.map((m) => m.tenantId)).toEqual([s.tenantId]);
        return Response.json({ ok: true, tenantId: ctx.tenantId });
      },
    );

    const req = authedRequest("https://example.test/api/aircraft", {
      userId: s.userId,
      tenantId: s.tenantId,
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tenantId: string };
    expect(body).toEqual({ ok: true, tenantId: s.tenantId });
  });

  it("403 when the role lacks the required permission", async () => {
    const deps = buildDeps(db, matrix);
    // `pilot` does not have aircraft.write — the matrix only grants it
    // to admin/manager/mechanic per A2.1's truth table.
    const handler = withRequest(
      deps,
      { permission: "aircraft.write" },
      async () => Response.json({ ok: true }),
    );

    const req = authedRequest("https://example.test/api/aircraft", {
      userId: s.userId,
      tenantId: s.tenantId,
    });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it("400 when no tenant id is supplied at all (header or URL)", async () => {
    // Not strictly a spec test path, but documents the edge: the
    // middleware must not enter `runAsTenant` without a tenant.
    const deps = buildDeps(db, matrix);
    const handler = withRequest(deps, {}, async () => Response.json({ ok: true }));

    const req = authedRequest("https://example.test/api/aircraft", {
      userId: s.userId,
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  it("URL-segment tenant resolution works as a fallback", async () => {
    const deps = buildDeps(db, matrix);
    const handler = withRequest(deps, {}, async (_req, ctx) =>
      Response.json({ ok: true, tenantId: ctx.tenantId }),
    );

    const cookie = createSessionCookieValue(
      { userId: s.userId, iat: Math.floor(Date.now() / 1000) },
      SECRET,
    );
    const req = new Request(
      `https://example.test/api/orgs/${s.tenantId}/aircraft`,
      { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } },
    );
    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  it("invalidates a session whose iat is older than passwordChangedAt", async () => {
    const deps = buildDeps(db, matrix);
    const handler = withRequest(deps, {}, async () => Response.json({ ok: true }));

    // Issue a session, then "rotate" the password by setting
    // password_changed_at to one hour into the future.
    const iat = Math.floor(Date.now() / 1000);
    const cookie = createSessionCookieValue(
      { userId: s.userId, iat },
      SECRET,
    );
    const future = new Date((iat + 3600) * 1000);
    await db
      .update(users)
      .set({ passwordChangedAt: future })
      .where(eqUserId(s.userId));

    const req = new Request("https://example.test/api/aircraft", {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
        "x-tenant-id": s.tenantId,
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it("rejects a tampered cookie signature", async () => {
    const deps = buildDeps(db, matrix);
    const handler = withRequest(deps, {}, async () => Response.json({ ok: true }));

    const cookie = createSessionCookieValue(
      { userId: s.userId, iat: Math.floor(Date.now() / 1000) },
      SECRET,
    );
    // Flip one signature character. The structure stays valid so
    // parseSessionCookieValue gets to the HMAC compare.
    const tampered = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    const req = new Request("https://example.test/api/aircraft", {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${tampered}`,
        "x-tenant-id": s.tenantId,
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });
});

describe("handleLogin (PMB-33)", () => {
  let db: TestDb;
  let s: Seed;

  beforeEach(async () => {
    db = await setupTestDb();
    s = await seed(db);
  });

  it("issues a signed session cookie on valid credentials", async () => {
    const res = await handleLogin(
      new Request("https://example.test/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: s.email, password: s.password }),
        headers: { "content-type": "application/json" },
      }),
      { db, secret: SECRET },
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
  });

  it("returns 401 on wrong password (and the response shape is identical to unknown email)", async () => {
    const bad = await handleLogin(
      new Request("https://example.test/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: s.email, password: "wrong" }),
        headers: { "content-type": "application/json" },
      }),
      { db, secret: SECRET },
    );
    const unknown = await handleLogin(
      new Request("https://example.test/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: "nobody@example.test",
          password: "anything",
        }),
        headers: { "content-type": "application/json" },
      }),
      { db, secret: SECRET },
    );
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await bad.json()).toEqual(await unknown.json());
  });

  it("rejects a missing email or password field", async () => {
    const res = await handleLogin(
      new Request("https://example.test/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: s.email }),
        headers: { "content-type": "application/json" },
      }),
      { db, secret: SECRET },
    );
    expect(res.status).toBe(400);
  });
});

// drizzle import for the password rotation test — kept here to avoid
// re-importing `eq` and the users table at the top.
import { eq } from "drizzle-orm";
function eqUserId(id: string) {
  return eq(users.id, id);
}
