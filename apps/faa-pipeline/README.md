# faa-pipeline

Daily ingest pipeline for the FAA Aircraft Registry. Downloads the FAA fixed-width data files, stages them in Cloudflare R2, transforms to bronze/gold, and loads into the `faa_registry` Postgres schema.

## Architecture

```
FAA ReleasableAircraft ZIP (HTTP)
  → GH Actions cron (0 2 * * *)
    → R2 raw/YYYY-MM-DD/{MASTER,ACFTREF,ENGINE,DEALER,DEREG}.txt
      → bronze parse (fixed-width → row objects)
        → gold upsert into Postgres (faa_registry schema)
```

**Storage layout (R2 bucket `faa-registry`):**

| Prefix | Content |
|--------|---------|
| `raw/YYYY-MM-DD/` | Byte-identical FAA source files |
| `bronze/YYYY-MM-DD/` | Newline-delimited JSON (one object per aircraft) |
| `gold/YYYY-MM-DD/` | Normalised, deduplicated NDJSON ready for PG load |

## Scripts

```bash
pnpm --filter faa-pipeline ingest      # run the pipeline locally
pnpm --filter faa-pipeline typecheck   # strict TS check
pnpm --filter faa-pipeline test        # unit + integration tests
```

## What R1 (PMB-105) does

1. Insert `faa_registry.pipeline_runs` row with `status='running'`, `run_id=GITHUB_RUN_ID`.
2. Download `ReleasableAircraft.zip` from `FAA_ZIP_URL` (defaults to the public FAA endpoint).
3. Extract MASTER, ACFTREF, ENGINE, DEALER, DEREG; compute sha256 + byte length per file.
4. For each file, `HEAD` the R2 key; if absent, `PUT` to `raw/YYYY-MM-DD/{FILE}.txt`.
5. UPSERT `faa_registry.snapshot_manifest` keyed on `snapshot_date` with ETag/bytes/sha256/count per file.
6. Mark the run `done`; on any throw, mark `failed` with the error message and exit non-zero so the GH Actions failure email fires.

Re-running the same `SNAPSHOT_DATE`:
- If the manifest row exists **and** all five R2 keys exist → no download, no PUTs, no PG churn (idempotent skip).
- If some keys are missing → only those keys are downloaded/uploaded and the manifest is upserted.

Override the date for backfills with `SNAPSHOT_DATE=2026-06-01`.

## Environment variables

| Variable | Secret name | Description |
|----------|-------------|-------------|
| `R2_ACCOUNT_ID` | `FAA_R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | `FAA_R2_ACCESS_KEY_ID` | R2 API key ID |
| `R2_SECRET_ACCESS_KEY` | `FAA_R2_SECRET_ACCESS_KEY` | R2 API secret |
| `R2_BUCKET` | — | `faa-registry` (default) |
| `FAA_DATABASE_URL` | `FAA_DATABASE_URL` | Supabase FAA project connection string |
| `FAA_ZIP_URL` | — | Override the FAA download URL (default: `https://registry.faa.gov/database/ReleasableAircraft.zip`) |
| `SNAPSHOT_DATE` | — | Override the snapshot date (defaults to today UTC). Format `YYYY-MM-DD`. |
| `GITHUB_RUN_ID` | — | GH Actions run id; recorded in `pipeline_runs.run_id`. |

On-call failure email (GH Actions step) needs these secrets:

| Variable | Description |
|----------|-------------|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` | SMTP relay creds |
| `FAA_ONCALL_EMAIL` | Recipient alias |

## Runbook

See [PMB-104 runbook document](/PMB/issues/PMB-104#document-runbook) for rerun, rollback, and failure-recovery procedures.
