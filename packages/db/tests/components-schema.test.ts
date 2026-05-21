import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestDb, type TestDb } from "@ga/db";

import { runAsTenant } from "../src/test/tenant.js";

/**
 * B2.1 (PMB-11) — components + installation history schema.
 *
 * Pins:
 *   * components is tenant-scoped with per-(tenant, kind, serial)
 *     uniqueness (case-insensitive).
 *   * component_installations enforces removed_at / removed_at_tt
 *     consistency and the partial-unique "at most one active install".
 *   * Tenant RLS applies to both tables.
 */

type TenantSeed = {
  orgId: string;
  regimeId: string;
  aircraftId: string;
};

async function seedTenant(
  db: TestDb,
  name: string,
  registration: string,
): Promise<TenantSeed> {
  const regime = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const regimeId = regime.rows[0]!.id;

  const orgs = await db.execute<{ id: string }>(sql`
    insert into organizations (name, org_type, default_regime_id)
    values (${name}, 'shop', ${regimeId})
    returning id
  `);
  const orgId = orgs.rows[0]!.id;

  const ac = await db.execute<{ id: string }>(sql`
    insert into aircraft
      (tenant_id, regime_id, registration, make, model, serial_number,
       category, aircraft_class, airframe_total_time, time_source)
    values
      (${orgId}, ${regimeId}, ${registration}, 'Cessna', '172N', '17270001',
       'normal', 'single_engine_land', 2000.0, 'hobbs')
    returning id
  `);

  return { orgId, regimeId, aircraftId: ac.rows[0]!.id };
}

async function insertEngine(
  db: TestDb,
  args: { tenantId: string; serial: string; tboHours?: number | null },
): Promise<string> {
  const result = await db.execute<{ id: string }>(sql`
    insert into components
      (tenant_id, kind, serial_number, make, model, tbo_hours)
    values
      (${args.tenantId}, 'engine', ${args.serial}, 'Lycoming', 'O-360',
       ${args.tboHours ?? 2000})
    returning id
  `);
  return result.rows[0]!.id;
}

describe("B2.1 components schema (PMB-11)", () => {
  it("rejects an unknown component kind", async () => {
    const db = await setupTestDb();
    const tenant = await seedTenant(db, "Tenant A", "N11111");
    await expect(
      db.execute(sql`
        insert into components (tenant_id, kind, serial_number)
        values (${tenant.orgId}, 'wing', 'W-1')
      `),
    ).rejects.toThrow(/check|components_kind/i);
  });

  it("enforces per-(tenant, kind, serial) uniqueness case-insensitively", async () => {
    const db = await setupTestDb();
    const tenant = await seedTenant(db, "Tenant A", "N11111");
    await insertEngine(db, { tenantId: tenant.orgId, serial: "L-12345" });
    await expect(
      insertEngine(db, { tenantId: tenant.orgId, serial: "l-12345" }),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("allows the same serial across different kinds and different tenants", async () => {
    const db = await setupTestDb();
    const a = await seedTenant(db, "Tenant A", "N11111");
    const b = await seedTenant(db, "Tenant B", "N22222");

    await insertEngine(db, { tenantId: a.orgId, serial: "SN-100" });
    // same serial, same tenant, different kind → allowed
    await db.execute(sql`
      insert into components (tenant_id, kind, serial_number)
      values (${a.orgId}, 'propeller', 'SN-100')
    `);
    // same serial, same kind, different tenant → allowed
    await insertEngine(db, { tenantId: b.orgId, serial: "SN-100" });

    const result = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from components where lower(serial_number) = 'sn-100'`,
    );
    expect(Number(result.rows[0]!.count)).toBe(3);
  });

  it("rejects non-positive TBO / cycle values", async () => {
    const db = await setupTestDb();
    const tenant = await seedTenant(db, "Tenant A", "N11111");
    await expect(
      db.execute(sql`
        insert into components (tenant_id, kind, serial_number, tbo_hours)
        values (${tenant.orgId}, 'engine', 'X-1', 0)
      `),
    ).rejects.toThrow(/check|tbo_hours/i);
    await expect(
      db.execute(sql`
        insert into components (tenant_id, kind, serial_number, cycle_limit)
        values (${tenant.orgId}, 'engine', 'X-2', -5)
      `),
    ).rejects.toThrow(/check|cycle_limit/i);
  });

  it("isolates components by tenant under runAsTenant", async () => {
    const db = await setupTestDb();
    const a = await seedTenant(db, "Tenant A", "N11111");
    const b = await seedTenant(db, "Tenant B", "N22222");
    await insertEngine(db, { tenantId: a.orgId, serial: "ENGINE-A" });
    await insertEngine(db, { tenantId: b.orgId, serial: "ENGINE-B" });

    await runAsTenant(db, a.orgId, async (tx) => {
      const rows = await tx.execute<{ serial_number: string }>(
        sql`select serial_number from components`,
      );
      expect(rows.rows.map((r) => r.serial_number)).toEqual(["ENGINE-A"]);
    });
  });
});

describe("B2.1 component_installations schema (PMB-11)", () => {
  it("enforces removed_at / removed_at_tt consistency", async () => {
    const db = await setupTestDb();
    const tenant = await seedTenant(db, "Tenant A", "N11111");
    const engine = await insertEngine(db, {
      tenantId: tenant.orgId,
      serial: "L-1",
    });

    // removed_at set but TT not → should fail
    await expect(
      db.execute(sql`
        insert into component_installations
          (tenant_id, component_id, aircraft_id,
           installed_at, installed_at_aircraft_total_time, removed_at)
        values
          (${tenant.orgId}, ${engine}, ${tenant.aircraftId},
           now() - interval '30 days', 1000.0, now())
      `),
    ).rejects.toThrow(/check|removed_consistency/i);

    // TT set but removed_at not → should fail
    await expect(
      db.execute(sql`
        insert into component_installations
          (tenant_id, component_id, aircraft_id,
           installed_at, installed_at_aircraft_total_time,
           removed_at_aircraft_total_time)
        values
          (${tenant.orgId}, ${engine}, ${tenant.aircraftId},
           now() - interval '30 days', 1000.0, 1100.0)
      `),
    ).rejects.toThrow(/check|removed_consistency/i);
  });

  it("rejects removed_at earlier than installed_at", async () => {
    const db = await setupTestDb();
    const tenant = await seedTenant(db, "Tenant A", "N11111");
    const engine = await insertEngine(db, {
      tenantId: tenant.orgId,
      serial: "L-1",
    });
    await expect(
      db.execute(sql`
        insert into component_installations
          (tenant_id, component_id, aircraft_id,
           installed_at, installed_at_aircraft_total_time,
           removed_at, removed_at_aircraft_total_time)
        values
          (${tenant.orgId}, ${engine}, ${tenant.aircraftId},
           now(), 1000.0,
           now() - interval '1 day', 1100.0)
      `),
    ).rejects.toThrow(/check|removed_after_installed/i);
  });

  it("rejects removed_at_tt less than installed_at_tt", async () => {
    const db = await setupTestDb();
    const tenant = await seedTenant(db, "Tenant A", "N11111");
    const engine = await insertEngine(db, {
      tenantId: tenant.orgId,
      serial: "L-1",
    });
    await expect(
      db.execute(sql`
        insert into component_installations
          (tenant_id, component_id, aircraft_id,
           installed_at, installed_at_aircraft_total_time,
           removed_at, removed_at_aircraft_total_time)
        values
          (${tenant.orgId}, ${engine}, ${tenant.aircraftId},
           now() - interval '30 days', 1500.0,
           now(), 1400.0)
      `),
    ).rejects.toThrow(/check|remove_tt_gte_install/i);
  });

  it("forbids two active installations for the same component (partial unique)", async () => {
    const db = await setupTestDb();
    const a = await seedTenant(db, "Tenant A", "N11111");
    // Second aircraft in the same tenant so the FK + RLS still apply.
    const ac2 = await db.execute<{ id: string }>(sql`
      insert into aircraft
        (tenant_id, regime_id, registration, make, model, serial_number,
         category, aircraft_class, airframe_total_time, time_source)
      values
        (${a.orgId}, ${a.regimeId}, 'N99999', 'Cessna', '152', '15280001',
         'normal', 'single_engine_land', 100.0, 'tach')
      returning id
    `);
    const engine = await insertEngine(db, {
      tenantId: a.orgId,
      serial: "L-1",
    });

    await db.execute(sql`
      insert into component_installations
        (tenant_id, component_id, aircraft_id,
         installed_at, installed_at_aircraft_total_time)
      values
        (${a.orgId}, ${engine}, ${a.aircraftId},
         now() - interval '30 days', 1000.0)
    `);

    await expect(
      db.execute(sql`
        insert into component_installations
          (tenant_id, component_id, aircraft_id,
           installed_at, installed_at_aircraft_total_time)
        values
          (${a.orgId}, ${engine}, ${ac2.rows[0]!.id},
           now(), 50.0)
      `),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("isolates installations by tenant under runAsTenant", async () => {
    const db = await setupTestDb();
    const a = await seedTenant(db, "Tenant A", "N11111");
    const b = await seedTenant(db, "Tenant B", "N22222");
    const engineA = await insertEngine(db, {
      tenantId: a.orgId,
      serial: "ENGINE-A",
    });
    const engineB = await insertEngine(db, {
      tenantId: b.orgId,
      serial: "ENGINE-B",
    });
    await db.execute(sql`
      insert into component_installations
        (tenant_id, component_id, aircraft_id,
         installed_at, installed_at_aircraft_total_time)
      values
        (${a.orgId}, ${engineA}, ${a.aircraftId},
         now() - interval '30 days', 1000.0),
        (${b.orgId}, ${engineB}, ${b.aircraftId},
         now() - interval '30 days', 1500.0)
    `);

    await runAsTenant(db, a.orgId, async (tx) => {
      const result = await tx.execute<{ count: string }>(
        sql`select count(*)::text as count from component_installations`,
      );
      expect(Number(result.rows[0]!.count)).toBe(1);
    });
  });
});
