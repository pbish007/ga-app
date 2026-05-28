import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "../src/index.js";
import { TENANT_APP_ROLE, TENANT_CONTEXT_GUC } from "../src/test/tenant.js";

/**
 * Contract test for the PMB-66 shared-instance helper. `reset()` must:
 *   * truncate every data table (including ad-hoc fixture tables a test made),
 *   * preserve the migration-seeded catalog (regimes, credential types, RBAC),
 *   * drop a leaked session role + tenant GUC so it can truncate as owner and
 *     hand the next test a clean session.
 */
describe("setupTestSuite / reset (PMB-66)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });

  async function count(table: string): Promise<number> {
    const r = await db.execute<{ n: string }>(
      sql.raw(`select count(*)::text as n from ${table}`),
    );
    return Number(r.rows[0]!.n);
  }

  it("truncates data, keeps catalog, clears role+GUC, and re-seeds cleanly", async () => {
    const regimesBefore = await count("regimes");
    const credTypesBefore = await count("regime_credential_types");
    const rolesBefore = await count("app_roles");
    expect(regimesBefore).toBeGreaterThan(0);
    expect(credTypesBefore).toBeGreaterThan(0);
    expect(rolesBefore).toBeGreaterThan(0);

    const faa = await db.execute<{ id: string }>(
      sql`select id from regimes where code = 'FAA'`,
    );
    const regimeId = faa.rows[0]!.id;
    await db.execute(sql`
      insert into organizations (name, org_type, default_regime_id)
      values ('Acme', 'club', ${regimeId})
    `);
    // An ad-hoc fixture table + a leaked tenant_app role and tenant GUC: the
    // exact session state a tenant-isolation test can leave behind.
    await db.$client.exec(`
      create table ad_hoc_fixture (id int primary key);
      insert into ad_hoc_fixture (id) values (1);
      set role ${TENANT_APP_ROLE};
      select set_config('${TENANT_CONTEXT_GUC}', '00000000-0000-0000-0000-000000000001', false);
    `);

    await reset();

    expect(await count("organizations")).toBe(0);
    expect(await count("ad_hoc_fixture")).toBe(0);
    expect(await count("regimes")).toBe(regimesBefore);
    expect(await count("regime_credential_types")).toBe(credTypesBefore);
    expect(await count("app_roles")).toBe(rolesBefore);

    const ctx = await db.execute<{ role: string; tenant: string | null }>(
      sql`select current_user as role,
                 current_setting(${TENANT_CONTEXT_GUC}, true) as tenant`,
    );
    expect(ctx.rows[0]!.role).not.toBe(TENANT_APP_ROLE);
    expect(ctx.rows[0]!.tenant ?? "").toBe("");

    // Re-seeding works: catalog FKs still resolve and no leftover rows collide.
    await db.execute(sql`
      insert into organizations (name, org_type, default_regime_id)
      values ('Beta', 'shop', ${regimeId})
    `);
    expect(await count("organizations")).toBe(1);
  });
});
