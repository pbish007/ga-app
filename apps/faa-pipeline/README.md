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

## Storage modes (PMB-144)

The pipeline supports two `STORAGE_MODE` values, set per workflow run:

### `lakefs` (default for new runs)

The ingest extracts the 5 FAA files to `LAKEFS_STAGING_DIR/raw/YYYY-MM-DD/{FILE}.txt`
on disk, then a downstream GH Actions step does:

```
lakectl fs upload --direct -s <staged-file> lakefs://faa-registry/main/raw/<date>/<FILE>.txt
lakectl commit lakefs://faa-registry/main -m "FAA ingest <date>" --meta source=faa-arweb --meta rows=<row-count>
lakectl tag create  lakefs://faa-registry/ingest-<date> lakefs://faa-registry/main
```

`--direct` tells lakectl to pull a pre-signed S3 URL from the lakeFS server
and PUT to R2 itself, so the actual file bytes never traverse the Fly VM.

The Node ingest also writes `LAKEFS_STAGING_DIR/_summary.json` with
`{ snapshotDate, totalRows, files: [...] }` for the workflow to consume.

**Rollback recipe** — to point `main` back at the commit before an ingest:

```
lakectl revert lakefs://faa-registry/main <commit-hash>
```

The commit hash is in the workflow run's GitHub step summary, and on the
`ingest-<date>` tag.

### `r2` (legacy direct path, retained as a fallback)

Bypasses lakeFS entirely and PUTs straight to R2 as in R1. Trigger from
**Run workflow** with `storage_mode=r2` if lakeFS is wedged. The R2 bucket
layout is identical between the two modes, so downstream consumers see no
difference on the read path.

## Environment variables

| Variable | Secret name | Description |
|----------|-------------|-------------|
| `STORAGE_MODE` | — | `lakefs` (default in the workflow) or `r2`. Selects whether the Node ingest writes directly to R2 or stages files for `lakectl`. |
| `LAKEFS_STAGING_DIR` | — | Directory the Node ingest writes staged files to in `lakefs` mode (default: `$RUNNER_TEMP/faa-stage`). |
| `R2_ACCOUNT_ID` | `FAA_R2_ACCOUNT_ID` | Cloudflare account ID (required when `STORAGE_MODE=r2`). |
| `R2_ACCESS_KEY_ID` | `FAA_R2_ACCESS_KEY_ID` | R2 API key ID (required when `STORAGE_MODE=r2`). |
| `R2_SECRET_ACCESS_KEY` | `FAA_R2_SECRET_ACCESS_KEY` | R2 API secret (required when `STORAGE_MODE=r2`). |
| `R2_BUCKET` | — | `faa-registry` (default) |
| `FAA_DATABASE_URL` | `FAA_DATABASE_URL` | Supabase FAA project connection string |
| `FAA_ZIP_URL` | — | Override the FAA download URL (default: `https://registry.faa.gov/database/ReleasableAircraft.zip`) |
| `SNAPSHOT_DATE` | — | Override the snapshot date (defaults to today UTC). Format `YYYY-MM-DD`. |
| `GITHUB_RUN_ID` | — | GH Actions run id; recorded in `pipeline_runs.run_id`. |

The workflow additionally reads `LAKEFS_ENDPOINT`, `LAKEFS_ACCESS_KEY_ID`,
and `LAKEFS_SECRET_ACCESS_KEY` (provisioned in PMB-139) for the `lakectl`
shell calls. The Node ingest never sees those.

On-call failure email (GH Actions step) needs these secrets:

| Variable | Description |
|----------|-------------|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` | SMTP relay creds |
| `FAA_ONCALL_EMAIL` | Recipient alias |

## Runbook

See [PMB-104 runbook document](/PMB/issues/PMB-104#document-runbook) for rerun, rollback, and failure-recovery procedures.
