import type { MappedRow } from "../parser-types.js";

/**
 * Closed vocabulary of entities the C4 per-entity validators target.
 *
 * The names are the singular entity vocabulary the spec uses ("aircraft",
 * "maintenance_entry", "component", "flight_time_entry"); the `import_jobs`
 * schema uses plural target table names. {@link entityToTargetTable} bridges.
 */
export const TARGET_ENTITIES = [
  "aircraft",
  "maintenance_entry",
  "component",
  "flight_time_entry",
] as const;
export type TargetEntity = (typeof TARGET_ENTITIES)[number];

export const VALIDATOR_ERROR_CODES = [
  "MISSING_REQUIRED_FIELD",
  "INVALID_FORMAT",
  "INVALID_REGISTRATION",
  "OUT_OF_RANGE",
  "INVALID_ENUM",
  "UNSIGNED_HISTORICAL",
  "UNKNOWN_RTS_TEMPLATE",
  "UNKNOWN_CERTIFICATE",
  "AIRCRAFT_NOT_RESOLVED",
  "MONOTONICITY_VIOLATION",
  "LIFE_LIMIT_INVALID",
  "TIME_SINCE_OVERHAUL_EXCEEDS_TOTAL",
  "MAPPING_ERROR",
] as const;
export type ValidatorErrorCode = (typeof VALIDATOR_ERROR_CODES)[number];

export interface ValidationError {
  rowNumber: number;
  code: ValidatorErrorCode;
  message: string;
  /** Target field the error is anchored to, when applicable. */
  field?: string;
}

export type ValidationStatus = "valid" | "invalid";

/**
 * What a {@link RowValidator} returns. Matches the shape the C5 commit
 * pipeline (PMB-161) writes to `import_job_rows.validation_status` and
 * `validation_errors`.
 */
export interface ValidationResult {
  status: ValidationStatus;
  errors: ValidationError[];
}

/**
 * In-memory snapshot of the regime's RTS template catalog. The
 * orchestrator loads this once per (regime, import job) and shares it
 * across every per-row validate call so the validator stays sync.
 *
 * Codes are matched case-insensitively against this set, mirroring how
 * the F2 sign-off flow resolves RTS template codes.
 */
export interface RegimeRtsTemplateCatalog {
  regimeId: string;
  /** Set of allowed RTS template codes for the regime. */
  codes: ReadonlySet<string>;
}

/**
 * Per-regime catalog the validators consult. Includes the registration
 * regex the {@link aircraftValidator} applies (FAA's N-number grammar
 * for the FAA regime; other regimes will land their own pattern when
 * they ship) plus the RTS template catalog the maintenance validator
 * consults for the sign-off shape check.
 *
 * The orchestrator is responsible for assembling this from the regime
 * catalog tables (`regimes`, `regime_rts_templates`) under tenant_app /
 * RLS, then handing the in-memory snapshot down to each row validator.
 */
export interface RegimeCatalog {
  regimeId: string;
  /** Regime code (e.g. "FAA"). Surfaced in error messages. */
  code: string;
  /**
   * Aircraft registration grammar for this regime. The FAA seeder uses
   * the standard N-number grammar (`^N[1-9][0-9]{0,4}[A-Z]{0,2}$`).
   * Other regimes substitute their own.
   *
   * If omitted, the aircraft validator does only a non-empty check.
   */
  registrationRegex?: RegExp;
  rts: RegimeRtsTemplateCatalog;
}

/**
 * Read-only tenant cursor the validators use for spot lookups against
 * the importing tenant. Validators are pure / synchronous, so this is a
 * pre-loaded snapshot, not a live DB cursor — the orchestrator scans the
 * mapped rows first to collect the keys it will need, then loads them in
 * a single RLS-scoped query (running as `tenant_app` with the import
 * job's tenant id in `app.current_tenant_id`), and hands the in-memory
 * tables down here.
 *
 * The mapping engine has its own {@link import("../lookup-adapter").LookupAdapter}
 * for resolving ids *during mapping* (e.g. tail → aircraft_id when the
 * mapping engine writes mapped_payload). This cursor is for the per-row
 * *integrity* checks the validator runs on top of mapped_payload — for
 * instance, "does this certificate number belong to anyone the tenant
 * trusts" or "does this aircraft id actually exist."
 *
 * Production implementations MUST execute their backing query as
 * `tenant_app` so RLS scopes the read to the importing tenant; a
 * leak here is a P0 tenant-isolation bug.
 */
export interface TenantCursor {
  /**
   * Resolve a registration string to an aircraft id. Case-insensitive,
   * mirroring the `aircraft_tenant_registration_unique` index. NULL on
   * miss.
   */
  aircraftIdByRegistration(registration: string): string | null;
  /**
   * Resolve a certificate number to the matching active user credential.
   * NULL on miss. Returns both the credential id (so the C5 commit
   * pipeline can populate `maintenance_entries.signed_by_credential_id`)
   * and the user id (so it can populate `signed_by_user_id`).
   *
   * Matching is case-insensitive. "Active" means `revoked_at IS NULL`;
   * expired credentials may still be matched, per the spec note that
   * historical sign-offs are valid even when the signer's credential
   * later expired.
   */
  credentialByCertificateNumber(
    certificateNumber: string,
  ): { credentialId: string; userId: string } | null;
}

/**
 * Cross-row accumulator state the orchestrator maintains across a single
 * import batch. Validators that need cross-row context (today: only
 * {@link flightTimeEntryValidator} for monotonic airframe time) read
 * and mutate this map in place.
 *
 * The state lives in the orchestrator; the validator never owns it.
 * Tests instantiate a fresh state per batch via {@link createBatchState}.
 */
export interface BatchState {
  /**
   * For each aircraft id seen in this batch so far, the highest
   * `airframeTimeNew` value the flight-time validator has accepted.
   * The orchestrator inspects/updates this so a later row that goes
   * backwards (non-monotonic) is flagged MONOTONICITY_VIOLATION.
   */
  highestAirframeTimeByAircraft: Map<string, number>;
}

export function createBatchState(): BatchState {
  return {
    highestAirframeTimeByAircraft: new Map(),
  };
}

export interface ValidatorContext {
  tenantId: string;
  regimeId: string;
  /** 1-indexed source row number for error reporting. */
  rowNumber: number;
  cursor: TenantCursor;
  regime: RegimeCatalog;
  /**
   * Required when the validator needs cross-row state (flight_time);
   * other validators can omit it.
   */
  batch?: BatchState;
}

/**
 * The C4 validator interface. One implementation per
 * {@link TargetEntity}. Pure and synchronous: emit `{ status, errors[] }`
 * given a {@link MappedRow} and a {@link ValidatorContext}; never touch
 * the database.
 *
 * Validators fold {@link MappedRow.errors} (mapping-stage errors) into
 * their output as `MAPPING_ERROR` entries so a row's full error set is
 * available downstream from one place.
 */
export interface RowValidator<T extends TargetEntity = TargetEntity> {
  entity: T;
  validate(row: MappedRow, ctx: ValidatorContext): ValidationResult;
}

/**
 * Bridge the singular entity vocabulary the C4 validators use to the
 * plural import-jobs target table names the schema stores.
 */
export function entityToTargetTable(entity: TargetEntity): string {
  switch (entity) {
    case "aircraft":
      return "aircraft";
    case "maintenance_entry":
      return "maintenance_entries";
    case "component":
      return "components";
    case "flight_time_entry":
      return "flight_time_entries";
  }
}

/**
 * Fold {@link MappedRow.errors} (mapping-stage errors) into a per-entity
 * validator error list. The orchestrator-facing error code is always
 * `MAPPING_ERROR`; the original mapping code is preserved in the
 * message so the UI can surface it.
 */
export function foldMappingErrors(row: MappedRow): ValidationError[] {
  return row.errors.map((e) => ({
    rowNumber: e.rowNumber,
    code: "MAPPING_ERROR" as const,
    message: `${e.code}: ${e.message}`,
    field: e.field,
  }));
}

/**
 * Tiny helper used inside each validator to assemble a result with the
 * right status flag.
 */
export function finalize(
  errors: ValidationError[],
): ValidationResult {
  return {
    status: errors.length === 0 ? "valid" : "invalid",
    errors,
  };
}

/**
 * Pull a string-valued field from a mapped payload. Returns NULL when
 * absent or blank. Mirrors how the coerce layer represents missing
 * cells.
 */
export function readString(
  row: MappedRow,
  field: string,
): string | null {
  const v = row.mapped[field];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return String(v);
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function readNumber(
  row: MappedRow,
  field: string,
): number | null {
  const v = row.mapped[field];
  if (v === null || v === undefined) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function readBoolean(
  row: MappedRow,
  field: string,
): boolean | null {
  const v = row.mapped[field];
  if (v === null || v === undefined) return null;
  return typeof v === "boolean" ? v : null;
}
