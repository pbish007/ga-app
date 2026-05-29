import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { setupTestSuite, type TestDb } from "@ga/db";

import { TENANT_APP_ROLE, TENANT_CONTEXT_GUC } from "../src/test/tenant.js";

/**
 * PMB-74 — fail-closed at the *privilege* layer, not just the row layer.
 *
 * Today the runtime connects as the schema-owner role. Tenant isolation then
 * rests entirely on FORCE ROW LEVEL SECURITY: a request that forgets to
 * `SET ROLE tenant_app` + set the tenant GUC still runs as the owner, and
 * FORCE makes the owner's unset-GUC query return zero rows. That is a *silent*
 * fail-closed — correct only as long as FORCE is on every tenant table forever
 * and the owner never gains BYPASSRLS.
 *
 * The fix is to connect as a dedicated, non-owner login role that:
 *   - is NOSUPERUSER NOBYPASSRLS,
 *   - is a *member* of `tenant_app` so it can `SET ROLE tenant_app`,
 *   - but is **NOINHERIT**, so it does NOT automatically gain tenant_app's
 *     table privileges — it must explicitly switch roles to use them, and
 *   - holds no direct privilege on any tenant table.
 *
 * With that role a missed `SET ROLE` fails *loudly* — `permission denied for
 * table …` — instead of silently returning zero rows. NOINHERIT is the load-
 * bearing attribute: a plain (inheriting) member would silently pick up
 * tenant_app's grants and fall back to the FORCE-RLS behavior we're trying to
 * stop depending on.
 *
 * This suite proves the property against the REAL `tenant_runtime` role that
 * migration 0018 provisions, and a tenant table mirroring the production shape
 * (FORCE RLS + `app_isolation` policy + tenant_app grant).
 */

const RUNTIME_ROLE = "tenant_runtime";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";

async function createTenantTable(db: TestDb): Promise<void> {
  // Same posture as every real tenant table (migrations 0002–0015): RLS
  // enabled AND forced, an app_isolation policy keyed on the tenant GUC with
  // missing_ok=true (fail closed), and SELECT/DML granted to tenant_app only.
  await db.$client.exec(`
    create table runtime_role_widgets (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null,
      label text not null
    );
    alter table runtime_role_widgets enable row level security;
    alter table runtime_role_widgets force row level security;
    create policy app_isolation on runtime_role_widgets
      using (tenant_id::text = current_setting('${TENANT_CONTEXT_GUC}', true))
      with check (tenant_id::text = current_setting('${TENANT_CONTEXT_GUC}', true));
    grant select, insert, update, delete on runtime_role_widgets to ${TENANT_APP_ROLE};

    insert into runtime_role_widgets (tenant_id, label) values
      ('${TENANT_A}', 'a-1'),
      ('${TENANT_A}', 'a-2'),
      ('${TENANT_B}', 'b-1');
  `);
}

describe("PMB-74 runtime role fails closed at the privilege layer", () => {
  let db: TestDb;

  beforeAll(async () => {
    // `tenant_runtime` is created by migration 0018 (replayed by setupTestSuite),
    // so this suite verifies the ACTUAL provisioned role, not a synthetic stand-in.
    ({ db } = await setupTestSuite());
    await createTenantTable(db);
  });

  afterEach(async () => {
    // Drop back to the bootstrap role between tests; the seeded table and the
    // runtime role persist for the suite (reads here don't mutate rows).
    await db.$client.exec(`reset role;`);
  });

  it("is configured as a non-owner, NOINHERIT member of tenant_app", async () => {
    const role = await db.$client.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolinherit: boolean;
      rolcanlogin: boolean;
    }>(
      `select rolsuper, rolbypassrls, rolinherit, rolcanlogin
         from pg_roles where rolname = $1`,
      [RUNTIME_ROLE],
    );
    expect(role.rows[0]).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolinherit: false,
      rolcanlogin: true,
    });

    const member = await db.$client.query<{ ok: boolean }>(
      `select exists (
         select 1
         from pg_auth_members m
         join pg_roles parent on parent.oid = m.roleid
         join pg_roles child on child.oid = m.member
         where parent.rolname = $1 and child.rolname = $2
       ) as ok`,
      [TENANT_APP_ROLE, RUNTIME_ROLE],
    );
    expect(member.rows[0]?.ok).toBe(true);
  });

  it("DENIES a direct tenant-table read when the role switch is skipped", async () => {
    await db.$client.exec(`set role ${RUNTIME_ROLE};`);
    // Table-level denial (not schema) — the role has schema USAGE but no table
    // privilege, and NOINHERIT keeps tenant_app's grant from leaking in.
    await expect(
      db.$client.query(`select label from runtime_role_widgets`),
    ).rejects.toThrow(/permission denied for table/i);
  });

  it("DENIES a direct tenant-table write when the role switch is skipped", async () => {
    await db.$client.exec(`set role ${RUNTIME_ROLE};`);
    await expect(
      db.$client.query(
        `insert into runtime_role_widgets (tenant_id, label) values ('${TENANT_A}', 'x')`,
      ),
    ).rejects.toThrow(/permission denied for table/i);
  });

  it("ALLOWS scoped reads via SET ROLE tenant_app + tenant GUC (the real path)", async () => {
    // Mirror runAsTenant: from the runtime role, switch into tenant_app and pin
    // the tenant GUC, all LOCAL to one transaction.
    await db.$client.exec(`
      begin;
      set local role ${RUNTIME_ROLE};
      set local role ${TENANT_APP_ROLE};
      select set_config('${TENANT_CONTEXT_GUC}', '${TENANT_A}', true);
    `);
    const scoped = await db.$client.query<{ label: string }>(
      `select label from runtime_role_widgets order by label`,
    );
    await db.$client.exec(`commit;`);
    expect(scoped.rows.map((r) => r.label)).toEqual(["a-1", "a-2"]);
  });

  it("CONTRAST: the privileged (owner-class) connection reads directly with no permission error", async () => {
    // The bootstrap connection stands in for today's schema-owner runtime.
    // Note it returns rows here only because pglite's bootstrap role is a
    // superuser (bypasses RLS). In prod the non-owner owner would instead get
    // *zero* rows via FORCE — but, crucially, still NOT a permission error.
    // Either way the current config never fails loudly on a missed role switch;
    // that loud failure is exactly what the dedicated runtime role above adds.
    const direct = await db.$client.query(`select label from runtime_role_widgets`);
    expect(direct.rows.length).toBeGreaterThan(0);
  });
});
