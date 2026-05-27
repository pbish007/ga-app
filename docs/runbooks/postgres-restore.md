# Postgres backup + restore runbook

> **Audience:** any future operator (engineer, on-call, or the CEO) coming to this cold.
> **Scope:** GA App production Postgres, hosted on Neon.
> **Owner of last resort:** CTO.

This runbook covers (1) the backup posture we run with, (2) the targets we
hold ourselves to, and (3) the exact steps to restore the database from
either a point-in-time or a snapshot. It is the J1.1 deliverable on
[PMB-19](/PMB/issues/PMB-19); the J1.2 drill ([PMB-22](/PMB/issues/PMB-22))
exercises step 3 against a staging branch.

> **A note on "staging" in Phase A.** Neon has no separate staging instance
> in our setup — there is one project, `ga-app-prod`. The drill (and any
> rehearsal restore) creates a fresh Neon **branch** off `main`, treats it
> as staging for the duration of the exercise, then deletes it. The same
> branch-from-PITR mechanism is what we use in an actual incident.

---

## 1. Backup posture

| Concern              | Setting (Phase A — Neon Free)                   | Setting (Phase B — Neon Launch, $19/mo) |
| -------------------- | ----------------------------------------------- | --------------------------------------- |
| Frequency            | Continuous WAL streamed into the project        | Continuous WAL streamed into the project |
| Snapshots            | Automatic daily snapshot                        | Automatic daily snapshot                |
| **PITR window**      | **24 hours** (Free)                              | **7 days** (Launch); upgradeable on higher tiers |
| Retention beyond PITR | None on Free — provider deletes WAL past 24h    | 7-day rolling window on Launch          |
| Cross-region copies  | None at MVP                                     | None at MVP                             |
| Owner                | Neon (managed) + CTO (verifies via drill)       | Neon (managed) + CTO (verifies via drill) |

**Why this is enough for MVP:** the system is the source of truth for
maintenance compliance, not for live operational telemetry. The realistic
worst-case data loss event is an accidental delete by an authenticated user;
PITR within the last 24h covers that. Production goes to Phase B before the
first paying tenant — the trigger and a follow-up confirmation are tracked
on [PMB-9](/PMB/issues/PMB-9).

### Phase A → Phase B trigger (must be re-confirmed by CEO)

Move to Neon Launch **before** any of:

1. The first paying tenant signs up (revenue at risk → 24h RPO is no longer acceptable).
2. Aggregate row count crosses ~250k (Neon Free storage ceiling is ~512 MB).
3. We add anything that needs a longer PITR (audit log retention, regulator-facing exports).

---

## 2. RTO / RPO targets

| Target | Phase A (Free) | Phase B (Launch) |
| ------ | -------------- | ---------------- |
| **RPO** (max acceptable data loss)        | ≤ 24 hours | ≤ 5 minutes |
| **RTO** (max acceptable downtime)         | ≤ 2 hours  | ≤ 30 minutes |
| **Verification cadence**                  | quarterly  | monthly      |
| **Owner**                                 | CTO        | CTO          |

These numbers are conservative on purpose. Neon's PITR completes in
single-digit minutes for a project of this size in practice; the budget above
includes a person realizing something is wrong, deciding to restore, and
re-pointing the app at the recovered branch.

---

## 3. Restore procedure

### 3.1 When to restore (decision tree)

```
Is the database visibly broken (errors, missing rows, corrupt data)?
├── No → STOP. Investigate, don't restore.
└── Yes:
    Was the cause a known event with a clear timestamp (bad migration, mass delete)?
    ├── Yes → Restore to a point a few minutes BEFORE that event. See 3.3.
    └── No (silent corruption, unclear blast radius):
            Restore to the most recent automatic snapshot. See 3.4.
            File a post-incident issue under the J epic ([PMB-9](/PMB/issues/PMB-9)).
```

### 3.2 Prerequisites — verify before restoring

1. **You can log into Neon.** Console URL: <https://console.neon.tech>.
   Organization: **Patrick** (`org-snowy-violet-63023497`). Project: human
   name **`ga-app-prod`**, project slug **`royal-darkness-36853636`**,
   region `aws-us-east-2`, Postgres 17. The slug is what shows up in the
   URL bar and what the Neon API expects.
2. **You have a working psql.** macOS:
   `brew install postgresql@17`. Verify: `psql --version` ≥ 14.
3. **You have the current `DATABASE_URL_DIRECT`.** This is the direct
   (non-pooled) connection string. Pooled connections cannot be used for
   restore-style admin work. As of 2026-05-27 the direct host is
   `ep-wispy-block-aj56ake7.c-3.us-east-2.aws.neon.tech`; the pooled host
   is the same with `-pooler` appended. Both are also set on the Vercel
   `ga-app` project as `DATABASE_URL_DIRECT` and `DATABASE_URL`
   respectively (Production scope), so `vercel env pull` works as a
   fallback if the Neon console is unreachable.
4. **You have a place to send the recovered DB.** Default plan: restore into
   a **new Neon branch**, validate the data, then promote that branch to
   primary by swapping `DATABASE_URL` in Vercel. **Do not** restore over the
   current primary on the first attempt — branches are free and reversible.

### 3.3 Point-in-time restore (Neon UI)

Use this when you know the timestamp to roll back to.

1. Neon console → project `ga-app-prod` → **Branches** → **Create branch**.
2. **Parent branch:** `production` (this is what the default/primary branch
   is actually named in our Neon project — `main` is the conventional
   default Neon assigns, but our project was created with `production`).
3. **From point in time:** select the timestamp **just before** the event
   you're recovering from. Neon's selector is in your local timezone — log
   the chosen UTC timestamp in the incident ticket.
4. Name the branch `restore-YYYYMMDD-HHMM-${incident_id}`. Submit.
5. Wait for the branch status to flip to **Ready** (typically 1–5 minutes).
6. Click the new branch → **Connection details** → copy the pooled and
   direct connection strings.
7. **Validate before promoting.** From a workstation with psql:
   ```sh
   psql "$RESTORED_DATABASE_URL_DIRECT" -c "SELECT count(*) FROM regimes;"
   psql "$RESTORED_DATABASE_URL_DIRECT" -c "SELECT count(*) FROM users;"
   psql "$RESTORED_DATABASE_URL_DIRECT" -c "SELECT max(updated_at) FROM users;"
   ```
   Check row counts roughly match expectation and that `max(updated_at)`
   pre-dates the incident. Spot-check 2–3 tenants by id if the incident is
   tenant-scoped.
8. **Promote.** In Vercel → project `ga-app` → **Settings → Environment
   Variables**, set `DATABASE_URL` and `DATABASE_URL_DIRECT` to the new
   branch's strings for **Production**. Redeploy
   (`vercel --prod`, or push an empty commit if you don't have the CLI).
9. **Verify production.** Hit `https://<prod-host>/health`, exercise one
   read-heavy and one write-heavy path, confirm no 5xx in the Vercel log.
10. **Tidy up.** In Neon, mark the old primary branch read-only (do **not**
    delete it) for at least 7 days. Open a follow-up issue capturing the
    cause, the chosen restore timestamp, and the validation results.

### 3.4 Snapshot restore (no clear timestamp)

Same as 3.3 but in step 3 pick **From snapshot** instead of a point in time.
The most recent automatic snapshot is the default.

### 3.5 Restore from a different region (DR drill, not MVP)

Out of scope for MVP. Neon is single-region today. When we go multi-region,
this section will document the failover playbook; J epic owns that
expansion.

---

## 3.6 Applying migrations to a fresh (or restored) Neon branch

Run the idempotent migration helper. It uses `psql`, creates a
`schema_migrations` tracking table on first run, and is safe to re-invoke:

```sh
export DATABASE_URL_DIRECT="postgres://USER:PASS@HOST.REGION.aws.neon.tech/DBNAME?sslmode=require"
packages/db/scripts/migrate.sh
```

The script refuses to run against a URL without `sslmode=require` (or
stricter) and against the pooled endpoint — use the direct (non-`-pooler.`)
hostname.

Verify TLS is on after the first migration completes:

```sh
psql "$DATABASE_URL_DIRECT" -c "SHOW ssl;"            # expect: on
psql "$DATABASE_URL_DIRECT" -c "SELECT count(*) FROM regimes;"  # expect: 1 (FAA)
```

---

## 3.7 Verification drill (J1.2)

The drill exercises §3.3 end-to-end and writes one row into §5 (verification
log). Run it quarterly on Phase A, monthly on Phase B. Both the engineer
and an on-call operator should be able to execute it cold.

**Inputs you need before starting**

- Neon console access (so you can create a branch and read its connection
  string), OR a Neon API key with `member` scope on the `ga-app-prod`
  project.
- A workstation with `psql` ≥ 14 and `python3` (for the JSON diff).

**Procedure**

1. **Snapshot the source.** In the Neon console → project `ga-app-prod` →
   **Branches** → note the head LSN / timestamp on `main`. Start a wall-clock
   stopwatch.
2. **Create the drill branch.** Click **Create branch** → parent `main` →
   **From point in time:** the timestamp from step 1 (or "Now" — both are
   valid for a drill). Name the branch `drill-YYYYMMDD-HHMM`. Wait for the
   status to flip to **Ready**.
3. **Stop the stopwatch.** Record the elapsed seconds — this is the restore
   duration the drill publishes.
4. **Pull both connection strings.** From the Neon UI, copy the **direct**
   (non-`-pooler.`) URLs of (a) the source/primary `main` branch and (b)
   the new drill branch.
5. **Run the comparator.** From a checkout of this repo on `main`:

   ```sh
   export SOURCE_DATABASE_URL='postgres://...@HOST.REGION.aws.neon.tech/DBNAME?sslmode=require'
   export RESTORED_DATABASE_URL='postgres://...@DRILL_HOST.REGION.aws.neon.tech/DBNAME?sslmode=require'
   export RESTORE_DURATION_SECONDS=<from step 3>
   export OUT_DIR=./drill-out
   packages/db/scripts/drill-compare.sh
   ```

   The script writes `./drill-out/report.json` and exits **0 on match**, **1
   on mismatch**. It checks every table the migrations create — extra/missing
   tables and row-count differences both fail the drill.

6. **Attach the artifact.** Upload `drill-out/report.json` to [PMB-22](/PMB/issues/PMB-22).
   Add a row to §5 below with the date, the tier, the operator, PASS/FAIL,
   and the report's `total_duration_seconds` (= our published RTO estimate
   for this drill).

7. **Tidy up.** Delete the drill branch from the Neon UI. Drill branches
   bill against the project's storage allowance.

**What "PASS" means**

- `ok: true` in the report (every sample table either exists in both with
  identical row counts, or doesn't exist in either).
- `total_duration_seconds` is at or below the documented RTO for the
  current tier (Phase A ≤ 7200s, Phase B ≤ 1800s).

If `ok` is false, do **not** mark the drill PASS. The mismatch is either a
real fidelity bug in Neon (file an incident under [PMB-9](/PMB/issues/PMB-9)
immediately) or a runbook gap — note it in §5 and patch this document.

---

## 4. What we explicitly do NOT do

- **No `pg_dump` to local disk on a schedule.** Neon's continuous backup is
  the source of truth. Hand-rolled dumps add an exfiltration surface and
  drift from the managed copy.
- **No restore-in-place over the current primary.** Always restore into a
  new branch, validate, then swap. The CTO must explicitly authorize an
  in-place restore (and document why) before it happens.
- **No secrets in this runbook.** Connection strings live in 1Password
  (or the equivalent secret manager) and in Vercel project env. This file
  must remain checkable into git.

---

## 5. Verification log

| Date       | Tier   | Operator | Result | Notes / linked issue |
| ---------- | ------ | -------- | ------ | -------------------- |
| 2026-05-27 | Phase A (Neon Free) | CTO ([@Founding Engineer](agent://cc7304c9-2164-4f4b-a9d1-c2e12cd1440e)) | **PASS** — 28/28 sample tables match (regime spine + RBAC populated, domain tables empty on both sides); restore 11s, verify 23s, total 34s, vs Phase A RTO budget 7200s. | [PMB-22](/PMB/issues/PMB-22), `drill-out/report.json` attached to the issue. Two runbook gaps caught and patched in the same commit: §3.2 project slug + §3.3 default branch name (`production`, not `main`). |
