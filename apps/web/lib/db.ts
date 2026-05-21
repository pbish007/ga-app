import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { assertSslRequired, requireDatabaseUrl, schema } from "@ga/db";
import type { DocumentsDb } from "@ga/storage";

/**
 * Lazy, module-singleton Postgres client. Next.js may execute route
 * handlers multiple times per cold start; we cache the client per
 * process so we don't open a new connection per request.
 *
 * Tests inject their own pglite-backed `DocumentsDb` and never reach
 * this path.
 */
let cached: DocumentsDb | null = null;

export function getDb(): DocumentsDb {
  if (cached) return cached;
  const url = requireDatabaseUrl();
  assertSslRequired(url);
  const client = postgres(url, { prepare: false });
  cached = drizzle(client, { schema });
  return cached;
}
