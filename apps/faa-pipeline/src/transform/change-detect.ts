/**
 * R3 change detection (PMB-107).
 *
 * Runs after pg-load. Consumes the SCD-2 state pg-load just wrote:
 *   - rows in `aircraft_registry_history` with `valid_from = snapshot_date,
 *     is_current = true`  →  "today's new history rows"
 *   - rows with `valid_to = snapshot_date, is_current = false`
 *                            →  "today's just-closed previous rows"
 *
 * Emits per-type rows into `aircraft_changes`:
 *
 *   - new_registration     — n_number's first-ever history row
 *   - ownership_transfer   — owner_name differs from prev-closed-today
 *   - address_change       — any of street/street2/city/state/zip_code/country differs
 *   - expiration_change    — expiration_date differs
 *   - airworthiness_change — airworthiness_date differs
 *   - deregistration       — n_number appears in today's DEREG bronze and is in _current
 *
 * The deregistration step also closes the live history row for each DEREG'd
 * n_number so the SCD-2 state reflects "no longer registered as of today".
 *
 * Idempotent: every INSERT uses `ON CONFLICT (n_number, snapshot_date,
 * change_type) DO NOTHING`, and the DEREG history close uses
 * `WHERE is_current` so re-running is a no-op.
 */

import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { pipeline } from "node:stream/promises";
import { streamDuckSql, r2Preamble, type R2Credentials } from "./duckdb.js";

export interface ChangeDetectInputs {
  snapshotDate: string;
  databaseUrl: string;
  /**
   * DEREG bronze parquet URI (s3:// or file://). Optional. When omitted, the
   * deregistration step is skipped — useful for tests that don't care about
   * DEREG churn.
   */
  deregBronze?: string;
  r2?: R2Credentials;
}

export interface ChangeDetectResult {
  newRegistration: number;
  ownershipTransfer: number;
  addressChange: number;
  expirationChange: number;
  airworthinessChange: number;
  deregistration: number;
  total: number;
}

export async function runChangeDetect(inputs: ChangeDetectInputs): Promise<ChangeDetectResult> {
  if (inputs.deregBronze?.startsWith("s3://") && !inputs.r2) {
    throw new Error("change-detect: r2 credentials required for s3:// deregBronze");
  }

  const client = new pg.Client({
    connectionString: inputs.databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    await client.query("BEGIN");

    const newReg = await client.query(
      `
      INSERT INTO faa_registry.aircraft_changes
        (n_number, snapshot_date, change_type, old_value, new_value)
      SELECT h.n_number, $1::date, 'new_registration', NULL,
             jsonb_build_object(
               'n_number',          h.n_number,
               'owner_name',        h.owner_name,
               'street',            h.street,
               'city',              h.city,
               'state',             h.state,
               'zip_code',          h.zip_code,
               'country',           h.country,
               'status_code',       h.status_code,
               'expiration_date',   to_jsonb(h.expiration_date),
               'airworthiness_date',to_jsonb(h.airworthiness_date)
             )
        FROM faa_registry.aircraft_registry_history h
       WHERE h.valid_from = $1::date
         AND h.is_current = true
         AND NOT EXISTS (
           SELECT 1
             FROM faa_registry.aircraft_registry_history h2
            WHERE h2.n_number = h.n_number
              AND h2.valid_from < $1::date
         )
      ON CONFLICT (n_number, snapshot_date, change_type) DO NOTHING
      `,
      [inputs.snapshotDate],
    );

    const ownerXfer = await client.query(
      `
      INSERT INTO faa_registry.aircraft_changes
        (n_number, snapshot_date, change_type, old_value, new_value)
      SELECT n.n_number, $1::date, 'ownership_transfer',
             jsonb_build_object('owner_name', p.owner_name),
             jsonb_build_object('owner_name', n.owner_name)
        FROM faa_registry.aircraft_registry_history n
        JOIN faa_registry.aircraft_registry_history p
          ON p.n_number = n.n_number
         AND p.valid_to = $1::date
         AND p.is_current = false
       WHERE n.valid_from = $1::date
         AND n.is_current = true
         AND p.owner_name IS DISTINCT FROM n.owner_name
      ON CONFLICT (n_number, snapshot_date, change_type) DO NOTHING
      `,
      [inputs.snapshotDate],
    );

    const addrChange = await client.query(
      `
      INSERT INTO faa_registry.aircraft_changes
        (n_number, snapshot_date, change_type, old_value, new_value)
      SELECT n.n_number, $1::date, 'address_change',
             jsonb_build_object(
               'street',   p.street,   'street2', p.street2,
               'city',     p.city,     'state',   p.state,
               'zip_code', p.zip_code, 'country', p.country
             ),
             jsonb_build_object(
               'street',   n.street,   'street2', n.street2,
               'city',     n.city,     'state',   n.state,
               'zip_code', n.zip_code, 'country', n.country
             )
        FROM faa_registry.aircraft_registry_history n
        JOIN faa_registry.aircraft_registry_history p
          ON p.n_number = n.n_number
         AND p.valid_to = $1::date
         AND p.is_current = false
       WHERE n.valid_from = $1::date
         AND n.is_current = true
         AND (
              p.street   IS DISTINCT FROM n.street
           OR p.street2  IS DISTINCT FROM n.street2
           OR p.city     IS DISTINCT FROM n.city
           OR p.state    IS DISTINCT FROM n.state
           OR p.zip_code IS DISTINCT FROM n.zip_code
           OR p.country  IS DISTINCT FROM n.country
         )
      ON CONFLICT (n_number, snapshot_date, change_type) DO NOTHING
      `,
      [inputs.snapshotDate],
    );

    const expChange = await client.query(
      `
      INSERT INTO faa_registry.aircraft_changes
        (n_number, snapshot_date, change_type, old_value, new_value)
      SELECT n.n_number, $1::date, 'expiration_change',
             jsonb_build_object('expiration_date', to_jsonb(p.expiration_date)),
             jsonb_build_object('expiration_date', to_jsonb(n.expiration_date))
        FROM faa_registry.aircraft_registry_history n
        JOIN faa_registry.aircraft_registry_history p
          ON p.n_number = n.n_number
         AND p.valid_to = $1::date
         AND p.is_current = false
       WHERE n.valid_from = $1::date
         AND n.is_current = true
         AND p.expiration_date IS DISTINCT FROM n.expiration_date
      ON CONFLICT (n_number, snapshot_date, change_type) DO NOTHING
      `,
      [inputs.snapshotDate],
    );

    const awChange = await client.query(
      `
      INSERT INTO faa_registry.aircraft_changes
        (n_number, snapshot_date, change_type, old_value, new_value)
      SELECT n.n_number, $1::date, 'airworthiness_change',
             jsonb_build_object('airworthiness_date', to_jsonb(p.airworthiness_date)),
             jsonb_build_object('airworthiness_date', to_jsonb(n.airworthiness_date))
        FROM faa_registry.aircraft_registry_history n
        JOIN faa_registry.aircraft_registry_history p
          ON p.n_number = n.n_number
         AND p.valid_to = $1::date
         AND p.is_current = false
       WHERE n.valid_from = $1::date
         AND n.is_current = true
         AND p.airworthiness_date IS DISTINCT FROM n.airworthiness_date
      ON CONFLICT (n_number, snapshot_date, change_type) DO NOTHING
      `,
      [inputs.snapshotDate],
    );

    let deregCount = 0;
    if (inputs.deregBronze) {
      // Stage DEREG n_numbers from the bronze parquet into a temp table.
      // DuckDB → CSV → pg COPY, same pattern as pg-load uses for gold.
      await client.query(`
        CREATE TEMP TABLE aircraft_dereg_staging (
          n_number text not null primary key
        ) ON COMMIT DROP;
      `);

      const preamble = inputs.r2 ? r2Preamble(inputs.r2) : "";
      const exportSql = [
        preamble,
        // DEREG.txt's first column is N-NUMBER (verified in 0022 bronze tests).
        // Quote the identifier exactly — DuckDB preserves header case.
        `SELECT TRIM("N-NUMBER") AS n_number
           FROM read_parquet('${inputs.deregBronze}')
          WHERE "N-NUMBER" IS NOT NULL
            AND TRIM("N-NUMBER") <> '';`,
      ].join("\n");

      const duck = streamDuckSql(exportSql);
      const copyStream = client.query(
        copyFrom(`
          COPY aircraft_dereg_staging (n_number)
          FROM STDIN WITH (FORMAT csv, HEADER false, NULL '')
        `),
      );
      await pipeline(duck.stdout, copyStream);
      await duck.done;

      const dereg = await client.query(
        `
        INSERT INTO faa_registry.aircraft_changes
          (n_number, snapshot_date, change_type, old_value, new_value)
        SELECT d.n_number, $1::date, 'deregistration',
               jsonb_build_object(
                 'status_code', c.status_code,
                 'owner_name',  c.owner_name
               ),
               jsonb_build_object('deregistered_on', to_jsonb($1::date))
          FROM aircraft_dereg_staging d
          JOIN faa_registry.aircraft_registry_current c USING (n_number)
        ON CONFLICT (n_number, snapshot_date, change_type) DO NOTHING
        `,
        [inputs.snapshotDate],
      );
      deregCount = dereg.rowCount ?? 0;

      // Close the live history row for every DEREG'd n_number. Already-closed
      // rows (idempotent re-runs, or pg-load-just-closed rows for n_numbers
      // that ALSO churned today) are filtered by `WHERE is_current`.
      await client.query(
        `
        UPDATE faa_registry.aircraft_registry_history h
           SET valid_to = $1::date,
               is_current = false
          FROM aircraft_dereg_staging d
         WHERE h.n_number = d.n_number
           AND h.is_current
        `,
        [inputs.snapshotDate],
      );
    }

    const newRegC = newReg.rowCount ?? 0;
    const ownerXferC = ownerXfer.rowCount ?? 0;
    const addrC = addrChange.rowCount ?? 0;
    const expC = expChange.rowCount ?? 0;
    const awC = awChange.rowCount ?? 0;
    const total = newRegC + ownerXferC + addrC + expC + awC + deregCount;

    await client.query(
      `
      UPDATE faa_registry.snapshot_manifest
         SET changes_detected_at          = now(),
             changes_total                = $2,
             changes_new_registration     = $3,
             changes_ownership_transfer   = $4,
             changes_address_change       = $5,
             changes_expiration_change    = $6,
             changes_airworthiness_change = $7,
             changes_deregistration       = $8
       WHERE snapshot_date = $1
      `,
      [inputs.snapshotDate, total, newRegC, ownerXferC, addrC, expC, awC, deregCount],
    );

    await client.query("COMMIT");

    return {
      newRegistration: newRegC,
      ownershipTransfer: ownerXferC,
      addressChange: addrC,
      expirationChange: expC,
      airworthinessChange: awC,
      deregistration: deregCount,
      total,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}
