import { and, eq, isNull, sql } from "drizzle-orm";

import { schema as dbSchema, type ComponentKind } from "@ga/db";
import type {
  LookupAdapter,
  TenantCursor,
} from "@ga/import";

const {
  aircraft,
  components,
  regimes,
  regimeInspectionProgramTemplates,
  userCredentials,
} = dbSchema;

/**
 * Drizzle handle these adapters operate against. Cross-driver — pglite
 * (tests) and postgres-js (production) — surface a slightly different
 * generic shape per driver, so we type the handle structurally as the
 * builder operations the adapters actually use.
 *
 * The adapters MUST be called from inside a transaction pinned to
 * `tenant_app` + `app.current_tenant_id` (see
 * `runAsTenantOnProductionDb` in `apps/web/lib/tenant-tx.ts`). RLS
 * scopes the reads — passing a bare owner-class connection is a P0
 * tenant-isolation bug.
 */
// Drizzle's driver-specific generic shapes don't compose; the adapters
// only ever issue `.select().from().where().limit()` chains here.
// eslint-disable-next-line
export type AdapterTx = any;

/**
 * Production {@link LookupAdapter}. The mapping engine (C3 / PMB-159)
 * calls this when a `lookups` entry needs to resolve a key into an id.
 *
 * Each method runs a single tenant-scoped SELECT. Misses return null;
 * the mapping engine folds a miss into the per-row error list with
 * code `LOOKUP_MISS`. Throws are reserved for genuine adapter failures
 * (folded as `LOOKUP_ERROR`).
 */
export class DbLookupAdapter implements LookupAdapter {
  constructor(private readonly tx: AdapterTx) {}

  async aircraftIdByRegistration(
    registration: string,
  ): Promise<string | null> {
    const trimmed = registration.trim();
    if (trimmed.length === 0) return null;
    const rows = await this.tx
      .select({ id: aircraft.id })
      .from(aircraft)
      .where(sql`lower(${aircraft.registration}) = lower(${trimmed})`)
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async regimeIdByCode(code: string): Promise<string | null> {
    const trimmed = code.trim();
    if (trimmed.length === 0) return null;
    // Regimes are global catalog (not tenant-scoped) — still readable
    // by tenant_app under the existing grant.
    const rows = await this.tx
      .select({ id: regimes.id })
      .from(regimes)
      .where(eq(regimes.code, trimmed))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async componentIdBySerial(
    kind: ComponentKind,
    serialNumber: string,
  ): Promise<string | null> {
    const trimmed = serialNumber.trim();
    if (trimmed.length === 0) return null;
    const rows = await this.tx
      .select({ id: components.id })
      .from(components)
      .where(
        and(
          eq(components.kind, kind),
          sql`lower(${components.serialNumber}) = lower(${trimmed})`,
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async inspectionProgramIdByCode(code: string): Promise<string | null> {
    const trimmed = code.trim();
    if (trimmed.length === 0) return null;
    // Catalog table — keyed by regime + code. The mapping config
    // already names the regime via the job's regime_id, but the
    // adapter interface only takes a code. To stay within RLS we
    // accept that two regimes with overlapping codes would be
    // ambiguous; in practice each tenant pins one regime and the
    // lookup is unique per the global catalog.
    const rows = await this.tx
      .select({ id: regimeInspectionProgramTemplates.id })
      .from(regimeInspectionProgramTemplates)
      .where(eq(regimeInspectionProgramTemplates.code, trimmed))
      .limit(1);
    return rows[0]?.id ?? null;
  }
}

/**
 * Build a synchronous {@link TenantCursor} for the per-entity
 * validators (C4 / PMB-160). The validators are sync by design —
 * batch state, registration grammar, and signed-by lookups all need
 * to fit inside one tight per-row loop — so we PRE-LOAD the keys the
 * batch is about to ask about, then expose them through an in-memory
 * cursor.
 *
 * Pre-loaded keys:
 *
 *   * `aircraftRegistrations` — every registration the mapping engine
 *     emitted under the `registration` field. The cursor resolves
 *     them case-insensitively, matching the
 *     `aircraft_tenant_registration_unique` index.
 *
 *   * `certificateNumbers` — every certificate number any
 *     maintenance-entry row references. The C5 commit pipeline reads
 *     the cursor's resolution to populate
 *     `maintenance_entries.signed_by_credential_id` /
 *     `signed_by_user_id`.
 */
export async function buildTenantCursor(
  tx: AdapterTx,
  keys: {
    aircraftRegistrations: readonly string[];
    certificateNumbers: readonly string[];
  },
): Promise<TenantCursor> {
  const aircraftMap = new Map<string, string>();
  if (keys.aircraftRegistrations.length > 0) {
    const lowered = keys.aircraftRegistrations.map((r) => r.trim().toLowerCase());
    const rows = await tx
      .select({ id: aircraft.id, registration: aircraft.registration })
      .from(aircraft)
      .where(
        sql`lower(${aircraft.registration}) = any(${sql`array[${sql.join(
          lowered.map((l) => sql`${l}`),
          sql`, `,
        )}]::text[]`})`,
      );
    for (const row of rows as { id: string; registration: string }[]) {
      aircraftMap.set(row.registration.toLowerCase(), row.id);
    }
  }

  const credentialMap = new Map<
    string,
    { credentialId: string; userId: string }
  >();
  if (keys.certificateNumbers.length > 0) {
    const lowered = keys.certificateNumbers.map((c) => c.trim().toLowerCase());
    const rows = await tx
      .select({
        id: userCredentials.id,
        userId: userCredentials.userId,
        certificateNumber: userCredentials.certificateNumber,
      })
      .from(userCredentials)
      .where(
        and(
          isNull(userCredentials.revokedAt),
          sql`lower(${userCredentials.certificateNumber}) = any(${sql`array[${sql.join(
            lowered.map((l) => sql`${l}`),
            sql`, `,
          )}]::text[]`})`,
        ),
      );
    for (const row of rows as {
      id: string;
      userId: string;
      certificateNumber: string | null;
    }[]) {
      if (!row.certificateNumber) continue;
      credentialMap.set(row.certificateNumber.toLowerCase(), {
        credentialId: row.id,
        userId: row.userId,
      });
    }
  }

  return {
    aircraftIdByRegistration(registration: string): string | null {
      return aircraftMap.get(registration.toLowerCase()) ?? null;
    },
    credentialByCertificateNumber(
      certificateNumber: string,
    ): { credentialId: string; userId: string } | null {
      return credentialMap.get(certificateNumber.toLowerCase()) ?? null;
    },
  };
}
