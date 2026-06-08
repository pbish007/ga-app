import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { assertSslRequired, requireFaaDatabaseUrl } from "@ga/db";

/**
 * Module-singleton read-only connection to the FAA Supabase project.
 * Lives behind {@link getFaaClient} so a route handler imports the
 * factory, not the singleton — which makes tests free to inject a
 * stub via the lookup function's `Deps` parameter.
 *
 * No schema is bound here because the FAA tables live in a different
 * Postgres database than the tenant schema (FAA Supabase vs. Neon
 * tenant). The lookup module issues raw SQL with the `faa_registry.`
 * prefix and shapes results into {@link FaaLookupResult}.
 */
export type FaaSql = ReturnType<typeof postgres>;

let cached: FaaSql | null = null;

export function getFaaSql(): FaaSql {
  if (cached) return cached;
  const url = requireFaaDatabaseUrl();
  assertSslRequired(url);
  // The lookup endpoint is one-row reads gated by a hot index on
  // n_number — connection limits dominate cost on Supabase free, so we
  // intentionally keep a small pool here. Per-request opens are
  // wasteful and were rejected.
  cached = postgres(url, { prepare: false, max: 4 });
  return cached;
}

/**
 * Carrier for the drizzle wrapper around {@link FaaSql}. We expose
 * both the raw `sql` template and the drizzle handle so the lookup
 * code can pick whichever is cleaner per query.
 */
export interface FaaClient {
  sql: FaaSql;
  drizzle: ReturnType<typeof drizzle>;
}

export function getFaaClient(): FaaClient {
  const sql = getFaaSql();
  return { sql, drizzle: drizzle(sql) };
}
