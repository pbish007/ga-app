# Postgres restore-verification trend log

> **Source of rows:** the J1.2 manual drill plus every successful run of
> `.github/workflows/db-backup-verify.yml` (PMB-87). Rows are appended by
> the workflow via a PR titled `chore(ops): backup-verify trend row …`;
> the CTO merges those PRs as part of normal review.

Why this file exists: the Phase A J1.2 drill ([PMB-22](/PMB/issues/PMB-22))
captured a single 34 s point-in-time RTO. A point is not a trend. If Neon
control-plane latency drifts, our schema-migration count grows, or PITR
retention silently shortens, we want to see it on the trend line before the
next real incident.

## How to read this table

- **timestamp_utc** — the verifier's server-side `now() AT TIME ZONE 'UTC'`
  at the moment the snapshot was captured (not when the workflow started).
- **trigger** — `schedule` (monthly cron), `workflow_dispatch` (manual
  rehearsal), or `manual` (J1.2 drill, performed by hand pre-automation).
- **restore_s / verify_s / total_s** — wall-clock seconds for branch
  create, snapshot diff, and the sum. Phase A budget: `total_s ≤ 170`
  (5× the J1.2 baseline of 34 s). Phase A absolute RTO budget per
  `postgres-restore.md` §2 is 7200 s.
- **tables_matched** — count of sample tables that exist on the ephemeral
  branch (numerator) over the verifier's full sample list (denominator,
  currently 28). Anything other than `N/N` is a fail.
- **server_version** — Postgres major.minor reported by the branch.
- **run** — link to the GitHub Actions run that produced the row (or to
  the source ticket for pre-automation rows).

## Trend

| timestamp_utc | trigger | restore_s | verify_s | total_s | tables_matched | server_version | run |
| ------------- | ------- | --------- | -------- | ------- | -------------- | -------------- | --- |
| 2026-05-27T19:00:00Z | manual | 11 | 23 | 34 | 28/28 | 17.10 | [PMB-22](/PMB/issues/PMB-22) |
| 2026-06-04T15:51:44Z | workflow_dispatch | 5 | 28 | 33 | 28/28 | 17.10(6a49db4) | [run](https://github.com/pbish007/ga-app/actions/runs/26963072334) |
