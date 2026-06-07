/**
 * Integration test for the SCD-2 transform (PMB-203).
 *
 * Skips automatically unless both `FAA_TEST_DATABASE_URL` and a working
 * `duckdb` binary are available. When run, it:
 *
 *   1. Applies the 0022/0025/0031/0032 migrations to a clean
 *      `faa_registry` schema in the test DB.
 *   2. Writes a fixture MASTER/ACFTREF/ENGINE .txt for day-1 and day-2:
 *      - N-001: identical both days
 *      - N-002: owner_name changes day-2
 *      - N-003: only present day-2
 *   3. Runs the full transform (bronze + gold + pg-load) twice, once per
 *      snapshot date, against the test DB and a `file://` URI for the gold
 *      parquet (no R2 round-trip).
 *   4. Asserts:
 *      - `_current` has 3 rows after day-2
 *      - `_history.is_current=true` count = `_current` count
 *      - N-002 has 2 history rows with correct `valid_from`/`valid_to`/`is_current`
 *      - `getAircraftAsOf('N-002', day-1)` returns the day-1 owner
 *      - `getAircraftAsOf('N-002', day-2)` returns the day-2 owner
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { runBronze, bronzeUri } from "../src/transform/bronze.js";
import { runGold, goldUri } from "../src/transform/gold.js";
import { runPgLoad, getAircraftAsOf } from "../src/transform/pg-load.js";
import { runChangeDetect } from "../src/transform/change-detect.js";
import { FAA_FILES, type FaaFile } from "../src/lib/config.js";

const TEST_DB_URL = process.env.FAA_TEST_DATABASE_URL;
const DUCKDB_BIN = process.env.DUCKDB_BINARY ?? "duckdb";

const duckDbAvailable = (() => {
  try {
    execSync(`${DUCKDB_BIN} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const shouldRun = !!TEST_DB_URL && duckDbAvailable;
const describeMaybe = shouldRun ? describe : describe.skip;

const DAY_1 = "2026-06-01";
const DAY_2 = "2026-06-02";
const DAY_3 = "2026-06-03";

// MASTER columns we exercise. Use FAA's exact header names; gold.ts depends
// on them. Keep this minimal (only the columns the assertions read) — other
// fields can be empty strings.
const MASTER_HEADER = [
  "N-NUMBER", "SERIAL NUMBER", "MFR MDL CODE", "ENG MFR MDL", "YEAR MFR",
  "TYPE REGISTRANT", "NAME", "STREET", "STREET2", "CITY", "STATE", "ZIP CODE",
  "REGION", "COUNTY", "COUNTRY", "LAST ACTION DATE", "CERT ISSUE DATE",
  "CERTIFICATION", "TYPE AIRCRAFT", "TYPE ENGINE", "STATUS CODE", "MODE S CODE",
  "FRACT OWNER", "AIR WORTH DATE", "OTHER NAMES(1)", "OTHER NAMES(2)",
  "OTHER NAMES(3)", "OTHER NAMES(4)", "OTHER NAMES(5)", "EXPIRATION DATE",
  "UNIQUE ID", "KIT MFR", "KIT MODEL", "MODE S CODE HEX",
];

const ACFTREF_HEADER = [
  "CODE", "MFR", "MODEL", "TYPE-ACFT", "TYPE-ENG", "AC-CAT", "BUILD-CERT-IND",
  "NO-ENG", "NO-SEATS", "AC-WEIGHT", "SPEED",
];

const ENGINE_HEADER = [
  "CODE", "MFR", "MODEL", "TYPE", "HORSEPOWER", "THRUST",
];

interface MasterRow {
  nNumber: string;
  ownerName: string;
}

function csvLine(fields: string[]): string {
  // FAA-style CSV: simple comma join, no quoting (test data has no commas).
  return fields.join(",") + "\n";
}

function masterTxt(rows: MasterRow[]): string {
  let out = MASTER_HEADER.join(",") + "\n";
  for (const r of rows) {
    const fields = MASTER_HEADER.map((h) => {
      switch (h) {
        case "N-NUMBER": return r.nNumber;
        case "NAME": return r.ownerName;
        case "MFR MDL CODE": return "CESS-172";
        case "ENG MFR MDL": return "LYCO-IO360";
        default: return "";
      }
    });
    out += csvLine(fields);
  }
  return out;
}

function acftrefTxt(): string {
  return [
    ACFTREF_HEADER.join(","),
    "CESS-172,CESSNA,172,4,1,1,STD,1,4,1,140",
    "",
  ].join("\n");
}

function engineTxt(): string {
  return [
    ENGINE_HEADER.join(","),
    "LYCO-IO360,LYCOMING,IO-360,1,200,0",
    "",
  ].join("\n");
}

function emptyTxt(headerJoin: string): string {
  return headerJoin + "\n";
}

function deregTxt(nNumbers: string[]): string {
  // Header columns DuckDB will see in the parquet; first column is N-NUMBER
  // (change-detect reads it as `"N-NUMBER"`).
  let out = "N-NUMBER,DEREG-DATE\n";
  for (const n of nNumbers) {
    out += `${n},\n`;
  }
  return out;
}

interface FixtureDay {
  date: string;
  master: MasterRow[];
  /** N-numbers to put in this day's DEREG.txt fixture (R3 deregistration). */
  dereg?: string[];
}

const FIXTURE_DAYS: FixtureDay[] = [
  {
    date: DAY_1,
    master: [
      { nNumber: "N-001", ownerName: "ALICE LLC" },
      { nNumber: "N-002", ownerName: "ORIG OWNER LLC" },
    ],
  },
  {
    date: DAY_2,
    master: [
      { nNumber: "N-001", ownerName: "ALICE LLC" },              // unchanged
      { nNumber: "N-002", ownerName: "NEW OWNER LLC" },          // changed
      { nNumber: "N-003", ownerName: "FRESH OWNER LLC" },        // new
    ],
  },
  {
    date: DAY_3,
    master: [
      { nNumber: "N-002", ownerName: "NEW OWNER LLC" },          // unchanged
      { nNumber: "N-003", ownerName: "FRESH OWNER LLC" },        // unchanged
    ],
    dereg: ["N-001"],                                            // R3 deregistration
  },
];

describeMaybe("transform pipeline (SCD-2 + getAircraftAsOf)", () => {
  let pool: pg.Pool;
  let workDir: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 4, ssl: { rejectUnauthorized: false } });
    workDir = mkdtempSync(join(tmpdir(), "faa-transform-it-"));

    // Re-apply schema: drop + recreate faa_registry so prior test runs don't
    // pollute. The migration files are idempotent enough for re-runs but
    // 0031 is drop+recreate so we lean on that.
    await pool.query(`DROP SCHEMA IF EXISTS faa_registry CASCADE`);
    const migrations = ["0022_faa_registry_schema.sql", "0025_faa_registry_manifest_fingerprints.sql", "0031_faa_registry_aircraft_scd2.sql", "0032_faa_snapshot_manifest_transform.sql", "0034_faa_aircraft_changes_r3.sql"];
    for (const m of migrations) {
      const sql = readFileSync(join(__dirname, "..", "..", "..", "packages", "db", "migrations", m), "utf8");
      await pool.query(sql);
    }

    // Seed snapshot_manifest rows so the transform's idempotency probe
    // ("manifest row must exist") passes.
    for (const day of FIXTURE_DAYS) {
      await pool.query(
        `INSERT INTO faa_registry.snapshot_manifest (snapshot_date, r2_prefix, master_count)
         VALUES ($1, $2, $3)
         ON CONFLICT (snapshot_date) DO UPDATE SET master_count = EXCLUDED.master_count`,
        [day.date, `raw/${day.date}`, day.master.length],
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end().catch(() => {});
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  it("day-1 ingest creates 2 _current + 2 _history (is_current=true) rows", async () => {
    await runOneDay(FIXTURE_DAYS[0]!, workDir);

    const cur = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM faa_registry.aircraft_registry_current`);
    expect(cur.rows[0]!.n).toBe(2);

    const hist = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM faa_registry.aircraft_registry_history WHERE is_current`,
    );
    expect(hist.rows[0]!.n).toBe(2);
  }, 60_000);

  it("day-2 ingest: N-002 closes day-1 row + opens day-2; N-003 inserts; N-001 unchanged", async () => {
    await runOneDay(FIXTURE_DAYS[1]!, workDir);

    const cur = await pool.query<{ n_number: string; owner_name: string }>(
      `SELECT n_number, owner_name FROM faa_registry.aircraft_registry_current ORDER BY n_number`,
    );
    expect(cur.rows.map((r) => r.n_number)).toEqual(["N-001", "N-002", "N-003"]);
    expect(cur.rows.find((r) => r.n_number === "N-002")!.owner_name).toBe("NEW OWNER LLC");

    const liveCount = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM faa_registry.aircraft_registry_history WHERE is_current`,
    );
    expect(liveCount.rows[0]!.n).toBe(3);

    // N-002 has exactly 2 history rows; the day-1 one is closed.
    const n2 = await pool.query<{
      valid_from: Date; valid_to: Date | null; is_current: boolean; owner_name: string;
    }>(
      `SELECT valid_from, valid_to, is_current, owner_name
         FROM faa_registry.aircraft_registry_history
        WHERE n_number = 'N-002'
        ORDER BY valid_from ASC`,
    );
    expect(n2.rows.length).toBe(2);
    expect(n2.rows[0]!.is_current).toBe(false);
    expect(formatDate(n2.rows[0]!.valid_to)).toBe(DAY_2);
    expect(n2.rows[0]!.owner_name).toBe("ORIG OWNER LLC");
    expect(n2.rows[1]!.is_current).toBe(true);
    expect(n2.rows[1]!.valid_to).toBeNull();
    expect(n2.rows[1]!.owner_name).toBe("NEW OWNER LLC");

    // N-001 unchanged: still 1 history row.
    const n1 = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM faa_registry.aircraft_registry_history WHERE n_number = 'N-001'`,
    );
    expect(n1.rows[0]!.n).toBe(1);
  }, 60_000);

  it("getAircraftAsOf returns the row that was current on the asked-for date", async () => {
    const client = await pool.connect();
    try {
      const day1 = await getAircraftAsOf(client, "N-002", DAY_1);
      const day2 = await getAircraftAsOf(client, "N-002", DAY_2);
      expect(day1?.owner_name).toBe("ORIG OWNER LLC");
      expect(day2?.owner_name).toBe("NEW OWNER LLC");
    } finally {
      client.release();
    }
  });

  // R3 (PMB-107) — change detection runs at the tail of runOneDay.
  it("R3: day-1 emitted new_registration for both seed aircraft", async () => {
    const rows = await pool.query<{
      n_number: string; change_type: string; old_value: unknown; new_value: { owner_name: string };
    }>(
      `SELECT n_number, change_type, old_value, new_value
         FROM faa_registry.aircraft_changes
        WHERE snapshot_date = $1
        ORDER BY n_number`,
      [DAY_1],
    );
    expect(rows.rows.map((r) => r.n_number)).toEqual(["N-001", "N-002"]);
    expect(rows.rows.every((r) => r.change_type === "new_registration")).toBe(true);
    expect(rows.rows.every((r) => r.old_value === null)).toBe(true);
    expect(rows.rows.find((r) => r.n_number === "N-001")!.new_value.owner_name).toBe("ALICE LLC");
  });

  it("R3: day-2 emitted exactly one ownership_transfer for N-002 + one new_registration for N-003", async () => {
    const rows = await pool.query<{
      n_number: string; change_type: string;
      old_value: { owner_name?: string } | null;
      new_value: { owner_name?: string };
    }>(
      `SELECT n_number, change_type, old_value, new_value
         FROM faa_registry.aircraft_changes
        WHERE snapshot_date = $1
        ORDER BY n_number, change_type`,
      [DAY_2],
    );
    expect(rows.rows.map((r) => `${r.n_number}/${r.change_type}`).sort()).toEqual([
      "N-002/ownership_transfer",
      "N-003/new_registration",
    ]);
    const xfer = rows.rows.find((r) => r.change_type === "ownership_transfer")!;
    expect(xfer.old_value?.owner_name).toBe("ORIG OWNER LLC");
    expect(xfer.new_value.owner_name).toBe("NEW OWNER LLC");

    // N-001 was unchanged — no change rows at all for it on day-2.
    const n1 = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM faa_registry.aircraft_changes
        WHERE snapshot_date = $1 AND n_number = 'N-001'`,
      [DAY_2],
    );
    expect(n1.rows[0]!.n).toBe(0);
  });

  it("R3: rerunning change-detect for day-2 is idempotent (row counts unchanged)", async () => {
    const before = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM faa_registry.aircraft_changes
        WHERE snapshot_date = $1`,
      [DAY_2],
    );

    await runChangeDetect({
      snapshotDate: DAY_2,
      databaseUrl: TEST_DB_URL!,
      deregBronze: bronzeUri(`file://${workDir}/r2`, DAY_2, "DEREG"),
    });

    const after = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM faa_registry.aircraft_changes
        WHERE snapshot_date = $1`,
      [DAY_2],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  }, 60_000);

  it("rerunning day-2 is a fast-skip (pg_loaded_at already set)", async () => {
    // First, the orchestrator-level fast skip — but we call pg-load directly
    // in this test so we just verify the manifest stamp didn't change and
    // re-running pg-load produces zero history inserts.
    const before = await pool.query<{ ts: Date }>(
      `SELECT pg_loaded_at AS ts FROM faa_registry.snapshot_manifest WHERE snapshot_date = $1`,
      [DAY_2],
    );
    expect(before.rows[0]!.ts).not.toBeNull();

    // Replay day-2 directly through pg-load: gold parquet still on disk
    const goldOut = goldUri(`file://${workDir}/r2`, DAY_2);
    const res = await runPgLoad({
      goldParquet: goldOut,
      snapshotDate: DAY_2,
      databaseUrl: TEST_DB_URL!,
      masterAccepted: 3,
      masterRejected: 0,
    });
    expect(res.historyInserts).toBe(0);

    // _current count remains 3.
    const cur = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM faa_registry.aircraft_registry_current`);
    expect(cur.rows[0]!.n).toBe(3);

    // is_current count remains 3.
    const live = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM faa_registry.aircraft_registry_history WHERE is_current`,
    );
    expect(live.rows[0]!.n).toBe(3);
  }, 60_000);

  // R3 deregistration runs LAST because it mutates is_current state in a way
  // that would invalidate the "live=3" invariant the day-2-rerun test asserts.
  it("R3: day-3 DEREG fires deregistration for N-001 and flips is_current=false", async () => {
    await runOneDay(FIXTURE_DAYS[2]!, workDir);

    const change = await pool.query<{
      change_type: string;
      old_value: { owner_name: string };
      new_value: { deregistered_on: string };
    }>(
      `SELECT change_type, old_value, new_value
         FROM faa_registry.aircraft_changes
        WHERE snapshot_date = $1 AND n_number = 'N-001'`,
      [DAY_3],
    );
    expect(change.rows.length).toBe(1);
    expect(change.rows[0]!.change_type).toBe("deregistration");
    expect(change.rows[0]!.old_value.owner_name).toBe("ALICE LLC");

    const hist = await pool.query<{ is_current: boolean; valid_to: Date | null }>(
      `SELECT is_current, valid_to
         FROM faa_registry.aircraft_registry_history
        WHERE n_number = 'N-001'
        ORDER BY valid_from DESC
        LIMIT 1`,
    );
    expect(hist.rows[0]!.is_current).toBe(false);
    expect(formatDate(hist.rows[0]!.valid_to)).toBe(DAY_3);

    // R4 chronology query (acceptance criterion #5).
    const chrono = await pool.query<{ snapshot_date: Date; change_type: string }>(
      `SELECT snapshot_date, change_type
         FROM faa_registry.aircraft_changes
        WHERE n_number = 'N-001'
        ORDER BY snapshot_date DESC`,
    );
    expect(chrono.rows.map((r) => `${formatDate(r.snapshot_date)}/${r.change_type}`)).toEqual([
      `${DAY_3}/deregistration`,
      `${DAY_1}/new_registration`,
    ]);
  }, 60_000);

  async function runOneDay(day: FixtureDay, root: string): Promise<void> {
    const rawDir = join(root, "raw", day.date);
    const r2Root = `file://${root}/r2`;

    // Write raw fixture .txt files.
    execSync(`mkdir -p '${rawDir}'`);
    writeFileSync(join(rawDir, "MASTER.txt"), masterTxt(day.master));
    writeFileSync(join(rawDir, "ACFTREF.txt"), acftrefTxt());
    writeFileSync(join(rawDir, "ENGINE.txt"), engineTxt());
    writeFileSync(join(rawDir, "DEALER.txt"), emptyTxt("DEALER,ID"));
    writeFileSync(join(rawDir, "DEREG.txt"), deregTxt(day.dereg ?? []));

    const sources = Object.fromEntries(
      FAA_FILES.map((f) => [f, join(rawDir, `${f}.txt`)]),
    ) as Record<FaaFile, string>;
    const destinations = Object.fromEntries(
      FAA_FILES.map((f) => [f, bronzeUri(r2Root, day.date, f)]),
    ) as Record<FaaFile, string>;

    const bronze = await runBronze({ sources, destinations });

    const recon = await runGold({
      masterParquet: destinations.MASTER,
      acftrefParquet: destinations.ACFTREF,
      engineParquet: destinations.ENGINE,
      goldParquetOut: goldUri(r2Root, day.date),
      reconciliationOut: join(root, `_reconciliation-${day.date}.json`),
      snapshotDate: day.date,
    });
    expect(recon.gold_rows).toBe(day.master.length);

    await runPgLoad({
      goldParquet: goldUri(r2Root, day.date),
      snapshotDate: day.date,
      databaseUrl: TEST_DB_URL!,
      masterAccepted: bronze.perTable.MASTER.rowsWritten,
      masterRejected: bronze.perTable.MASTER.rowsRejected,
    });

    // R3 change detection (PMB-107). Reads the SCD-2 state pg-load just
    // committed and emits per-type rows into aircraft_changes.
    await runChangeDetect({
      snapshotDate: day.date,
      databaseUrl: TEST_DB_URL!,
      deregBronze: bronzeUri(r2Root, day.date, "DEREG"),
    });
  }
});

function formatDate(d: Date | null): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

if (!shouldRun) {
  describe("transform pipeline (SCD-2)", () => {
    it.skip(`skipped: set FAA_TEST_DATABASE_URL${duckDbAvailable ? "" : " and install duckdb"} to enable`, () => {});
  });
}
