import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

import {
  TENANT_CONTEXT_GUC,
  clearTenantContext,
  setTenantContext,
  withTenantContext,
} from "../src/test/tenant.js";

const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";

/**
 * Install a sample tenant-scoped table with Row Level Security so the
 * isolation pattern can be exercised without depending on Epic A's
 * tenants/users schema (which lands in PMB-10).
 *
 * Two things matter for parity with the real tables Epic A will add:
 *   1. `ALTER TABLE ... FORCE ROW LEVEL SECURITY` — without FORCE, the
 *      table owner (and pglite runs everything as superuser) bypasses
 *      the policy. We want failures to surface in tests, not in prod.
 *   2. `current_setting(..., true)` — the `true` makes a missing GUC
 *      return NULL, so an unset context never matches a tenant_id and
 *      the policy fails closed.
 *
 * The DDL runs once per suite ({@link createWidgetsTable} in `beforeAll`);
 * `resetTestDb` truncates the rows between tests, so each test re-seeds via
 * {@link seedWidgets}. The fixture table is not a migration catalog table, so
 * `reset` discovers and truncates it like any other data table.
 */
async function createWidgetsTable(db: TestDb) {
  await db.$client.exec(`
    create table tenant_widgets (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null,
      label text not null
    );
    alter table tenant_widgets enable row level security;
    alter table tenant_widgets force row level security;
    create policy tenant_widgets_isolation on tenant_widgets
      using (tenant_id::text = current_setting('${TENANT_CONTEXT_GUC}', true))
      with check (tenant_id::text = current_setting('${TENANT_CONTEXT_GUC}', true));
    grant select, insert, update, delete on tenant_widgets to tenant_app;
  `);
}

/**
 * Seed the widget rows and switch the session to the non-superuser
 * `tenant_app` role so the RLS policy is actually exercised — pglite runs
 * the connection as a superuser by default, which bypasses RLS. `reset`
 * (afterEach) drops the role back and truncates these rows.
 */
async function seedWidgets(db: TestDb) {
  await db.$client.exec(`
    insert into tenant_widgets (tenant_id, label) values
      ('${TENANT_A}', 'a-1'),
      ('${TENANT_A}', 'a-2'),
      ('${TENANT_B}', 'b-1');
    set role tenant_app;
  `);
}

async function selectLabels(
  db: TestDb,
  whereClause = "",
): Promise<string[]> {
  const result = await db.execute<{ label: string }>(
    sql.raw(`select label from tenant_widgets ${whereClause} order by label`),
  );
  return result.rows.map((r) => r.label);
}

describe("J3.2 tenant-isolation harness (PMB-9)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
    await createWidgetsTable(db);
  });

  afterEach(async () => {
    await reset();
  });

  it("scopes reads to the active tenant when context is set", async () => {
    await seedWidgets(db);

    const seenByA = await withTenantContext(db, TENANT_A, () =>
      selectLabels(db),
    );
    expect(seenByA).toEqual(["a-1", "a-2"]);

    const seenByB = await withTenantContext(db, TENANT_B, () =>
      selectLabels(db),
    );
    expect(seenByB).toEqual(["b-1"]);
  });

  it("returns zero rows when no tenant context is set (fail closed)", async () => {
    await seedWidgets(db);
    await clearTenantContext(db);

    expect(await selectLabels(db)).toEqual([]);
  });

  it("blocks cross-tenant reads even with explicit tenant_id predicates", async () => {
    await seedWidgets(db);

    await withTenantContext(db, TENANT_A, async () => {
      expect(
        await selectLabels(db, `where tenant_id = '${TENANT_B}'`),
      ).toEqual([]);
      expect(await selectLabels(db, "where true")).toEqual(["a-1", "a-2"]);
    });
  });

  it("blocks cross-tenant writes (insert/update/delete bound by USING)", async () => {
    await seedWidgets(db);

    await withTenantContext(db, TENANT_A, async () => {
      const updated = await db.execute<{ id: string }>(
        sql.raw(`
          update tenant_widgets
             set label = 'tampered'
           where tenant_id = '${TENANT_B}'
        returning id
        `),
      );
      expect(updated.rows).toEqual([]);

      const deleted = await db.execute<{ id: string }>(
        sql.raw(`
          delete from tenant_widgets
           where tenant_id = '${TENANT_B}'
        returning id
        `),
      );
      expect(deleted.rows).toEqual([]);
    });

    await withTenantContext(db, TENANT_B, async () => {
      expect(await selectLabels(db)).toEqual(["b-1"]);
    });
  });

  it("set/clear is observable through current_setting()", async () => {
    await setTenantContext(db, TENANT_A);
    const set = await db.execute<{ tenant: string | null }>(
      sql`select current_setting(${TENANT_CONTEXT_GUC}, true) as tenant`,
    );
    expect(set.rows[0]?.tenant).toBe(TENANT_A);

    await clearTenantContext(db);
    const cleared = await db.execute<{ tenant: string | null }>(
      sql`select current_setting(${TENANT_CONTEXT_GUC}, true) as tenant`,
    );
    expect(cleared.rows[0]?.tenant ?? "").toBe("");
  });

  it("restores context on thrown errors inside withTenantContext", async () => {
    await seedWidgets(db);

    await expect(
      withTenantContext(db, TENANT_A, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const after = await db.execute<{ tenant: string | null }>(
      sql`select current_setting(${TENANT_CONTEXT_GUC}, true) as tenant`,
    );
    expect(after.rows[0]?.tenant ?? "").toBe("");
  });
});
