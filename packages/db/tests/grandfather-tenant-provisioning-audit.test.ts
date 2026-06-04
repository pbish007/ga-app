import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

/**
 * PMB-119 (V1 Managed onboarding S5) — grandfather backfill.
 *
 * Migration 0025 inserts a synthetic `tenant_provisioning_audit` row for
 * every tenant that already exists when it runs. The shape of each row is
 * exact (the C3 audit listing reads it back as-is) and the operation MUST
 * be idempotent (the migration runner replays on a partial failure, and
 * an operator may re-run the migration package after manual fixes).
 *
 * The test suite spins up a clean migrated database, seeds organizations
 * that did NOT exist when 0025 first applied (so the table starts empty
 * for those rows), then re-executes the migration SQL — exercising the
 * exact backfill statement the migration runner would issue.
 */

const here = dirname(fileURLToPath(import.meta.url));
const grandfatherMigrationPath = resolve(
  here,
  "..",
  "migrations",
  "0025_grandfather_tenant_provisioning_audit.sql",
);
const grandfatherMigrationSql = readFileSync(grandfatherMigrationPath, "utf8");

interface SeededOrg {
  id: string;
  name: string;
  orgType: "school" | "club" | "shop" | "owner";
  createdAt: string;
}

async function getFaaRegimeId(db: TestDb): Promise<string> {
  const rows = await db.execute<{ id: string }>(
    sql`select id from regimes where code = 'FAA' limit 1`,
  );
  expect(rows.rows[0]).toBeDefined();
  return rows.rows[0]!.id;
}

async function seedOrganization(
  db: TestDb,
  args: {
    name: string;
    orgType: SeededOrg["orgType"];
    regimeId: string;
    createdAt: string;
  },
): Promise<SeededOrg> {
  const rows = await db.execute<{ id: string; created_at: string }>(sql`
    insert into organizations (name, org_type, default_regime_id, created_at, updated_at)
    values (${args.name}, ${args.orgType}, ${args.regimeId}, ${args.createdAt}, ${args.createdAt})
    returning id, created_at
  `);
  const row = rows.rows[0]!;
  return {
    id: row.id,
    name: args.name,
    orgType: args.orgType,
    createdAt: row.created_at,
  };
}

async function deleteAuditRows(db: TestDb): Promise<void> {
  // The migration ran during setup against an empty `organizations` table,
  // so this is normally a no-op. The reset between tests also truncates
  // tenant_provisioning_audit, but we call this defensively before the
  // seed-then-replay drill so each test starts from a known-empty state.
  await db.execute(sql`delete from tenant_provisioning_audit`);
}

async function applyGrandfatherMigration(db: TestDb): Promise<void> {
  await db.$client.exec(grandfatherMigrationSql);
}

describe("PMB-119 migration 0025 — grandfather tenant_provisioning_audit", () => {
  let db: TestDb;
  let reset: () => Promise<void>;
  let regimeId: string;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
    regimeId = await getFaaRegimeId(db);
  });

  afterEach(async () => {
    await reset();
  });

  it("inserts one audit row per existing organization with the contracted shape", async () => {
    const demo = await seedOrganization(db, {
      name: "Demo Flight School",
      orgType: "school",
      regimeId,
      createdAt: "2026-01-15T10:00:00Z",
    });
    const club = await seedOrganization(db, {
      name: "Pre-C2 Owners Club",
      orgType: "club",
      regimeId,
      createdAt: "2026-02-20T15:30:00Z",
    });

    await deleteAuditRows(db);
    await applyGrandfatherMigration(db);

    const rows = await db.execute<{
      created_tenant_id: string;
      idempotency_key: string;
      actor_user_id: string | null;
      actor_kind: string;
      input_snapshot: unknown;
      result_status: string;
      result_snapshot: unknown;
      error: unknown;
      created_at: string;
      completed_at: string | null;
    }>(sql`
      select
        created_tenant_id,
        idempotency_key,
        actor_user_id,
        actor_kind,
        input_snapshot,
        result_status,
        result_snapshot,
        error,
        created_at,
        completed_at
      from tenant_provisioning_audit
      order by created_at asc
    `);

    expect(rows.rows).toHaveLength(2);

    const demoRow = rows.rows[0]!;
    expect(demoRow.created_tenant_id).toBe(demo.id);
    expect(demoRow.idempotency_key).toBe(`grandfather:${demo.id}`);
    expect(demoRow.actor_user_id).toBeNull();
    expect(demoRow.actor_kind).toBe("grandfathered");
    expect(demoRow.result_status).toBe("done");
    expect(demoRow.error).toBeNull();
    expect(demoRow.input_snapshot).toEqual({
      source: "grandfather",
      orgName: "Demo Flight School",
      orgType: "school",
      regimeId,
    });
    expect(demoRow.result_snapshot).toEqual({ tenantId: demo.id });
    expect(new Date(demoRow.created_at).toISOString()).toBe(
      new Date(demo.createdAt).toISOString(),
    );
    expect(new Date(demoRow.completed_at!).toISOString()).toBe(
      new Date(demo.createdAt).toISOString(),
    );

    const clubRow = rows.rows[1]!;
    expect(clubRow.created_tenant_id).toBe(club.id);
    expect(clubRow.idempotency_key).toBe(`grandfather:${club.id}`);
    expect(clubRow.actor_kind).toBe("grandfathered");
    expect(clubRow.input_snapshot).toEqual({
      source: "grandfather",
      orgName: "Pre-C2 Owners Club",
      orgType: "club",
      regimeId,
    });
  });

  it("row count equals SELECT count(*) FROM organizations", async () => {
    await seedOrganization(db, {
      name: "A",
      orgType: "school",
      regimeId,
      createdAt: "2026-03-01T00:00:00Z",
    });
    await seedOrganization(db, {
      name: "B",
      orgType: "shop",
      regimeId,
      createdAt: "2026-03-02T00:00:00Z",
    });
    await seedOrganization(db, {
      name: "C",
      orgType: "owner",
      regimeId,
      createdAt: "2026-03-03T00:00:00Z",
    });

    await deleteAuditRows(db);
    await applyGrandfatherMigration(db);

    const orgCount = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from organizations`,
    );
    const auditCount = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from tenant_provisioning_audit where actor_kind = 'grandfathered'`,
    );
    expect(auditCount.rows[0]!.n).toBe(orgCount.rows[0]!.n);
    expect(auditCount.rows[0]!.n).toBe("3");
  });

  it("re-running the migration is a no-op (idempotency drill)", async () => {
    const org = await seedOrganization(db, {
      name: "Idempotent Co.",
      orgType: "school",
      regimeId,
      createdAt: "2026-01-15T10:00:00Z",
    });

    await deleteAuditRows(db);
    await applyGrandfatherMigration(db);
    await applyGrandfatherMigration(db);
    await applyGrandfatherMigration(db);

    const rows = await db.execute<{ id: string; idempotency_key: string }>(sql`
      select id, idempotency_key
        from tenant_provisioning_audit
       where actor_kind = 'grandfathered'
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.idempotency_key).toBe(`grandfather:${org.id}`);
  });

  it("leaves non-grandfather audit rows untouched", async () => {
    const org = await seedOrganization(db, {
      name: "Already Audited",
      orgType: "school",
      regimeId,
      createdAt: "2026-01-15T10:00:00Z",
    });

    await deleteAuditRows(db);

    // Simulate a pre-existing audit row from a real provisionTenant call —
    // it has no `grandfather:` key, so the grandfather migration must
    // insert a SECOND audit row beside it (the partial-unique index keys
    // by `idempotency_key`, and these two keys are disjoint).
    await db.execute(sql`
      insert into tenant_provisioning_audit
        (created_tenant_id, idempotency_key, actor_user_id, actor_kind,
         input_snapshot, result_status, result_snapshot, created_at, completed_at)
      values
        (${org.id}, NULL, NULL, 'self-service',
         ${JSON.stringify({ orgName: "Already Audited" })}::jsonb,
         'done',
         ${JSON.stringify({ tenantId: org.id })}::jsonb,
         '2026-01-15T10:05:00Z'::timestamptz,
         '2026-01-15T10:05:00Z'::timestamptz)
    `);

    await applyGrandfatherMigration(db);

    const rows = await db.execute<{ actor_kind: string }>(sql`
      select actor_kind
        from tenant_provisioning_audit
       where created_tenant_id = ${org.id}
       order by actor_kind asc
    `);
    expect(rows.rows.map((r) => r.actor_kind)).toEqual([
      "grandfathered",
      "self-service",
    ]);
  });

  it("no organizations → no rows inserted (empty-environment safety)", async () => {
    await deleteAuditRows(db);
    await applyGrandfatherMigration(db);

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from tenant_provisioning_audit`,
    );
    expect(rows.rows[0]!.n).toBe("0");
  });
});
