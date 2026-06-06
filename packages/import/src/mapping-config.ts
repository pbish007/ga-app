import { type ImportJobTargetTable } from "./target-fields.js";

/**
 * Closed set of `format` kinds the mapping engine knows how to apply
 * to a source cell. Reject anything else at validate time as an
 * "unsupported format".
 */
export const COLUMN_FORMAT_KINDS = [
  "text",
  "date",
  "datetime",
  "decimal",
  "integer",
  "boolean",
] as const;
export type ColumnFormatKind = (typeof COLUMN_FORMAT_KINDS)[number];

/**
 * Date input shapes the engine accepts. ISO is the default and the
 * one we recommend in the doc; the two slash variants exist because
 * paper-log CSVs commonly carry US- or EU-style dates.
 */
export const SUPPORTED_DATE_FORMATS = [
  "ISO",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
] as const;
export type SupportedDateFormat = (typeof SUPPORTED_DATE_FORMATS)[number];

export interface TextFormat {
  kind: "text";
  /** Default true. */
  trim?: boolean;
}

export interface DateFormat {
  kind: "date";
  /** Default 'ISO'. */
  format?: SupportedDateFormat;
}

export interface DateTimeFormat {
  kind: "datetime";
}

export interface DecimalFormat {
  kind: "decimal";
}

export interface IntegerFormat {
  kind: "integer";
}

export interface BooleanFormat {
  kind: "boolean";
  /** Defaults: ['true', 'yes', 'y', '1']. Case-insensitive. */
  truthy?: string[];
  /** Defaults: ['false', 'no', 'n', '0', '']. Case-insensitive. */
  falsy?: string[];
}

export type ColumnFormat =
  | TextFormat
  | DateFormat
  | DateTimeFormat
  | DecimalFormat
  | IntegerFormat
  | BooleanFormat;

/**
 * Column mapping: take cell from `source` column, optionally coerce
 * via `format`, write to the target field this entry is keyed under.
 *
 * Per-target field type drives which `format.kind` is acceptable; the
 * validator rejects mismatches (e.g. decimal format for a date target).
 */
export interface ColumnMapping {
  source: string;
  format?: ColumnFormat;
}

/**
 * Constant value to write into the target field, unconditional of any
 * source cell. Useful for fields the operator knows are uniform across
 * the upload (e.g. `category: "airplane"` on a single-type spreadsheet,
 * or `timeSource: "tach"` when the operator's fleet uses tach time).
 *
 * Constants are stored as raw JSON values; the validator type-checks
 * them against the target field's type.
 */
export type ConstantValue = string | number | boolean | null;

/**
 * Lookup kinds supported in V1. Each kind names a tenant-scoped read
 * the production lookup adapter is allowed to perform. The adapter
 * MUST run with the `tenant_app` role so RLS scopes the SELECT —
 * cross-tenant resolution is a P0 bug.
 *
 *   aircraft_by_registration — registration string (case-insensitive
 *     match per the aircraft_tenant_registration_unique index) →
 *     aircraft.id.
 *   regime_by_code — regime.code constant (e.g. "FAA") → regime.id.
 *     `regimes` is a catalog table, not tenant-scoped, but the lookup
 *     adapter still runs as tenant_app for symmetry.
 *   component_by_serial — component.kind + serial → component.id.
 *   inspection_program_by_code — regime inspection program code →
 *     regime_inspection_program_templates.id.
 */
export const LOOKUP_KINDS = [
  "aircraft_by_registration",
  "regime_by_code",
  "component_by_serial",
  "inspection_program_by_code",
] as const;
export type LookupKind = (typeof LOOKUP_KINDS)[number];

/**
 * Lookup that draws its key from a row cell — e.g. each row carries a
 * tail number, resolve it to an aircraft id per-row.
 */
export interface ColumnDrivenLookup {
  target: string;
  kind:
    | "aircraft_by_registration"
    | "component_by_serial"
    | "inspection_program_by_code";
  sourceColumn: string;
  /** Required for `component_by_serial`. */
  componentKind?: "engine" | "propeller" | "appliance";
}

/**
 * Lookup that resolves once for the whole file from a constant key —
 * primarily used to attach the FAA regime to every aircraft in a
 * spreadsheet without forcing an operator to write the regime UUID in
 * a column.
 */
export interface ConstantKeyLookup {
  target: string;
  kind: "regime_by_code";
  value: string;
}

export type LookupMapping = ColumnDrivenLookup | ConstantKeyLookup;

/**
 * V1 mapping config. Authored by the operator (with UI assist) or
 * generated from a saved template; persisted alongside the import job
 * row.
 *
 * Semantics:
 *  - Every required target field MUST be provided by exactly one of
 *    `columns`, `constants`, `lookups`.
 *  - A target field declared in more than one of those sections is
 *    rejected by `validateMappingConfig` (no implicit precedence —
 *    the operator must pick one shape per field).
 *  - Optional target fields can be omitted entirely; they land as
 *    NULL in `mapped_payload`.
 *  - Source column names match the parser's header strings exactly
 *    (the C2 parser handles BOM, trims headers).
 *
 * `version` is a hard literal `"1"` today; bumping it is a versioning
 * event tied to a follow-up issue when we introduce a non-backwards-
 * compatible shape.
 */
export interface MappingConfig {
  version: "1";
  targetTable: ImportJobTargetTable;
  /** Optional XLSX worksheet name (parser uses the first sheet by default). */
  sheet?: string;
  columns?: Record<string, ColumnMapping>;
  constants?: Record<string, ConstantValue>;
  lookups?: LookupMapping[];
}
