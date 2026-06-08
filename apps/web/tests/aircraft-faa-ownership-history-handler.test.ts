import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";
import { AircraftService } from "@ga/aircraft";

import { handleAircraftFaaOwnershipHistory } from "../lib/aircraft-faa-ownership-history-handler";
import type { FaaSql } from "../lib/faa/client";

interface Seed {
  tenantId: string;
  otherTenantId: string;
  aircraftId: string;
  otherTenantAircraftId: string;
}

async function seed(db: TestDb): Promise<Seed> {
  const regime = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const regimeId = regime.rows[0]!.id;
  const orgs = await db.execute<{ id: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values ('Primary Shop', 'shop', ${regimeId}),
           ('Other Shop',   'shop', ${regimeId})
    returning id
  `);
  const svc = new AircraftService(db);
  const primary = await svc.create({
    tenantId: orgs.rows[0]!.id,
    registration: "N12345",
    make: "Cessna",
    model: "172N",
    serialNumber: "17270001",
    category: "normal",
    aircraftClass: "single_engine_land",
    timeSource: "hobbs",
  });
  const other = await svc.create({
    tenantId: orgs.rows[1]!.id,
    registration: "N99999",
    make: "Cessna",
    model: "172N",
    serialNumber: "17270002",
    category: "normal",
    aircraftClass: "single_engine_land",
    timeSource: "hobbs",
  });
  return {
    tenantId: orgs.rows[0]!.id,
    otherTenantId: orgs.rows[1]!.id,
    aircraftId: primary.id,
    otherTenantAircraftId: other.id,
  };
}

function stubSql(
  router: (queryText: string) => Promise<unknown[]>,
): FaaSql {
  return ((strings: TemplateStringsArray) =>
    router(strings.join(" "))) as unknown as FaaSql;
}

describe("handleAircraftFaaOwnershipHistory", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  let s: Seed;
  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });
  beforeEach(async () => {
    s = await seed(db);
  });
  afterEach(async () => {
    await reset();
  });

  it("rejects a non-UUID aircraft id with 400", async () => {
    const res = await handleAircraftFaaOwnershipHistory(new Request("https://x"), {
      tenantId: s.tenantId,
      db,
      faaDeps: { sql: stubSql(async () => []) },
      params: { id: "not-a-uuid" },
    });
    expect(res.status).toBe(400);
  });

  it("returns ordered events for a tail with known changes", async () => {
    const faaSql = stubSql(async (query) => {
      if (query.includes("snapshot_manifest")) {
        return [
          { snapshot_date: "2026-06-01", pg_loaded_at: "2026-06-01T03:00:00Z" },
        ];
      }
      if (query.includes("aircraft_changes")) {
        return [
          {
            snapshot_date: "2026-06-01",
            change_type: "ownership_transfer",
            old_value: { owner_name: "ACME LLC" },
            new_value: { owner_name: "BETA INC" },
          },
        ];
      }
      return [];
    });
    const res = await handleAircraftFaaOwnershipHistory(new Request("https://x"), {
      tenantId: s.tenantId,
      db,
      faaDeps: { sql: faaSql },
      params: { id: s.aircraftId },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].change_kind).toBe("ownership_transfer");
    expect(body.freshness.pg_loaded_at).toBe("2026-06-01T03:00:00Z");
  });

  it("returns an empty events list for a tail with no changes", async () => {
    const faaSql = stubSql(async (query) => {
      if (query.includes("snapshot_manifest")) {
        return [
          { snapshot_date: "2026-06-01", pg_loaded_at: "2026-06-01T03:00:00Z" },
        ];
      }
      return [];
    });
    const res = await handleAircraftFaaOwnershipHistory(new Request("https://x"), {
      tenantId: s.tenantId,
      db,
      faaDeps: { sql: faaSql },
      params: { id: s.aircraftId },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
  });

  it("returns 404 when the aircraft id belongs to a different tenant", async () => {
    const res = await handleAircraftFaaOwnershipHistory(new Request("https://x"), {
      tenantId: s.tenantId,
      db,
      faaDeps: { sql: stubSql(async () => []) },
      params: { id: s.otherTenantAircraftId },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("aircraft not found");
  });

  it("returns 503 when the FAA query throws", async () => {
    const faaSql = stubSql(async () => {
      throw new Error("FAA pool exhausted");
    });
    const res = await handleAircraftFaaOwnershipHistory(new Request("https://x"), {
      tenantId: s.tenantId,
      db,
      faaDeps: { sql: faaSql },
      params: { id: s.aircraftId },
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("FAA Registry unavailable");
  });
});
