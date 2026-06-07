/**
 * Bronze: raw FAA `.txt` → typed-projection Parquet, one file per table.
 *
 * Reads 5 fixed-position-with-comma-delimiter FAA files; writes 5 Parquet
 * files under `bronze/YYYY-MM-DD/`. Uses DuckDB's `read_csv_auto` with
 * `all_varchar=true` for safety against fields with embedded commas (rare
 * for FAA but possible in owner names). Type coercion happens in the gold
 * stage where it can be inspected against the joined schema.
 *
 * Idempotency: caller checks `snapshot_manifest.bronze_written_at`; if non-
 * null, skip this stage. The DuckDB COPY itself is non-atomic against R2,
 * but partial writes are detectable (parquet footer absent) and the rerun
 * will replace them.
 *
 * Reconciliation: returns `{rowsWritten, rowsRejected}` per table. The MASTER
 * numbers flow into `master_accepted` / `master_rejected` on the manifest.
 */

import { runDuckSql, r2Preamble, parseSingleRowCsv, type R2Credentials } from "./duckdb.js";
import { FAA_FILES, type FaaFile } from "../lib/config.js";

export interface BronzeInputs {
  /** Per-table source URI: either file:///… or s3://bucket/key */
  sources: Record<FaaFile, string>;
  /** Per-table destination URI for the Parquet output. Must be s3:// or file://. */
  destinations: Record<FaaFile, string>;
  /** R2 creds — required if any source or destination is s3://. */
  r2?: R2Credentials;
}

export interface BronzeTableResult {
  table: FaaFile;
  rowsWritten: number;
  /**
   * Source line count (minus header) minus rows actually written. Approximate;
   * DuckDB's `ignore_errors` silently drops malformed rows but we capture the
   * delta against the raw record count.
   */
  rowsRejected: number;
  sourceLines: number;
}

export interface BronzeResult {
  perTable: Record<FaaFile, BronzeTableResult>;
}

export async function runBronze(inputs: BronzeInputs): Promise<BronzeResult> {
  const needsR2 = (uri: string) => uri.startsWith("s3://");
  const anyS3 = FAA_FILES.some(
    (f) => needsR2(inputs.sources[f]) || needsR2(inputs.destinations[f]),
  );
  if (anyS3 && !inputs.r2) {
    throw new Error("bronze: r2 credentials required for s3:// URIs");
  }

  const preamble = inputs.r2 ? r2Preamble(inputs.r2) : "";
  const perTable = {} as Record<FaaFile, BronzeTableResult>;

  for (const table of FAA_FILES) {
    const src = inputs.sources[table];
    const dst = inputs.destinations[table];

    // Read raw .txt as all-VARCHAR; trim trailing spaces in the projection.
    // FAA files use `,` as a delimiter with no quoting in legacy data; modern
    // releases occasionally quote name fields containing commas. We let
    // DuckDB auto-detect quoting; `ignore_errors=true` drops any row that
    // doesn't parse (counted in `rowsRejected` via source-line delta).
    const writeSql = [
      preamble,
      `COPY (`,
      `  SELECT * FROM read_csv_auto(`,
      `    ${quoteUri(src)},`,
      `    header=true,`,
      `    all_varchar=true,`,
      `    ignore_errors=true,`,
      `    null_padding=true`,
      `  )`,
      `) TO ${quoteUri(dst)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 50000);`,
    ].join("\n");

    await runDuckSql(writeSql);

    // Now count rows written to the parquet, and count source lines for reject delta.
    const countSql = [
      preamble,
      `SELECT`,
      `  (SELECT COUNT(*) FROM read_parquet(${quoteUri(dst)}))    AS rows_written,`,
      `  (SELECT COUNT(*) FROM read_csv_auto(${quoteUri(src)}, header=true, all_varchar=true, ignore_errors=true, null_padding=true)) AS source_rows;`,
    ].join("\n");

    const { stdout } = await runDuckSql(countSql);
    const row = parseSingleRowCsv(stdout);
    const rowsWritten = Number(row.rows_written ?? "0");
    const sourceRows = Number(row.source_rows ?? "0");

    // rowsRejected is approximate: when ignore_errors=true, malformed rows
    // don't appear in either count. We approximate via wc-style line-count
    // by reading the raw file as a single column (no parsing) and counting.
    let sourceLines = sourceRows;
    try {
      const lineSql = [
        preamble,
        `SELECT COUNT(*) AS n FROM read_csv(${quoteUri(src)}, header=true, columns={'raw':'VARCHAR'}, delim='\\x1F', quote='', ignore_errors=true);`,
      ].join("\n");
      const lineOut = await runDuckSql(lineSql);
      sourceLines = Number(parseSingleRowCsv(lineOut.stdout).n ?? sourceRows);
    } catch {
      // If the raw line-count probe fails, fall back to sourceRows.
    }

    perTable[table] = {
      table,
      rowsWritten,
      rowsRejected: Math.max(0, sourceLines - rowsWritten),
      sourceLines,
    };
  }

  return { perTable };
}

function quoteUri(uri: string): string {
  if (uri.includes("'")) {
    throw new Error(`URI contains a single quote, refusing to inject: ${uri}`);
  }
  return `'${uri}'`;
}

export function bronzeUri(rootBronzeUri: string, snapshotDate: string, table: FaaFile): string {
  const base = rootBronzeUri.replace(/\/+$/, "");
  return `${base}/bronze/${snapshotDate}/${table.toLowerCase()}.parquet`;
}
