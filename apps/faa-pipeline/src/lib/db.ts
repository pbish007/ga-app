import pg from "pg";

export interface ManifestFile {
  etag: string;
  bytes: number;
  sha256: string;
  count: number | null;
}

export interface ManifestRow {
  snapshotDate: string;
  r2Prefix: string;
  master: ManifestFile;
  acftref: ManifestFile;
  engine: ManifestFile;
  dealer: ManifestFile;
  dereg: ManifestFile;
}

export interface PipelineDb {
  startRun(runId: string, snapshotDate: string): Promise<number>;
  finishRun(id: number, status: "done" | "failed", errorMessage?: string): Promise<void>;
  hasManifest(snapshotDate: string): Promise<boolean>;
  upsertManifest(row: ManifestRow): Promise<void>;
  close(): Promise<void>;
}

export function makePipelineDb(connectionString: string): PipelineDb {
  const pool = new pg.Pool({
    connectionString,
    max: 2,
    ssl: { rejectUnauthorized: false },
  });

  return {
    async startRun(runId, snapshotDate) {
      const { rows } = await pool.query<{ id: number }>(
        `insert into faa_registry.pipeline_runs (run_id, snapshot_date, status)
         values ($1, $2, 'running')
         on conflict (run_id) do update
           set snapshot_date = excluded.snapshot_date,
               status = 'running',
               started_at = now(),
               finished_at = null,
               error_message = null
         returning id`,
        [runId, snapshotDate],
      );
      return rows[0]!.id;
    },

    async finishRun(id, status, errorMessage) {
      await pool.query(
        `update faa_registry.pipeline_runs
            set status = $2,
                finished_at = now(),
                error_message = $3
          where id = $1`,
        [id, status, errorMessage ?? null],
      );
    },

    async hasManifest(snapshotDate) {
      const { rowCount } = await pool.query(
        `select 1 from faa_registry.snapshot_manifest where snapshot_date = $1`,
        [snapshotDate],
      );
      return (rowCount ?? 0) > 0;
    },

    async upsertManifest(row) {
      await pool.query(
        `insert into faa_registry.snapshot_manifest (
            snapshot_date, r2_prefix,
            master_etag, master_bytes, master_sha256, master_count,
            acftref_etag, acftref_bytes, acftref_sha256, acftref_count,
            engine_etag, engine_bytes, engine_sha256, engine_count,
            dealer_etag, dealer_bytes, dealer_sha256, dealer_count,
            dereg_etag, dereg_bytes, dereg_sha256, dereg_count
         ) values (
            $1, $2,
            $3, $4, $5, $6,
            $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17, $18,
            $19, $20, $21, $22
         )
         on conflict (snapshot_date) do update set
            r2_prefix = excluded.r2_prefix,
            master_etag = excluded.master_etag,
            master_bytes = excluded.master_bytes,
            master_sha256 = excluded.master_sha256,
            master_count = excluded.master_count,
            acftref_etag = excluded.acftref_etag,
            acftref_bytes = excluded.acftref_bytes,
            acftref_sha256 = excluded.acftref_sha256,
            acftref_count = excluded.acftref_count,
            engine_etag = excluded.engine_etag,
            engine_bytes = excluded.engine_bytes,
            engine_sha256 = excluded.engine_sha256,
            engine_count = excluded.engine_count,
            dealer_etag = excluded.dealer_etag,
            dealer_bytes = excluded.dealer_bytes,
            dealer_sha256 = excluded.dealer_sha256,
            dealer_count = excluded.dealer_count,
            dereg_etag = excluded.dereg_etag,
            dereg_bytes = excluded.dereg_bytes,
            dereg_sha256 = excluded.dereg_sha256,
            dereg_count = excluded.dereg_count`,
        [
          row.snapshotDate,
          row.r2Prefix,
          row.master.etag, row.master.bytes, row.master.sha256, row.master.count,
          row.acftref.etag, row.acftref.bytes, row.acftref.sha256, row.acftref.count,
          row.engine.etag, row.engine.bytes, row.engine.sha256, row.engine.count,
          row.dealer.etag, row.dealer.bytes, row.dealer.sha256, row.dealer.count,
          row.dereg.etag, row.dereg.bytes, row.dereg.sha256, row.dereg.count,
        ],
      );
    },

    async close() {
      await pool.end();
    },
  };
}
