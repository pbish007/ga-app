import {
  loadPermissionsMatrix,
  type PermissionsMatrix,
} from "@ga/accounts";

import {
  buildLoadMembership,
  buildLoadSession,
  type WithRequestDeps,
} from "./auth/withRequest";
import { getDb } from "./db";
import { runAsTenantOnProductionDb, type RequestTenantTx } from "./tenant-tx";

function requireSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET must be set");
  }
  return secret;
}

let cachedMatrix: PermissionsMatrix | null = null;

async function getMatrix(): Promise<PermissionsMatrix> {
  if (cachedMatrix) return cachedMatrix;
  cachedMatrix = await loadPermissionsMatrix(getDb());
  return cachedMatrix;
}

/**
 * Build the per-request deps consumed by `withRequest`. The session
 * secret comes from `SESSION_SECRET`; the database and permissions
 * matrix are lazy module singletons.
 *
 * The permissions matrix is loaded once per process — role/permission
 * rows are seeded by migration and not edited at runtime today. If
 * that changes, switch to a TTL'd reload here.
 */
export async function buildRequestDeps(): Promise<WithRequestDeps<RequestTenantTx>> {
  const db = getDb();
  const matrix = await getMatrix();
  return {
    loadSession: buildLoadSession({ db, secret: requireSessionSecret() }),
    loadMembership: buildLoadMembership(db, matrix),
    runAsTenant: <T,>(tenantId: string, fn: (tx: RequestTenantTx) => Promise<T>) =>
      runAsTenantOnProductionDb(db, tenantId, fn),
  };
}
