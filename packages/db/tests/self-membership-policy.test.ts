import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

import {
  TENANT_APP_ROLE,
  TENANT_CONTEXT_GUC,
} from "../src/test/tenant.js";

/**
 * PMB-74 — `app_self_membership` policy on `organization_memberships`
 * (migration 0019). The policy is what makes the cross-tenant identity-path
 * reads (`listUserOrganizations`) and the signup self-insert into
 * `organization_memberships` keep working after `DATABASE_URL` is repointed
 * away from a `BYPASSRLS` role and onto `tenant_runtime`.
 *
 * Properties verified:
 *   * No-GUC reads as `tenant_app` still return zero rows (no regression in
 *     the existing fail-closed posture).
 *   * Reads as `tenant_app` with only `app.current_user_id` set return ONLY
 *     that user's own memberships, across all tenants — i.e. the
 *     `listUserOrganizations` shape.
 *   * INSERT as `tenant_app` with `app.current_user_id = X` passes
 *     `WITH CHECK` only when `user_id = X` — the signup self-insert path,
 *     and a write attempting another user's id is rejected.
 *   * The existing `app_isolation` tenant-scoped read continues to work
 *     unchanged. Permissive policies are OR'd, so a session with both GUCs
 *     set sees the union (used to assert no surprising restriction).
 */

const USER_ALICE = "11111111-1111-1111-1111-111111111111";
const USER_BOB = "22222222-2222-2222-2222-222222222222";
const USER_CHARLIE = "33333333-3333-3333-3333-333333333333";
const USER_NEW = "44444444-4444-4444-4444-444444444444";

type Seed = {
  orgA: string;
  orgB: string;
  orgC: string;
};

async function seed(db: TestDb): Promise<Seed> {
  const regime = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA'`,
  );
  const regimeId = regime.rows[0]!.id;

  const orgs = await db.execute<{ id: string; name: string }>(sql`
    insert into organizations (name, org_type, default_regime_id) values
      ('Org A', 'school', ${regimeId}),
      ('Org B', 'shop',   ${regimeId}),
      ('Org C', 'club',   ${regimeId})
    returning id, name
  `);
  const orgA = orgs.rows.find((r) => r.name === "Org A")!.id;
  const orgB = orgs.rows.find((r) => r.name === "Org B")!.id;
  const orgC = orgs.rows.find((r) => r.name === "Org C")!.id;

  await db.execute(sql`
    insert into users (id, email) values
      (${USER_ALICE},   'alice@example.test'),
      (${USER_BOB},     'bob@example.test'),
      (${USER_CHARLIE}, 'charlie@example.test')
  `);
  // Alice is in both A and B (cross-tenant case). Bob is only in A. Charlie
  // is only in C. Used to verify the user-GUC filter and the tenant-GUC
  // filter scope independently.
  await db.execute(sql`
    insert into organization_memberships (tenant_id, user_id, role) values
      (${orgA}, ${USER_ALICE},   'admin'),
      (${orgB}, ${USER_ALICE},   'mechanic'),
      (${orgA}, ${USER_BOB},     'pilot'),
      (${orgC}, ${USER_CHARLIE}, 'admin')
  `);
  return { orgA, orgB, orgC };
}

const USER_GUC = "app.current_user_id";

async function withUserContext<T>(
  db: TestDb,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await db.$client.exec(`set role ${TENANT_APP_ROLE};`);
  await db.execute(sql`select set_config(${USER_GUC}, ${userId}, false)`);
  try {
    return await fn();
  } finally {
    await db.$client.exec(`reset role;`);
    await db.execute(sql.raw(`reset ${USER_GUC}`));
  }
}

async function rowsAsTenantApp(
  db: TestDb,
): Promise<Array<{ tenant_id: string; user_id: string; role: string }>> {
  const result = await db.execute<{
    tenant_id: string;
    user_id: string;
    role: string;
  }>(sql`select tenant_id, user_id, role from organization_memberships order by user_id, tenant_id`);
  return result.rows;
}

describe("PMB-74 app_self_membership policy (migration 0019)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  let s: Seed;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });

  afterEach(async () => {
    // setupTestSuite.reset() does `reset role` + clears the tenant GUC; clear
    // the new user GUC too so cross-test leakage is impossible.
    await db.$client.exec(`reset role;`);
    await db.execute(sql.raw(`reset ${USER_GUC}`));
    await reset();
  });

  it("returns zero rows as tenant_app with no GUC set (existing fail-closed)", async () => {
    s = await seed(db);
    await db.$client.exec(`set role ${TENANT_APP_ROLE};`);
    expect(await rowsAsTenantApp(db)).toEqual([]);
  });

  it("returns ONLY the user's own memberships across tenants when app.current_user_id is set", async () => {
    s = await seed(db);
    await withUserContext(db, USER_ALICE, async () => {
      const rows = await rowsAsTenantApp(db);
      // Alice has rows in A and B (sorted by tenant_id deterministically).
      expect(rows.map((r) => ({ user_id: r.user_id, role: r.role }))).toEqual([
        { user_id: USER_ALICE, role: expect.any(String) },
        { user_id: USER_ALICE, role: expect.any(String) },
      ]);
      // Both rows belong to Alice; neither leaks Bob/Charlie.
      const tenants = new Set(rows.map((r) => r.tenant_id));
      expect(tenants.has(s.orgA)).toBe(true);
      expect(tenants.has(s.orgB)).toBe(true);
      expect(tenants.has(s.orgC)).toBe(false);
    });

    await withUserContext(db, USER_BOB, async () => {
      const rows = await rowsAsTenantApp(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(USER_BOB);
      expect(rows[0]?.tenant_id).toBe(s.orgA);
    });
  });

  it("does not leak across users when the user GUC is set", async () => {
    s = await seed(db);
    await withUserContext(db, USER_NEW, async () => {
      // USER_NEW has no membership rows — must see zero, not Alice/Bob/Charlie.
      expect(await rowsAsTenantApp(db)).toEqual([]);
    });
  });

  it("permits self-insert under app.current_user_id (signup self-membership)", async () => {
    s = await seed(db);
    // Create a brand-new user + org to mirror the signup INSERT shape.
    const regime = await db.execute<{ id: string }>(
      sql`select id from regimes where code = 'FAA'`,
    );
    const regimeId = regime.rows[0]!.id;
    await db.execute(sql`
      insert into users (id, email) values (${USER_NEW}, 'new@example.test')
    `);
    const orgRow = await db.execute<{ id: string }>(sql`
      insert into organizations (name, org_type, default_regime_id)
      values ('Signup Org', 'owner', ${regimeId})
      returning id
    `);
    const newOrgId = orgRow.rows[0]!.id;

    await withUserContext(db, USER_NEW, async () => {
      // user_id = USER_NEW matches the GUC → WITH CHECK passes via
      // app_self_membership even though no app.current_tenant_id is set.
      await db.execute(sql`
        insert into organization_memberships (tenant_id, user_id, role)
        values (${newOrgId}, ${USER_NEW}, 'admin')
      `);
      const rows = await rowsAsTenantApp(db);
      expect(rows.some((r) => r.user_id === USER_NEW && r.tenant_id === newOrgId)).toBe(true);
    });
  });

  it("REJECTS an insert that claims another user's id when only app.current_user_id is set", async () => {
    s = await seed(db);
    const regime = await db.execute<{ id: string }>(
      sql`select id from regimes where code = 'FAA'`,
    );
    const regimeId = regime.rows[0]!.id;
    await db.execute(sql`
      insert into users (id, email) values (${USER_NEW}, 'new@example.test')
    `);
    const orgRow = await db.execute<{ id: string }>(sql`
      insert into organizations (name, org_type, default_regime_id)
      values ('Signup Org', 'owner', ${regimeId})
      returning id
    `);
    const newOrgId = orgRow.rows[0]!.id;

    await withUserContext(db, USER_NEW, async () => {
      // user_id = ALICE does NOT match the GUC, no tenant GUC set →
      // neither app_self_membership nor app_isolation's WITH CHECK passes.
      await expect(
        db.execute(sql`
          insert into organization_memberships (tenant_id, user_id, role)
          values (${newOrgId}, ${USER_ALICE}, 'admin')
        `),
      ).rejects.toThrow(/row.*violates.*policy|new row violates row-level security/i);
    });
  });

  it("does NOT regress the tenant-scoped read path (app_isolation still works)", async () => {
    s = await seed(db);
    await db.$client.exec(`set role ${TENANT_APP_ROLE};`);
    await db.execute(
      sql`select set_config(${TENANT_CONTEXT_GUC}, ${s.orgA}, false)`,
    );
    try {
      const rows = await rowsAsTenantApp(db);
      // Org A has Alice + Bob.
      expect(new Set(rows.map((r) => r.user_id))).toEqual(
        new Set([USER_ALICE, USER_BOB]),
      );
      expect(rows.every((r) => r.tenant_id === s.orgA)).toBe(true);
    } finally {
      await db.execute(sql.raw(`reset ${TENANT_CONTEXT_GUC}`));
    }
  });

  it("permissive OR: both GUCs set → tenant-scoped rows ∪ user's cross-tenant rows", async () => {
    s = await seed(db);
    await db.$client.exec(`set role ${TENANT_APP_ROLE};`);
    await db.execute(
      sql`select set_config(${TENANT_CONTEXT_GUC}, ${s.orgC}, false)`,
    );
    await db.execute(sql`select set_config(${USER_GUC}, ${USER_ALICE}, false)`);
    try {
      const rows = await rowsAsTenantApp(db);
      // Org C's Charlie + Alice's two memberships (A, B). Total 3 distinct rows.
      const users = rows.map((r) => r.user_id);
      expect(users.filter((u) => u === USER_ALICE)).toHaveLength(2);
      expect(users.filter((u) => u === USER_CHARLIE)).toHaveLength(1);
      expect(users.includes(USER_BOB)).toBe(false);
    } finally {
      await db.execute(sql.raw(`reset ${TENANT_CONTEXT_GUC}`));
      await db.execute(sql.raw(`reset ${USER_GUC}`));
    }
  });
});
