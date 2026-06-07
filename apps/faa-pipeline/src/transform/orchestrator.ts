/**
 * Transform orchestrator: bronze → gold → pg-load for a single snapshot date.
 *
 * Reads:
 * - Raw `.txt` files from either local staging dir (set `LOCAL_RAW_DIR`) or
 *   R2 (`s3://$R2_BUCKET/raw/<date>/<file>.txt`). Local read is the default
 *   in lakefs storage mode because the GH Actions workflow has the files
 *   on disk anyway; R2 read is the path for r2 storage mode and for any
 *   restart-only-the-transform scenario.
 *
 * Writes:
 * - Bronze parquets to `s3://$R2_BUCKET/bronze/<date>/<table>.parquet`
 * - Gold parquet to `s3://$R2_BUCKET/gold/<date>/aircraft_registry_current.parquet`
 * - `_reconciliation.json` to `s3://$R2_BUCKET/gold/<date>/_reconciliation.json`
 *
 * Updates `snapshot_manifest`:
 * - `bronze_written_at` after bronze completes
 * - `gold_written_at` after gold completes
 * - `pg_loaded_at`, `master_accepted`, `master_rejected`,
 *   `aircraft_history_inserts`, `aircraft_current_upserts` after pg-load
 *
 * Idempotency: if `pg_loaded_at` is already set, skip the whole transform
 * (fast path). Otherwise re-runs are safe: bronze/gold overwrite, pg-load's
 * SCD-2 transaction is no-op when staging matches `_current`.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { runBronze, bronzeUri } from "./bronze.js";
import { runGold, goldUri } from "./gold.js";
import { runPgLoad } from "./pg-load.js";
import { FAA_FILES, rawKey, type FaaFile } from "../lib/config.js";
import type { R2Credentials } from "./duckdb.js";

export interface TransformConfig {
  snapshotDate: string;
  databaseUrl: string;
  r2Bucket: string;
  r2: R2Credentials & { endpoint: string };  // endpoint = https://… for AWS-SDK uploads
  /** If set, bronze reads raw .txt from this local directory rather than R2. */
  localRawDir?: string;
}

export interface TransformDeps {
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export async function runTransform(
  config: TransformConfig,
  deps: TransformDeps,
): Promise<{ skipped: boolean }> {
  const { snapshotDate, databaseUrl, r2Bucket } = config;
  const rootBronzeUri = `s3://${r2Bucket}`;

  // Idempotency fast path.
  const pgPool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    ssl: { rejectUnauthorized: false },
  });
  try {
    const { rows } = await pgPool.query<{
      pg_loaded_at: Date | null;
      master_count: number | null;
    }>(
      `SELECT pg_loaded_at, master_count
         FROM faa_registry.snapshot_manifest
        WHERE snapshot_date = $1`,
      [snapshotDate],
    );
    if (rows.length === 0) {
      throw new Error(
        `transform: no snapshot_manifest row for ${snapshotDate} — run the raw ingest stage first`,
      );
    }
    if (rows[0]!.pg_loaded_at != null) {
      deps.log("transform.idempotent_skip", { snapshotDate });
      return { skipped: true };
    }

    // Bronze sources: file:// from local staging dir, or s3:// from R2.
    const sources = buildSources(config);
    const destinations = buildBronzeDestinations(rootBronzeUri, snapshotDate);

    deps.log("transform.bronze.started", { snapshotDate });
    const bronze = await runBronze({
      sources,
      destinations,
      r2: config.r2,
    });
    deps.log("transform.bronze.done", {
      snapshotDate,
      perTable: Object.fromEntries(
        FAA_FILES.map((f) => [f, {
          rowsWritten: bronze.perTable[f].rowsWritten,
          rowsRejected: bronze.perTable[f].rowsRejected,
        }]),
      ),
    });
    await pgPool.query(
      `UPDATE faa_registry.snapshot_manifest
          SET bronze_written_at = now()
        WHERE snapshot_date = $1`,
      [snapshotDate],
    );

    // Gold.
    const goldOut = goldUri(rootBronzeUri, snapshotDate);
    const tmpRoot = mkdtempSync(join(tmpdir(), "faa-transform-"));
    const reconLocal = join(tmpRoot, "_reconciliation.json");
    deps.log("transform.gold.started", { snapshotDate });
    const recon = await runGold({
      masterParquet: destinations.MASTER,
      acftrefParquet: destinations.ACFTREF,
      engineParquet: destinations.ENGINE,
      goldParquetOut: goldOut,
      reconciliationOut: reconLocal,
      snapshotDate,
      r2: config.r2,
    });
    deps.log("transform.gold.done", { snapshotDate, recon });

    // Upload reconciliation JSON to R2 next to the gold parquet.
    const reconR2Key = `gold/${snapshotDate}/_reconciliation.json`;
    await uploadJsonToR2(config, reconR2Key, readFileSync(reconLocal, "utf8"));
    await pgPool.query(
      `UPDATE faa_registry.snapshot_manifest
          SET gold_written_at = now()
        WHERE snapshot_date = $1`,
      [snapshotDate],
    );

    // PG load (SCD-2 transaction + manifest stamping).
    deps.log("transform.pg_load.started", { snapshotDate });
    const pgRes = await runPgLoad({
      goldParquet: goldOut,
      snapshotDate,
      databaseUrl,
      r2: config.r2,
      masterAccepted: bronze.perTable.MASTER.rowsWritten,
      masterRejected: bronze.perTable.MASTER.rowsRejected,
    });
    deps.log("transform.pg_load.done", { snapshotDate, ...pgRes });

    return { skipped: false };
  } finally {
    await pgPool.end().catch(() => {});
  }
}

function buildSources(config: TransformConfig): Record<FaaFile, string> {
  const out = {} as Record<FaaFile, string>;
  for (const f of FAA_FILES) {
    if (config.localRawDir) {
      out[f] = `file://${join(config.localRawDir, rawKey(config.snapshotDate, f))}`;
    } else {
      out[f] = `s3://${config.r2Bucket}/${rawKey(config.snapshotDate, f)}`;
    }
  }
  return out;
}

function buildBronzeDestinations(rootBronzeUri: string, snapshotDate: string): Record<FaaFile, string> {
  const out = {} as Record<FaaFile, string>;
  for (const f of FAA_FILES) {
    out[f] = bronzeUri(rootBronzeUri, snapshotDate, f);
  }
  return out;
}

async function uploadJsonToR2(
  config: TransformConfig,
  key: string,
  body: string,
): Promise<void> {
  const s3 = new S3Client({
    region: "auto",
    endpoint: config.r2.endpoint,
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
  });
  await s3.send(
    new PutObjectCommand({
      Bucket: config.r2Bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
    }),
  );
}
