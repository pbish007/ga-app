import type { Readable } from "node:stream";

import ExcelJS from "exceljs";

import type { ParsedRow } from "./parser-types.js";

export interface ParseXlsxOptions {
  /**
   * Sheet selection. If omitted, the first worksheet is used. When
   * supplied, only the named worksheet is processed; other sheets are
   * skipped silently. Surfaced into the V1 importer via
   * `mapping_config.sheet`.
   */
  sheetName?: string;
  /**
   * 1-based row number assigned to the header. Defaults to 1, matching
   * the operator-visible row number in their spreadsheet.
   */
  headerRowNumber?: number;
}

export class XlsxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxParseError";
  }
}

/**
 * XLSX parser yielding one {@link ParsedRow} per non-empty data row.
 *
 * Implementation note: we buffer the input into memory and parse with
 * `Workbook.xlsx.load`. The alternative streaming reader
 * (`stream.xlsx.WorkbookReader`) does not surface merged-cell
 * metadata — `cell.isMerged` is always false — so detecting merges
 * (an acceptance requirement) is impossible there. For the V1
 * importer's 50k-row target, the in-memory workbook footprint is well
 * within a Vercel Function's memory budget; we still yield rows
 * lazily through this async generator so downstream consumers (the
 * mapping engine, the commit pipeline) keep their own state bounded.
 *
 * Behavioral choices:
 *   - First worksheet is the default when `sheetName` is not set.
 *   - Selecting a sheet by name that does not exist throws
 *     {@link XlsxParseError} with a clear message rather than yielding
 *     an empty iterable.
 *   - Merged cells are rejected at the first occurrence with a clear
 *     error: silently picking the master value or `null` for the
 *     covered cells would hide intent and corrupt the mapping.
 *   - Formula cells surface their *calculated* result (the value the
 *     operator sees in Excel).
 *   - Date cells surface as ISO `YYYY-MM-DD` strings so the same date
 *     coercer in the mapping engine handles CSV and XLSX inputs.
 *   - Row numbers track the worksheet's own row index, preserving the
 *     operator's source-sheet line numbers even when blank rows are
 *     skipped.
 */
export async function* parseXlsx(
  input: Readable,
  options: ParseXlsxOptions = {},
): AsyncGenerator<ParsedRow> {
  const headerRowNumber = options.headerRowNumber ?? 1;
  const wantedSheet = options.sheetName;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.read(input);

  if (wb.worksheets.length === 0) {
    throw new XlsxParseError("XLSX contains no worksheets");
  }

  const worksheet =
    wantedSheet === undefined
      ? wb.worksheets[0]!
      : wb.getWorksheet(wantedSheet);

  if (!worksheet) {
    throw new XlsxParseError(
      `XLSX has no worksheet named '${wantedSheet ?? ""}'`,
    );
  }

  // Read header row once. Column positions in headers are 1-indexed
  // to match ExcelJS' sparse `row.values` array.
  const headerRow = worksheet.getRow(headerRowNumber);
  const headers: (string | null)[] = [];
  const values = (headerRow.values as ExcelJS.CellValue[]) ?? [];
  for (let i = 1; i < values.length; i++) {
    const text = cellToString(values[i]);
    headers.push(text === null ? null : text.trim());
  }

  // eachRow iterates only over rows present in the worksheet — gaps
  // skipped automatically. `includeEmpty: false` keeps memory and
  // iteration bounded.
  const dataRows: ExcelJS.Row[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    if (row.number === headerRowNumber || row.number < headerRowNumber) return;
    dataRows.push(row);
  });

  for (const row of dataRows) {
    const cells = readDataRow(row, headers, row.number);
    if (cells === null) continue;
    yield { rowNumber: row.number, raw_cells: cells };
  }
}

type CellValue = string | number | boolean | null;

function readDataRow(
  row: ExcelJS.Row,
  headers: (string | null)[],
  rowNumber: number,
): Record<string, CellValue> | null {
  const cells: Record<string, CellValue> = {};
  let anyNonEmpty = false;

  const values = (row.values as ExcelJS.CellValue[]) ?? [];
  for (let i = 1; i < Math.max(values.length, headers.length + 1); i++) {
    const header = headers[i - 1];
    if (header === null || header === undefined || header === "") continue;

    const cell = row.getCell(i);
    if (cell.isMerged) {
      throw new XlsxParseError(
        `XLSX row ${rowNumber} cell '${header}' is part of a merged range; ` +
          `unmerge cells before importing`,
      );
    }
    const value = normalizeCellValue(values[i]);
    cells[header] = value;
    if (value !== null && value !== "") anyNonEmpty = true;
  }

  return anyNonEmpty ? cells : null;
}

/**
 * Reduce an `ExcelJS.CellValue` to a JSON-friendly primitive. Formula
 * cells surface their calculated result; rich-text and hyperlink cells
 * surface their visible text. Dates are emitted as ISO date strings
 * so they flow through the same date-format coercer as CSV inputs.
 */
function normalizeCellValue(raw: ExcelJS.CellValue): CellValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return raw;
  if (typeof raw === "boolean") return raw;
  if (raw instanceof Date) return formatDate(raw);
  if (typeof raw === "object") {
    if ("result" in raw && raw.result !== undefined && raw.result !== null) {
      return normalizeCellValue(raw.result as ExcelJS.CellValue);
    }
    if ("text" in raw && typeof (raw as { text: unknown }).text === "string") {
      return (raw as { text: string }).text;
    }
    if (
      "richText" in raw &&
      Array.isArray((raw as { richText: { text: string }[] }).richText)
    ) {
      return (raw as { richText: { text: string }[] }).richText
        .map((p) => p.text)
        .join("");
    }
    if ("error" in raw) {
      // Excel error cells (#N/A, #REF!, …) surface as a string so the
      // mapping engine's coercer can fail loudly rather than silently
      // treating them as null.
      return String((raw as { error: string }).error);
    }
  }
  return null;
}

function cellToString(raw: ExcelJS.CellValue): string | null {
  const norm = normalizeCellValue(raw);
  if (norm === null) return null;
  return String(norm);
}

function formatDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}
