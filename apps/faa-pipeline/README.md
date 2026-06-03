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
pnpm --filter faa-pipeline ingest   # run the pipeline locally
```

## Environment variables

| Variable | Secret name | Description |
|----------|-------------|-------------|
| `R2_ACCOUNT_ID` | `FAA_R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | `FAA_R2_ACCESS_KEY_ID` | R2 API key ID |
| `R2_SECRET_ACCESS_KEY` | `FAA_R2_SECRET_ACCESS_KEY` | R2 API secret |
| `R2_BUCKET` | — | `faa-registry` (hardcoded) |
| `FAA_DATABASE_URL` | `FAA_DATABASE_URL` | Supabase FAA project connection string |

## Runbook

See [PMB-104 runbook document](/PMB/issues/PMB-104#document-runbook) for rerun, rollback, and failure-recovery procedures.
