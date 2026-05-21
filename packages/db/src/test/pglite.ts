import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import * as schema from "../schema/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "..", "..", "migrations");

export type TestDb = PgliteDatabase<typeof schema> & {
  $client: PGlite;
};

/**
 * Spin up an in-memory Postgres (pglite) with every migration in
 * `packages/db/migrations` applied, in filename order. Used by every
 * package that needs a real database in its tests — no external services.
 */
export async function setupTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  for (const file of readdirSync(migrationsDir).sort()) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(resolve(migrationsDir, file), "utf8");
    await pg.exec(sql);
  }
  const db = drizzle(pg, { schema }) as TestDb;
  db.$client = pg;
  return db;
}
