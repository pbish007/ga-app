# Postgres backup + restore runbook

> **Audience:** any future operator (engineer, on-call, or the CEO) coming to this cold.
> **Scope:** GA App production Postgres, hosted on Neon.
> **Owner of last resort:** CTO.

This runbook covers (1) the backup posture we run with, (2) the targets we
hold ourselves to, and (3) the exact steps to restore the database from
either a point-in-time or a snapshot. It is the J1.1 deliverable on
[PMB-19](/PMB/issues/PMB-19); the J1.2 drill ([PMB-22](/PMB/issues/PMB-22))
exercises step 3 against a staging branch.

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

1. **You can log into Neon.** Console URL: <https://console.neon.tech>. Project:
   `ga-app-prod` (replace with the actual slug once provisioned).
2. **You have a working psql.** macOS:
   `brew install postgresql@17`. Verify: `psql --version` ≥ 14.
3. **You have the current `DATABASE_URL_DIRECT`.** This is the direct
   (non-pooled) connection string. Pooled connections cannot be used for
   restore-style admin work.
4. **You have a place to send the recovered DB.** Default plan: restore into
   a **new Neon branch**, validate the data, then promote that branch to
   primary by swapping `DATABASE_URL` in Vercel. **Do not** restore over the
   current primary on the first attempt — branches are free and reversible.

### 3.3 Point-in-time restore (Neon UI)

Use this when you know the timestamp to roll back to.

1. Neon console → project `ga-app-prod` → **Branches** → **Create branch**.
2. **Parent branch:** `main` (or whichever branch is currently primary).
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
| *(empty — J1.2 will write the first row)* | | | | [PMB-22](/PMB/issues/PMB-22) |
