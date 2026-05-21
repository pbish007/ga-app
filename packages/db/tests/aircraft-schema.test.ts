import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestDb, type TestDb } from "@ga/db";

import { runAsTenant } from "../src/test/tenant.js";

/**
 * B1.1 (PMB-11) — aircraft schema, regime seam (K2), tenant isolation,
 * and per-tenant N-number uniqueness.
 *
 * These tests pin contract-level invariants, not application behaviour:
 *   * regime_id is NOT NULL with an FK to regimes (the K2 seam).
 *   * N-number is unique per tenant and case-insensitive.
 *   * Two different tenants may track an aircraft with the same N-number.
 *   * time_source is constrained to ('hobbs', 'tach') by CHECK.
 *   * Tenant RLS isolates reads and blocks cross-tenant writes.
 */

type TenantSeed = { orgId: string; regimeId: string };

async function seedTwoTenants(
  db: TestDb,
): Promise<{ a: TenantSeed; b: TenantSeed }> {
  const regime = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const regimeId = regime.rows[0]!.id;

  const orgs = await db.execute<{ id: string; name: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values ('Tenant A', 'club', ${regimeId}),
           ('Tenant B', 'shop', ${regimeId})
    returning id, name
  `);
  const orgA = orgs.rows.find((r) => r.name === "Tenant A")!.id;
  const orgB = orgs.rows.find((r) => r.name === "Tenant B")!.id;

  return {
    a: { orgId: orgA, regimeId },
    b: { orgId: orgB, regimeId },
  };
}

async function insertAircraft(
  db: TestDb,
  args: {
    tenantId: string;
    regimeId: string;
    registration: string;
    timeSource?: string;
  },
): Promise<{ id: string }> {
  const timeSource = args.timeSource ?? "hobbs";
  const result = await db.execute<{ id: string }>(sql`
    insert into aircraft
      (tenant_id, regime_id, registration, make, model, serial_number,
       year_manufactured, category, aircraft_class, airframe_total_time,
       time_source)
    values
      (${args.tenantId}, ${args.regimeId}, ${args.registration},
       'Cessna', '172N', '17270001', 1979,
       'normal', 'single_engine_land', 1234.5, ${timeSource})
    returning id
  `);
  return result.rows[0]!;
}

describe("B1.1 aircraft schema — regime seam + tenant uniqueness (PMB-11)", () => {
  it("requires regime_id (NOT NULL FK) — K2 seam", async () => {
    const db = await setupTestDb();
    const { a } = await seedTwoTenants(db);

    await expect(
      db.execute(sql`
        insert into aircraft
          (tenant_id, registration, make, model, serial_number,
           category, aircraft_class, time_source)
        values
          (${a.orgId}, 'N12345', 'Cessna', '172N', '17270001',
           'normal', 'single_engine_land', 'hobbs')
      `),
    ).rejects.toThrow(/regime_id|not.null/i);
  });

  it("rejects a regime_id that does not exist in regimes", async () => {
    const db = await setupTestDb();
    const { a } = await seedTwoTenants(db);
    const fakeRegime = "00000000-0000-0000-0000-000000000000";
    await expect(
      db.execute(sql`
        insert into aircraft
          (tenant_id, regime_id, registration, make, model, serial_number,
           category, aircraft_class, time_source)
        values
          (${a.orgId}, ${fakeRegime}, 'N12345', 'Cessna', '172N', '17270001',
           'normal', 'single_engine_land', 'hobbs')
      `),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("rejects deleting a regime that an aircraft references (ON DELETE RESTRICT)", async () => {
    const db = await setupTestDb();
    const { a } = await seedTwoTenants(db);
    await insertAircraft(db, {
      tenantId: a.orgId,
      regimeId: a.regimeId,
      registration: "N12345",
    });

    await expect(
      db.execute(sql`delete from regimes where id = ${a.regimeId}`),
    ).rejects.toThrow(/violates|restrict|foreign key/i);
  });

  it("enforces N-number uniqueness per tenant (case-insensitive)", async () => {
    const db = await setupTestDb();
    const { a } = await seedTwoTenants(db);
    await insertAircraft(db, {
      tenantId: a.orgId,
      regimeId: a.regimeId,
      registration: "N12345",
    });

    await expect(
      insertAircraft(db, {
        tenantId: a.orgId,
        regimeId: a.regimeId,
        registration: "n12345",
      }),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("allows the same N-number across different tenants", async () => {
    const db = await setupTestDb();
    const { a, b } = await seedTwoTenants(db);

    await insertAircraft(db, {
      tenantId: a.orgId,
      regimeId: a.regimeId,
      registration: "N12345",
    });
    await insertAircraft(db, {
      tenantId: b.orgId,
      regimeId: b.regimeId,
      registration: "N12345",
    });

    const result = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from aircraft where lower(registration) = 'n12345'`,
    );
    expect(Number(result.rows[0]!.count)).toBe(2);
  });

  it("rejects an invalid time_source value", async () => {
    const db = await setupTestDb();
    const { a } = await seedTwoTenants(db);
    await expect(
      insertAircraft(db, {
        tenantId: a.orgId,
        regimeId: a.regimeId,
        registration: "N12345",
        timeSource: "engine_monitor",
      }),
    ).rejects.toThrow(/check|aircraft_time_source/i);
  });

  it("isolates aircraft rows by tenant under runAsTenant", async () => {
    const db = await setupTestDb();
    const { a, b } = await seedTwoTenants(db);

    await insertAircraft(db, {
      tenantId: a.orgId,
      regimeId: a.regimeId,
      registration: "N11111",
    });
    await insertAircraft(db, {
      tenantId: b.orgId,
      regimeId: b.regimeId,
      registration: "N22222",
    });

    await runAsTenant(db, a.orgId, async (tx) => {
      const rows = await tx.execute<{ registration: string }>(
        sql`select registration from aircraft`,
      );
      expect(rows.rows.map((r) => r.registration)).toEqual(["N11111"]);
    });

    await runAsTenant(db, b.orgId, async (tx) => {
      const rows = await tx.execute<{ registration: string }>(
        sql`select registration from aircraft`,
      );
      expect(rows.rows.map((r) => r.registration)).toEqual(["N22222"]);
    });
  });

  it("blocks cross-tenant aircraft writes via WITH CHECK", async () => {
    const db = await setupTestDb();
    const { a, b } = await seedTwoTenants(db);

    await expect(
      runAsTenant(db, a.orgId, async (tx) => {
        await tx.execute(sql`
          insert into aircraft
            (tenant_id, regime_id, registration, make, model, serial_number,
             category, aircraft_class, time_source)
          values
            (${b.orgId}, ${b.regimeId}, 'N99999', 'Cessna', '172N', '17270001',
             'normal', 'single_engine_land', 'hobbs')
        `);
      }),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it("rejects negative airframe_total_time", async () => {
    const db = await setupTestDb();
    const { a } = await seedTwoTenants(db);
    await expect(
      db.execute(sql`
        insert into aircraft
          (tenant_id, regime_id, registration, make, model, serial_number,
           category, aircraft_class, airframe_total_time, time_source)
        values
          (${a.orgId}, ${a.regimeId}, 'N12345', 'Cessna', '172N', '17270001',
           'normal', 'single_engine_land', -1, 'hobbs')
      `),
    ).rejects.toThrow(/check|airframe_total_time/i);
  });

  it("cascades aircraft deletion when the owning tenant is removed", async () => {
    const db = await setupTestDb();
    const { a } = await seedTwoTenants(db);
    await insertAircraft(db, {
      tenantId: a.orgId,
      regimeId: a.regimeId,
      registration: "N33333",
    });

    await db.execute(sql`delete from organizations where id = ${a.orgId}`);

    const result = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from aircraft`,
    );
    expect(Number(result.rows[0]!.count)).toBe(0);
  });
});
