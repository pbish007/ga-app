import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  runAsTenant,
  schema as dbSchema,
  setupTestSuite,
  type TestDb,
} from "@ga/db";
import {
  loadPermissionsMatrix,
  passwordHasher,
  type AccountsDb,
  type PermissionsMatrix,
} from "@ga/accounts";

import {
  SESSION_COOKIE_NAME,
  buildLoadMembership,
  buildLoadSession,
  createSessionCookieValue,
  withRequest,
} from "../lib/auth";
import {
  handleCredentialsCreate,
  handleCredentialsList,
  handleCredentialsListActive,
  handleCredentialsRevoke,
  handleCredentialsUpdate,
} from "../lib/credentials-handler";

const {
  organizationMemberships,
  organizations,
  regimeCredentialTypes,
  regimes,
  userCredentials,
  users,
} = dbSchema;

const SECRET =
  "test-only-secret-test-only-secret-test-only-secret-32+bytes";

interface Seed {
  acmeTenant: string;
  betaTenant: string;
  faaRegimeId: string;
  apTypeId: string;
  acmeAdmin: string;
  acmeMechanic: string;
  acmePilot: string;
  betaAdmin: string;
  betaMechanic: string;
}

async function seed(db: TestDb): Promise<Seed> {
  const [faa] = await db.select().from(regimes).where(eq(regimes.code, "FAA"));
  if (!faa) throw new Error("FAA regime seed missing");
  const types = await db
    .select()
    .from(regimeCredentialTypes)
    .where(eq(regimeCredentialTypes.regimeId, faa.id));
  const ap = types[0];
  if (!ap) throw new Error("FAA credential types missing");

  const [acme] = await db
    .insert(organizations)
    .values({ name: "Acme", orgType: "shop", defaultRegimeId: faa.id })
    .returning({ id: organizations.id });
  const [beta] = await db
    .insert(organizations)
    .values({ name: "Beta", orgType: "club", defaultRegimeId: faa.id })
    .returning({ id: organizations.id });
  if (!acme || !beta) throw new Error("seed orgs failed");

  const passwordHash = await passwordHasher.hash("strong-test-password");
  async function newUser(email: string): Promise<string> {
    const [u] = await db
      .insert(users)
      .values({ email, passwordHash })
      .returning({ id: users.id });
    if (!u) throw new Error(`seed user ${email} failed`);
    return u.id;
  }
  const acmeAdmin = await newUser("acme-admin@example.test");
  const acmeMechanic = await newUser("acme-mech@example.test");
  const acmePilot = await newUser("acme-pilot@example.test");
  const betaAdmin = await newUser("beta-admin@example.test");
  const betaMechanic = await newUser("beta-mech@example.test");

  await db.insert(organizationMemberships).values([
    { tenantId: acme.id, userId: acmeAdmin, role: "admin" },
    { tenantId: acme.id, userId: acmeMechanic, role: "mechanic" },
    { tenantId: acme.id, userId: acmePilot, role: "pilot" },
    { tenantId: beta.id, userId: betaAdmin, role: "admin" },
    { tenantId: beta.id, userId: betaMechanic, role: "mechanic" },
  ]);

  return {
    acmeTenant: acme.id,
    betaTenant: beta.id,
    faaRegimeId: faa.id,
    apTypeId: ap.id,
    acmeAdmin,
    acmeMechanic,
    acmePilot,
    betaAdmin,
    betaMechanic,
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

interface AuthOpts {
  userId: string;
  method?: string;
  body?: unknown;
}

function authedRequest(url: string, opts: AuthOpts): Request {
  const iat = Math.floor(Date.now() / 1000);
  const cookie = createSessionCookieValue({ userId: opts.userId, iat }, SECRET);
  const headers: Record<string, string> = {
    cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

/**
 * Helper to insert a credential without going through the HTTP layer.
 * Mirrors `runAsTenant` so the audit row lands inside RLS.
 */
async function adminInsert(
  db: TestDb,
  s: Seed,
  targetUserId: string,
): Promise<{ id: string }> {
  return runAsTenant(db, s.acmeTenant, async (tx) => {
    const [row] = await tx
      .insert(userCredentials)
      .values({
        userId: targetUserId,
        regimeCredentialTypeId: s.apTypeId,
        issuedOn: "2026-01-01",
        expiresOn: "2099-12-31",
        ratings: ["Airframe"],
        createdByUserId: s.acmeAdmin,
      })
      .returning({ id: userCredentials.id });
    if (!row) throw new Error("insert failed");
    return row;
  });
}

describe("PMB-155 credentials route RBAC + cross-tenant isolation", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  let matrix: PermissionsMatrix;
  let s: Seed;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  beforeEach(async () => {
    matrix = await loadPermissionsMatrix(db);
    s = await seed(db);
  });
  afterEach(async () => {
    await reset();
  });

  // ---------------------------------------------------------------------------
  // POST /api/orgs/{tenantId}/credentials
  // ---------------------------------------------------------------------------

  const buildCreate = () =>
    withRequest(
      buildDeps(db, matrix),
      { permission: "credential.manage" },
      (req, ctx) =>
        handleCredentialsCreate(req, {
          tenantId: ctx.tenantId,
          db: ctx.tx as unknown as AccountsDb,
          user: ctx.user,
          membership: ctx.membership,
        }),
    );

  it("POST: admin creates a credential (201)", async () => {
    const req = authedRequest(
      `https://example.test/api/orgs/${s.acmeTenant}/credentials`,
      {
        method: "POST",
        userId: s.acmeAdmin,
        body: {
          user_id: s.acmeMechanic,
          regime_credential_type_id: s.apTypeId,
          certificate_number: "A&P-1",
          ratings: ["Airframe", "Powerplant"],
          issued_on: "2026-01-01",
          expires_on: "2099-12-31",
        },
      },
    );
    const res = await buildCreate()(req);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { credential: { ratings: string[] } };
    expect(json.credential.ratings).toEqual(["Airframe", "Powerplant"]);
  });

  it("POST: mechanic is forbidden (403)", async () => {
    const req = authedRequest(
      `https://example.test/api/orgs/${s.acmeTenant}/credentials`,
      {
        method: "POST",
        userId: s.acmeMechanic,
        body: {
          user_id: s.acmeMechanic,
          regime_credential_type_id: s.apTypeId,
          issued_on: "2026-01-01",
        },
      },
    );
    const res = await buildCreate()(req);
    expect(res.status).toBe(403);
  });

  it("POST: pilot is forbidden (403)", async () => {
    const req = authedRequest(
      `https://example.test/api/orgs/${s.acmeTenant}/credentials`,
      {
        method: "POST",
        userId: s.acmePilot,
        body: {
          user_id: s.acmePilot,
          regime_credential_type_id: s.apTypeId,
          issued_on: "2026-01-01",
        },
      },
    );
    const res = await buildCreate()(req);
    expect(res.status).toBe(403);
  });

  it("POST: admin of tenant A cannot create credential for a user not in tenant A (404)", async () => {
    const req = authedRequest(
      `https://example.test/api/orgs/${s.acmeTenant}/credentials`,
      {
        method: "POST",
        userId: s.acmeAdmin,
        body: {
          user_id: s.betaMechanic,
          regime_credential_type_id: s.apTypeId,
          issued_on: "2026-01-01",
        },
      },
    );
    const res = await buildCreate()(req);
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // GET /api/orgs/{tenantId}/credentials
  // ---------------------------------------------------------------------------

  const buildList = () =>
    withRequest(buildDeps(db, matrix), {}, (req, ctx) =>
      handleCredentialsList(req, {
        tenantId: ctx.tenantId,
        db: ctx.tx as unknown as AccountsDb,
        user: ctx.user,
        membership: ctx.membership,
      }),
    );

  it("GET: mechanic self-read returns own credentials", async () => {
    await adminInsert(db, s, s.acmeMechanic);
    const req = authedRequest(
      `https://example.test/api/orgs/${s.acmeTenant}/credentials`,
      { userId: s.acmeMechanic },
    );
    const res = await buildList()(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { credentials: unknown[] };
    expect(json.credentials).toHaveLength(1);
  });

  it("GET: mechanic cannot read another user's credentials (403)", async () => {
    await adminInsert(db, s, s.acmeAdmin);
    const req = authedRequest(
      `https://example.test/api/orgs/${s.acmeTenant}/credentials?userId=${s.acmeAdmin}`,
      { userId: s.acmeMechanic },
    );
    const res = await buildList()(req);
    expect(res.status).toBe(403);
  });

  it("GET: admin can read any member's credentials (200)", async () => {
    await adminInsert(db, s, s.acmeMechanic);
    const req = authedRequest(
      `https://example.test/api/orgs/${s.acmeTenant}/credentials?userId=${s.acmeMechanic}`,
      { userId: s.acmeAdmin },
    );
    const res = await buildList()(req);
    expect(res.status).toBe(200);
  });

  it("GET: cross-tenant admin read of non-member returns 404", async () => {
    const req = authedRequest(
      `https://example.test/api/orgs/${s.acmeTenant}/credentials?userId=${s.betaMechanic}`,
      { userId: s.acmeAdmin },
    );
    const res = await buildList()(req);
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // GET /api/orgs/{tenantId}/credentials/active
  // ---------------------------------------------------------------------------

  const buildListActive = () =>
    withRequest(buildDeps(db, matrix), {}, (req, ctx) =>
      handleCredentialsListActive(req, {
        tenantId: ctx.tenantId,
        db: ctx.tx as unknown as AccountsDb,
        user: ctx.user,
        membership: ctx.membership,
      }),
    );

  it("GET /active: returns the credential-type-joined card (no N+1)", async () => {
    await adminInsert(db, s, s.acmeMechanic);
    const req = authedRequest(
      `https://example.test/api/orgs/${s.acmeTenant}/credentials/active?userId=${s.acmeMechanic}`,
      { userId: s.acmeAdmin },
    );
    const res = await buildListActive()(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      credentials: Array<{
        credential_type_code: string;
        credential_type_name: string;
        authorizes_signoff: boolean;
        ratings: string[];
      }>;
    };
    expect(json.credentials).toHaveLength(1);
    const card = json.credentials[0]!;
    expect(typeof card.credential_type_code).toBe("string");
    expect(typeof card.credential_type_name).toBe("string");
    expect(typeof card.authorizes_signoff).toBe("boolean");
    expect(card.ratings).toEqual(["Airframe"]);
  });

  // ---------------------------------------------------------------------------
  // PATCH + DELETE /api/orgs/{tenantId}/credentials/{id}
  // ---------------------------------------------------------------------------

  const buildUpdate = (credentialId: string) =>
    withRequest(
      buildDeps(db, matrix),
      { permission: "credential.manage" },
      (req, ctx) =>
        handleCredentialsUpdate(req, {
          tenantId: ctx.tenantId,
          db: ctx.tx as unknown as AccountsDb,
          user: ctx.user,
          membership: ctx.membership,
          params: { id: credentialId },
        }),
    );

  const buildRevoke = (credentialId: string) =>
    withRequest(
      buildDeps(db, matrix),
      { permission: "credential.manage" },
      (req, ctx) =>
        handleCredentialsRevoke(req, {
          tenantId: ctx.tenantId,
          db: ctx.tx as unknown as AccountsDb,
          user: ctx.user,
          membership: ctx.membership,
          params: { id: credentialId },
        }),
    );

  it("PATCH: admin updates ratings (200, idempotent)", async () => {
    const credential = await adminInsert(db, s, s.acmeMechanic);
    const req = authedRequest(
      `https://example.test/api/orgs/${s.acmeTenant}/credentials/${credential.id}`,
      {
        method: "PATCH",
        userId: s.acmeAdmin,
        body: { ratings: ["Airframe", "Powerplant"] },
      },
    );
    const res = await buildUpdate(credential.id)(req);
    expect(res.status).toBe(200);
  });

  it("PATCH: mechanic is forbidden (403)", async () => {
    const credential = await adminInsert(db, s, s.acmeMechanic);
    const req = authedRequest(
      `https://example.test/api/orgs/${s.acmeTenant}/credentials/${credential.id}`,
      {
        method: "PATCH",
        userId: s.acmeMechanic,
        body: { ratings: ["Airframe"] },
      },
    );
    const res = await buildUpdate(credential.id)(req);
    expect(res.status).toBe(403);
  });

  it("PATCH: cross-tenant admin gets 404", async () => {
    // Create a credential against beta's mechanic via the beta tenant tx.
    const betaCredential = await runAsTenant(
      db,
      s.betaTenant,
      async (tx) => {
        const [row] = await tx
          .insert(userCredentials)
          .values({
            userId: s.betaMechanic,
            regimeCredentialTypeId: s.apTypeId,
            issuedOn: "2026-01-01",
            createdByUserId: s.betaAdmin,
          })
          .returning({ id: userCredentials.id });
        if (!row) throw new Error("seed failed");
        return row;
      },
    );
    const req = authedRequest(
      `https://example.test/api/orgs/${s.acmeTenant}/credentials/${betaCredential.id}`,
      {
        method: "PATCH",
        userId: s.acmeAdmin,
        body: { certificate_number: "HIJACKED" },
      },
    );
    const res = await buildUpdate(betaCredential.id)(req);
    expect(res.status).toBe(404);
  });

  it("DELETE: admin revokes (200)", async () => {
    const credential = await adminInsert(db, s, s.acmeMechanic);
    const req = authedRequest(
      `https://example.test/api/orgs/${s.acmeTenant}/credentials/${credential.id}`,
      { method: "DELETE", userId: s.acmeAdmin },
    );
    const res = await buildRevoke(credential.id)(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      credential: { revoked_at: string | null };
    };
    expect(json.credential.revoked_at).not.toBeNull();
  });

  it("DELETE: mechanic is forbidden (403)", async () => {
    const credential = await adminInsert(db, s, s.acmeMechanic);
    const req = authedRequest(
      `https://example.test/api/orgs/${s.acmeTenant}/credentials/${credential.id}`,
      { method: "DELETE", userId: s.acmeMechanic },
    );
    const res = await buildRevoke(credential.id)(req);
    expect(res.status).toBe(403);
  });
});
