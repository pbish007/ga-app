import {
  createBatchState,
  FAA_REGISTRATION_REGEX,
  type BatchState,
  type MappedRow,
  type RegimeCatalog,
  type TenantCursor,
  type ValidatorContext,
} from "../../src/index.js";

/**
 * Test seed: a regime catalog that mimics the FAA seed
 * (the only regime in V1 — see PMB-18). Tests can override fields via
 * spread.
 */
export function makeRegime(
  overrides: Partial<RegimeCatalog> = {},
): RegimeCatalog {
  return {
    regimeId: "11111111-1111-1111-1111-111111111111",
    code: "FAA",
    registrationRegex: FAA_REGISTRATION_REGEX,
    rts: {
      regimeId: "11111111-1111-1111-1111-111111111111",
      codes: new Set(["FAA_91_407", "FAA_43_9", "FAA_43_11"]),
    },
    ...overrides,
  };
}

/**
 * In-memory cursor for the per-entity validators. Tests seed maps of
 * `registration → aircraftId` and `certificateNumber → { credentialId,
 * userId }`. Matching is case-insensitive on both keys.
 */
export class InMemoryCursor implements TenantCursor {
  private readonly aircraft: Map<string, string>;
  private readonly credentials: Map<
    string,
    { credentialId: string; userId: string }
  >;

  constructor(seed: {
    aircraft?: Record<string, string>;
    credentials?: Record<string, { credentialId: string; userId: string }>;
  } = {}) {
    this.aircraft = new Map(
      Object.entries(seed.aircraft ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    this.credentials = new Map(
      Object.entries(seed.credentials ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
  }

  aircraftIdByRegistration(registration: string): string | null {
    return this.aircraft.get(registration.toLowerCase()) ?? null;
  }

  credentialByCertificateNumber(
    certificateNumber: string,
  ): { credentialId: string; userId: string } | null {
    return this.credentials.get(certificateNumber.toLowerCase()) ?? null;
  }
}

export function makeRow(
  rowNumber: number,
  mapped: Record<string, unknown>,
  errors: MappedRow["errors"] = [],
): MappedRow {
  return { mapped, errors };
}

export function makeCtx(overrides: Partial<ValidatorContext> = {}): {
  ctx: ValidatorContext;
  batch: BatchState;
  cursor: InMemoryCursor;
} {
  const cursor = overrides.cursor instanceof InMemoryCursor
    ? overrides.cursor
    : new InMemoryCursor();
  const batch = overrides.batch ?? createBatchState();
  const ctx: ValidatorContext = {
    tenantId: "22222222-2222-2222-2222-222222222222",
    regimeId: "11111111-1111-1111-1111-111111111111",
    rowNumber: 2,
    cursor,
    regime: makeRegime(),
    batch,
    ...overrides,
  };
  return { ctx, batch, cursor };
}

export const VALID_AIRCRAFT_ID = "33333333-3333-3333-3333-333333333333";
export const VALID_REGIME_ID = "11111111-1111-1111-1111-111111111111";
