import { sql } from "drizzle-orm";

import {
  TENANT_APP_ROLE,
  TENANT_CONTEXT_GUC,
} from "@ga/db";
import type { DocumentsDb } from "@ga/storage";

/**
 * Production-side analogue of @ga/db's `runAsTenant`. Opens a tx and
 * pins both the tenant GUC and the `tenant_app` role as LOCAL settings,
 * so any query inside `fn` runs under RLS.
 *
 * The @ga/db helper is typed against pglite for tests; this one is
 * shaped for the runtime DB type (postgres-js drizzle, but pglite works
 * too because the transaction API is the same).
 */
export type RequestTenantTx = Parameters<
  Parameters<DocumentsDb["transaction"]>[0]
>[0];

export async function runAsTenantOnProductionDb<T>(
  db: DocumentsDb,
  tenantId: string,
  fn: (tx: RequestTenantTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config(${TENANT_CONTEXT_GUC}, ${tenantId}, true)`,
    );
    await tx.execute(sql.raw(`set local role ${TENANT_APP_ROLE}`));
    return fn(tx);
  });
}
