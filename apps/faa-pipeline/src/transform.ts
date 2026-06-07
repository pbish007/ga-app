/**
 * CLI entry point for the FAA Registry transform pipeline (R2 stage).
 *
 * Run via `pnpm --filter faa-pipeline transform`. Required env:
 *
 *   SNAPSHOT_DATE      - YYYY-MM-DD (defaults to today UTC)
 *   FAA_DATABASE_URL   - Supabase pooler URL
 *   R2_ACCOUNT_ID      - Cloudflare R2 account
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *
 * Optional:
 *
 *   R2_BUCKET          - defaults to 'faa-registry'
 *   LOCAL_RAW_DIR      - If set, bronze reads raw .txt from this local dir
 *                        rather than s3://$R2_BUCKET/raw/<date>/. Used in
 *                        lakefs storage mode where the workflow already has
 *                        the raw files on disk after the ingest step.
 *   DUCKDB_BINARY      - optional path to the duckdb CLI (defaults to PATH)
 *
 * The transform itself is idempotent: re-running for the same snapshot_date
 * after `pg_loaded_at` is set is a no-op fast-skip.
 */

import { runTransform } from "./transform/orchestrator.js";

async function cli(): Promise<void> {
  const snapshotDate = parseSnapshotDate(process.env.SNAPSHOT_DATE);
  const databaseUrl = required("FAA_DATABASE_URL");
  const accountId = required("R2_ACCOUNT_ID");
  const accessKeyId = required("R2_ACCESS_KEY_ID");
  const secretAccessKey = required("R2_SECRET_ACCESS_KEY");
  const bucket = process.env.R2_BUCKET?.trim() || "faa-registry";
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const hostname = `${accountId}.r2.cloudflarestorage.com`;
  const localRawDir = process.env.LOCAL_RAW_DIR?.trim();

  const log = (msg: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ at: msg, ...extra ?? {} }));

  log("transform.cli.starting", {
    snapshotDate,
    bucket,
    localRawDir: localRawDir ?? null,
  });

  const result = await runTransform(
    {
      snapshotDate,
      databaseUrl,
      r2Bucket: bucket,
      r2: {
        hostname,
        accessKeyId,
        secretAccessKey,
        region: "auto",
        endpoint,
      },
      localRawDir,
    },
    { log },
  );

  log("transform.cli.done", { snapshotDate, skipped: result.skipped });
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}

function parseSnapshotDate(raw: string | undefined): string {
  const v = raw?.trim() || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`SNAPSHOT_DATE must be YYYY-MM-DD, got: ${raw}`);
  }
  return v;
}

const invokedAsCli =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/transform.ts");

if (invokedAsCli) {
  cli().catch((err) => {
    console.error(JSON.stringify({ at: "transform.fatal", error: String(err) }));
    process.exit(1);
  });
}
