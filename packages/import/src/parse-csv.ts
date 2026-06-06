import { Readable } from "node:stream";

import { parse as parseCsvStream } from "fast-csv";

import type { ParsedRow } from "./parser-types.js";

export interface ParseCsvOptions {
  /**
   * 1-based row number assigned to the header. Defaults to 1, matching
   * the operator-visible row number in their spreadsheet. The first
   * data row will therefore be numbered `headerRowNumber + 1`.
   */
  headerRowNumber?: number;
}

/**
 * Streaming CSV parser. Reads UTF-8 CSV from a `Readable` and yields
 * one {@link ParsedRow} per non-empty data row.
 *
 * Why streaming: operator imports can be 50k+ rows (Epic A/V1
 * acceptance). Buffering the whole sheet into memory before mapping
 * would push us past Node's default heap on the smaller Fluid Compute
 * tier and starve the commit pipeline of backpressure.
 *
 * Format handling:
 *   - BOM is stripped (fast-csv handles this when `BOM` option is set).
 *   - Quoted fields with embedded commas, CRLF, and escaped quotes are
 *     handled by fast-csv per RFC 4180.
 *   - Header row defines column names; `raw_cells` keys are those
 *     trimmed header strings.
 *   - Row numbering preserves the operator's source-sheet index so
 *     per-row errors point at the line they can fix in their tool.
 *   - Fully-empty rows are skipped silently; a row with any non-empty
 *     cell flows through (even if some cells are blank).
 */
export async function* parseCsv(
  input: Readable,
  options: ParseCsvOptions = {},
): AsyncGenerator<ParsedRow> {
  const headerRowNumber = options.headerRowNumber ?? 1;

  const stream = input.pipe(
    parseCsvStream({
      // fast-csv 5 strips a UTF-8 BOM from the first line automatically.
      headers: (headers) =>
        headers.map((h) => (typeof h === "string" ? h.trim() : h)),
      ignoreEmpty: true,
      trim: false,
      discardUnmappedColumns: false,
      strictColumnHandling: false,
      skipLines: 0,
    }),
  );

  let dataIndex = 0;
  for await (const record of stream as AsyncIterable<Record<string, string>>) {
    dataIndex += 1;
    const cells: Record<string, string | null> = {};
    let anyNonEmpty = false;
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined || value === null || value === "") {
        cells[key] = null;
      } else {
        cells[key] = value;
        anyNonEmpty = true;
      }
    }
    if (!anyNonEmpty) continue;
    yield { rowNumber: headerRowNumber + dataIndex, raw_cells: cells };
  }
}
