import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";
import { AircraftService } from "@ga/aircraft";

import {
  handleAircraftChangeRegime,
  handleAircraftRegimeHistory,
} from "../lib/aircraft-regime-change-handler";

interface Seed {
  tenantId: string;
  faaRegimeId: string;
  carsRegimeId: string;
  userId: string;
  aircraftId: string;
}

async function seed(db: TestDb): Promise<Seed> {
  const faa = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const faaRegimeId = faa.rows[0]!.id;

  const cars = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'CARS'`,
  );
  const carsRegimeId = cars.rows[0]!.id;

  const orgs = await db.execute<{ id: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values ('Test Tenant', 'club', ${faaRegimeId})
    returning id
  `);
  const tenantId = orgs.rows[0]!.id;

  const user = await db.execute<{ id: string }>(sql`
    insert into users (email) values ('admin@example.test') returning id
  `);
  const userId = user.rows[0]!.id;

  const svc = new AircraftService(db);
  const ac = await svc.create({
    tenantId,
    registration: "N12345",
    make: "Cessna",
    model: "172N",
    serialNumber: "S1",
    category: "normal",
    aircraftClass: "single_engine_land",
    timeSource: "hobbs",
  });

  return { tenantId, faaRegimeId, carsRegimeId, userId, aircraftId: ac.id };
}

/**
 * CARS is regime reference data, so it is seeded once per suite alongside
 * the migration (in `beforeAll`) rather than per test. `reset` preserves
 * catalog rows, so the per-test `seed()` reads it back by code.
 */
async function seedCarsCatalog(db: TestDb): Promise<void> {
  await db.execute(sql`
    insert into regimes (code, name, jurisdiction)
    values ('CARS', 'Canadian Aviation Regulations', 'Canada')
  `);
}

function postRequest(body: unknown): Request {
  return new Request("https://example.test/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleAircraftChangeRegime (PMB-18)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  let s: Seed;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
    await seedCarsCatalog(db);
  });

  beforeEach(async () => {
    s = await seed(db);
  });

  afterEach(async () => {
    await reset();
  });

  it("changes the regime, writes the audit row, returns 200", async () => {
    const res = await handleAircraftChangeRegime(
      postRequest({ to_regime_id: s.carsRegimeId, reason: "Re-registered" }),
      {
        tenantId: s.tenantId,
        db,
        actorUserId: s.userId,
        params: { id: s.aircraftId },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      aircraft: { regime_id: string };
      change: {
        from_regime_id: string;
        to_regime_id: string;
        reason: string;
        actor_user_id: string;
      };
    };
    expect(body.aircraft.regime_id).toBe(s.carsRegimeId);
    expect(body.change.from_regime_id).toBe(s.faaRegimeId);
    expect(body.change.to_regime_id).toBe(s.carsRegimeId);
    expect(body.change.reason).toBe("Re-registered");
    expect(body.change.actor_user_id).toBe(s.userId);
  });

  it("400 on missing reason", async () => {
    const res = await handleAircraftChangeRegime(
      postRequest({ to_regime_id: s.carsRegimeId }),
      {
        tenantId: s.tenantId,
        db,
        actorUserId: s.userId,
        params: { id: s.aircraftId },
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/reason/);
  });

  it("400 on non-UUID to_regime_id", async () => {
    const res = await handleAircraftChangeRegime(
      postRequest({ to_regime_id: "not-a-uuid", reason: "x" }),
      {
        tenantId: s.tenantId,
        db,
        actorUserId: s.userId,
        params: { id: s.aircraftId },
      },
    );
    expect(res.status).toBe(400);
  });

  it("400 on non-UUID aircraft id path param", async () => {
    const res = await handleAircraftChangeRegime(
      postRequest({ to_regime_id: s.carsRegimeId, reason: "x" }),
      {
        tenantId: s.tenantId,
        db,
        actorUserId: s.userId,
        params: { id: "not-a-uuid" },
      },
    );
    expect(res.status).toBe(400);
  });

  it("404 on unknown aircraft id", async () => {
    const res = await handleAircraftChangeRegime(
      postRequest({ to_regime_id: s.carsRegimeId, reason: "x" }),
      {
        tenantId: s.tenantId,
        db,
        actorUserId: s.userId,
        params: { id: "00000000-0000-0000-0000-000000000000" },
      },
    );
    expect(res.status).toBe(404);
  });

  it("404 on unknown target regime id", async () => {
    const res = await handleAircraftChangeRegime(
      postRequest({
        to_regime_id: "00000000-0000-0000-0000-000000000000",
        reason: "x",
      }),
      {
        tenantId: s.tenantId,
        db,
        actorUserId: s.userId,
        params: { id: s.aircraftId },
      },
    );
    expect(res.status).toBe(404);
  });

  it("400 on no-op change (same regime as current)", async () => {
    const res = await handleAircraftChangeRegime(
      postRequest({ to_regime_id: s.faaRegimeId, reason: "x" }),
      {
        tenantId: s.tenantId,
        db,
        actorUserId: s.userId,
        params: { id: s.aircraftId },
      },
    );
    expect(res.status).toBe(400);
  });

  it("400 on non-JSON body", async () => {
    const req = new Request("https://example.test/x", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "text/plain" },
    });
    const res = await handleAircraftChangeRegime(req, {
      tenantId: s.tenantId,
      db,
      actorUserId: s.userId,
      params: { id: s.aircraftId },
    });
    expect(res.status).toBe(400);
  });
});

describe("handleAircraftRegimeHistory (PMB-18)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  let s: Seed;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
    await seedCarsCatalog(db);
  });

  beforeEach(async () => {
    s = await seed(db);
  });

  afterEach(async () => {
    await reset();
  });

  it("returns an empty list before any change", async () => {
    const res = await handleAircraftRegimeHistory(
      new Request("https://example.test/x"),
      { tenantId: s.tenantId, db, params: { id: s.aircraftId } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changes: unknown[] };
    expect(body.changes).toEqual([]);
  });

  it("returns the change after one has been recorded", async () => {
    await handleAircraftChangeRegime(
      postRequest({ to_regime_id: s.carsRegimeId, reason: "Re-registered" }),
      {
        tenantId: s.tenantId,
        db,
        actorUserId: s.userId,
        params: { id: s.aircraftId },
      },
    );
    const res = await handleAircraftRegimeHistory(
      new Request("https://example.test/x"),
      { tenantId: s.tenantId, db, params: { id: s.aircraftId } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changes: Array<{ reason: string; from_regime_id: string }>;
    };
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]!.reason).toBe("Re-registered");
    expect(body.changes[0]!.from_regime_id).toBe(s.faaRegimeId);
  });

  it("400 on non-UUID aircraft id", async () => {
    const res = await handleAircraftRegimeHistory(
      new Request("https://example.test/x"),
      { tenantId: s.tenantId, db, params: { id: "not-a-uuid" } },
    );
    expect(res.status).toBe(400);
  });
});
