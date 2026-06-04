import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  schema as dbSchema,
  setupTestSuite,
  type TestDb,
} from "@ga/db";
import { passwordHasher } from "@ga/accounts";

import {
  SESSION_COOKIE_NAME,
  createSessionCookieValue,
} from "../lib/auth";
import {
  handleCreateTenant,
  handleGetTenant,
  handleListAudit,
  handleListTenants,
  handleReseedDemo,
  type AdminTenantsDeps,
} from "../lib/admin/tenants-handler";

const {
  aircraft,
  organizationMemberships,
  organizations,
  platformAdmins,
  regimes,
  squawks,
  tenantProvisioningAudit,
  users,
} = dbSchema;

const SECRET =
  "test-only-secret-test-only-secret-test-only-secret-32+bytes";

let db: TestDb;
let reset: () => Promise<void>;

interface Seed {
  adminUserId: string;
  adminEmail: string;
  tenantUserId: string;
  tenantUserEmail: string;
  password: string;
}

async function seed(): Promise<Seed> {
  const hash = await passwordHasher.hash("correct horse battery staple");
  const [admin, tenant] = await db
    .insert(users)
    .values([
      { email: "admin@platform.test", passwordHash: hash },
      { email: "pilot@example.test", passwordHash: hash },
    ])
    .returning();
  if (!admin || !tenant) throw new Error("seed users failed");

  await db
    .insert(platformAdmins)
    .values({ userId: admin.id, note: "test seed" });

  // Create an unrelated tenant + tenant-only user so the list endpoint has
  // something to read and so RBAC checks can use a real non-admin session.
  const [faa] = await db.select().from(regimes);
  if (!faa) throw new Error("FAA regime seed missing");
  const [tenantOrg] = await db
    .insert(organizations)
    .values({
      name: "Tenant Org",
      orgType: "club",
      defaultRegimeId: faa.id,
    })
    .returning();
  if (!tenantOrg) throw new Error("seed org failed");
  await db.insert(organizationMemberships).values({
    tenantId: tenantOrg.id,
    userId: tenant.id,
    role: "admin",
  });

  return {
    adminUserId: admin.id,
    adminEmail: admin.email,
    tenantUserId: tenant.id,
    tenantUserEmail: tenant.email,
    password: "correct horse battery staple",
  };
}

function deps(): AdminTenantsDeps {
  // In pglite tests there's a single connection — `db` and `directDb`
  // point at the same handle. Production routes pass `getDirectDb()` for
  // `directDb` (BYPASSRLS owner connection) so the cross-tenant reads
  // see all tenants. See AdminTenantsDeps in
  // `apps/web/lib/admin/tenants-handler.ts`.
  return {
    db,
    directDb: db,
    secret: SECRET,
    acceptUrlBase: "https://app.example.test/invitations",
  };
}

function authed(
  url: string,
  userId: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Request {
  const cookie = createSessionCookieValue(
    { userId, iat: Math.floor(Date.now() / 1000) },
    SECRET,
  );
  return new Request(url, {
    method: init.method ?? "GET",
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    body:
      init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body),
  });
}

function anon(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Request {
  return new Request(url, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body:
      init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body),
  });
}

const BASE = "https://app.example.test";

describe("PMB-118 admin tenant API — RBAC", () => {
  let s: Seed;
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  beforeAll(async () => {
    s = await seed();
  });
  afterEach(async () => {
    await reset();
    s = await seed();
  });

  it("returns 401 to anonymous callers on every endpoint", async () => {
    const create = await handleCreateTenant(
      anon(`${BASE}/api/admin/tenants`, {
        method: "POST",
        body: {
          orgName: "Anon Co",
          orgType: "club",
          primaryAdmin: { email: "x@x.test", password: "longenough" },
        },
      }),
      deps(),
    );
    expect(create.status).toBe(401);

    const list = await handleListTenants(
      anon(`${BASE}/api/admin/tenants`),
      deps(),
    );
    expect(list.status).toBe(401);

    const detail = await handleGetTenant(
      anon(`${BASE}/api/admin/tenants/x`),
      deps(),
      { id: "00000000-0000-0000-0000-000000000000" },
    );
    expect(detail.status).toBe(401);

    const audit = await handleListAudit(
      anon(`${BASE}/api/admin/audit`),
      deps(),
    );
    expect(audit.status).toBe(401);

    const reseed = await handleReseedDemo(
      anon(`${BASE}/api/admin/tenants/x/reseed-demo`, { method: "POST" }),
      deps(),
      { id: "00000000-0000-0000-0000-000000000000" },
    );
    expect(reseed.status).toBe(401);
  });

  it("returns 403 to tenant-only users (no platform_admins row) on every endpoint", async () => {
    const create = await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.tenantUserId, {
        method: "POST",
        body: {
          orgName: "Pilot Co",
          orgType: "club",
          primaryAdmin: { email: "y@y.test", password: "longenough" },
        },
      }),
      deps(),
    );
    expect(create.status).toBe(403);

    const list = await handleListTenants(
      authed(`${BASE}/api/admin/tenants`, s.tenantUserId),
      deps(),
    );
    expect(list.status).toBe(403);

    const audit = await handleListAudit(
      authed(`${BASE}/api/admin/audit`, s.tenantUserId),
      deps(),
    );
    expect(audit.status).toBe(403);
  });
});

describe("PMB-118 POST /api/admin/tenants", () => {
  let s: Seed;
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  beforeAll(async () => {
    s = await seed();
  });
  afterEach(async () => {
    await reset();
    s = await seed();
  });

  it("provisions a tenant + audit row + returns 201", async () => {
    const res = await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
        method: "POST",
        body: {
          orgName: "Acme Aviation",
          orgType: "club",
          primaryAdmin: {
            email: "founder@acme.test",
            password: "long-enough-password",
          },
        },
      }),
      deps(),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.tenantId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.primaryAdminUserId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.auditId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.initialPassword).toBeUndefined();

    const [audit] = await db
      .select()
      .from(tenantProvisioningAudit)
      .where(eq(tenantProvisioningAudit.id, body.auditId));
    expect(audit?.resultStatus).toBe("done");
    expect(audit?.actorKind).toBe("platform-admin");
    expect(audit?.actorUserId).toBe(s.adminUserId);
  });

  it("returns initialPassword when generatePassword:true (mode (a))", async () => {
    const res = await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
        method: "POST",
        body: {
          orgName: "Generated Co",
          orgType: "owner",
          primaryAdmin: {
            email: "gen@example.test",
            generatePassword: true,
          },
        },
      }),
      deps(),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.initialPassword).toBe("string");
    expect(body.initialPassword.length).toBeGreaterThanOrEqual(16);

    // The audit input snapshot does NOT include the password.
    const [audit] = await db
      .select()
      .from(tenantProvisioningAudit)
      .where(eq(tenantProvisioningAudit.id, body.auditId));
    expect(JSON.stringify(audit?.inputSnapshot)).not.toContain(
      body.initialPassword,
    );
  });

  it("rejects password + generatePassword set together", async () => {
    const res = await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
        method: "POST",
        body: {
          orgName: "Both Set",
          orgType: "shop",
          primaryAdmin: {
            email: "both@example.test",
            password: "long-enough-password",
            generatePassword: true,
          },
        },
      }),
      deps(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_error");
  });

  it("enforces server-side provisionedBy = 'platform-admin' even if the caller injects another shape", async () => {
    const res = await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
        method: "POST",
        body: {
          orgName: "Spoof Co",
          orgType: "school",
          primaryAdmin: {
            email: "spoof@example.test",
            password: "long-enough-password",
          },
          // Caller tries to claim self-service — we must ignore it.
          provisionedBy: { kind: "self-service" },
        },
      }),
      deps(),
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    const [audit] = await db
      .select()
      .from(tenantProvisioningAudit)
      .where(eq(tenantProvisioningAudit.id, body.auditId));
    expect(audit?.actorKind).toBe("platform-admin");
    expect(audit?.actorUserId).toBe(s.adminUserId);
  });

  it("maps EmailAlreadyExists to 409 with a typed code", async () => {
    await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
        method: "POST",
        body: {
          orgName: "First",
          orgType: "owner",
          primaryAdmin: {
            email: "dup@example.test",
            password: "long-enough-password",
          },
        },
      }),
      deps(),
    );
    const res = await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
        method: "POST",
        body: {
          orgName: "Second",
          orgType: "owner",
          primaryAdmin: {
            email: "DUP@example.test",
            password: "long-enough-password",
          },
        },
      }),
      deps(),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("email_already_exists");
  });

  it("maps InvalidRegime to 400 with a typed code", async () => {
    const res = await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
        method: "POST",
        body: {
          orgName: "Bad Regime",
          orgType: "club",
          regimeId: "00000000-0000-0000-0000-000000000000",
          primaryAdmin: {
            email: "bad-regime@example.test",
            password: "long-enough-password",
          },
        },
      }),
      deps(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_regime");
  });

  it("returns 400 with field on missing/invalid fields", async () => {
    for (const body of [
      { orgType: "club", primaryAdmin: { email: "a@b.test", password: "longenough" } }, // missing orgName
      { orgName: "X", orgType: "airline", primaryAdmin: { email: "a@b.test", password: "longenough" } }, // invalid orgType
      { orgName: "X", orgType: "club", primaryAdmin: { email: "not-an-email", password: "longenough" } },
      { orgName: "X", orgType: "club", primaryAdmin: { email: "a@b.test", password: "short" } },
      { orgName: "X", orgType: "club", primaryAdmin: { email: "a@b.test" } }, // no password and no generate
    ]) {
      const res = await handleCreateTenant(
        authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
          method: "POST",
          body,
        }),
        deps(),
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe("validation_error");
    }
  });

  it("returns 400 on a non-JSON body", async () => {
    const res = await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
        method: "POST",
        body: "not json",
      }),
      deps(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_error");
  });

  it("idempotency: same Idempotency-Key + same body returns the same auditId on the second call (one tenant total)", async () => {
    const body = {
      orgName: "Idempotent Co",
      orgType: "club" as const,
      primaryAdmin: {
        email: "idem@example.test",
        password: "long-enough-password",
      },
    };
    const headers = { "idempotency-key": "tenant:idem-1" };

    const first = await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
        method: "POST",
        headers,
        body,
      }),
      deps(),
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const second = await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
        method: "POST",
        headers,
        body,
      }),
      deps(),
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();

    expect(secondBody.tenantId).toBe(firstBody.tenantId);
    expect(secondBody.auditId).toBe(firstBody.auditId);
    // Replay never re-emits initialPassword, even if the original call
    // had generated one. This call uses an explicit password so neither
    // should carry it; the rule is "never on replay" either way.
    expect(secondBody.initialPassword).toBeUndefined();

    // ONE tenant + ONE audit row total.
    const orgs = await db.select().from(organizations);
    // (+1 because the test seed creates "Tenant Org".)
    expect(orgs.length).toBe(2);
    const audits = await db.select().from(tenantProvisioningAudit);
    expect(audits).toHaveLength(1);
  });

  it("idempotency: different body under the same key returns 409", async () => {
    const headers = { "idempotency-key": "tenant:idem-2" };
    const first = await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
        method: "POST",
        headers,
        body: {
          orgName: "Original",
          orgType: "club",
          primaryAdmin: {
            email: "orig@example.test",
            password: "long-enough-password",
          },
        },
      }),
      deps(),
    );
    expect(first.status).toBe(201);

    const second = await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
        method: "POST",
        headers,
        body: {
          orgName: "Different",
          orgType: "shop",
          primaryAdmin: {
            email: "other@example.test",
            password: "long-enough-password",
          },
        },
      }),
      deps(),
    );
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.code).toBe("idempotency_key_reused");
  });
});

describe("PMB-118 GET /api/admin/tenants + /:id", () => {
  let s: Seed;
  let createdTenantId: string;
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  beforeAll(async () => {
    s = await seed();
  });
  afterEach(async () => {
    await reset();
    s = await seed();
  });

  async function createOne() {
    const res = await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
        method: "POST",
        body: {
          orgName: "Listing Co",
          orgType: "club",
          primaryAdmin: {
            email: "list@example.test",
            password: "long-enough-password",
          },
        },
      }),
      deps(),
    );
    const json = await res.json();
    createdTenantId = json.tenantId;
  }

  it("list returns provisioned tenants + member counts + primary admin email", async () => {
    await createOne();
    const res = await handleListTenants(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId),
      deps(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.tenants.find(
      (t: { id: string }) => t.id === createdTenantId,
    );
    expect(row).toBeDefined();
    expect(row.name).toBe("Listing Co");
    expect(row.primaryAdminEmail).toBe("list@example.test");
    expect(row.memberCount).toBe(1);
    expect(row.adminCount).toBe(1);
  });

  it("detail returns tenant + memberships + recent audit", async () => {
    await createOne();
    const res = await handleGetTenant(
      authed(
        `${BASE}/api/admin/tenants/${createdTenantId}`,
        s.adminUserId,
      ),
      deps(),
      { id: createdTenantId },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant.id).toBe(createdTenantId);
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].role).toBe("admin");
    expect(body.memberships[0].email).toBe("list@example.test");
    expect(body.recentAudit.length).toBeGreaterThan(0);
    expect(body.recentAudit[0].resultStatus).toBe("done");
  });

  it("detail returns 404 for an unknown tenant id", async () => {
    const res = await handleGetTenant(
      authed(`${BASE}/api/admin/tenants/x`, s.adminUserId),
      deps(),
      { id: "00000000-0000-0000-0000-000000000000" },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("not_found");
  });

  it("detail returns 400 on a non-uuid id", async () => {
    const res = await handleGetTenant(
      authed(`${BASE}/api/admin/tenants/abc`, s.adminUserId),
      deps(),
      { id: "abc" },
    );
    expect(res.status).toBe(400);
  });
});

describe("PMB-118 GET /api/admin/audit", () => {
  let s: Seed;
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  beforeAll(async () => {
    s = await seed();
  });
  afterEach(async () => {
    await reset();
    s = await seed();
  });

  it("paginates audit rows in ascending order with an `after` cursor", async () => {
    // Provision three tenants.
    const ids: string[] = [];
    for (const i of [1, 2, 3]) {
      const res = await handleCreateTenant(
        authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
          method: "POST",
          body: {
            orgName: `Tenant ${i}`,
            orgType: "club",
            primaryAdmin: {
              email: `t${i}@example.test`,
              password: "long-enough-password",
            },
          },
        }),
        deps(),
      );
      const body = await res.json();
      ids.push(body.auditId);
    }

    // First page, limit=2 → 2 rows + nextAfter.
    const page1 = await handleListAudit(
      authed(`${BASE}/api/admin/audit?limit=2`, s.adminUserId),
      deps(),
    );
    expect(page1.status).toBe(200);
    const p1 = await page1.json();
    expect(p1.audit).toHaveLength(2);
    expect(p1.nextAfter).toBe(p1.audit[1].id);

    // Second page using cursor returns the remaining row.
    const page2 = await handleListAudit(
      authed(
        `${BASE}/api/admin/audit?limit=2&after=${p1.nextAfter}`,
        s.adminUserId,
      ),
      deps(),
    );
    expect(page2.status).toBe(200);
    const p2 = await page2.json();
    expect(p2.audit).toHaveLength(1);
    expect(p2.nextAfter).toBeNull();
  });

  it("rejects a non-uuid after cursor with 400", async () => {
    const res = await handleListAudit(
      authed(`${BASE}/api/admin/audit?after=not-a-uuid`, s.adminUserId),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("PMB-118 POST /api/admin/tenants/:id/reseed-demo", () => {
  let s: Seed;
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  beforeAll(async () => {
    s = await seed();
  });
  afterEach(async () => {
    await reset();
    s = await seed();
  });

  async function createTenant(): Promise<string> {
    const res = await handleCreateTenant(
      authed(`${BASE}/api/admin/tenants`, s.adminUserId, {
        method: "POST",
        body: {
          orgName: "Demo Recipient",
          orgType: "club",
          primaryAdmin: {
            email: "demo@example.test",
            password: "long-enough-password",
          },
        },
      }),
      deps(),
    );
    const body = await res.json();
    return body.tenantId;
  }

  it("seeds the demo aircraft + squawk into an existing tenant (idempotent)", async () => {
    const tenantId = await createTenant();

    const first = await handleReseedDemo(
      authed(
        `${BASE}/api/admin/tenants/${tenantId}/reseed-demo`,
        s.adminUserId,
        { method: "POST" },
      ),
      deps(),
      { id: tenantId },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.tenantId).toBe(tenantId);
    expect(firstBody.aircraftId).toMatch(/^[0-9a-f-]{36}$/i);

    const aircraftRows = await db
      .select()
      .from(aircraft)
      .where(eq(aircraft.tenantId, tenantId));
    expect(aircraftRows).toHaveLength(1);

    const openSquawks = await db
      .select()
      .from(squawks)
      .where(eq(squawks.tenantId, tenantId));
    expect(openSquawks).toHaveLength(1);
    expect(openSquawks[0]?.severity).toBe("grounding");

    // Second call replaces the prior rows but does not duplicate them.
    const second = await handleReseedDemo(
      authed(
        `${BASE}/api/admin/tenants/${tenantId}/reseed-demo`,
        s.adminUserId,
        { method: "POST" },
      ),
      deps(),
      { id: tenantId },
    );
    expect(second.status).toBe(200);
    const aircraftRows2 = await db
      .select()
      .from(aircraft)
      .where(eq(aircraft.tenantId, tenantId));
    expect(aircraftRows2).toHaveLength(1);
    // The aircraft row was deleted + recreated so the id is a new uuid.
    expect(aircraftRows2[0]?.id).not.toBe(aircraftRows[0]?.id);
  });

  it("returns 404 for an unknown tenant", async () => {
    const res = await handleReseedDemo(
      authed(`${BASE}/api/admin/tenants/x/reseed-demo`, s.adminUserId, {
        method: "POST",
      }),
      deps(),
      { id: "00000000-0000-0000-0000-000000000000" },
    );
    expect(res.status).toBe(404);
  });
});
