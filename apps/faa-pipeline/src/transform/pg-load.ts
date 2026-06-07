/**
 * PG load: gold parquet → `aircraft_registry_staging` (temp) → SCD-2 tx.
 *
 * The SCD-2 transaction is the heart of this stage. Within ONE transaction:
 *   1. COPY gold parquet (as CSV via DuckDB) into a TEMP staging table.
 *   2. Identify n_numbers whose data-column body differs from `_current`
 *      (or is missing from `_current`) — these are "changed".
 *   3. For each changed n_number, close the live history row:
 *      `valid_to = snapshot_date, is_current = false`.
 *   4. Insert one new history row per changed n_number with
 *      `valid_from = snapshot_date, valid_to = NULL, is_current = true`
 *      and the staging row's data columns.
 *   5. UPSERT `_current` from staging.
 *
 * Idempotency invariant: rerunning the same snapshot_date is a no-op
 * (zero history INSERTs, zero `_current` mutations besides updated_at)
 * because `IS DISTINCT FROM` returns FALSE when staging and current match.
 *
 * The transaction also stamps `snapshot_manifest.pg_loaded_at`,
 * `aircraft_history_inserts`, and `aircraft_current_upserts`.
 */

import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { pipeline } from "node:stream/promises";
import { streamDuckSql, r2Preamble, type R2Credentials } from "./duckdb.js";
import { DATA_COLUMNS, CURRENT_COLUMNS } from "./columns.js";

export interface PgLoadInputs {
  goldParquet: string;     // s3:// or file:// URI for aircraft_registry_current.parquet
  snapshotDate: string;
  databaseUrl: string;
  r2?: R2Credentials;       // required if goldParquet is s3://
  /**
   * Reconciliation values from the gold stage; written into snapshot_manifest
   * so they're queryable next to history/upsert counts.
   */
  masterAccepted: number;
  masterRejected: number;
}

export interface PgLoadResult {
  historyInserts: number;
  currentUpserts: number;
}

export async function runPgLoad(inputs: PgLoadInputs): Promise<PgLoadResult> {
  if (inputs.goldParquet.startsWith("s3://") && !inputs.r2) {
    throw new Error("pg-load: r2 credentials required for s3:// goldParquet");
  }

  const client = new pg.Client({
    connectionString: inputs.databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    await client.query("BEGIN");

    // 1. Create temp staging table mirroring _current's shape (incl. PK & defaults
    //    so updated_at default works); drop on commit so it never leaks.
    await client.query(`
      CREATE TEMP TABLE aircraft_registry_staging
      (LIKE faa_registry.aircraft_registry_current INCLUDING DEFAULTS)
      ON COMMIT DROP;
    `);

    // 2. Stream gold parquet → CSV via duckdb → pg COPY FROM STDIN.
    //    `streamDuckSql` spawns duckdb with `-csv -noheader`, so a bare SELECT
    //    emits headerless RFC-4180 CSV on stdout. (Do NOT use
    //    `COPY (...) TO '/dev/stdout'`: DuckDB tries to open the path as a
    //    regular file and fails with "Cannot open file /dev/stdout" on the
    //    GH Actions runner.)
    const preamble = inputs.r2 ? r2Preamble(inputs.r2) : "";
    const exportSql = [
      preamble,
      `SELECT ${CURRENT_COLUMNS.join(", ")} FROM read_parquet('${inputs.goldParquet}');`,
    ].join("\n");

    const duck = streamDuckSql(exportSql);
    const copyStream = client.query(
      copyFrom(`
        COPY aircraft_registry_staging (${CURRENT_COLUMNS.join(", ")})
        FROM STDIN WITH (FORMAT csv, HEADER false, NULL '')
      `),
    );
    await pipeline(duck.stdout, copyStream);
    await duck.done;

    // Bookkeeping helpers in the same tx so counts come from the same view.
    const dataColsCsv = DATA_COLUMNS.join(", ");
    const stagingDataCols = DATA_COLUMNS.map((c) => `s.${c}`).join(", ");
    const currentDataCols = DATA_COLUMNS.map((c) => `c.${c}`).join(", ");

    // 3. Close live history rows for n_numbers whose body changes (or are new).
    //    Use a CTE that materialises the "changed" set so step 4 sees the same
    //    rows; we re-derive in step 4 from the same predicate, but a CTE
    //    snapshot avoids reading from _current twice if the planner doesn't
    //    cache it.
    const closeRes = await client.query(
      `
      WITH changed AS (
        SELECT s.n_number
          FROM aircraft_registry_staging s
          LEFT JOIN faa_registry.aircraft_registry_current c USING (n_number)
         WHERE c.n_number IS NULL
            OR ROW(${stagingDataCols}) IS DISTINCT FROM ROW(${currentDataCols})
      )
      UPDATE faa_registry.aircraft_registry_history h
         SET valid_to = $1::date,
             is_current = false
        FROM changed
       WHERE h.n_number = changed.n_number
         AND h.is_current;
      `,
      [inputs.snapshotDate],
    );
    const historyCloses = closeRes.rowCount ?? 0;

    // 4. Insert new history rows for the same "changed" set.
    const insertRes = await client.query(
      `
      WITH changed AS (
        SELECT s.n_number
          FROM aircraft_registry_staging s
          LEFT JOIN faa_registry.aircraft_registry_current c USING (n_number)
         WHERE c.n_number IS NULL
            OR ROW(${stagingDataCols}) IS DISTINCT FROM ROW(${currentDataCols})
      )
      INSERT INTO faa_registry.aircraft_registry_history
        (n_number, valid_from, valid_to, is_current, ${dataColsCsv})
      SELECT s.n_number, $1::date, NULL, true, ${dataColsCsv}
        FROM aircraft_registry_staging s
        JOIN changed USING (n_number);
      `,
      [inputs.snapshotDate],
    );
    const historyInserts = insertRes.rowCount ?? 0;

    // Invariant: every closed live row should have a paired insert (same set).
    if (historyCloses > historyInserts) {
      throw new Error(
        `SCD-2 invariant violation: closed ${historyCloses} live history rows but only inserted ${historyInserts}`,
      );
    }

    // 5. UPSERT _current from staging.
    const upsertRes = await client.query(
      `
      INSERT INTO faa_registry.aircraft_registry_current
        (${CURRENT_COLUMNS.join(", ")})
      SELECT ${CURRENT_COLUMNS.join(", ")} FROM aircraft_registry_staging
      ON CONFLICT (n_number) DO UPDATE SET
        ${DATA_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(",\n        ")},
        snapshot_date = EXCLUDED.snapshot_date,
        updated_at = now();
      `,
    );
    const currentUpserts = upsertRes.rowCount ?? 0;

    // 6. Stamp the snapshot_manifest with pg_loaded_at and counts.
    await client.query(
      `
      UPDATE faa_registry.snapshot_manifest
         SET pg_loaded_at = now(),
             master_accepted = $2,
             master_rejected = $3,
             aircraft_history_inserts = $4,
             aircraft_current_upserts = $5
       WHERE snapshot_date = $1
      `,
      [
        inputs.snapshotDate,
        inputs.masterAccepted,
        inputs.masterRejected,
        historyInserts,
        currentUpserts,
      ],
    );

    await client.query("COMMIT");
    return { historyInserts, currentUpserts };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/**
 * Convenience reader: returns the row body that was current for `n_number`
 * at `asOf`. Used by tests and by callers needing a snapshot view.
 *
 * Returns null if no row was current on that date.
 */
export async function getAircraftAsOf(
  client: pg.ClientBase,
  nNumber: string,
  asOf: string,
): Promise<Record<string, unknown> | null> {
  const res = await client.query(
    `
    SELECT *
      FROM faa_registry.aircraft_registry_history
     WHERE n_number = $1
       AND valid_from <= $2::date
       AND (valid_to IS NULL OR valid_to > $2::date)
     ORDER BY valid_from DESC
     LIMIT 1
    `,
    [nNumber, asOf],
  );
  return res.rows[0] ?? null;
}
