import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  IMPORT_JOB_ROW_VALIDATION_STATUSES,
  IMPORT_JOB_STATES,
  IMPORT_JOB_TARGET_TABLES,
  setupTestSuite,
  type TestDb,
} from "../src/index.js";
import { TENANT_APP_ROLE } from "../src/test/tenant.js";

/**
 * PMB-157 — V1 importer staging schema.
 *
 * Locks in the C1 acceptance criteria as database properties:
 *   * import_jobs / import_job_rows exist with the documented columns.
 *   * Both tables FORCE ROW LEVEL SECURITY and carry the per-tenant
 *     app_isolation policy (the FORCE-RLS lint also covers this).
 *   * tenant_app has SELECT/INSERT/UPDATE — NO DELETE — on both staging
 *     tables. Append-only is a grant, not a convention.
 *   * source_row_number is 1-indexed via CHECK, UNIQUE per
 *     (import_job_id, source_row_number).
 *   * import_jobs.state CHECK matches the documented state machine.
 *   * import_job_rows.target_table CHECK matches the four V1 live tables.
 *   * The four live tables grew a nullable source_import_row_id column
 *     with ON DELETE SET NULL — interactive rows are unaffected.
 *   * documents.document_type catalog gained `import_source` for the
 *     FAA regime via regime_retention_rules.
 *   * The TypeScript `as const` literals match the SQL CHECK vocabularies
 *     so the application can't drift out of sync with the data layer.
 */

const TENANT_TABLES = ["import_jobs", "import_job_rows"] as const;
const LIVE_TABLES = [
  "aircraft",
  "maintenance_entries",
  "components",
  "flight_time_entries",
] as const;

async function listColumns(db: TestDb, table: string): Promise<string[]> {
  const result = await db.execute<{ column_name: string }>(sql`
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = ${table}
     order by column_name
  `);
  return result.rows.map((r) => r.column_name);
}

async function listGrants(
  db: TestDb,
  grantee: string,
  table: string,
): Promise<string[]> {
  const result = await db.execute<{ privilege_type: string }>(sql`
    select privilege_type
      from information_schema.role_table_grants
     where grantee = ${grantee}
       and table_schema = 'public'
       and table_name = ${table}
  `);
  return result.rows.map((r) => r.privilege_type).sort();
}

describe("PMB-157 importer schema (migration 0028)", () => {
  let db: TestDb;
  let reset: () => Promise<void>;

  beforeAll(async () => {
    ({ db, reset } = await setupTestSuite());
  });

  afterEach(async () => {
    await db.$client.exec(`reset role;`);
    await reset();
  });

  describe("import_jobs", () => {
    it("creates the documented columns", async () => {
      const columns = await listColumns(db, "import_jobs");
      expect(columns).toEqual(
        [
          "aircraft_id",
          "committed_at",
          "committed_by_user_id",
          "created_at",
          "created_by_user_id",
          "error_summary",
          "id",
          "import_kind",
          "mapping_config",
          "regime_id",
          "row_count",
          "source_document_id",
          "source_filename",
          "state",
          "target_table",
          "tenant_id",
          "updated_at",
        ].sort(),
      );
    });

    it("forces row level security on import_jobs", async () => {
      const result = await db.execute<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(sql`
        select relrowsecurity, relforcerowsecurity
          from pg_class where relname = 'import_jobs'
      `);
      expect(result.rows[0]?.relrowsecurity).toBe(true);
      expect(result.rows[0]?.relforcerowsecurity).toBe(true);
    });

    it("rejects state values outside the documented machine", async () => {
      await expect(
        db.execute(sql`
          insert into import_jobs
            (tenant_id, import_kind, source_filename, created_by_user_id, state)
          values
            ('00000000-0000-0000-0000-000000000000',
             'aircraft',
             'test.csv',
             '00000000-0000-0000-0000-000000000000',
             'mystery_state')
        `),
      ).rejects.toThrow(/import_jobs_state_check|violates check/i);
    });

    it("grants SELECT, INSERT, UPDATE — but NEVER DELETE — to tenant_app", async () => {
      const privs = await listGrants(db, TENANT_APP_ROLE, "import_jobs");
      expect(privs).toEqual(["INSERT", "SELECT", "UPDATE"]);
      expect(privs).not.toContain("DELETE");
    });
  });

  describe("import_job_rows", () => {
    it("creates the documented columns", async () => {
      const columns = await listColumns(db, "import_job_rows");
      expect(columns).toEqual(
        [
          "committed_record_id",
          "created_at",
          "id",
          "import_job_id",
          "mapped_payload",
          "source_payload",
          "source_row_number",
          "target_table",
          "tenant_id",
          "updated_at",
          "validation_errors",
          "validation_status",
        ].sort(),
      );
    });

    it("forces row level security on import_job_rows", async () => {
      const result = await db.execute<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(sql`
        select relrowsecurity, relforcerowsecurity
          from pg_class where relname = 'import_job_rows'
      `);
      expect(result.rows[0]?.relrowsecurity).toBe(true);
      expect(result.rows[0]?.relforcerowsecurity).toBe(true);
    });

    it("rejects source_row_number = 0 (1-indexed CHECK)", async () => {
      // Seed a parent job to satisfy the FK; tenant/user FKs trip first
      // if we don't, but the row_number CHECK is what we're after — so
      // we use a minimal fixture that puts the CHECK on the failure path.
      await db.execute(sql`
        insert into organizations (id, name, org_type, default_regime_id)
        select '11111111-1111-1111-1111-111111111111', 'tenantA', 'owner', id
          from regimes where code = 'FAA'
      `);
      await db.execute(sql`
        insert into users (id, email) values
          ('22222222-2222-2222-2222-222222222222', 'u@example.test')
      `);
      const job = await db.execute<{ id: string }>(sql`
        insert into import_jobs
          (tenant_id, import_kind, source_filename, created_by_user_id)
        values
          ('11111111-1111-1111-1111-111111111111',
           'aircraft',
           'test.csv',
           '22222222-2222-2222-2222-222222222222')
        returning id
      `);
      const jobId = job.rows[0]!.id;
      await expect(
        db.execute(sql`
          insert into import_job_rows
            (tenant_id, import_job_id, source_row_number, source_payload)
          values
            ('11111111-1111-1111-1111-111111111111',
             ${jobId},
             0,
             '{}'::jsonb)
        `),
      ).rejects.toThrow(/one_indexed|violates check/i);
    });

    it("enforces unique source_row_number per job", async () => {
      await db.execute(sql`
        insert into organizations (id, name, org_type, default_regime_id)
        select '11111111-1111-1111-1111-111111111111', 'tenantA', 'owner', id
          from regimes where code = 'FAA'
      `);
      await db.execute(sql`
        insert into users (id, email) values
          ('22222222-2222-2222-2222-222222222222', 'u@example.test')
      `);
      const job = await db.execute<{ id: string }>(sql`
        insert into import_jobs
          (tenant_id, import_kind, source_filename, created_by_user_id)
        values
          ('11111111-1111-1111-1111-111111111111',
           'aircraft',
           'test.csv',
           '22222222-2222-2222-2222-222222222222')
        returning id
      `);
      const jobId = job.rows[0]!.id;
      await db.execute(sql`
        insert into import_job_rows
          (tenant_id, import_job_id, source_row_number, source_payload)
        values
          ('11111111-1111-1111-1111-111111111111', ${jobId}, 1, '{}'::jsonb)
      `);
      await expect(
        db.execute(sql`
          insert into import_job_rows
            (tenant_id, import_job_id, source_row_number, source_payload)
          values
            ('11111111-1111-1111-1111-111111111111', ${jobId}, 1, '{}'::jsonb)
        `),
      ).rejects.toThrow(/import_job_rows_job_row_unique|duplicate key/i);
    });

    it("rejects target_table values outside the V1 list", async () => {
      await db.execute(sql`
        insert into organizations (id, name, org_type, default_regime_id)
        select '11111111-1111-1111-1111-111111111111', 'tenantA', 'owner', id
          from regimes where code = 'FAA'
      `);
      await db.execute(sql`
        insert into users (id, email) values
          ('22222222-2222-2222-2222-222222222222', 'u@example.test')
      `);
      const job = await db.execute<{ id: string }>(sql`
        insert into import_jobs
          (tenant_id, import_kind, source_filename, created_by_user_id)
        values
          ('11111111-1111-1111-1111-111111111111',
           'aircraft',
           'test.csv',
           '22222222-2222-2222-2222-222222222222')
        returning id
      `);
      const jobId = job.rows[0]!.id;
      await expect(
        db.execute(sql`
          insert into import_job_rows
            (tenant_id, import_job_id, source_row_number,
             source_payload, target_table)
          values
            ('11111111-1111-1111-1111-111111111111', ${jobId}, 1, '{}'::jsonb, 'squawks')
        `),
      ).rejects.toThrow(/target_table_check|violates check/i);
    });

    it("grants SELECT, INSERT, UPDATE — but NEVER DELETE — to tenant_app", async () => {
      const privs = await listGrants(db, TENANT_APP_ROLE, "import_job_rows");
      expect(privs).toEqual(["INSERT", "SELECT", "UPDATE"]);
      expect(privs).not.toContain("DELETE");
    });
  });

  describe("source_import_row_id traceability column", () => {
    it.each(LIVE_TABLES)(
      "adds a nullable source_import_row_id uuid to %s",
      async (table) => {
        const result = await db.execute<{
          data_type: string;
          is_nullable: string;
        }>(sql`
          select data_type, is_nullable
            from information_schema.columns
           where table_schema = 'public'
             and table_name = ${table}
             and column_name = 'source_import_row_id'
        `);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.data_type).toBe("uuid");
        expect(result.rows[0]?.is_nullable).toBe("YES");
      },
    );

    it.each(LIVE_TABLES)(
      "uses ON DELETE SET NULL on %s.source_import_row_id",
      async (table) => {
        const result = await db.execute<{ delete_rule: string }>(sql`
          select rc.delete_rule
            from information_schema.referential_constraints rc
            join information_schema.key_column_usage kcu
              on kcu.constraint_name = rc.constraint_name
             and kcu.table_schema    = rc.constraint_schema
           where kcu.table_schema = 'public'
             and kcu.table_name   = ${table}
             and kcu.column_name  = 'source_import_row_id'
        `);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.delete_rule).toBe("SET NULL");
      },
    );
  });

  describe("documents.document_type catalog extension", () => {
    it("seeds an import_source retention rule for the FAA regime", async () => {
      const result = await db.execute<{
        retention_period_kind: string;
        retention_period_value: number | null;
      }>(sql`
        select rr.retention_period_kind, rr.retention_period_value
          from regime_retention_rules rr
          join regimes r on r.id = rr.regime_id
         where r.code = 'FAA'
           and rr.record_kind = 'import_source'
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.retention_period_kind).toBe("lifetime");
      expect(result.rows[0]?.retention_period_value).toBeNull();
    });
  });

  describe("application constants mirror the DB CHECK vocabularies", () => {
    it("IMPORT_JOB_STATES matches the SQL CHECK list", () => {
      expect([...IMPORT_JOB_STATES].sort()).toEqual(
        [
          "pending",
          "validating",
          "ready",
          "committing",
          "committed",
          "failed",
          "cancelled",
        ].sort(),
      );
    });

    it("IMPORT_JOB_ROW_VALIDATION_STATUSES matches the SQL CHECK list", () => {
      expect([...IMPORT_JOB_ROW_VALIDATION_STATUSES].sort()).toEqual(
        ["pending", "valid", "invalid", "committed"].sort(),
      );
    });

    it("IMPORT_JOB_TARGET_TABLES matches the SQL CHECK list", () => {
      expect([...IMPORT_JOB_TARGET_TABLES].sort()).toEqual(
        [...LIVE_TABLES].sort(),
      );
    });
  });

  describe("tenant isolation under app_isolation policy", () => {
    it("scopes import_jobs reads to the active tenant", async () => {
      const tenantA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const tenantB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const userId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
      await db.execute(sql`
        insert into organizations (id, name, org_type, default_regime_id)
        select ${tenantA}::uuid, 'tenantA', 'owner', id from regimes where code = 'FAA'
        union all
        select ${tenantB}::uuid, 'tenantB', 'owner', id from regimes where code = 'FAA'
      `);
      await db.execute(sql`
        insert into users (id, email) values (${userId}, 'u@example.test')
      `);
      await db.execute(sql`
        insert into import_jobs
          (tenant_id, import_kind, source_filename, created_by_user_id)
        values
          (${tenantA}, 'aircraft', 'a.csv', ${userId}),
          (${tenantB}, 'aircraft', 'b.csv', ${userId})
      `);
      await db.$client.exec(
        `select set_config('app.current_tenant_id', '${tenantA}', false);`,
      );
      await db.$client.exec(`set role ${TENANT_APP_ROLE};`);
      const visible = await db.execute<{ count: string }>(
        sql`select count(*)::text as count from import_jobs`,
      );
      expect(Number(visible.rows[0]!.count)).toBe(1);
    });
  });

  describe("FORCE-RLS lint coverage (sanity)", () => {
    it.each(TENANT_TABLES)(
      "marks %s as a tenant table the FORCE-RLS lint will see",
      async (table) => {
        const result = await db.execute<{
          has_tenant_id: boolean;
          has_policy: boolean;
        }>(sql`
          select
            exists (
              select 1 from information_schema.columns
              where table_schema='public' and table_name=${table}
                and column_name='tenant_id'
            ) as has_tenant_id,
            exists (
              select 1 from pg_policy p
              join pg_class c on c.oid = p.polrelid
              where c.relname = ${table} and p.polname = 'app_isolation'
            ) as has_policy
        `);
        expect(result.rows[0]?.has_tenant_id).toBe(true);
        expect(result.rows[0]?.has_policy).toBe(true);
      },
    );
  });
});
