import { CoercionError, coerce } from "./coerce.js";
import type {
  ColumnFormat,
  ColumnMapping,
  LookupMapping,
  MappingConfig,
} from "./mapping-config.js";
import type { LookupAdapter } from "./lookup-adapter.js";
import type {
  MappedRow,
  MappingError,
  ParsedRow,
} from "./parser-types.js";
import { findTargetField } from "./target-fields.js";

/**
 * Apply a mapping config to one parsed row. Returns the
 * mapped-payload object and a per-row error list.
 *
 * Order of application:
 *   1. columns (each cell coerced per declared format)
 *   2. constants (literal writes)
 *   3. lookups (tenant-scoped resolution via the supplied adapter)
 *
 * The validator (`validateMappingConfig`) rejects configs that source
 * the same target field from more than one section, so order does not
 * affect correctness — but applying lookups last keeps test reasoning
 * simple (lookups never get clobbered by columns/constants).
 *
 * The engine is pure: it never touches the database. Tenant scoping
 * lives in the {@link LookupAdapter} the caller passes in (production
 * adapters MUST run as `tenant_app` so RLS does the scoping; see
 * adapter docstring).
 */
export async function applyMapping(
  config: MappingConfig,
  row: ParsedRow,
  lookups: LookupAdapter,
): Promise<MappedRow> {
  const mapped: Record<string, unknown> = {};
  const errors: MappingError[] = [];

  if (config.columns) {
    for (const [target, mapping] of Object.entries(config.columns)) {
      applyColumn(config, target, mapping, row, mapped, errors);
    }
  }

  if (config.constants) {
    for (const [target, value] of Object.entries(config.constants)) {
      mapped[target] = value;
    }
  }

  if (config.lookups) {
    for (const lookup of config.lookups) {
      await applyLookup(lookup, row, lookups, mapped, errors);
    }
  }

  return { mapped, errors };
}

function applyColumn(
  config: MappingConfig,
  target: string,
  mapping: ColumnMapping,
  row: ParsedRow,
  mapped: Record<string, unknown>,
  errors: MappingError[],
): void {
  if (!Object.prototype.hasOwnProperty.call(row.raw_cells, mapping.source)) {
    errors.push({
      field: target,
      column: mapping.source,
      rowNumber: row.rowNumber,
      message: `source column '${mapping.source}' missing on row`,
      code: "MISSING_COLUMN",
    });
    return;
  }
  const raw = row.raw_cells[mapping.source];
  const format: ColumnFormat =
    mapping.format ?? defaultFormatFor(config, target);
  try {
    const value = coerce(raw, format);
    if (value !== null) {
      mapped[target] = value;
    }
  } catch (err) {
    if (err instanceof CoercionError) {
      errors.push({
        field: target,
        column: mapping.source,
        rowNumber: row.rowNumber,
        message: err.message,
        code: "FORMAT_ERROR",
      });
    } else {
      throw err;
    }
  }
}

async function applyLookup(
  lookup: LookupMapping,
  row: ParsedRow,
  lookups: LookupAdapter,
  mapped: Record<string, unknown>,
  errors: MappingError[],
): Promise<void> {
  try {
    let resolved: string | null;
    let lookupKey: string | undefined;

    if (lookup.kind === "regime_by_code") {
      lookupKey = lookup.value;
      resolved = await lookups.regimeIdByCode(lookup.value);
    } else if (lookup.kind === "aircraft_by_registration") {
      const raw = readLookupKey(row, lookup.sourceColumn);
      if (raw === null) {
        errors.push({
          field: lookup.target,
          column: lookup.sourceColumn,
          rowNumber: row.rowNumber,
          message: `aircraft_by_registration lookup needs a non-empty cell in '${lookup.sourceColumn}'`,
          code: "MISSING_COLUMN",
        });
        return;
      }
      lookupKey = raw;
      resolved = await lookups.aircraftIdByRegistration(raw);
    } else if (lookup.kind === "component_by_serial") {
      const raw = readLookupKey(row, lookup.sourceColumn);
      if (raw === null) {
        errors.push({
          field: lookup.target,
          column: lookup.sourceColumn,
          rowNumber: row.rowNumber,
          message: `component_by_serial lookup needs a non-empty cell in '${lookup.sourceColumn}'`,
          code: "MISSING_COLUMN",
        });
        return;
      }
      // The config validator guarantees componentKind is one of the
      // closed set when reaching here.
      lookupKey = raw;
      resolved = await lookups.componentIdBySerial(
        lookup.componentKind!,
        raw,
      );
    } else {
      // inspection_program_by_code
      const raw = readLookupKey(row, lookup.sourceColumn);
      if (raw === null) {
        errors.push({
          field: lookup.target,
          column: lookup.sourceColumn,
          rowNumber: row.rowNumber,
          message: `inspection_program_by_code lookup needs a non-empty cell in '${lookup.sourceColumn}'`,
          code: "MISSING_COLUMN",
        });
        return;
      }
      lookupKey = raw;
      resolved = await lookups.inspectionProgramIdByCode(raw);
    }

    if (resolved === null) {
      errors.push({
        field: lookup.target,
        column:
          lookup.kind === "regime_by_code" ? undefined : lookup.sourceColumn,
        rowNumber: row.rowNumber,
        message: `${lookup.kind} lookup found no match for '${lookupKey}'`,
        code: "LOOKUP_MISS",
      });
      return;
    }
    mapped[lookup.target] = resolved;
  } catch (err) {
    errors.push({
      field: lookup.target,
      column:
        lookup.kind === "regime_by_code" ? undefined : lookup.sourceColumn,
      rowNumber: row.rowNumber,
      message: `${lookup.kind} lookup adapter raised: ${(err as Error).message}`,
      code: "LOOKUP_ERROR",
    });
  }
}

function readLookupKey(row: ParsedRow, column: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(row.raw_cells, column)) {
    return null;
  }
  const raw = row.raw_cells[column];
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s.length === 0 ? null : s;
}

/**
 * When the operator omits `format`, infer it from the target field's
 * type. Keeps simple configs concise (`{ source: "TT" }` is enough
 * for a decimal column) while leaving room for explicit format
 * overrides (date format, custom truthy/falsy lists).
 */
function defaultFormatFor(
  config: MappingConfig,
  target: string,
): ColumnFormat {
  const field = findTargetField(config.targetTable, target);
  if (!field) return { kind: "text" };
  switch (field.type.kind) {
    case "decimal":
      return { kind: "decimal" };
    case "integer":
      return { kind: "integer" };
    case "date":
      return { kind: "date", format: "ISO" };
    case "datetime":
      return { kind: "datetime" };
    case "boolean":
      return { kind: "boolean" };
    case "text":
    case "enum":
    case "uuid":
    default:
      return { kind: "text" };
  }
}
