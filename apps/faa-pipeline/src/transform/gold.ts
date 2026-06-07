/**
 * Gold: MASTER ⋈ ACFTREF ⋈ ENGINE → one Parquet shaped exactly like
 * `faa_registry.aircraft_registry_current`.
 *
 * The schema written here MUST match the column order of the `_current`
 * table so the pg-load stage can `COPY` into a staging table without
 * column-list gymnastics.
 *
 * Reconciliation: writes `_reconciliation.json` alongside the parquet with
 * counts for rejected rows (MASTER rows that failed type-casts), unmatched
 * ACFTREF/ENGINE joins, etc. The JSON file lands as a sibling of the
 * parquet so an operator can `lakectl fs cat` it without opening DuckDB.
 *
 * FAA date format: 'YYYYMMDD' as text. We use `TRY_STRPTIME(...)` so any
 * malformed date silently produces NULL rather than failing the whole load.
 */

import { writeFileSync } from "node:fs";
import { runDuckSql, r2Preamble, parseSingleRowCsv, type R2Credentials } from "./duckdb.js";

export interface GoldInputs {
  masterParquet: string;     // bronze MASTER parquet URI
  acftrefParquet: string;    // bronze ACFTREF parquet URI
  engineParquet: string;     // bronze ENGINE parquet URI
  goldParquetOut: string;    // destination URI for aircraft_registry_current.parquet
  reconciliationOut: string; // LOCAL file path for _reconciliation.json (caller uploads)
  snapshotDate: string;
  r2?: R2Credentials;
}

export interface GoldReconciliation {
  snapshot_date: string;
  master_rows: number;
  gold_rows: number;
  master_rejected: number;
  unmatched_acftref: number;
  unmatched_engine: number;
}

export async function runGold(inputs: GoldInputs): Promise<GoldReconciliation> {
  const preamble = inputs.r2 ? r2Preamble(inputs.r2) : "";

  // Project + cast MASTER into the gold shape, left-joined to ACFTREF/ENGINE.
  // Column order MUST match aircraft_registry_current in migration 0031.
  // We trim TEXT fields (FAA pads with spaces); empty trimmed text becomes NULL.
  const goldSelect = `
SELECT
  TRIM(m."N-NUMBER")                                                AS n_number,
  NULLIF(TRIM(m."SERIAL NUMBER"), '')                              AS serial_number,
  NULLIF(TRIM(m."MFR MDL CODE"), '')                               AS mfr_mdl_code,
  NULLIF(TRIM(m."ENG MFR MDL"), '')                                AS eng_mfr_mdl,
  TRY_CAST(NULLIF(TRIM(m."YEAR MFR"), '') AS SMALLINT)             AS year_mfr,
  TRY_CAST(NULLIF(TRIM(m."TYPE REGISTRANT"), '') AS SMALLINT)      AS type_registrant,
  NULLIF(TRIM(m."NAME"), '')                                       AS owner_name,
  NULLIF(TRIM(m."STREET"), '')                                     AS street,
  NULLIF(TRIM(m."STREET2"), '')                                    AS street2,
  NULLIF(TRIM(m."CITY"), '')                                       AS city,
  NULLIF(TRIM(m."STATE"), '')                                      AS state,
  NULLIF(TRIM(m."ZIP CODE"), '')                                   AS zip_code,
  NULLIF(TRIM(m."REGION"), '')                                     AS region,
  NULLIF(TRIM(m."COUNTY"), '')                                     AS county,
  NULLIF(TRIM(m."COUNTRY"), '')                                    AS country,
  TRY_STRPTIME(NULLIF(TRIM(m."LAST ACTION DATE"), ''), '%Y%m%d')::DATE AS last_action_date,
  TRY_STRPTIME(NULLIF(TRIM(m."CERT ISSUE DATE"), ''), '%Y%m%d')::DATE  AS cert_issue_date,
  NULLIF(TRIM(m."CERTIFICATION"), '')                              AS certification,
  TRY_CAST(NULLIF(TRIM(m."TYPE AIRCRAFT"), '') AS SMALLINT)        AS type_aircraft,
  TRY_CAST(NULLIF(TRIM(m."TYPE ENGINE"), '') AS SMALLINT)          AS type_engine,
  NULLIF(TRIM(m."STATUS CODE"), '')                                AS status_code,
  NULLIF(TRIM(m."MODE S CODE"), '')                                AS mode_s_code,
  NULLIF(TRIM(m."FRACT OWNER"), '')                                AS fract_owner,
  TRY_STRPTIME(NULLIF(TRIM(m."AIR WORTH DATE"), ''), '%Y%m%d')::DATE AS airworthiness_date,
  NULLIF(TRIM(m."OTHER NAMES(1)"), '')                             AS other_names_1,
  NULLIF(TRIM(m."OTHER NAMES(2)"), '')                             AS other_names_2,
  NULLIF(TRIM(m."OTHER NAMES(3)"), '')                             AS other_names_3,
  NULLIF(TRIM(m."OTHER NAMES(4)"), '')                             AS other_names_4,
  NULLIF(TRIM(m."OTHER NAMES(5)"), '')                             AS other_names_5,
  TRY_STRPTIME(NULLIF(TRIM(m."EXPIRATION DATE"), ''), '%Y%m%d')::DATE AS expiration_date,
  NULLIF(TRIM(m."UNIQUE ID"), '')                                  AS unique_id,
  NULLIF(TRIM(m."KIT MFR"), '')                                    AS kit_mfr,
  NULLIF(TRIM(m."KIT MODEL"), '')                                  AS kit_model,
  NULLIF(TRIM(m."MODE S CODE HEX"), '')                            AS mode_s_code_hex,

  NULLIF(TRIM(a."MFR"), '')                                        AS mfr_name,
  NULLIF(TRIM(a."MODEL"), '')                                      AS model_name,
  NULLIF(TRIM(a."TYPE-ACFT"), '')                                  AS aircraft_type,
  TRY_CAST(NULLIF(TRIM(a."AC-CAT"), '') AS SMALLINT)               AS ac_cat_code,
  NULLIF(TRIM(a."BUILD-CERT-IND"), '')                             AS ac_weight_class,
  TRY_CAST(NULLIF(TRIM(a."NO-ENG"), '') AS SMALLINT)               AS no_engines,
  TRY_CAST(NULLIF(TRIM(a."NO-SEATS"), '') AS SMALLINT)             AS no_seats,
  TRY_CAST(NULLIF(TRIM(a."SPEED"), '') AS INTEGER)                 AS ac_cruising_speed,

  NULLIF(TRIM(e."MFR"), '')                                        AS eng_mfr_name,
  NULLIF(TRIM(e."MODEL"), '')                                      AS eng_model_name,
  TRY_CAST(NULLIF(TRIM(e."TYPE"), '') AS SMALLINT)                 AS eng_type,
  TRY_CAST(NULLIF(TRIM(e."HORSEPOWER"), '') AS INTEGER)            AS eng_horsepower,
  TRY_CAST(NULLIF(TRIM(e."THRUST"), '') AS INTEGER)                AS eng_thrust,

  DATE '${inputs.snapshotDate}'                                    AS snapshot_date,
  CURRENT_TIMESTAMP                                                AS updated_at
FROM read_parquet(${quoteUri(inputs.masterParquet)}) m
LEFT JOIN read_parquet(${quoteUri(inputs.acftrefParquet)}) a
  ON TRIM(a."CODE") = TRIM(m."MFR MDL CODE")
LEFT JOIN read_parquet(${quoteUri(inputs.engineParquet)}) e
  ON TRIM(e."CODE") = TRIM(m."ENG MFR MDL")
WHERE m."N-NUMBER" IS NOT NULL AND TRIM(m."N-NUMBER") <> ''
`;

  const writeSql = [
    preamble,
    `COPY (${goldSelect}) TO ${quoteUri(inputs.goldParquetOut)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 50000);`,
  ].join("\n");
  await runDuckSql(writeSql);

  // Reconciliation: compute counts off the parquets directly.
  const reconSql = [
    preamble,
    `SELECT`,
    `  (SELECT COUNT(*) FROM read_parquet(${quoteUri(inputs.masterParquet)})) AS master_rows,`,
    `  (SELECT COUNT(*) FROM read_parquet(${quoteUri(inputs.goldParquetOut)})) AS gold_rows,`,
    `  (SELECT COUNT(*) FROM read_parquet(${quoteUri(inputs.masterParquet)}) m`,
    `   LEFT JOIN read_parquet(${quoteUri(inputs.acftrefParquet)}) a`,
    `     ON TRIM(a."CODE") = TRIM(m."MFR MDL CODE")`,
    `   WHERE a."CODE" IS NULL) AS unmatched_acftref,`,
    `  (SELECT COUNT(*) FROM read_parquet(${quoteUri(inputs.masterParquet)}) m`,
    `   LEFT JOIN read_parquet(${quoteUri(inputs.engineParquet)}) e`,
    `     ON TRIM(e."CODE") = TRIM(m."ENG MFR MDL")`,
    `   WHERE e."CODE" IS NULL AND TRIM(m."ENG MFR MDL") <> '') AS unmatched_engine;`,
  ].join("\n");

  const { stdout } = await runDuckSql(reconSql);
  const row = parseSingleRowCsv(stdout);
  const masterRows = Number(row.master_rows ?? "0");
  const goldRows = Number(row.gold_rows ?? "0");

  const recon: GoldReconciliation = {
    snapshot_date: inputs.snapshotDate,
    master_rows: masterRows,
    gold_rows: goldRows,
    master_rejected: Math.max(0, masterRows - goldRows),
    unmatched_acftref: Number(row.unmatched_acftref ?? "0"),
    unmatched_engine: Number(row.unmatched_engine ?? "0"),
  };

  writeFileSync(inputs.reconciliationOut, JSON.stringify(recon, null, 2));
  return recon;
}

function quoteUri(uri: string): string {
  if (uri.includes("'")) throw new Error(`URI contains a single quote: ${uri}`);
  return `'${uri}'`;
}

export function goldUri(rootBronzeUri: string, snapshotDate: string): string {
  const base = rootBronzeUri.replace(/\/+$/, "");
  return `${base}/gold/${snapshotDate}/aircraft_registry_current.parquet`;
}
