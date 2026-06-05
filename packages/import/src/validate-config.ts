import {
  COLUMN_FORMAT_KINDS,
  LOOKUP_KINDS,
  SUPPORTED_DATE_FORMATS,
  type ColumnFormat,
  type ColumnFormatKind,
  type LookupMapping,
  type MappingConfig,
} from "./mapping-config.js";
import {
  IMPORT_JOB_TARGET_TABLES,
  findTargetField,
  targetFieldsFor,
  type TargetField,
} from "./target-fields.js";

export interface MappingConfigIssue {
  /** Stable code so the UI can localize or group issues. */
  code:
    | "UNKNOWN_TARGET_TABLE"
    | "UNKNOWN_TARGET_FIELD"
    | "DUPLICATE_TARGET_FIELD"
    | "MISSING_REQUIRED_FIELD"
    | "UNSUPPORTED_FORMAT"
    | "FORMAT_TYPE_MISMATCH"
    | "UNSUPPORTED_DATE_FORMAT"
    | "MISSING_SOURCE_COLUMN"
    | "INVALID_VERSION"
    | "INVALID_CONSTANT_TYPE"
    | "INVALID_ENUM_CONSTANT"
    | "INVALID_LOOKUP_KIND"
    | "MISSING_LOOKUP_KEY"
    | "MISSING_COMPONENT_KIND";
  message: string;
  /** Path into the mapping config, e.g. `columns.registration.format`. */
  path: string;
}

export interface ValidateMappingConfigOptions {
  /**
   * Column names the C2 parser saw in the source file. When provided,
   * the validator additionally rejects column mappings and column-
   * driven lookups whose `source` / `sourceColumn` is not present.
   *
   * Header comparison is exact (the parser canonicalizes headers
   * upstream); we don't try to be clever about case-folding here.
   */
  availableColumns?: readonly string[];
}

export interface ValidateMappingConfigResult {
  ok: boolean;
  issues: MappingConfigIssue[];
}

/**
 * Pure validation pass over a mapping config. Returns a list of
 * structured issues; `ok` is true only when the list is empty.
 *
 * Covers the C3 acceptance criteria:
 *   - rejects unknown target fields (UNKNOWN_TARGET_FIELD)
 *   - mismatched required columns (MISSING_REQUIRED_FIELD,
 *     MISSING_SOURCE_COLUMN)
 *   - unsupported formats (UNSUPPORTED_FORMAT, FORMAT_TYPE_MISMATCH,
 *     UNSUPPORTED_DATE_FORMAT)
 *
 * Plus structural guards: version, target table membership, lookup
 * kind membership, lookup shape, and basic constant typing.
 */
export function validateMappingConfig(
  config: MappingConfig,
  options: ValidateMappingConfigOptions = {},
): ValidateMappingConfigResult {
  const issues: MappingConfigIssue[] = [];

  if (config.version !== "1") {
    issues.push({
      code: "INVALID_VERSION",
      message: `unsupported mapping_config version '${String(config.version)}'; only '1' is supported`,
      path: "version",
    });
  }

  if (
    !IMPORT_JOB_TARGET_TABLES.includes(
      config.targetTable as (typeof IMPORT_JOB_TARGET_TABLES)[number],
    )
  ) {
    issues.push({
      code: "UNKNOWN_TARGET_TABLE",
      message: `unknown target table '${String(config.targetTable)}'`,
      path: "targetTable",
    });
    return { ok: false, issues };
  }

  const fields = targetFieldsFor(config.targetTable);

  // Track which fields are sourced by which section so we can detect
  // duplicates and unmet required fields.
  const sourcedBy = new Map<string, string>();

  function claim(target: string, source: string, path: string): boolean {
    const prior = sourcedBy.get(target);
    if (prior !== undefined) {
      issues.push({
        code: "DUPLICATE_TARGET_FIELD",
        message: `target field '${target}' is sourced by both '${prior}' and '${source}'; pick one`,
        path,
      });
      return false;
    }
    sourcedBy.set(target, source);
    return true;
  }

  // ---- columns ----------------------------------------------------
  if (config.columns) {
    for (const [target, mapping] of Object.entries(config.columns)) {
      const path = `columns.${target}`;
      const field = findTargetField(config.targetTable, target);
      if (!field) {
        issues.push({
          code: "UNKNOWN_TARGET_FIELD",
          message: `unknown target field '${target}' on table '${config.targetTable}'`,
          path,
        });
        continue;
      }
      claim(target, "columns", path);
      validateFormatAgainstField(field, mapping.format, `${path}.format`, issues);
      if (
        options.availableColumns &&
        !options.availableColumns.includes(mapping.source)
      ) {
        issues.push({
          code: "MISSING_SOURCE_COLUMN",
          message: `column mapping for '${target}' references source column '${mapping.source}' that is not present in the uploaded file`,
          path: `${path}.source`,
        });
      }
    }
  }

  // ---- constants --------------------------------------------------
  if (config.constants) {
    for (const [target, value] of Object.entries(config.constants)) {
      const path = `constants.${target}`;
      const field = findTargetField(config.targetTable, target);
      if (!field) {
        issues.push({
          code: "UNKNOWN_TARGET_FIELD",
          message: `unknown target field '${target}' on table '${config.targetTable}'`,
          path,
        });
        continue;
      }
      claim(target, "constants", path);
      validateConstantAgainstField(field, value, path, issues);
    }
  }

  // ---- lookups ----------------------------------------------------
  if (config.lookups) {
    for (const [i, lookup] of config.lookups.entries()) {
      const path = `lookups[${i}]`;
      if (
        !LOOKUP_KINDS.includes(lookup.kind as (typeof LOOKUP_KINDS)[number])
      ) {
        issues.push({
          code: "INVALID_LOOKUP_KIND",
          message: `unsupported lookup kind '${String(lookup.kind)}'`,
          path: `${path}.kind`,
        });
        continue;
      }
      const target = lookup.target;
      const field = findTargetField(config.targetTable, target);
      if (!field) {
        issues.push({
          code: "UNKNOWN_TARGET_FIELD",
          message: `unknown target field '${target}' on table '${config.targetTable}'`,
          path: `${path}.target`,
        });
        continue;
      }
      if (field.type.kind !== "uuid") {
        issues.push({
          code: "FORMAT_TYPE_MISMATCH",
          message: `lookups always produce a uuid; target field '${target}' is type '${field.type.kind}'`,
          path: `${path}.target`,
        });
        continue;
      }
      claim(target, "lookups", `${path}.target`);
      validateLookupShape(lookup, path, options, issues);
    }
  }

  // ---- required fields --------------------------------------------
  for (const f of fields) {
    if (!f.required) continue;
    if (!sourcedBy.has(f.name)) {
      issues.push({
        code: "MISSING_REQUIRED_FIELD",
        message: `required target field '${f.name}' has no source in columns, constants, or lookups`,
        path: `targetTable:${config.targetTable}`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

function validateFormatAgainstField(
  field: TargetField,
  format: ColumnFormat | undefined,
  path: string,
  issues: MappingConfigIssue[],
): void {
  if (!format) return;
  if (
    !COLUMN_FORMAT_KINDS.includes(format.kind as ColumnFormatKind)
  ) {
    issues.push({
      code: "UNSUPPORTED_FORMAT",
      message: `unsupported column format '${String(format.kind)}'`,
      path,
    });
    return;
  }

  // Date format sub-kind check.
  if (format.kind === "date" && format.format !== undefined) {
    if (
      !SUPPORTED_DATE_FORMATS.includes(
        format.format as (typeof SUPPORTED_DATE_FORMATS)[number],
      )
    ) {
      issues.push({
        code: "UNSUPPORTED_DATE_FORMAT",
        message: `unsupported date format '${format.format}'; supported: ${SUPPORTED_DATE_FORMATS.join(", ")}`,
        path: `${path}.format`,
      });
    }
  }

  // Column format must match the target field type.
  const ft = field.type;
  const compatible =
    (format.kind === "text" && (ft.kind === "text" || ft.kind === "enum" || ft.kind === "uuid")) ||
    (format.kind === "decimal" && ft.kind === "decimal") ||
    (format.kind === "integer" && ft.kind === "integer") ||
    (format.kind === "date" && ft.kind === "date") ||
    (format.kind === "datetime" && ft.kind === "datetime") ||
    (format.kind === "boolean" && ft.kind === "boolean");

  if (!compatible) {
    issues.push({
      code: "FORMAT_TYPE_MISMATCH",
      message: `column format '${format.kind}' cannot populate target field '${field.name}' of type '${ft.kind}'`,
      path,
    });
  }
}

function validateConstantAgainstField(
  field: TargetField,
  value: unknown,
  path: string,
  issues: MappingConfigIssue[],
): void {
  const t = field.type;
  switch (t.kind) {
    case "text":
    case "uuid":
    case "date":
    case "datetime":
      if (value !== null && typeof value !== "string") {
        issues.push({
          code: "INVALID_CONSTANT_TYPE",
          message: `constant for '${field.name}' must be a string or null; got ${typeof value}`,
          path,
        });
      }
      return;
    case "decimal":
    case "integer":
      if (value !== null && typeof value !== "number") {
        issues.push({
          code: "INVALID_CONSTANT_TYPE",
          message: `constant for '${field.name}' must be a number or null; got ${typeof value}`,
          path,
        });
      }
      if (
        t.kind === "integer" &&
        typeof value === "number" &&
        !Number.isInteger(value)
      ) {
        issues.push({
          code: "INVALID_CONSTANT_TYPE",
          message: `constant for '${field.name}' must be an integer; got ${value}`,
          path,
        });
      }
      return;
    case "boolean":
      if (value !== null && typeof value !== "boolean") {
        issues.push({
          code: "INVALID_CONSTANT_TYPE",
          message: `constant for '${field.name}' must be a boolean or null; got ${typeof value}`,
          path,
        });
      }
      return;
    case "enum":
      if (value === null) return;
      if (typeof value !== "string") {
        issues.push({
          code: "INVALID_CONSTANT_TYPE",
          message: `constant for '${field.name}' must be one of ${t.values.join(", ")}; got ${typeof value}`,
          path,
        });
        return;
      }
      if (!t.values.includes(value)) {
        issues.push({
          code: "INVALID_ENUM_CONSTANT",
          message: `constant for '${field.name}' must be one of ${t.values.join(", ")}; got '${value}'`,
          path,
        });
      }
      return;
  }
}

function validateLookupShape(
  lookup: LookupMapping,
  path: string,
  options: ValidateMappingConfigOptions,
  issues: MappingConfigIssue[],
): void {
  if (lookup.kind === "regime_by_code") {
    if (
      typeof (lookup as { value?: unknown }).value !== "string" ||
      (lookup as { value: string }).value.length === 0
    ) {
      issues.push({
        code: "MISSING_LOOKUP_KEY",
        message: `regime_by_code lookup requires a non-empty 'value'`,
        path: `${path}.value`,
      });
    }
    return;
  }

  const cd = lookup as { sourceColumn?: unknown };
  if (typeof cd.sourceColumn !== "string" || cd.sourceColumn.length === 0) {
    issues.push({
      code: "MISSING_LOOKUP_KEY",
      message: `${lookup.kind} lookup requires a non-empty 'sourceColumn'`,
      path: `${path}.sourceColumn`,
    });
    return;
  }
  if (
    options.availableColumns &&
    !options.availableColumns.includes(cd.sourceColumn as string)
  ) {
    issues.push({
      code: "MISSING_SOURCE_COLUMN",
      message: `lookup '${lookup.kind}' references source column '${String(cd.sourceColumn)}' that is not present in the uploaded file`,
      path: `${path}.sourceColumn`,
    });
  }
  if (lookup.kind === "component_by_serial") {
    const ck = (lookup as { componentKind?: unknown }).componentKind;
    if (
      ck !== "engine" &&
      ck !== "propeller" &&
      ck !== "appliance"
    ) {
      issues.push({
        code: "MISSING_COMPONENT_KIND",
        message: `component_by_serial lookup requires 'componentKind' to be one of engine|propeller|appliance`,
        path: `${path}.componentKind`,
      });
    }
  }
}
