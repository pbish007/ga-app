import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";

import * as schema from "../schema/index.js";
import { TENANT_CONTEXT_GUC } from "./tenant.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "..", "..", "migrations");

export type TestDb = PgliteDatabase<typeof schema> & {
  $client: PGlite;
};

/**
 * Static catalog tables seeded by migrations (regime spine in 0001/0010,
 * RBAC matrix in 0005). {@link resetTestDb} preserves these so a suite's
 * `beforeAll` migration is the single source of catalog rows — tests read
 * the FAA regime, credential types, RTS templates, roles, and permissions
 * straight after a reset without re-seeding them.
 */
const CATALOG_TABLES = new Set<string>([
  "regimes",
  "regime_inspection_program_templates",
  "regime_inspection_program_intervals",
  "regime_directive_sources",
  "regime_credential_types",
  "regime_rts_templates",
  "regime_retention_rules",
  "app_roles",
  "app_permissions",
  "app_role_permissions",
]);

async function applyMigrations(pg: PGlite): Promise<void> {
  for (const file of readdirSync(migrationsDir).sort()) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(resolve(migrationsDir, file), "utf8");
    await pg.exec(sql);
  }
}

/**
 * Spin up an in-memory Postgres (pglite) with every migration in
 * `packages/db/migrations` applied, in filename order.
 *
 * @deprecated Per-test use replays all migrations and re-instantiates WASM
 * on every call — the dominant cost that PMB-63 papered over with 30s
 * timeouts. Prefer {@link setupTestSuite} (once per suite in `beforeAll`) +
 * its `reset` (in `afterEach`). Retained as a compatibility shim until all
 * callers are migrated.
 */
export async function setupTestDb(): Promise<TestDb> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  await applyMigrations(pg);
  const db = drizzle(pg, { schema }) as TestDb;
  db.$client = pg;
  return db;
}

export interface TestSuite {
  /** Migrated database, shared for the lifetime of the suite. */
  db: TestDb;
  /**
   * Truncate every non-catalog table, leaving the schema and the seeded
   * regime/RBAC catalog intact. Call in `afterEach` so each test starts from
   * a clean data slate without paying the migration cost again.
   */
  reset: () => Promise<void>;
}

/**
 * One migrated pglite instance per test suite. Run once in `beforeAll`; call
 * the returned `reset` in `afterEach` to isolate tests from one another.
 *
 * Isolation is by truncation, not transaction rollback: `runAsTenant` pins
 * `SET LOCAL ROLE tenant_app` inside its own transaction, and a per-test
 * outer transaction would force that role onto a savepoint whose release
 * unwinds the `SET LOCAL` mid-test. Truncation sidesteps the nesting
 * entirely.
 */
export async function setupTestSuite(): Promise<TestSuite> {
  const db = await setupTestDb();

  async function reset(): Promise<void> {
    // A prior test may have left the session pinned to `tenant_app` (a
    // NOSUPERUSER role that cannot TRUNCATE) or with the tenant GUC set.
    // Drop back to the bootstrap role and clear the context before touching
    // data tables.
    await db.$client.exec(
      `reset role; select set_config('${TENANT_CONTEXT_GUC}', '', false);`,
    );

    // Re-discover tables every reset so ad-hoc fixture tables a test creates
    // (e.g. the tenant_widgets RLS harness) are cleared too.
    const result = await db.execute<{ tablename: string }>(
      sql`select tablename from pg_tables where schemaname = 'public'`,
    );
    const dataTables = result.rows
      .map((r) => r.tablename)
      .filter((t) => !CATALOG_TABLES.has(t));
    if (dataTables.length === 0) return;

    // A single multi-table TRUNCATE is atomic and order-independent: every
    // inter-data-table FK has both ends in the list. CASCADE only propagates
    // to referencing tables (all data tables, already listed) and can never
    // reach the parent catalog tables.
    const list = dataTables.map((t) => `"${t}"`).join(", ");
    await db.$client.exec(`truncate table ${list} restart identity cascade;`);
  }

  return { db, reset };
}
