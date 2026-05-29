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
 * Postgres custom GUC that the `app_self_membership` policy on
 * `organization_memberships` reads (migration 0019). The identity path
 * sets it from the trusted session so a tenant_app transaction with no
 * tenant context can still read (and self-insert) the authenticated user's
 * own membership rows — exactly what the `/orgs` cross-tenant org list and
 * the signup self-insert need. Fail-closed when unset (NULL never matches).
 *
 * PMB-74 introduces this so `DATABASE_URL` can repoint at a NOBYPASSRLS
 * `tenant_runtime` role without breaking the identity-path reads/writes
 * that today work via `neondb_owner`'s `rolbypassrls`.
 */
export const USER_CONTEXT_GUC = "app.current_user_id";

/**
 * Postgres role that every application connection MUST switch to before
 * issuing user-facing queries. Defined in migration 0004 as
 * NOSUPERUSER NOBYPASSRLS so that even a query that forgets to set the
 * tenant GUC cannot read other tenants' rows.
 */
export const TENANT_APP_ROLE = "tenant_app";

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

/**
 * Bypass-proof tenant scope for production request handlers.
 *
 * Opens a transaction and, *inside* it, pins both the tenant GUC and the
 * effective role as LOCAL settings:
 *
 *   * `SET LOCAL app.current_tenant_id = <tenantId>` — RLS predicates can
 *     now match rows.
 *   * `SET LOCAL ROLE tenant_app` — drops the connection's superuser
 *     privileges so even a query that forgets the GUC will hit FORCE
 *     ROW LEVEL SECURITY and return zero rows.
 *
 * LOCAL settings unwind automatically when the transaction commits or
 * rolls back — there is no way to leak a tenant context or an elevated
 * role to the next request on the same connection.
 *
 * The callback receives the transaction handle so its queries run on the
 * same connection where the LOCAL settings apply. With pglite (single
 * connection per database) the outer `db` happens to share the same
 * client, but real pool-backed drivers would not — passing `tx` is the
 * correct production shape.
 */
export async function runAsTenant<T>(
  db: TestDb,
  tenantId: string,
  fn: (tx: Parameters<Parameters<TestDb["transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config(${TENANT_CONTEXT_GUC}, ${tenantId}, true)`,
    );
    await tx.execute(sql.raw(`set local role ${TENANT_APP_ROLE}`));
    return await fn(tx);
  });
}
