import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { setupTestSuite, type TestDb } from "@ga/db";

/**
 * PMB-74 invariant #2 — defense-in-depth lint.
 *
 * Tenant isolation rests on every tenant table being created with BOTH
 * `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. `ENABLE` alone
 * exempts the table OWNER from its own policies; only `FORCE` binds the owner.
 * Until the runtime stops connecting as the schema owner (PMB-74's role
 * repoint), a single new tenant table that ships `ENABLE`-without-`FORCE`
 * silently downgrades to owner-bypass — a one-line omission with nothing to
 * catch it. This test is that catch: it asserts, against the fully migrated
 * schema, that the FORCE discipline holds for every current and future table.
 *
 * It runs over the real migrated catalog (not a fixture) so a future migration
 * that forgets FORCE — or enables RLS on a tenant table without forcing it —
 * fails here, in CI, before it reaches prod.
 */

// Type alias (not interface) so it satisfies drizzle's `execute<T extends
// Record<string, unknown>>` index-signature constraint.
type TableRlsRow = {
  relname: string;
  /** relrowsecurity — RLS enabled on the table. */
  enabled: boolean;
  /** relforcerowsecurity — RLS also applies to the table owner. */
  forced: boolean;
  /** Table carries a tenant_id column (the tenant-scoping marker). */
  has_tenant_id: boolean;
  /** Table has the conventional per-tenant `app_isolation` policy. */
  has_isolation_policy: boolean;
};

async function loadTableRls(db: TestDb): Promise<TableRlsRow[]> {
  const result = await db.execute<TableRlsRow>(sql`
    select
      c.relname,
      c.relrowsecurity                                   as enabled,
      c.relforcerowsecurity                              as forced,
      exists (
        select 1 from information_schema.columns col
        where col.table_schema = 'public'
          and col.table_name = c.relname
          and col.column_name = 'tenant_id'
      )                                                  as has_tenant_id,
      exists (
        select 1 from pg_catalog.pg_policy p
        where p.polrelid = c.oid and p.polname = 'app_isolation'
      )                                                  as has_isolation_policy
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
    order by c.relname
  `);
  return result.rows;
}

describe("PMB-74 FORCE ROW LEVEL SECURITY lint", () => {
  let db: TestDb;
  let tables: TableRlsRow[];

  beforeAll(async () => {
    ({ db } = await setupTestSuite());
    tables = await loadTableRls(db);
  });

  it("finds the migrated tenant tables (sanity guard against an empty query)", () => {
    const tenant = tables.filter((t) => t.has_tenant_id || t.has_isolation_policy);
    // If this ever hits zero the lint below would vacuously pass — fail loud.
    expect(tenant.length).toBeGreaterThanOrEqual(10);
  });

  it("never enables RLS without also forcing it (no owner-bypass downgrade)", () => {
    const offenders = tables
      .filter((t) => t.enabled && !t.forced)
      .map((t) => t.relname);
    expect(
      offenders,
      `tables with ENABLE but not FORCE row level security: ${offenders.join(", ")}. ` +
        `FORCE is required so the schema-owner connection is still bound by RLS. ` +
        `Add \`ALTER TABLE ${offenders[0] ?? "<table>"} FORCE ROW LEVEL SECURITY;\`.`,
    ).toEqual([]);
  });

  it("forces RLS on every table that carries a tenant_id column", () => {
    const offenders = tables
      .filter((t) => t.has_tenant_id && !(t.enabled && t.forced))
      .map((t) => `${t.relname} (enabled=${t.enabled}, forced=${t.forced})`);
    expect(
      offenders,
      `tenant-scoped tables missing ENABLE+FORCE row level security: ${offenders.join(", ")}. ` +
        `Every table with a tenant_id must enable AND force RLS so tenant isolation ` +
        `is a property of the database, not of the application remembering to scope.`,
    ).toEqual([]);
  });

  it("forces RLS on every table carrying an app_isolation policy", () => {
    const offenders = tables
      .filter((t) => t.has_isolation_policy && !(t.enabled && t.forced))
      .map((t) => `${t.relname} (enabled=${t.enabled}, forced=${t.forced})`);
    expect(
      offenders,
      `tables with an app_isolation policy but missing ENABLE+FORCE RLS: ${offenders.join(", ")}. ` +
        `A policy with FORCE off (or RLS disabled) is dead code that protects nothing.`,
    ).toEqual([]);
  });

  // Teeth check: prove the detection query actually flags an offender, so the
  // green assertions above can't be a false negative from a broken query.
  it("detects an ENABLE-without-FORCE table when one is introduced", async () => {
    await db.$client.exec(`
      create table lint_scratch_bad (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null
      );
      alter table lint_scratch_bad enable row level security;
    `);
    try {
      const rows = await loadTableRls(db);
      const bad = rows.find((t) => t.relname === "lint_scratch_bad");
      expect(bad?.enabled).toBe(true);
      expect(bad?.forced).toBe(false);
      expect(bad?.has_tenant_id).toBe(true);
      // Both relevant lints would fire on this table.
      const offenders = rows
        .filter((t) => t.enabled && !t.forced)
        .map((t) => t.relname);
      expect(offenders).toContain("lint_scratch_bad");
    } finally {
      await db.$client.exec(`drop table lint_scratch_bad;`);
    }
  });
});
