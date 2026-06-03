import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { schema as dbSchema, setupTestSuite, type TestDb } from "@ga/db";

import { handleSignup } from "../lib/auth/signup-handler";

const {
  organizationMemberships,
  organizations,
  tenantProvisioningAudit,
  users,
} = dbSchema;

const SECRET =
  "test-only-secret-test-only-secret-test-only-secret-32+bytes";

let db: TestDb;
let reset: () => Promise<void>;

function postSignup(body: unknown): Request {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("PMB-117 handleSignup against TenantProvisioningService", () => {
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });

  afterEach(async () => {
    await reset();
  });

  it("creates the user + org + admin membership, returns 200 with a session cookie", async () => {
    const res = await handleSignup(postSignup({
      email: "Founder@Example.test",
      password: "correct horse battery staple",
      org_name: "Skyhawk Club",
      org_type: "club",
    }), { db, secret: SECRET });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organization.name).toBe("Skyhawk Club");
    expect(body.organization.org_type).toBe("club");
    expect(body.user.email).toBe("founder@example.test");
    expect(body.tenant_id).toMatch(/^[0-9a-f-]{36}$/i);

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^ga_session=/);
    expect(cookie).toMatch(/HttpOnly/i);

    // User + org + membership exist.
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, "founder@example.test"));
    expect(user).toBeDefined();
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, body.tenant_id));
    expect(org).toBeDefined();
    const memberships = await db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.tenantId, body.tenant_id));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("admin");

    // Audit row landed.
    const audits = await db.select().from(tenantProvisioningAudit);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.resultStatus).toBe("done");
    expect(audits[0]?.actorKind).toBe("self-service");
    expect(audits[0]?.idempotencyKey).toBeNull();
  });

  it("returns 409 + the original error message when the email is already taken", async () => {
    // Land the first signup.
    await handleSignup(postSignup({
      email: "first@example.test",
      password: "first-password-fine",
      org_name: "First Org",
      org_type: "owner",
    }), { db, secret: SECRET });

    const res = await handleSignup(postSignup({
      email: "FIRST@example.test",  // case-insensitive collision
      password: "second-password",
      org_name: "Second Org",
      org_type: "shop",
    }), { db, secret: SECRET });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/);

    // No second user, no second org.
    const allUsers = await db.select().from(users);
    expect(allUsers).toHaveLength(1);
    const allOrgs = await db.select().from(organizations);
    expect(allOrgs).toHaveLength(1);
  });

  it("returns 400 on missing fields", async () => {
    expect((await handleSignup(postSignup({
      password: "long-enough-password",
      org_name: "Org",
      org_type: "club",
    }), { db, secret: SECRET })).status).toBe(400);

    expect((await handleSignup(postSignup({
      email: "a@b.test",
      password: "short",
      org_name: "Org",
      org_type: "club",
    }), { db, secret: SECRET })).status).toBe(400);

    expect((await handleSignup(postSignup({
      email: "a@b.test",
      password: "long-enough-password",
      org_name: "",
      org_type: "club",
    }), { db, secret: SECRET })).status).toBe(400);

    expect((await handleSignup(postSignup({
      email: "a@b.test",
      password: "long-enough-password",
      org_name: "Org",
      org_type: "airline",
    }), { db, secret: SECRET })).status).toBe(400);
  });

  it("returns 400 on a non-JSON body", async () => {
    const res = await handleSignup(
      new Request("http://localhost/api/auth/signup", {
        method: "POST",
        body: "not json",
      }),
      { db, secret: SECRET },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/JSON/i);
  });
});
