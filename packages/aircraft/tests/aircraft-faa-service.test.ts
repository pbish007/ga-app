import { createHash } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

import {
  AircraftFaaDecisionAircraftNotFoundError,
  AircraftFaaDecisionService,
  AircraftFaaDecisionValidationError,
  AircraftService,
  normalizeNNumber,
  sha256Hex,
} from "../src/index.js";

interface Seed {
  tenantId: string;
  userId: string;
  aircraftId: string;
}

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

async function seedUser(db: TestDb, email: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into users (email, password_hash)
    values (${email}, 'x')
    returning id
  `);
  return rows.rows[0]!.id;
}

async function seed(db: TestDb): Promise<Seed> {
  const tenantId = await seedTenant(db, "Owner Op");
  const userId = await seedUser(db, "owner@example.test");
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
  });
  return { tenantId, userId, aircraftId: ac.id };
}

describe("AircraftFaaDecisionService", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  afterEach(async () => {
    await reset();
  });

  it("records and reads back a tenant_wins decision with the hash pinned", async () => {
    const s = await seed(db);
    const service = new AircraftFaaDecisionService(db);

    const recorded = await service.record({
      tenantId: s.tenantId,
      aircraftId: s.aircraftId,
      fieldKey: "model",
      decision: "tenant_wins",
      faaValue: "Cessna 172S",
      tenantValue: "172N",
      decidedByUserId: s.userId,
    });

    expect(recorded.faaValueHash).toBe(sha256Hex("Cessna 172S"));
    expect(recorded.nNumber).toBe("12345");
    expect(recorded.reportReason).toBeNull();

    const listed = await service.listByAircraft(s.tenantId, s.aircraftId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.fieldKey).toBe("model");
    expect(listed[0]!.decision).toBe("tenant_wins");
  });

  it("upserts the latest decision per (aircraft, field)", async () => {
    const s = await seed(db);
    const service = new AircraftFaaDecisionService(db);

    await service.record({
      tenantId: s.tenantId,
      aircraftId: s.aircraftId,
      fieldKey: "model",
      decision: "tenant_wins",
      faaValue: "Cessna 172S",
      tenantValue: "172N",
      decidedByUserId: s.userId,
    });

    const second = await service.record({
      tenantId: s.tenantId,
      aircraftId: s.aircraftId,
      fieldKey: "model",
      decision: "accepted_faa",
      faaValue: "Cessna 172S",
      tenantValue: "Cessna 172S",
      decidedByUserId: s.userId,
    });

    expect(second.decision).toBe("accepted_faa");
    const listed = await service.listByAircraft(s.tenantId, s.aircraftId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.decision).toBe("accepted_faa");
  });

  it("rejects faa_reported_wrong without a report_reason", async () => {
    const s = await seed(db);
    const service = new AircraftFaaDecisionService(db);

    await expect(
      service.record({
        tenantId: s.tenantId,
        aircraftId: s.aircraftId,
        fieldKey: "owner_name",
        decision: "faa_reported_wrong",
        faaValue: "WRONG OWNER",
        tenantValue: "Right Owner LLC",
        decidedByUserId: s.userId,
      }),
    ).rejects.toBeInstanceOf(AircraftFaaDecisionValidationError);
  });

  it("rejects report_reason on a non-report decision", async () => {
    const s = await seed(db);
    const service = new AircraftFaaDecisionService(db);

    await expect(
      service.record({
        tenantId: s.tenantId,
        aircraftId: s.aircraftId,
        fieldKey: "make",
        decision: "tenant_wins",
        faaValue: "Cessna",
        tenantValue: "Cessna",
        reportReason: "stale_data",
        decidedByUserId: s.userId,
      }),
    ).rejects.toBeInstanceOf(AircraftFaaDecisionValidationError);
  });

  it("rejects a decision targeting another tenant's aircraft", async () => {
    const s = await seed(db);
    const otherTenantId = await seedTenant(db, "Other");
    const service = new AircraftFaaDecisionService(db);

    await expect(
      service.record({
        tenantId: otherTenantId,
        aircraftId: s.aircraftId,
        fieldKey: "model",
        decision: "tenant_wins",
        faaValue: "Cessna 172S",
        tenantValue: "172N",
        decidedByUserId: s.userId,
      }),
    ).rejects.toBeInstanceOf(AircraftFaaDecisionAircraftNotFoundError);
  });

  it("hashes a null FAA value to sha256('') so the anti-nag oracle has a pin", async () => {
    const s = await seed(db);
    const service = new AircraftFaaDecisionService(db);

    const recorded = await service.record({
      tenantId: s.tenantId,
      aircraftId: s.aircraftId,
      fieldKey: "expiration_date",
      decision: "tenant_wins",
      faaValue: null,
      tenantValue: "2027-04-01",
      decidedByUserId: s.userId,
    });

    expect(recorded.faaValue).toBeNull();
    expect(recorded.faaValueHash).toBe(
      createHash("sha256").update("").digest("hex"),
    );
  });

  it("normalizes N-numbers from the tenant aircraft row", () => {
    expect(normalizeNNumber(" n12345 ")).toBe("12345");
    expect(normalizeNNumber("N987AB")).toBe("987AB");
    expect(normalizeNNumber("12345")).toBe("12345");
  });
});
