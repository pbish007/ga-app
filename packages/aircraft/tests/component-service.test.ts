import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestDb, type TestDb } from "@ga/db";

import {
  AircraftService,
  ComponentAlreadyInstalledError,
  ComponentNotInstalledError,
  ComponentService,
  ComponentValidationError,
} from "../src/index.js";

async function seedTenant(db: TestDb, name: string): Promise<string> {
  const regime = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const regimeId = regime.rows[0]!.id;
  const orgs = await db.execute<{ id: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values (${name}, 'shop', ${regimeId})
    returning id
  `);
  return orgs.rows[0]!.id;
}

async function seedAircraft(
  db: TestDb,
  tenantId: string,
  registration: string,
  airframeTotalTime: number,
): Promise<string> {
  const svc = new AircraftService(db);
  const ac = await svc.create({
    tenantId,
    registration,
    make: "Cessna",
    model: "172N",
    serialNumber: registration + "-SN",
    category: "normal",
    aircraftClass: "single_engine_land",
    timeSource: "hobbs",
    airframeTotalTime,
  });
  return ac.id;
}

describe("ComponentService.create", () => {
  it("creates an engine with TBO hours", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Shop");
    const svc = new ComponentService(db);
    const engine = await svc.create({
      tenantId,
      kind: "engine",
      serialNumber: "L-12345",
      make: "Lycoming",
      model: "O-360",
      tboHours: 2000,
    });
    expect(engine.kind).toBe("engine");
    expect(Number(engine.tboHours)).toBe(2000);
  });

  it("rejects non-positive TBO at the validation layer", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Shop");
    const svc = new ComponentService(db);
    await expect(
      svc.create({
        tenantId,
        kind: "engine",
        serialNumber: "L-0",
        tboHours: 0,
      }),
    ).rejects.toBeInstanceOf(ComponentValidationError);
  });
});

describe("ComponentService.install / .remove (B2.2)", () => {
  it("installs a component and records airframe TT snapshot", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Shop");
    const aircraftId = await seedAircraft(db, tenantId, "N111", 1500);
    const svc = new ComponentService(db);

    const engine = await svc.create({
      tenantId,
      kind: "engine",
      serialNumber: "L-1",
      tboHours: 2000,
    });
    const installation = await svc.install({
      tenantId,
      componentId: engine.id,
      aircraftId,
      installedAt: new Date("2026-01-15T10:00:00Z"),
    });

    expect(installation.aircraftId).toBe(aircraftId);
    expect(installation.removedAt).toBeNull();
    expect(Number(installation.installedAtAircraftTotalTime)).toBe(1500);
  });

  it("rejects installing a component that is already installed", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Shop");
    const aircraftId = await seedAircraft(db, tenantId, "N111", 0);
    const svc = new ComponentService(db);
    const engine = await svc.create({
      tenantId,
      kind: "engine",
      serialNumber: "L-1",
    });
    await svc.install({
      tenantId,
      componentId: engine.id,
      aircraftId,
      installedAt: new Date("2026-01-01T00:00:00Z"),
    });

    await expect(
      svc.install({
        tenantId,
        componentId: engine.id,
        aircraftId,
        installedAt: new Date("2026-02-01T00:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(ComponentAlreadyInstalledError);
  });

  it("removes an installation and snapshots airframe TT", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Shop");
    const aircraftId = await seedAircraft(db, tenantId, "N111", 1500);
    const svc = new ComponentService(db);
    const aircraftSvc = new AircraftService(db);
    const engine = await svc.create({
      tenantId,
      kind: "engine",
      serialNumber: "L-1",
    });

    await svc.install({
      tenantId,
      componentId: engine.id,
      aircraftId,
      installedAt: new Date("2026-01-01T00:00:00Z"),
    });

    // Aircraft flies some hours; airframe TT advances.
    await aircraftSvc.updateAirframeTotalTime({
      tenantId,
      aircraftId,
      airframeTotalTime: 1620,
    });

    const removed = await svc.remove({
      tenantId,
      componentId: engine.id,
      removedAt: new Date("2026-03-15T00:00:00Z"),
      notes: "Sent out for overhaul",
    });

    expect(removed.removedAt).not.toBeNull();
    expect(Number(removed.removedAtAircraftTotalTime)).toBe(1620);
    expect(removed.notes).toBe("Sent out for overhaul");

    const active = await svc.getActiveInstallation(tenantId, engine.id);
    expect(active).toBeNull();
  });

  it("rejects removing a component that is not installed", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Shop");
    await seedAircraft(db, tenantId, "N111", 0);
    const svc = new ComponentService(db);
    const engine = await svc.create({
      tenantId,
      kind: "engine",
      serialNumber: "L-1",
    });
    await expect(
      svc.remove({
        tenantId,
        componentId: engine.id,
        removedAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(ComponentNotInstalledError);
  });

  it("preserves history and supports reinstallation on another aircraft", async () => {
    // The B2 epic DoD: "Removing a component preserves its history and
    // allows reinstallation on another aircraft — verified by automated test."
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Shop");
    const skyhawkId = await seedAircraft(db, tenantId, "N111", 1000);
    const cardinalId = await seedAircraft(db, tenantId, "N222", 2500);
    const svc = new ComponentService(db);

    const engine = await svc.create({
      tenantId,
      kind: "engine",
      serialNumber: "L-1",
      tboHours: 2000,
    });

    await svc.install({
      tenantId,
      componentId: engine.id,
      aircraftId: skyhawkId,
      installedAt: new Date("2025-01-01T00:00:00Z"),
    });
    await svc.remove({
      tenantId,
      componentId: engine.id,
      removedAt: new Date("2025-12-01T00:00:00Z"),
      removedAtAircraftTotalTime: 1450,
      notes: "Removed for transfer",
    });

    // Reinstall on a different aircraft.
    await svc.install({
      tenantId,
      componentId: engine.id,
      aircraftId: cardinalId,
      installedAt: new Date("2026-01-15T00:00:00Z"),
      notes: "Installed on Cardinal post-overhaul",
    });

    const history = await svc.listHistory(tenantId, engine.id);
    expect(history.length).toBe(2);
    // listHistory orders by installedAt desc; first row is most recent.
    expect(history[0]!.aircraftId).toBe(cardinalId);
    expect(history[0]!.removedAt).toBeNull();
    expect(history[1]!.aircraftId).toBe(skyhawkId);
    expect(history[1]!.removedAt).not.toBeNull();
    expect(Number(history[1]!.removedAtAircraftTotalTime)).toBe(1450);

    // The component is currently installed on the Cardinal.
    const installed = await svc.listInstalledOnAircraft(tenantId, cardinalId);
    expect(installed.length).toBe(1);
    expect(installed[0]!.component.id).toBe(engine.id);

    // The Skyhawk has no currently-installed components.
    const stillOnSkyhawk = await svc.listInstalledOnAircraft(
      tenantId,
      skyhawkId,
    );
    expect(stillOnSkyhawk).toEqual([]);
  });

  it("rejects removing earlier than installedAt at the validation layer", async () => {
    const db = await setupTestDb();
    const tenantId = await seedTenant(db, "Shop");
    const aircraftId = await seedAircraft(db, tenantId, "N111", 0);
    const svc = new ComponentService(db);
    const engine = await svc.create({
      tenantId,
      kind: "engine",
      serialNumber: "L-1",
    });
    await svc.install({
      tenantId,
      componentId: engine.id,
      aircraftId,
      installedAt: new Date("2026-02-01T00:00:00Z"),
    });
    await expect(
      svc.remove({
        tenantId,
        componentId: engine.id,
        removedAt: new Date("2026-01-15T00:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(ComponentValidationError);
  });
});
