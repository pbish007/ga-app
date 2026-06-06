import { Readable } from "node:stream";

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  parseXlsx,
  XlsxParseError,
  type ParsedRow,
} from "../src/index.js";

/**
 * PMB-158 / C2 — XLSX parser tests.
 *
 * Acceptance line items covered here:
 *   - first worksheet by default; explicit sheet-by-name selection
 *   - missing requested sheet → clear error
 *   - merged cells rejected with a clear error
 *   - formulas surface their calculated result (not the formula text)
 *   - empty rows skipped; source-sheet row numbers preserved
 *   - boolean and number cells flow through as primitives (the
 *     mapping engine handles coercion to target field types)
 *   - date cells surface as ISO `YYYY-MM-DD` strings so the same
 *     coercer path serves CSV and XLSX inputs
 */

async function buildWorkbook(
  configure: (wb: ExcelJS.Workbook) => void,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  configure(wb);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

async function collect(
  buf: Buffer,
  sheetName?: string,
): Promise<ParsedRow[]> {
  const rows: ParsedRow[] = [];
  for await (const row of parseXlsx(Readable.from(buf), { sheetName })) {
    rows.push(row);
  }
  return rows;
}

describe("parseXlsx", () => {
  it("parses the first worksheet by default", async () => {
    const buf = await buildWorkbook((wb) => {
      const ws = wb.addWorksheet("Aircraft");
      ws.addRow(["Tail", "Make", "Model"]);
      ws.addRow(["N12345", "Cessna", "172N"]);
      ws.addRow(["N67890", "Piper", "PA28"]);
    });
    const rows = await collect(buf);
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 3]);
    expect(rows[0]!.raw_cells).toEqual({
      Tail: "N12345",
      Make: "Cessna",
      Model: "172N",
    });
  });

  it("honors sheet selection by name", async () => {
    const buf = await buildWorkbook((wb) => {
      const a = wb.addWorksheet("First");
      a.addRow(["Tail"]);
      a.addRow(["WRONG"]);
      const b = wb.addWorksheet("Imports");
      b.addRow(["Tail"]);
      b.addRow(["N12345"]);
    });
    const rows = await collect(buf, "Imports");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw_cells.Tail).toBe("N12345");
  });

  it("throws a clear error when the named sheet is missing", async () => {
    const buf = await buildWorkbook((wb) => {
      wb.addWorksheet("Only").addRow(["Tail"]);
    });
    await expect(collect(buf, "Imports")).rejects.toThrow(XlsxParseError);
    await expect(collect(buf, "Imports")).rejects.toThrow(/Imports/);
  });

  it("rejects merged cells with a clear error pointing at the row", async () => {
    const buf = await buildWorkbook((wb) => {
      const ws = wb.addWorksheet("Aircraft");
      ws.addRow(["Tail", "Make", "Model"]);
      ws.addRow(["N12345", "Cessna", "172N"]);
      // Merge B2 and B3 so row 3's "Make" cell is part of a merge.
      ws.addRow(["N67890", null, "PA28"]);
      ws.mergeCells("B2:B3");
    });
    await expect(collect(buf)).rejects.toThrow(XlsxParseError);
    await expect(collect(buf)).rejects.toThrow(/merged/i);
  });

  it("reads the calculated value from a formula cell", async () => {
    const buf = await buildWorkbook((wb) => {
      const ws = wb.addWorksheet("Aircraft");
      ws.addRow(["Tail", "Hours"]);
      const row = ws.addRow(["N12345", null]);
      row.getCell(2).value = { formula: "100+50", result: 150 };
    });
    const rows = await collect(buf);
    expect(rows[0]!.raw_cells.Hours).toBe(150);
  });

  it("skips fully empty rows but keeps source-sheet row numbers", async () => {
    const buf = await buildWorkbook((wb) => {
      const ws = wb.addWorksheet("Aircraft");
      ws.addRow(["Tail", "Make"]);
      ws.addRow(["N1", "Cessna"]);
      ws.addRow([null, null]);
      ws.addRow(["N2", "Piper"]);
    });
    const rows = await collect(buf);
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 4]);
    expect(rows.map((r) => r.raw_cells.Tail)).toEqual(["N1", "N2"]);
  });

  it("surfaces booleans and numbers as primitives", async () => {
    const buf = await buildWorkbook((wb) => {
      const ws = wb.addWorksheet("FlightTime");
      ws.addRow(["Tail", "Hours", "Override"]);
      ws.addRow(["N1", 1234.5, true]);
    });
    const rows = await collect(buf);
    expect(rows[0]!.raw_cells.Hours).toBe(1234.5);
    expect(rows[0]!.raw_cells.Override).toBe(true);
  });

  it("formats date cells as ISO YYYY-MM-DD strings", async () => {
    const buf = await buildWorkbook((wb) => {
      const ws = wb.addWorksheet("Maintenance");
      ws.addRow(["Tail", "Performed"]);
      const row = ws.addRow(["N1", null]);
      row.getCell(2).value = new Date(Date.UTC(2024, 2, 14));
    });
    const rows = await collect(buf);
    expect(rows[0]!.raw_cells.Performed).toBe("2024-03-14");
  });

  it("treats blank cells in otherwise-present rows as null", async () => {
    const buf = await buildWorkbook((wb) => {
      const ws = wb.addWorksheet("Aircraft");
      ws.addRow(["Tail", "Make", "Model"]);
      ws.addRow(["N1", null, "PA28"]);
    });
    const rows = await collect(buf);
    expect(rows[0]!.raw_cells).toEqual({
      Tail: "N1",
      Make: null,
      Model: "PA28",
    });
  });

  it("throws when the workbook has no worksheets", async () => {
    const buf = await buildWorkbook(() => {
      // intentionally empty
    });
    await expect(collect(buf)).rejects.toThrow(XlsxParseError);
  });
});
