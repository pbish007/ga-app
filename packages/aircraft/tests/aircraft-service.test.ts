import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

import {
  AircraftNotFoundError,
  AircraftService,
  AircraftValidationError,
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

describe("AircraftService (B1)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  afterEach(async () => {
    await reset();
  });

  it("creates an aircraft and resolves the FAA regime by default", async () => {
    const tenantId = await seedTenant(db, "Owner-Operator A");
    const svc = new AircraftService(db);

    const ac = await svc.create({
      tenantId,
      registration: "N12345",
      make: "Cessna",
      model: "172N",
      serialNumber: "17270001",
      category: "normal",
      aircraftClass: "single_engine_land",
      timeSource: "hobbs",
      airframeTotalTime: 2500.5,
    });

    expect(ac.registration).toBe("N12345");
    expect(ac.regimeId).toBeTruthy();
    const regime = await db.execute<{ code: string }>(
      sql`select code from regimes where id = ${ac.regimeId}`,
    );
    expect(regime.rows[0]?.code).toBe("FAA");
    expect(Number(ac.airframeTotalTime)).toBe(2500.5);
  });

  it("rejects invalid timeSource at the validation layer", async () => {
    const tenantId = await seedTenant(db, "Owner");
    const svc = new AircraftService(db);
    await expect(
      svc.create({
        tenantId,
        registration: "N12345",
        make: "Cessna",
        model: "172",
        serialNumber: "S1",
        category: "normal",
        aircraftClass: "single_engine_land",
        // @ts-expect-error testing runtime guard
        timeSource: "engine_monitor",
      }),
    ).rejects.toBeInstanceOf(AircraftValidationError);
  });

  it("updates airframe total time", async () => {
    const tenantId = await seedTenant(db, "Owner");
    const svc = new AircraftService(db);
    const ac = await svc.create({
      tenantId,
      registration: "N1",
      make: "Cessna",
      model: "172",
      serialNumber: "S1",
      category: "normal",
      aircraftClass: "single_engine_land",
      timeSource: "hobbs",
      airframeTotalTime: 1000,
    });

    const updated = await svc.updateAirframeTotalTime({
      tenantId,
      aircraftId: ac.id,
      airframeTotalTime: 1010.4,
    });
    expect(Number(updated.airframeTotalTime)).toBe(1010.4);
  });

  it("getById fails for an unknown id", async () => {
    const tenantId = await seedTenant(db, "Owner");
    const svc = new AircraftService(db);
    await expect(
      svc.getById(tenantId, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toBeInstanceOf(AircraftNotFoundError);
  });

  it("listForTenant returns only the requesting tenant's aircraft", async () => {
    const a = await seedTenant(db, "A");
    const b = await seedTenant(db, "B");
    const svc = new AircraftService(db);
    await svc.create({
      tenantId: a,
      registration: "N111",
      make: "Cessna",
      model: "172",
      serialNumber: "S1",
      category: "normal",
      aircraftClass: "single_engine_land",
      timeSource: "hobbs",
    });
    await svc.create({
      tenantId: b,
      registration: "N222",
      make: "Cessna",
      model: "152",
      serialNumber: "S2",
      category: "normal",
      aircraftClass: "single_engine_land",
      timeSource: "tach",
    });

    const aircraftA = await svc.listForTenant(a);
    expect(aircraftA.map((x) => x.registration)).toEqual(["N111"]);
  });
});
