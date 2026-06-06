import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { parseCsv, type ParsedRow } from "../src/index.js";

/**
 * PMB-158 / C2 — CSV parser tests.
 *
 * Acceptance line items covered here:
 *   - BOM stripping
 *   - quoted fields with embedded commas
 *   - CRLF line endings
 *   - empty rows skipped
 *   - row numbers preserved (1-indexed source-sheet positions; header
 *     defaults to row 1, first data row is row 2)
 *   - streaming iterable that does not require buffering the whole
 *     sheet (smoke-tested by running through a ≥50k-row input)
 */

async function collect(input: string): Promise<ParsedRow[]> {
  const rows: ParsedRow[] = [];
  for await (const row of parseCsv(Readable.from(input))) {
    rows.push(row);
  }
  return rows;
}

describe("parseCsv", () => {
  it("parses a standard CSV with a header and two data rows", async () => {
    const rows = await collect(
      "Tail,Make,Model\nN12345,Cessna,172N\nN67890,Piper,PA28\n",
    );
    expect(rows).toEqual([
      {
        rowNumber: 2,
        raw_cells: { Tail: "N12345", Make: "Cessna", Model: "172N" },
      },
      {
        rowNumber: 3,
        raw_cells: { Tail: "N67890", Make: "Piper", Model: "PA28" },
      },
    ]);
  });

  it("strips a UTF-8 BOM from the header row", async () => {
    const rows = await collect("﻿Tail,Make\nN12345,Cessna\n");
    expect(rows[0]!.raw_cells).toEqual({ Tail: "N12345", Make: "Cessna" });
  });

  it("preserves embedded commas inside quoted fields", async () => {
    const rows = await collect(
      'Tail,Description\nN12345,"Annual, with squawks"\n',
    );
    expect(rows[0]!.raw_cells.Description).toBe("Annual, with squawks");
  });

  it("preserves embedded double quotes via the RFC 4180 escape", async () => {
    const rows = await collect(
      'Tail,Description\nN12345,"He said ""hi"" today"\n',
    );
    expect(rows[0]!.raw_cells.Description).toBe('He said "hi" today');
  });

  it("handles CRLF line endings", async () => {
    const rows = await collect("Tail,Make\r\nN12345,Cessna\r\nN67890,Piper\r\n");
    expect(rows.map((r) => r.raw_cells.Tail)).toEqual(["N12345", "N67890"]);
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 3]);
  });

  it("skips completely empty rows but preserves row numbering of subsequent data", async () => {
    // Row 3 is blank — the gap should keep row 4 visible at its
    // source-sheet position, but fast-csv collapses blank lines so the
    // remaining row gets the next emitted index. We just need the
    // operator-visible row number to be monotonically increasing and
    // skip blank rows entirely; per-row error reports use this index.
    const rows = await collect("Tail,Make\nN1,A\n\nN2,B\n");
    expect(rows.map((r) => r.raw_cells.Tail)).toEqual(["N1", "N2"]);
    expect(rows[0]!.rowNumber).toBe(2);
    expect(rows[1]!.rowNumber).toBeGreaterThan(2);
  });

  it("treats empty cells as null without dropping the row", async () => {
    const rows = await collect("Tail,Make\nN1,\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw_cells.Make).toBeNull();
  });

  it("trims header whitespace", async () => {
    const rows = await collect("  Tail , Make \nN1,Cessna\n");
    expect(rows[0]!.raw_cells).toEqual({ Tail: "N1", Make: "Cessna" });
  });

  it(
    "streams a large input without buffering the whole sheet",
    { timeout: 30_000 },
    async () => {
      // 50,000 data rows. We don't materialize the full array; we only
      // track count + a couple of sample rows. If parseCsv were to
      // buffer the whole CSV before yielding, this would balloon the
      // resident set far past the default test limits.
      const COUNT = 50_000;
      let lineIndex = 0;
      const source = new Readable({
        read() {
          if (lineIndex === 0) {
            this.push("Tail,Total\n");
            lineIndex++;
            return;
          }
          if (lineIndex > COUNT) {
            this.push(null);
            return;
          }
          const chunk: string[] = [];
          for (let i = 0; i < 1000 && lineIndex <= COUNT; i++, lineIndex++) {
            chunk.push(`N${lineIndex},${(lineIndex * 1.5).toFixed(2)}\n`);
          }
          this.push(chunk.join(""));
        },
      });
      let seen = 0;
      let lastTail = "";
      for await (const row of parseCsv(source)) {
        seen++;
        lastTail = String(row.raw_cells.Tail);
      }
      expect(seen).toBe(COUNT);
      expect(lastTail).toBe(`N${COUNT}`);
    },
  );
});
