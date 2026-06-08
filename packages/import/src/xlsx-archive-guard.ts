/**
 * XLSX zip-bomb guard. Walks the ZIP central directory record and
 * rejects archives whose uncompressed size, entry count, or per-entry
 * compression ratio exceeds the configured caps — BEFORE ExcelJS /
 * JSZip is allowed to decompress any entry. Class: OWASP API4
 * (Unrestricted Resource Consumption); see PMB-193 / PMB-205 for the
 * threshold rationale.
 *
 * No external dependency: we read the End of Central Directory record
 * and walk per-entry Central Directory File Headers ourselves. This is
 * the cheapest possible check — no allocation of decompressed bytes,
 * no JSZip object graph — and it does not depend on JSZip's private
 * API.
 */

/** 100 MiB. Below the AC's 250 MB suggestion; see PMB-205. */
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

/** Hard ceiling — env override may not exceed this. */
export const HARD_MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;

export const MAX_ENTRY_COUNT = 1024;
export const MAX_COMPRESSION_RATIO = 200;

/** Env var name. Value parsed as positive integer bytes. */
export const ENV_MAX_UNCOMPRESSED = "IMPORT_XLSX_MAX_UNCOMPRESSED_BYTES";

export interface ArchiveLimits {
  maxTotalUncompressedBytes: number;
  maxEntryUncompressedBytes: number;
  maxEntryCount: number;
  maxCompressionRatio: number;
}

export interface ArchiveAuditFields {
  compressedArchiveBytes: number;
  totalUncompressedBytes: number;
  entryCount: number;
  largestEntryUncompressedBytes: number;
  peakCompressionRatio: number;
}

export type ArchiveRejectionCode =
  | "upload_too_large_uncompressed"
  | "upload_too_many_entries"
  | "upload_compression_ratio"
  | "upload_invalid_xlsx";

export class XlsxArchiveRejectedError extends Error {
  readonly code: ArchiveRejectionCode;
  readonly httpStatus: 413 | 400;
  readonly limitBytes: number;
  readonly audit: ArchiveAuditFields;

  constructor(args: {
    code: ArchiveRejectionCode;
    message: string;
    httpStatus: 413 | 400;
    limitBytes: number;
    audit: ArchiveAuditFields;
  }) {
    super(args.message);
    this.name = "XlsxArchiveRejectedError";
    this.code = args.code;
    this.httpStatus = args.httpStatus;
    this.limitBytes = args.limitBytes;
    this.audit = args.audit;
  }
}

/**
 * Resolve limits from env. Env override clamped to
 * {@link HARD_MAX_UNCOMPRESSED_BYTES}; invalid / non-positive values
 * fall back to the default — no implicit unlimited fallback.
 */
export function resolveArchiveLimits(
  env: Record<string, string | undefined> = process.env,
): ArchiveLimits {
  const raw = env[ENV_MAX_UNCOMPRESSED];
  let max = DEFAULT_MAX_UNCOMPRESSED_BYTES;
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      max = Math.min(parsed, HARD_MAX_UNCOMPRESSED_BYTES);
    }
  }
  return {
    maxTotalUncompressedBytes: max,
    maxEntryUncompressedBytes: max,
    maxEntryCount: MAX_ENTRY_COUNT,
    maxCompressionRatio: MAX_COMPRESSION_RATIO,
  };
}

const EOCD_SIGNATURE = 0x06054b50;
const CDR_ENTRY_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const EOCD_MIN_LEN = 22;
const EOCD_MAX_COMMENT = 0xffff;
const ZIP32_SENTINEL = 0xffffffff;

/**
 * Inspect an XLSX (zip) archive without decompressing any entry.
 * Throws {@link XlsxArchiveRejectedError} on any cap breach or
 * malformed structure. Returns audit fields on success.
 *
 * ZIP64 sentinel values (sizes >= 4 GiB) are treated as "definitely
 * too large" without resolving the ZIP64 extra field. Our cap is far
 * below 4 GiB so an archive needing ZIP64 sizes is an automatic reject.
 */
export function inspectXlsxArchive(
  bytes: Uint8Array,
  limits: ArchiveLimits = resolveArchiveLimits(),
): ArchiveAuditFields {
  const audit: ArchiveAuditFields = {
    compressedArchiveBytes: bytes.byteLength,
    totalUncompressedBytes: 0,
    entryCount: 0,
    largestEntryUncompressedBytes: 0,
    peakCompressionRatio: 0,
  };

  if (bytes.byteLength < EOCD_MIN_LEN) {
    throw invalid(audit, "archive too small to contain a valid EOCD");
  }

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );

  const eocdOffset = findEocdOffset(view);
  if (eocdOffset === -1) {
    throw invalid(audit, "End of Central Directory record not found");
  }

  let entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  let totalEntries = view.getUint16(eocdOffset + 10, true);
  let cdrSize = view.getUint32(eocdOffset + 12, true);
  let cdrOffset = view.getUint32(eocdOffset + 16, true);

  if (
    entriesOnDisk === 0xffff ||
    totalEntries === 0xffff ||
    cdrSize === ZIP32_SENTINEL ||
    cdrOffset === ZIP32_SENTINEL
  ) {
    const z64 = resolveZip64(view, eocdOffset);
    if (z64 === null) {
      throw invalid(audit, "ZIP64 sentinels present but ZIP64 EOCD missing");
    }
    entriesOnDisk = z64.totalEntries;
    totalEntries = z64.totalEntries;
    cdrSize = z64.cdrSize;
    cdrOffset = z64.cdrOffset;
  }

  if (entriesOnDisk !== totalEntries) {
    throw invalid(audit, "multi-disk archives are not supported");
  }

  if (totalEntries > limits.maxEntryCount) {
    audit.entryCount = totalEntries;
    throw rejected(audit, {
      code: "upload_too_many_entries",
      message: "Upload exceeds maximum archive entry count",
      httpStatus: 400,
      limitBytes: limits.maxEntryCount,
    });
  }

  if (cdrOffset + cdrSize > bytes.byteLength) {
    throw invalid(audit, "central directory extends past archive end");
  }

  let cursor = cdrOffset;
  const cdrEnd = cdrOffset + cdrSize;
  let walked = 0;
  while (cursor < cdrEnd) {
    if (cursor + 46 > cdrEnd) {
      throw invalid(audit, "truncated central directory entry header");
    }
    const sig = view.getUint32(cursor, true);
    if (sig !== CDR_ENTRY_SIGNATURE) {
      throw invalid(audit, "invalid central directory entry signature");
    }
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);

    if (
      compressedSize === ZIP32_SENTINEL ||
      uncompressedSize === ZIP32_SENTINEL
    ) {
      audit.entryCount = walked + 1;
      audit.largestEntryUncompressedBytes = Math.max(
        audit.largestEntryUncompressedBytes,
        ZIP32_SENTINEL,
      );
      throw rejected(audit, {
        code: "upload_too_large_uncompressed",
        message: "Upload exceeds uncompressed size budget",
        httpStatus: 413,
        limitBytes: limits.maxEntryUncompressedBytes,
      });
    }

    walked++;
    audit.totalUncompressedBytes += uncompressedSize;
    if (uncompressedSize > audit.largestEntryUncompressedBytes) {
      audit.largestEntryUncompressedBytes = uncompressedSize;
    }
    if (compressedSize > 0) {
      const ratio = uncompressedSize / compressedSize;
      if (ratio > audit.peakCompressionRatio) {
        audit.peakCompressionRatio = ratio;
      }
    }

    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      audit.entryCount = walked;
      throw rejected(audit, {
        code: "upload_too_large_uncompressed",
        message: "Upload exceeds uncompressed size budget",
        httpStatus: 413,
        limitBytes: limits.maxEntryUncompressedBytes,
      });
    }
    if (
      compressedSize > 0 &&
      uncompressedSize / compressedSize > limits.maxCompressionRatio
    ) {
      audit.entryCount = walked;
      throw rejected(audit, {
        code: "upload_compression_ratio",
        message: "Upload exceeds per-entry compression ratio limit",
        httpStatus: 400,
        limitBytes: limits.maxCompressionRatio,
      });
    }
    if (audit.totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      audit.entryCount = walked;
      throw rejected(audit, {
        code: "upload_too_large_uncompressed",
        message: "Upload exceeds uncompressed size budget",
        httpStatus: 413,
        limitBytes: limits.maxTotalUncompressedBytes,
      });
    }

    cursor += 46 + nameLen + extraLen + commentLen;
  }

  if (walked !== totalEntries) {
    throw invalid(
      audit,
      `central directory entry count mismatch: header=${totalEntries}, walked=${walked}`,
    );
  }
  audit.entryCount = walked;
  return audit;
}

function findEocdOffset(view: DataView): number {
  const len = view.byteLength;
  const searchStart = Math.max(0, len - EOCD_MIN_LEN - EOCD_MAX_COMMENT);
  for (let i = len - EOCD_MIN_LEN; i >= searchStart; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      const commentLen = view.getUint16(i + 20, true);
      if (i + EOCD_MIN_LEN + commentLen === len) return i;
    }
  }
  return -1;
}

interface Zip64Header {
  totalEntries: number;
  cdrSize: number;
  cdrOffset: number;
}

function resolveZip64(
  view: DataView,
  eocdOffset: number,
): Zip64Header | null {
  const locatorOffset = eocdOffset - 20;
  if (locatorOffset < 0) return null;
  if (view.getUint32(locatorOffset, true) !== ZIP64_EOCD_LOCATOR_SIGNATURE) {
    return null;
  }
  const z64EocdOffset = readU64(view, locatorOffset + 8);
  if (z64EocdOffset < 0 || z64EocdOffset + 56 > view.byteLength) {
    return null;
  }
  if (view.getUint32(z64EocdOffset, true) !== ZIP64_EOCD_SIGNATURE) return null;
  const totalEntries = readU64(view, z64EocdOffset + 32);
  const cdrSize = readU64(view, z64EocdOffset + 40);
  const cdrOffset = readU64(view, z64EocdOffset + 48);
  if (totalEntries < 0 || cdrSize < 0 || cdrOffset < 0) return null;
  return { totalEntries, cdrSize, cdrOffset };
}

function readU64(view: DataView, offset: number): number {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  if (hi !== 0) return -1;
  return lo;
}

function rejected(
  audit: ArchiveAuditFields,
  args: {
    code: ArchiveRejectionCode;
    message: string;
    httpStatus: 413 | 400;
    limitBytes: number;
  },
): XlsxArchiveRejectedError {
  return new XlsxArchiveRejectedError({
    code: args.code,
    message: args.message,
    httpStatus: args.httpStatus,
    limitBytes: args.limitBytes,
    audit: { ...audit },
  });
}

function invalid(
  audit: ArchiveAuditFields,
  message: string,
): XlsxArchiveRejectedError {
  return new XlsxArchiveRejectedError({
    code: "upload_invalid_xlsx",
    message,
    httpStatus: 400,
    limitBytes: 0,
    audit: { ...audit },
  });
}
