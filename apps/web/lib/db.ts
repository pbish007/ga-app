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
let cachedDirect: DocumentsDb | null = null;

export function getDb(): DocumentsDb {
  if (cached) return cached;
  const url = requireDatabaseUrl();
  assertSslRequired(url);
  const client = postgres(url, { prepare: false });
  cached = drizzle(client, { schema });
  return cached;
}

/**
 * Owner-class ("direct") connection for *system* tasks that legitimately
 * span tenants and need to bypass RLS — currently the scheduled notification
 * sweep (`apps/web/app/api/cron/notifications/route.ts`). (The one-shot
 * `bootstrap-demo` admin endpoint was the other historical user; retired in
 * PMB-62 after the MVP demo signed off.) These predate the runtime/owner
 * split and rely on the bare connection seeing rows across every tenant.
 *
 * After PMB-74, the runtime `DATABASE_URL` repoints at the non-bypass
 * `tenant_runtime` role — at which point those cross-tenant system reads
 * /writes can no longer run on it. They run here instead, on the existing
 * `DATABASE_URL_DIRECT` connection (still `neondb_owner`, still the migrate
 * + break-glass identity), which is exactly what its `# Why a separate URL`
 * docstring in `packages/db/src/env.ts` is for.
 *
 * Falls back to `DATABASE_URL` when the direct var is unset (e.g. local
 * dev where both point at the same Neon role today) so this addition does
 * not regress existing environments.
 */
export function getDirectDb(): DocumentsDb {
  if (cachedDirect) return cachedDirect;
  const url = (process.env.DATABASE_URL_DIRECT ?? "").trim() || requireDatabaseUrl();
  assertSslRequired(url);
  const client = postgres(url, { prepare: false });
  cachedDirect = drizzle(client, { schema });
  return cachedDirect;
}
