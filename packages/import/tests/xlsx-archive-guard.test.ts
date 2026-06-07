import { Readable } from "node:stream";

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_UNCOMPRESSED_BYTES,
  HARD_MAX_UNCOMPRESSED_BYTES,
  MAX_COMPRESSION_RATIO,
  MAX_ENTRY_COUNT,
  XlsxArchiveRejectedError,
  inspectXlsxArchive,
  parseXlsx,
  resolveArchiveLimits,
  type ArchiveLimits,
} from "../src/index.js";

/**
 * PMB-193 / PMB-205 — zip-bomb guard regression matrix.
 *
 * Covers SE's 9-case spec from [PMB-205](/PMB/issues/PMB-205):
 *   T1 total over cap        T2 single-entry bomb
 *   T3 ratio anomaly         T4 entry-count explosion
 *   T5 exactly at cap        T6 one byte over cap
 *   T7 malformed CDR         T8 wrong content type
 *   T9 happy-path regression
 *
 * The guard runs synchronously on raw bytes — it walks the central
 * directory record without decompressing any entry. Cap-before-parse
 * is enforced by inspecting the byte path: when the guard throws,
 * ExcelJS is never instantiated.
 */

const smallLimits: ArchiveLimits = {
  maxTotalUncompressedBytes: 4096,
  maxEntryUncompressedBytes: 4096,
  maxEntryCount: 16,
  maxCompressionRatio: 200,
};

// ---------------------------------------------------------------------------
// ZIP forger — emits a structurally valid CDR with the requested per-entry
// (compressedSize, uncompressedSize). We don't need real Local File Headers
// or compressed payloads because the guard only walks the central directory.
// ---------------------------------------------------------------------------

interface ForgedEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

function forgeZip(entries: ForgedEntry[]): Uint8Array {
  const lfhFiller = Buffer.alloc(1, 0);
  const cdrChunks: Buffer[] = [];
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const headerLen = 46 + nameBuf.length;
    const header = Buffer.alloc(headerLen);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x14, 4);
    header.writeUInt16LE(0x14, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(entry.compressedSize, 20);
    header.writeUInt32LE(entry.uncompressedSize, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(0, 42);
    nameBuf.copy(header, 46);
    cdrChunks.push(header);
  }
  const cdr = Buffer.concat(cdrChunks);
  const cdrOffset = lfhFiller.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdr.length, 12);
  eocd.writeUInt32LE(cdrOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([lfhFiller, cdr, eocd]));
}

async function buildRealWorkbook(rows: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Data");
  ws.addRow(["Tail", "Make", "Model"]);
  for (let i = 0; i < rows; i++) {
    ws.addRow([`N${1000 + i}`, "Cessna", "172N"]);
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

function realUncompressedTotal(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("test fixture missing EOCD");
  const cdrOffset = view.getUint32(eocd + 16, true);
  const cdrSize = view.getUint32(eocd + 12, true);
  const total = view.getUint16(eocd + 10, true);
  let cursor = cdrOffset;
  let sum = 0;
  for (let i = 0; i < total && cursor < cdrOffset + cdrSize; i++) {
    sum += view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return sum;
}

describe("inspectXlsxArchive — SE regression matrix", () => {
  it("T1: rejects when sum of uncompressed sizes exceeds total cap", () => {
    const zip = forgeZip([
      { name: "a.xml", compressedSize: 500, uncompressedSize: 2000 },
      { name: "b.xml", compressedSize: 500, uncompressedSize: 2200 },
      { name: "c.xml", compressedSize: 500, uncompressedSize: 2000 },
    ]);
    expect(() => inspectXlsxArchive(zip, smallLimits)).toThrow(
      XlsxArchiveRejectedError,
    );
    try {
      inspectXlsxArchive(zip, smallLimits);
    } catch (err) {
      const e = err as XlsxArchiveRejectedError;
      expect(e.code).toBe("upload_too_large_uncompressed");
      expect(e.httpStatus).toBe(413);
      expect(e.limitBytes).toBe(smallLimits.maxTotalUncompressedBytes);
      expect(e.audit.totalUncompressedBytes).toBeGreaterThan(
        smallLimits.maxTotalUncompressedBytes,
      );
    }
  });

  it("T2: rejects a single entry whose uncompressed size exceeds the cap", () => {
    const zip = forgeZip([
      { name: "a.xml", compressedSize: 100, uncompressedSize: 100 },
      { name: "huge.xml", compressedSize: 100, uncompressedSize: 5000 },
    ]);
    try {
      inspectXlsxArchive(zip, smallLimits);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(XlsxArchiveRejectedError);
      const e = err as XlsxArchiveRejectedError;
      expect(e.code).toBe("upload_too_large_uncompressed");
      expect(e.httpStatus).toBe(413);
    }
  });

  it("T3: rejects entry with compression ratio above 200x", () => {
    const zip = forgeZip([
      { name: "a.xml", compressedSize: 3, uncompressedSize: 1500 },
    ]);
    try {
      inspectXlsxArchive(zip, smallLimits);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(XlsxArchiveRejectedError);
      const e = err as XlsxArchiveRejectedError;
      expect(e.code).toBe("upload_compression_ratio");
      expect(e.httpStatus).toBe(400);
      expect(e.audit.peakCompressionRatio).toBeGreaterThan(200);
    }
  });

  it("T4: rejects archives with more than 1024 entries", () => {
    const entries: ForgedEntry[] = [];
    for (let i = 0; i < MAX_ENTRY_COUNT + 5; i++) {
      entries.push({
        name: `e${i}.xml`,
        compressedSize: 10,
        uncompressedSize: 10,
      });
    }
    const zip = forgeZip(entries);
    try {
      inspectXlsxArchive(zip);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(XlsxArchiveRejectedError);
      const e = err as XlsxArchiveRejectedError;
      expect(e.code).toBe("upload_too_many_entries");
      expect(e.httpStatus).toBe(400);
      expect(e.limitBytes).toBe(MAX_ENTRY_COUNT);
    }
  });

  it("T5: accepts a workbook whose total uncompressed size equals the cap", async () => {
    const buf = await buildRealWorkbook(5);
    const total = realUncompressedTotal(buf);
    const limits: ArchiveLimits = {
      maxTotalUncompressedBytes: total,
      maxEntryUncompressedBytes: total,
      maxEntryCount: MAX_ENTRY_COUNT,
      maxCompressionRatio: MAX_COMPRESSION_RATIO,
    };
    const audit = inspectXlsxArchive(buf, limits);
    expect(audit.totalUncompressedBytes).toBe(total);
  });

  it("T6: rejects a workbook whose total uncompressed size is one byte over the cap", async () => {
    const buf = await buildRealWorkbook(5);
    const total = realUncompressedTotal(buf);
    const limits: ArchiveLimits = {
      maxTotalUncompressedBytes: total - 1,
      maxEntryUncompressedBytes: total,
      maxEntryCount: MAX_ENTRY_COUNT,
      maxCompressionRatio: MAX_COMPRESSION_RATIO,
    };
    try {
      inspectXlsxArchive(buf, limits);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(XlsxArchiveRejectedError);
      const e = err as XlsxArchiveRejectedError;
      expect(e.code).toBe("upload_too_large_uncompressed");
      expect(e.httpStatus).toBe(413);
      expect(e.limitBytes).toBe(total - 1);
    }
  });

  it("T7: rejects bytes without a valid EOCD record", () => {
    const junk = new Uint8Array(Buffer.from("not a zip at all, just text"));
    try {
      inspectXlsxArchive(junk);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(XlsxArchiveRejectedError);
      const e = err as XlsxArchiveRejectedError;
      expect(e.code).toBe("upload_invalid_xlsx");
      expect(e.httpStatus).toBe(400);
    }
  });

  it("T7b: rejects bytes too small to contain an EOCD", () => {
    const tiny = new Uint8Array([0, 1, 2]);
    try {
      inspectXlsxArchive(tiny);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(XlsxArchiveRejectedError);
      expect((err as XlsxArchiveRejectedError).code).toBe(
        "upload_invalid_xlsx",
      );
    }
  });

  it("T7c: rejects archives whose CDR extends past the byte buffer", () => {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(10_000_000, 12);
    eocd.writeUInt32LE(0, 16);
    eocd.writeUInt16LE(0, 20);
    try {
      inspectXlsxArchive(new Uint8Array(eocd));
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(XlsxArchiveRejectedError);
      expect((err as XlsxArchiveRejectedError).code).toBe(
        "upload_invalid_xlsx",
      );
    }
  });

  it("T8: rejects a non-XLSX payload (no central directory)", () => {
    const csvBytes = new Uint8Array(
      Buffer.from("Tail,Make,Model\nN1,Cessna,172N\n", "utf8"),
    );
    try {
      inspectXlsxArchive(csvBytes);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(XlsxArchiveRejectedError);
      expect((err as XlsxArchiveRejectedError).code).toBe(
        "upload_invalid_xlsx",
      );
    }
  });

  it("T9: a real workbook well under the default cap inspects cleanly", async () => {
    const buf = await buildRealWorkbook(50);
    const audit = inspectXlsxArchive(buf);
    expect(audit.entryCount).toBeGreaterThan(0);
    expect(audit.totalUncompressedBytes).toBeGreaterThan(0);
    expect(audit.totalUncompressedBytes).toBeLessThan(
      DEFAULT_MAX_UNCOMPRESSED_BYTES,
    );
  });
});

describe("parseXlsx — cap is enforced before parse", () => {
  it("throws XlsxArchiveRejectedError on a real workbook over the override cap", async () => {
    const buf = await buildRealWorkbook(20);
    const tinyLimits: ArchiveLimits = {
      maxTotalUncompressedBytes: 32,
      maxEntryUncompressedBytes: 32,
      maxEntryCount: MAX_ENTRY_COUNT,
      maxCompressionRatio: MAX_COMPRESSION_RATIO,
    };
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _row of parseXlsx(Readable.from(buf), {
        archiveLimits: tinyLimits,
      })) {
        /* unreachable on rejected archive */
      }
    }).rejects.toBeInstanceOf(XlsxArchiveRejectedError);
  });

  it("does NOT instantiate ExcelJS on a rejected archive (cap-before-parse invariant)", async () => {
    const originalWorkbook = ExcelJS.Workbook;
    let constructed = 0;
    (ExcelJS as unknown as { Workbook: unknown }).Workbook = class {
      constructor() {
        constructed++;
      }
    };
    try {
      const wb = new originalWorkbook();
      const ws = wb.addWorksheet("Data");
      ws.addRow(["Tail"]);
      for (let i = 0; i < 10; i++) ws.addRow([`N${i}`]);
      const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
      const tinyLimits: ArchiveLimits = {
        maxTotalUncompressedBytes: 16,
        maxEntryUncompressedBytes: 16,
        maxEntryCount: MAX_ENTRY_COUNT,
        maxCompressionRatio: MAX_COMPRESSION_RATIO,
      };
      // Reset counter — the workbook we built above used the real ctor
      // before the spy was installed.
      constructed = 0;
      try {
        for await (const _row of parseXlsx(Readable.from(buf), {
          archiveLimits: tinyLimits,
        })) {
          /* unreachable */
        }
      } catch (err) {
        expect(err).toBeInstanceOf(XlsxArchiveRejectedError);
      }
      expect(constructed).toBe(0);
    } finally {
      (ExcelJS as unknown as { Workbook: unknown }).Workbook =
        originalWorkbook;
    }
  });

  it("parses a real workbook normally when within the default cap", async () => {
    const buf = await buildRealWorkbook(3);
    const rows: { rowNumber: number; raw_cells: Record<string, unknown> }[] =
      [];
    for await (const row of parseXlsx(Readable.from(buf))) {
      rows.push(row);
    }
    expect(rows).toHaveLength(3);
    expect(rows[0]!.raw_cells.Tail).toBe("N1000");
  });
});

describe("resolveArchiveLimits", () => {
  it("returns defaults when env var is unset", () => {
    const limits = resolveArchiveLimits({});
    expect(limits.maxTotalUncompressedBytes).toBe(
      DEFAULT_MAX_UNCOMPRESSED_BYTES,
    );
    expect(limits.maxEntryCount).toBe(MAX_ENTRY_COUNT);
    expect(limits.maxCompressionRatio).toBe(MAX_COMPRESSION_RATIO);
  });

  it("honors a positive env override below the hard ceiling", () => {
    const limits = resolveArchiveLimits({
      IMPORT_XLSX_MAX_UNCOMPRESSED_BYTES: String(50 * 1024 * 1024),
    });
    expect(limits.maxTotalUncompressedBytes).toBe(50 * 1024 * 1024);
    expect(limits.maxEntryUncompressedBytes).toBe(50 * 1024 * 1024);
  });

  it("clamps env overrides above the hard ceiling", () => {
    const limits = resolveArchiveLimits({
      IMPORT_XLSX_MAX_UNCOMPRESSED_BYTES: String(10 * 1024 * 1024 * 1024),
    });
    expect(limits.maxTotalUncompressedBytes).toBe(HARD_MAX_UNCOMPRESSED_BYTES);
  });

  it("falls back to default for non-numeric, zero, or negative values", () => {
    for (const v of ["abc", "0", "-1", " ", ""]) {
      const limits = resolveArchiveLimits({
        IMPORT_XLSX_MAX_UNCOMPRESSED_BYTES: v,
      });
      expect(limits.maxTotalUncompressedBytes).toBe(
        DEFAULT_MAX_UNCOMPRESSED_BYTES,
      );
    }
  });
});
