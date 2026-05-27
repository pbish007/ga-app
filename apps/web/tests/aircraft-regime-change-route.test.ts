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
import { AircraftService, type AircraftDb } from "@ga/aircraft";

import {
  SESSION_COOKIE_NAME,
  buildLoadMembership,
  buildLoadSession,
  createSessionCookieValue,
  withRequest,
} from "../lib/auth";
import { handleAircraftChangeRegime } from "../lib/aircraft-regime-change-handler";

const {
  organizations,
  organizationMemberships,
  regimes,
  users,
} = dbSchema;

const SECRET =
  "test-only-secret-test-only-secret-test-only-secret-32+bytes";

interface Seed {
  tenantId: string;
  faaRegimeId: string;
  carsRegimeId: string;
  adminUserId: string;
  mechanicUserId: string;
  pilotUserId: string;
  aircraftId: string;
}

async function seed(db: TestDb): Promise<Seed> {
  const [faa] = await db.select().from(regimes);
  if (!faa) throw new Error("FAA regime seed missing");

  const [cars] = await db
    .insert(regimes)
    .values({
      code: "CARS",
      name: "Canadian Aviation Regulations",
      jurisdiction: "Canada",
    })
    .returning();
  if (!cars) throw new Error("seed cars failed");

  const [org] = await db
    .insert(organizations)
    .values({ name: "Org", orgType: "club", defaultRegimeId: faa.id })
    .returning();
  if (!org) throw new Error("seed org failed");

  const password = "correct horse battery staple";
  const passwordHash = await passwordHasher.hash(password);

  const [admin] = await db
    .insert(users)
    .values({ email: "admin@example.test", passwordHash })
    .returning();
  const [mechanic] = await db
    .insert(users)
    .values({ email: "mech@example.test", passwordHash })
    .returning();
  const [pilot] = await db
    .insert(users)
    .values({ email: "pilot@example.test", passwordHash })
    .returning();
  if (!admin || !mechanic || !pilot) throw new Error("seed users failed");

  await db.insert(organizationMemberships).values([
    { tenantId: org.id, userId: admin.id, role: "admin" },
    { tenantId: org.id, userId: mechanic.id, role: "mechanic" },
    { tenantId: org.id, userId: pilot.id, role: "pilot" },
  ]);

  const svc = new AircraftService(db);
  const ac = await svc.create({
    tenantId: org.id,
    registration: "N12345",
    make: "Cessna",
    model: "172N",
    serialNumber: "S1",
    category: "normal",
    aircraftClass: "single_engine_land",
    timeSource: "hobbs",
  });

  return {
    tenantId: org.id,
    faaRegimeId: faa.id,
    carsRegimeId: cars.id,
    adminUserId: admin.id,
    mechanicUserId: mechanic.id,
    pilotUserId: pilot.id,
    aircraftId: ac.id,
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

function authedPost(
  url: string,
  opts: { userId: string; body: unknown },
): Request {
  const iat = Math.floor(Date.now() / 1000);
  const cookie = createSessionCookieValue({ userId: opts.userId, iat }, SECRET);
  return new Request(url, {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(opts.body),
  });
}

describe("aircraft.change_regime role gate (PMB-18 + PMB-10)", () => {
  let db: TestDb;
  let matrix: PermissionsMatrix;
  let s: Seed;

  beforeEach(async () => {
    db = await setupTestDb();
    matrix = await loadPermissionsMatrix(db);
    s = await seed(db);
  });

  const buildHandler = () =>
    withRequest(
      buildDeps(db, matrix),
      { permission: "aircraft.change_regime" },
      async (req, ctx) =>
        handleAircraftChangeRegime(req, {
          tenantId: ctx.tenantId,
          db: ctx.tx as unknown as AircraftDb,
          actorUserId: ctx.user.id,
          params: { id: s.aircraftId },
        }),
    );

  it("admin can change the regime (200)", async () => {
    const req = authedPost(
      `https://example.test/api/orgs/${s.tenantId}/aircraft/${s.aircraftId}/regime`,
      {
        userId: s.adminUserId,
        body: { to_regime_id: s.carsRegimeId, reason: "Re-registered" },
      },
    );
    const res = await buildHandler()(req);
    expect(res.status).toBe(200);
  });

  it("mechanic is forbidden (403) — aircraft.write does not imply change_regime", async () => {
    const req = authedPost(
      `https://example.test/api/orgs/${s.tenantId}/aircraft/${s.aircraftId}/regime`,
      {
        userId: s.mechanicUserId,
        body: { to_regime_id: s.carsRegimeId, reason: "x" },
      },
    );
    const res = await buildHandler()(req);
    expect(res.status).toBe(403);
  });

  it("pilot is forbidden (403)", async () => {
    const req = authedPost(
      `https://example.test/api/orgs/${s.tenantId}/aircraft/${s.aircraftId}/regime`,
      {
        userId: s.pilotUserId,
        body: { to_regime_id: s.carsRegimeId, reason: "x" },
      },
    );
    const res = await buildHandler()(req);
    expect(res.status).toBe(403);
  });
});
