import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

import {
  AircraftService,
  FlightTimeMonotonicError,
  FlightTimeService,
  FlightTimeValidationError,
} from "../src/index.js";

async function seedTenant(db: TestDb, name: string): Promise<string> {
  const regime = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const regimeId = regime.rows[0]!.id;
  const orgs = await db.execute<{ id: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values (${name}, 'club', ${regimeId})
    returning id
  `);
  return orgs.rows[0]!.id;
}

async function seedAircraft(
  db: TestDb,
  tenantId: string,
  reg: string,
  initialTt = 0,
) {
  const svc = new AircraftService(db);
  return svc.create({
    tenantId,
    registration: reg,
    make: "Cessna",
    model: "172N",
    serialNumber: `SN-${reg}`,
    category: "normal",
    aircraftClass: "single_engine_land",
    timeSource: "hobbs",
    airframeTotalTime: initialTt,
  });
}

describe("FlightTimeService (C1)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  afterEach(async () => {
    await reset();
  });

  it("logs a normal (monotonic) time entry and advances aircraft TT", async () => {
    const tenantId = await seedTenant(db, "Org A");
    const ac = await seedAircraft(db, tenantId, "N11111", 1000);

    const ftSvc = new FlightTimeService(db);
    const entry = await ftSvc.logFlightTime({
      tenantId,
      aircraftId: ac.id,
      airframeTimeNew: 1001.5,
    });

    expect(Number(entry.airframeTimeNew)).toBe(1001.5);
    expect(Number(entry.airframeTimePrev)).toBe(1000);
    expect(entry.isOverride).toBe(false);

    const rows = await db.execute<{ airframe_total_time: string }>(
      sql`select airframe_total_time from aircraft where id = ${ac.id}`,
    );
    expect(Number(rows.rows[0]!.airframe_total_time)).toBe(1001.5);
  });

  it("allows equal readings (zero-flight log)", async () => {
    const tenantId = await seedTenant(db, "Org B");
    const ac = await seedAircraft(db, tenantId, "N22222", 500);
    const ftSvc = new FlightTimeService(db);
    const entry = await ftSvc.logFlightTime({
      tenantId,
      aircraftId: ac.id,
      airframeTimeNew: 500,
    });
    expect(Number(entry.airframeTimeNew)).toBe(500);
  });

  it("rejects a lower reading without override (app layer)", async () => {
    const tenantId = await seedTenant(db, "Org C");
    const ac = await seedAircraft(db, tenantId, "N33333", 2000);
    const ftSvc = new FlightTimeService(db);
    await expect(
      ftSvc.logFlightTime({
        tenantId,
        aircraftId: ac.id,
        airframeTimeNew: 1999,
      }),
    ).rejects.toThrow(FlightTimeMonotonicError);
  });

  it("accepts a lower reading when is_override=true with reason", async () => {
    const tenantId = await seedTenant(db, "Org D");
    const ac = await seedAircraft(db, tenantId, "N44444", 5000);
    const ftSvc = new FlightTimeService(db);
    const entry = await ftSvc.logFlightTime({
      tenantId,
      aircraftId: ac.id,
      airframeTimeNew: 10,
      isOverride: true,
      overrideReason: "Hobbs replaced S/N old → new",
    });
    expect(entry.isOverride).toBe(true);
    expect(entry.overrideReason).toBe("Hobbs replaced S/N old → new");
    expect(Number(entry.airframeTimePrev)).toBe(5000);
    expect(Number(entry.airframeTimeNew)).toBe(10);

    const rows = await db.execute<{ airframe_total_time: string }>(
      sql`select airframe_total_time from aircraft where id = ${ac.id}`,
    );
    expect(Number(rows.rows[0]!.airframe_total_time)).toBe(10);
  });

  it("rejects is_override=true without a reason (app layer)", async () => {
    const tenantId = await seedTenant(db, "Org E");
    const ac = await seedAircraft(db, tenantId, "N55555", 100);
    const ftSvc = new FlightTimeService(db);
    await expect(
      ftSvc.logFlightTime({
        tenantId,
        aircraftId: ac.id,
        airframeTimeNew: 50,
        isOverride: true,
      }),
    ).rejects.toThrow(FlightTimeValidationError);
  });

  it("db trigger enforces monotonicity independently of app layer", async () => {
    const tenantId = await seedTenant(db, "Org F");
    const ac = await seedAircraft(db, tenantId, "N66666", 3000);
    // Bypass app layer by inserting directly.
    await expect(
      db.execute(sql`
        insert into flight_time_entries
          (tenant_id, aircraft_id, airframe_time_new, is_override)
        values
          (${tenantId}, ${ac.id}, 2999, false)
      `),
    ).rejects.toThrow(/flight_time_not_monotonic/);
  });

  it("listForAircraft returns entries newest-first", async () => {
    const tenantId = await seedTenant(db, "Org G");
    const ac = await seedAircraft(db, tenantId, "N77777", 100);
    const ftSvc = new FlightTimeService(db);
    await ftSvc.logFlightTime({ tenantId, aircraftId: ac.id, airframeTimeNew: 101 });
    await ftSvc.logFlightTime({ tenantId, aircraftId: ac.id, airframeTimeNew: 102 });
    const entries = await ftSvc.listForAircraft(tenantId, ac.id);
    expect(entries.length).toBe(2);
    expect(Number(entries[0]!.airframeTimeNew)).toBe(102);
    expect(Number(entries[1]!.airframeTimeNew)).toBe(101);
  });
});
