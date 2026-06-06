import type { ColumnFormat } from "./mapping-config.js";

export class CoercionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoercionError";
  }
}

const DEFAULT_TRUTHY = new Set(["true", "yes", "y", "1"]);
const DEFAULT_FALSY = new Set(["false", "no", "n", "0", ""]);

/**
 * Coerce a raw parser cell into the JSON-friendly value the mapping
 * engine writes to `mapped_payload`.
 *
 * Returns `null` for cells that are explicitly null/undefined/empty
 * after trimming — the engine treats that as "field absent" and lets
 * the per-entity validator (PMB-160) decide whether that's an error.
 *
 * Throws {@link CoercionError} when the cell is present but cannot be
 * parsed as the requested format (e.g. "abc" as decimal). The engine
 * folds those into per-row `MappingError` entries.
 */
export function coerce(
  raw: string | number | boolean | null | undefined,
  format: ColumnFormat,
): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;

  switch (format.kind) {
    case "text":
      return coerceText(raw, format.trim ?? true);
    case "decimal":
      return coerceDecimal(raw);
    case "integer":
      return coerceInteger(raw);
    case "date":
      return coerceDate(raw, format.format ?? "ISO");
    case "datetime":
      return coerceDateTime(raw);
    case "boolean":
      return coerceBoolean(
        raw,
        format.truthy ?? Array.from(DEFAULT_TRUTHY),
        format.falsy ?? Array.from(DEFAULT_FALSY),
      );
  }
}

function coerceText(
  raw: string | number | boolean,
  trim: boolean,
): string {
  const s = String(raw);
  return trim ? s.trim() : s;
}

function coerceDecimal(raw: string | number | boolean): number {
  if (typeof raw === "boolean") {
    throw new CoercionError(`cannot read decimal from boolean '${raw}'`);
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new CoercionError(`decimal must be finite; got ${raw}`);
    }
    return raw;
  }
  // Tolerate thousands separators in the en-US sense ("1,234.56").
  const trimmed = raw.trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new CoercionError(`'${raw}' is not a valid decimal`);
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    throw new CoercionError(`'${raw}' overflowed decimal parsing`);
  }
  return n;
}

function coerceInteger(raw: string | number | boolean): number {
  const n = coerceDecimal(raw);
  if (!Number.isInteger(n)) {
    throw new CoercionError(`'${raw}' is not an integer`);
  }
  return n;
}

function coerceBoolean(
  raw: string | number | boolean,
  truthy: string[],
  falsy: string[],
): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") {
    if (raw === 1) return true;
    if (raw === 0) return false;
    throw new CoercionError(`'${raw}' is not a recognized boolean`);
  }
  const norm = raw.trim().toLowerCase();
  const truthySet = new Set(truthy.map((s) => s.toLowerCase()));
  const falsySet = new Set(falsy.map((s) => s.toLowerCase()));
  if (truthySet.has(norm)) return true;
  if (falsySet.has(norm)) return false;
  throw new CoercionError(`'${raw}' is not a recognized boolean`);
}

/**
 * Parse a date cell into an ISO calendar-date string (`YYYY-MM-DD`).
 * The PG `date` column kind we target (e.g. maintenance_entries.performed_on)
 * accepts this shape directly.
 */
function coerceDate(
  raw: string | number | boolean,
  format: "ISO" | "MM/DD/YYYY" | "DD/MM/YYYY",
): string {
  if (typeof raw === "boolean") {
    throw new CoercionError(`cannot read date from boolean '${raw}'`);
  }
  if (typeof raw === "number") {
    // Reject numeric dates outright. XLSX parsers (C2) are expected to
    // surface dates as ISO strings; raw serial numbers would silently
    // misparse here.
    throw new CoercionError(
      `numeric date cell '${raw}' is not supported; the parser should yield an ISO string`,
    );
  }
  const s = raw.trim();
  if (format === "ISO") {
    // Accept "YYYY-MM-DD" or full ISO datetime; emit "YYYY-MM-DD".
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
    if (!m) throw new CoercionError(`'${raw}' is not an ISO date`);
    return assembleDate(m[1]!, m[2]!, m[3]!, raw);
  }
  const isUS = format === "MM/DD/YYYY";
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) throw new CoercionError(`'${raw}' is not a ${format} date`);
  const a = m[1]!.padStart(2, "0");
  const b = m[2]!.padStart(2, "0");
  const year = m[3]!;
  const month = isUS ? a : b;
  const day = isUS ? b : a;
  return assembleDate(year, month, day, raw);
}

function assembleDate(
  year: string,
  month: string,
  day: string,
  raw: string | number | boolean,
): string {
  const mi = Number(month);
  const di = Number(day);
  if (mi < 1 || mi > 12 || di < 1 || di > 31) {
    throw new CoercionError(`'${raw}' has out-of-range month/day`);
  }
  return `${year}-${month}-${day}`;
}

function coerceDateTime(raw: string | number | boolean): string {
  if (typeof raw === "boolean") {
    throw new CoercionError(`cannot read datetime from boolean '${raw}'`);
  }
  if (typeof raw === "number") {
    throw new CoercionError(
      `numeric datetime cell '${raw}' is not supported`,
    );
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new CoercionError(`'${raw}' is not a valid datetime`);
  }
  return d.toISOString();
}
