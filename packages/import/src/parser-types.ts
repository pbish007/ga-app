/**
 * The shape the C2 parser (PMB-158) yields per source row. The mapping
 * engine in this package consumes this shape and produces a
 * `MappedRow` that the commit pipeline (PMB-161 / C5) writes into
 * `import_job_rows.mapped_payload`.
 *
 * `rowNumber` is the operator-visible 1-indexed row position in the
 * source spreadsheet (row 1 is the header in a default CSV/XLSX).
 *
 * `raw_cells` is a column-name → cell-value map. Values are kept
 * close to the raw form the parser saw: XLSX surfaces numbers and
 * booleans as primitives, CSV always surfaces strings. The mapping
 * engine handles the coercion to target field types based on the
 * `format` declared in the mapping config.
 *
 * Empty/blank cells are represented by `null` or empty string; a
 * column absent from the row entirely surfaces as `undefined`.
 */
export interface ParsedRow {
  rowNumber: number;
  raw_cells: Record<string, string | number | boolean | null>;
}

/**
 * Output of the mapping engine for one row. `mapped` is the value the
 * commit pipeline will store in `import_job_rows.mapped_payload`.
 * `errors` carries any per-field issues the engine detected
 * (format coercion failures, lookup misses); the per-entity validator
 * (PMB-160 / C4) folds these in with its own checks before deciding
 * the row's final `validation_status`.
 */
export interface MappedRow {
  mapped: Record<string, unknown>;
  errors: MappingError[];
}

export type MappingErrorCode =
  | "FORMAT_ERROR"
  | "LOOKUP_MISS"
  | "LOOKUP_ERROR"
  | "MISSING_COLUMN"
  | "TYPE_MISMATCH";

export interface MappingError {
  field: string;
  column?: string;
  rowNumber: number;
  message: string;
  code: MappingErrorCode;
}
