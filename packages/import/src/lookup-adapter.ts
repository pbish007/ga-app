import type { ComponentKind } from "@ga/db";

/**
 * Surface the mapping engine calls when a `lookups` entry needs to
 * resolve a tenant-scoped id from a key.
 *
 * IMPORTANT: production implementations of this interface MUST execute
 * each query under the tenant's `app.current_tenant_id` GUC and the
 * `tenant_app` role so RLS scopes the SELECT to the importing tenant.
 * The mapping engine itself is pure — it never touches the database —
 * which makes tenant-scoping the adapter author's responsibility.
 *
 * The C5 commit pipeline (PMB-161) wires up the production adapter
 * inside the same `runAsTenant` block that holds the rest of the
 * commit transaction; tests in this package use {@link
 * InMemoryLookupAdapter} with explicit per-tenant maps.
 *
 * Implementations return `null` on miss, NOT throw. The mapping engine
 * folds a miss into the per-row `MappingError` list with code
 * `LOOKUP_MISS`; throwing is reserved for genuine adapter failures
 * (DB error, malformed key) and is folded as `LOOKUP_ERROR`.
 */
export interface LookupAdapter {
  aircraftIdByRegistration(registration: string): Promise<string | null>;
  regimeIdByCode(code: string): Promise<string | null>;
  componentIdBySerial(
    kind: ComponentKind,
    serialNumber: string,
  ): Promise<string | null>;
  inspectionProgramIdByCode(code: string): Promise<string | null>;
}

/**
 * Test double for the lookup adapter. Seed it with per-key tables;
 * lookups return `null` for any key not seeded.
 *
 * Aircraft registration lookup is case-insensitive (matches the
 * `aircraft_tenant_registration_unique` index on lower(registration)).
 * Component lookup is keyed by `${kind}|${lowerSerial}`.
 */
export class InMemoryLookupAdapter implements LookupAdapter {
  private readonly aircraft: Map<string, string>;
  private readonly regimes: Map<string, string>;
  private readonly components: Map<string, string>;
  private readonly inspectionPrograms: Map<string, string>;

  constructor(seed?: {
    aircraft?: Record<string, string>;
    regimes?: Record<string, string>;
    components?: Record<string, { kind: ComponentKind; id: string }>;
    inspectionPrograms?: Record<string, string>;
  }) {
    this.aircraft = new Map(
      Object.entries(seed?.aircraft ?? {}).map(([reg, id]) => [
        reg.toLowerCase(),
        id,
      ]),
    );
    this.regimes = new Map(Object.entries(seed?.regimes ?? {}));
    this.components = new Map(
      Object.entries(seed?.components ?? {}).map(([serial, info]) => [
        `${info.kind}|${serial.toLowerCase()}`,
        info.id,
      ]),
    );
    this.inspectionPrograms = new Map(
      Object.entries(seed?.inspectionPrograms ?? {}),
    );
  }

  async aircraftIdByRegistration(
    registration: string,
  ): Promise<string | null> {
    return this.aircraft.get(registration.toLowerCase()) ?? null;
  }

  async regimeIdByCode(code: string): Promise<string | null> {
    return this.regimes.get(code) ?? null;
  }

  async componentIdBySerial(
    kind: ComponentKind,
    serialNumber: string,
  ): Promise<string | null> {
    return (
      this.components.get(`${kind}|${serialNumber.toLowerCase()}`) ?? null
    );
  }

  async inspectionProgramIdByCode(code: string): Promise<string | null> {
    return this.inspectionPrograms.get(code) ?? null;
  }
}
