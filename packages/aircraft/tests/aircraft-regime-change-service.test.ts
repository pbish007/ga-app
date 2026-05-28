import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

import {
  AircraftRegimeChangeAircraftNotFoundError,
  AircraftRegimeChangeRegimeNotFoundError,
  AircraftRegimeChangeService,
  AircraftRegimeChangeValidationError,
  AircraftService,
  REGIME_CHANGE_RETENTION_RECORD_KIND,
} from "../src/index.js";

interface Seed {
  tenantId: string;
  otherTenantId: string;
  faaRegimeId: string;
  carsRegimeId: string;
  userId: string;
}

async function seed(db: TestDb): Promise<Seed> {
  const faa = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const faaRegimeId = faa.rows[0]!.id;

  // Add a synthetic second regime so we can actually change to it. `regimes`
  // is a catalog table that survives reset() between tests, so make this
  // idempotent: insert once, then reuse the surviving row on later tests.
  const cars = await db.execute<{ id: string }>(sql`
    insert into regimes (code, name, jurisdiction)
    values ('CARS', 'Canadian Aviation Regulations', 'Canada')
    on conflict (code) do update set name = excluded.name
    returning id
  `);
  const carsRegimeId = cars.rows[0]!.id;

  const orgA = await db.execute<{ id: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values ('Tenant A', 'club', ${faaRegimeId})
    returning id
  `);
  const tenantId = orgA.rows[0]!.id;
  const orgB = await db.execute<{ id: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values ('Tenant B', 'shop', ${faaRegimeId})
    returning id
  `);
  const otherTenantId = orgB.rows[0]!.id;

  const user = await db.execute<{ id: string }>(sql`
    insert into users (email)
    values ('admin@example.test')
    returning id
  `);
  const userId = user.rows[0]!.id;

  return { tenantId, otherTenantId, faaRegimeId, carsRegimeId, userId };
}

async function makeAircraft(
  db: TestDb,
  tenantId: string,
  registration = "N12345",
): Promise<string> {
  const svc = new AircraftService(db);
  const ac = await svc.create({
    tenantId,
    registration,
    make: "Cessna",
    model: "172N",
    serialNumber: `S-${registration}`,
    category: "normal",
    aircraftClass: "single_engine_land",
    timeSource: "hobbs",
  });
  return ac.id;
}

describe("AircraftRegimeChangeService (K2.2 / PMB-18)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  let s: Seed;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  afterEach(async () => {
    await reset();
  });

  beforeEach(async () => {
    s = await seed(db);
  });

  it("changes the regime and writes an audit row in one transaction", async () => {
    const aircraftId = await makeAircraft(db, s.tenantId);
    const svc = new AircraftRegimeChangeService(db);

    const result = await svc.change({
      tenantId: s.tenantId,
      aircraftId,
      toRegimeId: s.carsRegimeId,
      actorUserId: s.userId,
      reason: "Aircraft re-registered in Canada.",
    });

    expect(result.aircraft.regimeId).toBe(s.carsRegimeId);
    expect(result.change.fromRegimeId).toBe(s.faaRegimeId);
    expect(result.change.toRegimeId).toBe(s.carsRegimeId);
    expect(result.change.actorUserId).toBe(s.userId);
    expect(result.change.reason).toBe("Aircraft re-registered in Canada.");

    const history = await svc.listForAircraft(s.tenantId, aircraftId);
    expect(history).toHaveLength(1);
    expect(history[0]!.id).toBe(result.change.id);
  });

  it("rejects a no-op change (same regime as current)", async () => {
    const aircraftId = await makeAircraft(db, s.tenantId);
    const svc = new AircraftRegimeChangeService(db);

    await expect(
      svc.change({
        tenantId: s.tenantId,
        aircraftId,
        toRegimeId: s.faaRegimeId,
        actorUserId: s.userId,
        reason: "Mistake",
      }),
    ).rejects.toBeInstanceOf(AircraftRegimeChangeValidationError);

    // Aircraft regime is unchanged AND no audit row was written.
    const post = await db.execute<{ regime_id: string }>(
      sql`select regime_id from aircraft where id = ${aircraftId}`,
    );
    expect(post.rows[0]?.regime_id).toBe(s.faaRegimeId);
    const history = await svc.listForAircraft(s.tenantId, aircraftId);
    expect(history).toHaveLength(0);
  });

  it("rejects an empty/whitespace reason", async () => {
    const aircraftId = await makeAircraft(db, s.tenantId);
    const svc = new AircraftRegimeChangeService(db);

    await expect(
      svc.change({
        tenantId: s.tenantId,
        aircraftId,
        toRegimeId: s.carsRegimeId,
        actorUserId: s.userId,
        reason: "   ",
      }),
    ).rejects.toBeInstanceOf(AircraftRegimeChangeValidationError);
  });

  it("rejects an unknown aircraft id", async () => {
    const svc = new AircraftRegimeChangeService(db);
    await expect(
      svc.change({
        tenantId: s.tenantId,
        aircraftId: "00000000-0000-0000-0000-000000000000",
        toRegimeId: s.carsRegimeId,
        actorUserId: s.userId,
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(AircraftRegimeChangeAircraftNotFoundError);
  });

  it("rejects an unknown target regime id with a regime-not-found error", async () => {
    const aircraftId = await makeAircraft(db, s.tenantId);
    const svc = new AircraftRegimeChangeService(db);

    await expect(
      svc.change({
        tenantId: s.tenantId,
        aircraftId,
        toRegimeId: "00000000-0000-0000-0000-000000000000",
        actorUserId: s.userId,
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(AircraftRegimeChangeRegimeNotFoundError);

    // Importantly: the transaction rolled back. Aircraft regime is unchanged.
    const post = await db.execute<{ regime_id: string }>(
      sql`select regime_id from aircraft where id = ${aircraftId}`,
    );
    expect(post.rows[0]?.regime_id).toBe(s.faaRegimeId);
  });

  it("isolates history per tenant", async () => {
    const aircraftA = await makeAircraft(db, s.tenantId, "N111");
    const aircraftB = await makeAircraft(db, s.otherTenantId, "N222");
    const svc = new AircraftRegimeChangeService(db);

    await svc.change({
      tenantId: s.tenantId,
      aircraftId: aircraftA,
      toRegimeId: s.carsRegimeId,
      actorUserId: s.userId,
      reason: "A",
    });
    await svc.change({
      tenantId: s.otherTenantId,
      aircraftId: aircraftB,
      toRegimeId: s.carsRegimeId,
      actorUserId: s.userId,
      reason: "B",
    });

    // listForAircraft is scoped by both tenant and aircraft. Asking for
    // tenant A + aircraft B yields no rows even though aircraft B has
    // a real audit row under tenant B.
    const aFromA = await svc.listForAircraft(s.tenantId, aircraftA);
    const bFromA = await svc.listForAircraft(s.tenantId, aircraftB);
    expect(aFromA).toHaveLength(1);
    expect(bFromA).toHaveLength(0);
  });

  it("seed migration ships a regime_change retention rule for FAA", async () => {
    const svc = new AircraftRegimeChangeService(db);
    const rule = await svc.retentionRuleFor(s.faaRegimeId);
    expect(rule).not.toBeNull();
    expect(rule!.recordKind).toBe(REGIME_CHANGE_RETENTION_RECORD_KIND);
    expect(rule!.retentionPeriodKind).toBe("lifetime");
  });

  it("audit rows are append-only — direct UPDATE raises", async () => {
    const aircraftId = await makeAircraft(db, s.tenantId);
    const svc = new AircraftRegimeChangeService(db);
    const { change } = await svc.change({
      tenantId: s.tenantId,
      aircraftId,
      toRegimeId: s.carsRegimeId,
      actorUserId: s.userId,
      reason: "first",
    });

    await expect(
      db.execute(
        sql`update aircraft_regime_changes set reason = 'tampered' where id = ${change.id}`,
      ),
    ).rejects.toThrow(/append-only/);
  });
});
