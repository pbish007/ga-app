import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestDb, type TestDb } from "@ga/db";
import { AircraftService, ComponentService } from "@ga/aircraft";

import {
  handleAircraftCreate,
  handleAircraftGet,
  handleAircraftList,
} from "../lib/aircraft-handler";

interface Seed {
  tenantId: string;
}

async function seed(db: TestDb): Promise<Seed> {
  const regime = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const regimeId = regime.rows[0]!.id;
  const orgs = await db.execute<{ id: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values ('Test Tenant', 'club', ${regimeId})
    returning id
  `);
  return { tenantId: orgs.rows[0]!.id };
}

function buildBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    registration: "N12345",
    make: "Cessna",
    model: "172N",
    serial_number: "17270001",
    year_manufactured: 1979,
    category: "normal",
    aircraft_class: "single_engine_land",
    time_source: "hobbs",
    airframe_total_time: 2500.5,
    ...overrides,
  };
}

function jsonRequest(body: unknown): Request {
  return new Request("https://example.test/api/orgs/x/aircraft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleAircraftCreate (B1.2)", () => {
  let db: TestDb;
  let s: Seed;
  beforeEach(async () => {
    db = await setupTestDb();
    s = await seed(db);
  });

  it("creates an aircraft and returns 201 with the serialized row", async () => {
    const res = await handleAircraftCreate(jsonRequest(buildBody()), {
      tenantId: s.tenantId,
      db,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.registration).toBe("N12345");
    expect(body.time_source).toBe("hobbs");
    expect(body.airframe_total_time).toBe(2500.5);
    expect(body.regime_id).toBeTruthy();
  });

  it("rejects missing fields with 400", async () => {
    const res = await handleAircraftCreate(
      jsonRequest(buildBody({ registration: "", time_source: "engine_monitor" })),
      { tenantId: s.tenantId, db },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/registration/);
    expect(body.error).toMatch(/time_source/);
  });

  it("returns 409 on duplicate N-number within the same tenant", async () => {
    await handleAircraftCreate(jsonRequest(buildBody()), {
      tenantId: s.tenantId,
      db,
    });
    const res = await handleAircraftCreate(
      jsonRequest(buildBody({ registration: "n12345" })),
      { tenantId: s.tenantId, db },
    );
    expect(res.status).toBe(409);
  });

  it("rejects non-numeric airframe_total_time with 400", async () => {
    const res = await handleAircraftCreate(
      jsonRequest(buildBody({ airframe_total_time: "not-a-number" })),
      { tenantId: s.tenantId, db },
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-JSON body with 400", async () => {
    const req = new Request("https://example.test/api/x", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "text/plain" },
    });
    const res = await handleAircraftCreate(req, { tenantId: s.tenantId, db });
    expect(res.status).toBe(400);
  });
});

describe("handleAircraftList (B1.2)", () => {
  it("lists aircraft for the tenant only", async () => {
    const db = await setupTestDb();
    const a = await seed(db);
    const b = await seed(db);
    const svc = new AircraftService(db);
    await svc.create({
      tenantId: a.tenantId,
      registration: "N111",
      make: "Cessna",
      model: "172",
      serialNumber: "S1",
      category: "normal",
      aircraftClass: "single_engine_land",
      timeSource: "hobbs",
    });
    await svc.create({
      tenantId: b.tenantId,
      registration: "N222",
      make: "Cessna",
      model: "152",
      serialNumber: "S2",
      category: "normal",
      aircraftClass: "single_engine_land",
      timeSource: "tach",
    });

    const res = await handleAircraftList(
      new Request("https://example.test/x"),
      { tenantId: a.tenantId, db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      aircraft: Array<{ registration: string }>;
    };
    expect(body.aircraft.map((x) => x.registration)).toEqual(["N111"]);
  });
});

describe("handleAircraftGet (B1.2)", () => {
  it("returns the aircraft plus its currently-installed components", async () => {
    const db = await setupTestDb();
    const { tenantId } = await seed(db);
    const aircraftSvc = new AircraftService(db);
    const componentSvc = new ComponentService(db);

    const ac = await aircraftSvc.create({
      tenantId,
      registration: "N123",
      make: "Cessna",
      model: "172",
      serialNumber: "S1",
      category: "normal",
      aircraftClass: "single_engine_land",
      timeSource: "hobbs",
      airframeTotalTime: 1500,
    });
    const engine = await componentSvc.create({
      tenantId,
      kind: "engine",
      serialNumber: "L-1",
      tboHours: 2000,
    });
    await componentSvc.install({
      tenantId,
      componentId: engine.id,
      aircraftId: ac.id,
      installedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const res = await handleAircraftGet(
      new Request(`https://example.test/api/orgs/${tenantId}/aircraft/${ac.id}`),
      { tenantId, db, params: { id: ac.id } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      registration: string;
      installed_components: Array<{
        component: { kind: string };
        installation: { installed_at_aircraft_total_time: number };
      }>;
    };
    expect(body.registration).toBe("N123");
    expect(body.installed_components.length).toBe(1);
    expect(body.installed_components[0]!.component.kind).toBe("engine");
    expect(
      body.installed_components[0]!.installation.installed_at_aircraft_total_time,
    ).toBe(1500);
  });

  it("returns 404 for an unknown id", async () => {
    const db = await setupTestDb();
    const { tenantId } = await seed(db);
    const res = await handleAircraftGet(
      new Request("https://example.test/x"),
      {
        tenantId,
        db,
        params: { id: "00000000-0000-0000-0000-000000000000" },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for a non-UUID id", async () => {
    const db = await setupTestDb();
    const { tenantId } = await seed(db);
    const res = await handleAircraftGet(
      new Request("https://example.test/x"),
      { tenantId, db, params: { id: "not-a-uuid" } },
    );
    expect(res.status).toBe(400);
  });
});
