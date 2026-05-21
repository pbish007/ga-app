import { sql } from "drizzle-orm";

import type { TestDb } from "./pglite.js";

/**
 * Postgres custom GUC that tenant-scoped Row Level Security policies read.
 *
 * Policies on tenant tables MUST use `current_setting('app.current_tenant_id', true)`
 * (with the missing_ok flag) so the GUC being unset returns NULL and the
 * policy fails closed — no rows visible without an explicit tenant context.
 *
 * Epic A (PMB-10) consumes this constant when defining tenant RLS policies.
 */
export const TENANT_CONTEXT_GUC = "app.current_tenant_id";

/**
 * Set the session-level tenant context for subsequent queries on this
 * connection. Parameterized via `set_config()` so the tenant id is bound,
 * not interpolated.
 */
export async function setTenantContext(
  db: TestDb,
  tenantId: string,
): Promise<void> {
  await db.execute(
    sql`select set_config(${TENANT_CONTEXT_GUC}, ${tenantId}, false)`,
  );
}

/**
 * Clear the session-level tenant context. After this call, RLS policies
 * that reference `app.current_tenant_id` should return zero rows for
 * tenant-scoped tables.
 */
export async function clearTenantContext(db: TestDb): Promise<void> {
  await db.execute(sql.raw(`reset ${TENANT_CONTEXT_GUC}`));
}

/**
 * Run `fn` with the tenant context set to `tenantId`, clearing the
 * context on exit (including on thrown errors). The recommended way to
 * scope a block of queries to a single tenant in tests and request
 * handlers.
 */
export async function withTenantContext<T>(
  db: TestDb,
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await setTenantContext(db, tenantId);
  try {
    return await fn();
  } finally {
    await clearTenantContext(db);
  }
}
