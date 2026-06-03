/**
 * FAA Registry daily ingest entry point (PMB-105 R1).
 *
 * Flow:
 *   1. Start a pipeline_runs row (status='running').
 *   2. Download ReleasableAircraft.zip from the FAA releasable database.
 *   3. Extract MASTER/ACFTREF/ENGINE/DEALER/DEREG, hash each.
 *   4. Upload each file to r2://<bucket>/raw/YYYY-MM-DD/{FILE}.txt
 *      — skip the PUT if the key already exists (idempotent re-run).
 *   5. UPSERT snapshot_manifest with R2 ETag + bytes + sha256 + record counts.
 *   6. Mark the pipeline_runs row 'done', or 'failed' on any throw.
 */

import { loadConfig, FAA_FILES, rawKey, rawPrefix, type FaaFile } from "./lib/config.js";
import { downloadFaaSnapshot, type DownloadResult } from "./lib/download.js";
import { makeR2Client, type R2Client } from "./lib/r2.js";
import { makePipelineDb, type ManifestRow, type PipelineDb } from "./lib/db.js";
import { countRecords } from "./lib/parse.js";

export interface PipelineDeps {
  db: PipelineDb;
  r2: R2Client;
  download: (zipUrl: string) => Promise<DownloadResult>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export async function runPipeline(
  config: ReturnType<typeof loadConfig>,
  deps: PipelineDeps,
): Promise<{ skipped: boolean; manifest: ManifestRow }> {
  const runRowId = await deps.db.startRun(config.runId, config.snapshotDate);
  deps.log("pipeline_run.started", {
    runId: config.runId,
    snapshotDate: config.snapshotDate,
    runRowId,
  });

  try {
    const result = await runOnce(config, deps);
    await deps.db.finishRun(runRowId, "done");
    deps.log("pipeline_run.done", {
      runRowId,
      skipped: result.skipped,
      snapshotDate: config.snapshotDate,
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await deps.db.finishRun(runRowId, "failed", msg);
    deps.log("pipeline_run.failed", { runRowId, error: msg });
    throw err;
  }
}

async function runOnce(
  config: ReturnType<typeof loadConfig>,
  deps: PipelineDeps,
): Promise<{ skipped: boolean; manifest: ManifestRow }> {
  const prefix = rawPrefix(config.snapshotDate);

  // Idempotency fast path: if the manifest row already exists AND all 5 R2
  // keys are present, this is a no-op. We still re-record the manifest row
  // values from R2 HEAD output so the call is observable.
  const manifestPresent = await deps.db.hasManifest(config.snapshotDate);
  const existingHeads = await Promise.all(
    FAA_FILES.map(async (f) => {
      const head = await deps.r2.headObject(rawKey(config.snapshotDate, f));
      return [f, head] as const;
    }),
  );
  const allPresent = existingHeads.every(([, head]) => head !== null);

  if (manifestPresent && allPresent) {
    deps.log("pipeline.idempotent_skip", {
      snapshotDate: config.snapshotDate,
      prefix,
    });
    const manifest = manifestFromExisting(config.snapshotDate, prefix, existingHeads);
    return { skipped: true, manifest };
  }

  // Real run: download + upload missing keys + write manifest.
  deps.log("pipeline.downloading", { zipUrl: config.zipUrl });
  const dl = await deps.download(config.zipUrl);
  deps.log("pipeline.downloaded", {
    zipBytes: dl.zipBytes,
    files: Object.fromEntries(
      FAA_FILES.map((f) => [f, { bytes: dl.files[f].bytes, sha256: dl.files[f].sha256 }]),
    ),
  });

  const heads = new Map(existingHeads);
  const manifestFiles: Partial<Record<FaaFile, ManifestRow["master"]>> = {};

  for (const f of FAA_FILES) {
    const payload = dl.files[f];
    const key = rawKey(config.snapshotDate, f);
    const head = heads.get(f);

    let etag: string;
    if (head) {
      etag = head.etag;
      deps.log("pipeline.r2_skip_existing", { file: f, key, bytes: head.bytes });
    } else {
      etag = await deps.r2.putObject(key, payload.buffer, "text/plain");
      deps.log("pipeline.r2_put", { file: f, key, bytes: payload.bytes, etag });
    }

    const count = needsCount(f) ? countRecords(payload.buffer) : null;
    manifestFiles[f] = {
      etag,
      bytes: payload.bytes,
      sha256: payload.sha256,
      count,
    };
  }

  const manifest: ManifestRow = {
    snapshotDate: config.snapshotDate,
    r2Prefix: prefix,
    master: manifestFiles.MASTER!,
    acftref: manifestFiles.ACFTREF!,
    engine: manifestFiles.ENGINE!,
    dealer: manifestFiles.DEALER!,
    dereg: manifestFiles.DEREG!,
  };

  await deps.db.upsertManifest(manifest);
  deps.log("pipeline.manifest_upserted", { snapshotDate: config.snapshotDate });

  return { skipped: false, manifest };
}

function needsCount(_f: FaaFile): boolean {
  // We record line counts for all 5 files. Cheap on the same buffer we already have.
  return true;
}

function manifestFromExisting(
  snapshotDate: string,
  prefix: string,
  heads: ReadonlyArray<readonly [FaaFile, { etag: string; bytes: number } | null]>,
): ManifestRow {
  const m = new Map(heads);
  const f = (file: FaaFile) => {
    const h = m.get(file)!;
    return { etag: h!.etag, bytes: h!.bytes, sha256: "", count: null };
  };
  return {
    snapshotDate,
    r2Prefix: prefix,
    master: f("MASTER"),
    acftref: f("ACFTREF"),
    engine: f("ENGINE"),
    dealer: f("DEALER"),
    dereg: f("DEREG"),
  };
}

async function cli(): Promise<void> {
  const config = loadConfig();
  const db = makePipelineDb(config.databaseUrl);
  const r2 = makeR2Client(config);

  try {
    await runPipeline(config, {
      db,
      r2,
      download: (url) => downloadFaaSnapshot(url),
      log: (msg, extra) =>
        console.log(JSON.stringify({ at: msg, ...extra ?? {} })),
    });
  } finally {
    await db.close().catch(() => {});
  }
}

// Run as CLI when invoked directly (not when imported by tests).
const invokedAsCli =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/ingest.ts");

if (invokedAsCli) {
  cli().catch((err) => {
    console.error(JSON.stringify({ at: "pipeline.fatal", error: String(err) }));
    process.exit(1);
  });
}
