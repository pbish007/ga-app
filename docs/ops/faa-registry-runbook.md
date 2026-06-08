# FAA Registry pipeline runbook

> **Audience:** any future operator coming to this cold — engineer, on-call, or the CEO.
> **Scope:** the daily FAA aircraft-registry ingest → bronze → gold → Postgres
> pipeline, its monitoring surfaces, and its recovery playbook.
> **Owner of last resort:** DevOpsEngineer (pipeline runtime), BackendEngineer
> (transform/data code inside it), CTO (escalation).
> **Issues:** [PMB-99](../../README.md) (epic) →
> [PMB-105 / PMB-106 / PMB-110](../../README.md) (R1/R2/R5).

This runbook is the [PMB-110](../../README.md) deliverable. Pair it with
`docs/runbooks/observability.md` (cross-pipeline failure-signal map) and
`docs/runbooks/migrations.md` (FAA migration apply procedure).

---

## 1. Architecture at a glance

```
                    cron 02:00 UTC                  workflow_dispatch
                          │                                 │
                          ▼                                 │
                ┌────────────────────────────────┐          │
                │ .github/workflows/             │◀─────────┘
                │   faa-ingest.yml               │
                └──────────┬─────────────────────┘
                           │
       ┌───────────────────┼───────────────────────────┐
       ▼                   ▼                           ▼
  download +          stage to                  bronze + gold +
  extract ZIP    →    lakeFS / R2          →    pg-load (DuckDB)
  (3x retry)         (signed PUT)                       │
                                                        ▼
                                              FAA Supabase
                                            (faa_registry.*)
```

- **Trigger:** GH Actions cron `0 2 * * *` (UTC) or manual `workflow_dispatch`.
- **Source:** [`https://registry.faa.gov/database/ReleasableAircraft.zip`](https://registry.faa.gov/database/ReleasableAircraft.zip)
  (FAA Aircraft Registry releasable database — public, no auth).
- **Storage:** lakeFS (default) → Cloudflare R2 backing store. Legacy `r2`
  mode is preserved as a workflow-dispatch fallback. See
  [`infra/lakefs-faa/`](../../infra/lakefs-faa) and PMB-139 for the lakeFS
  deployment story.
- **Database:** FAA Supabase project `idjhuqubjgjloywsfgtu`
  (`aws-1` pooler, `us-east-1`). Schema lives at `faa_registry.*`.
- **Pipeline state-of-record:** `faa_registry.pipeline_runs` (one row per
  workflow run), `faa_registry.snapshot_manifest` (one row per snapshot
  date, with bronze/gold/pg timestamps + row-count fingerprints).

---

## 2. Monitoring & alerting

### 2.1 What we have today

| Signal              | Where it lands                                                                                                            | SLA |
|---------------------|---------------------------------------------------------------------------------------------------------------------------|-----|
| Workflow failure    | GitHub Issue (`pbish007/ga-app`, labels `ops`, `workflow-failure`, `faa-ingest`) auto-assigned to `@pbish007`; GH emails him within seconds | < 1 min |
| Pipeline-run state  | `faa_registry.pipeline_runs` row (`status` ∈ `running`/`done`/`failed`, `error_message`)                                  | real-time |
| Transform progress  | `faa_registry.snapshot_manifest` columns: `bronze_written_at`, `gold_written_at`, `pg_loaded_at`, accept/reject counts    | real-time |
| Workflow summary    | `$GITHUB_STEP_SUMMARY` table per run, posted to the Actions run page                                                      | real-time |

This satisfies the PMB-110 alerting AC ("PagerDuty **or email fallback**
within 15 min"): the GitHub Issue notifier in `faa-ingest.yml` (step
`File GitHub issue on failure`) reaches the CEO's inbox in under a minute
on every failed run.

### 2.2 What we deferred (and the upgrade path)

- **PagerDuty.** Paid; not warranted while volume is one daily cron with
  a single recipient. Upgrade trigger: when on-call rotation has > 1
  recipient, or when MTTD ever exceeds 15 min in practice. Tracked in
  the PMB-110 follow-up child issues.
- **Grafana / metrics stack.** The "dashboard" AC is satisfied for now
  by the SQL query in §2.4 below: it's the same one we'd put on a Grafana
  panel and we can lift it directly when a metrics stack lands. Upgrade
  trigger: same as PagerDuty (multi-recipient on-call), or when a
  non-engineer needs at-a-glance state without psql access.

### 2.3 Reading `pipeline_runs` (one-pager)

```bash
psql "$FAA_DATABASE_URL" <<'SQL'
SELECT id,
       run_id,
       snapshot_date,
       status,
       started_at,
       finished_at,
       finished_at - started_at AS duration,
       left(coalesce(error_message,''), 200) AS error_head
FROM faa_registry.pipeline_runs
ORDER BY started_at DESC
LIMIT 14;
SQL
```

The view answers "did today's ingest land?", "how long did it take?", and
"what was the last failure?" in one round-trip.

### 2.4 SQL "dashboard" panel — success/failure over 30d

This is the AC-1 panel. Lift directly to Grafana when the metrics stack
lands; the columns map 1:1 to a time-series.

```sql
SELECT date_trunc('day', started_at)::date         AS day,
       count(*)                                     AS runs,
       count(*) FILTER (WHERE status = 'done')      AS done,
       count(*) FILTER (WHERE status = 'failed')    AS failed,
       count(*) FILTER (WHERE status = 'running'
                     AND started_at < now() - interval '1 hour') AS stuck
FROM faa_registry.pipeline_runs
WHERE started_at > now() - interval '30 days'
GROUP BY 1
ORDER BY 1 DESC;
```

`stuck` is the panel's leading alert column: a run still in `running`
state after 1 h is almost always a wedged workflow that never reached
`finishRun`.

### 2.5 Testing the alert path without breaking prod

The simplest non-destructive verification is `workflow_dispatch` with a
forced-fail input on the `db-migrate.yml` companion workflow (synthetic
fail). The FAA ingest workflow has no synthetic-fail input today; if we
need one, add a `synthetic_fail: bool` matching the db-migrate pattern
under PMB-110 follow-up.

### 2.6 Silencing a runaway notifier

If the issue notifier itself misbehaves (e.g. labels the wrong repo,
floods the inbox), the safe stop is to PR-revert the `File GitHub issue
on failure` step in `faa-ingest.yml`. Do **not** disable the whole
workflow — that silences the failure too.

---

## 3. Retry & dead-letter semantics (AC 5)

### 3.1 Where retries fire

`apps/faa-pipeline/src/lib/download.ts:downloadFaaSnapshot` wraps the FAA
ZIP fetch with bounded retry. Configured for **3 attempts total** with
exponential backoff (1s, 2s) between tries. Retries fire on:

- Network-level errors (ECONNRESET, ETIMEDOUT, AbortError, etc.).
- HTTP 408 (request timeout).
- HTTP 429 (rate-limited).
- HTTP 5xx (FAA server side).

Retries do **NOT** fire on:

- HTTP 4xx other than 408/429 (URL is wrong → operator-visible immediately).
- Malformed/corrupt ZIP errors (`extractFromZip` failures) — those are
  permanent for the snapshot and reattempting just burns minutes.

### 3.2 Dead-letter / "what happens on persistent failure"

The pipeline does not have a separate dead-letter queue today — it does
not need one. The FAA cron is daily and snapshots are immutable per date,
so the recovery model is:

1. `pipeline_runs` row goes to `status='failed'` with `error_message`.
2. The workflow step `File GitHub issue on failure` opens a GH Issue
   tagged `faa-ingest` and assigned to `@pbish007`.
3. Operator inspects, fixes the cause, re-dispatches the workflow.
   The ingest step is idempotent (`hasManifest` + R2 HEAD short-circuit
   in `r2` mode; lakeFS no-op-commit in `lakefs` mode).

If the FAA host is fully down at 02:00 UTC, we just re-dispatch when it
comes back. No data is lost: the next day's snapshot is a full
replacement of all 5 files, not an incremental delta.

### 3.3 Tests

`apps/faa-pipeline/tests/download.test.ts` covers the retry contract:
success-on-first, 503 → retry → success-on-3rd, network-throw → retry,
404 → no-retry, persistent-503 → give-up-after-3.

---

## 4. R2 access policy (AC 3)

### 4.1 Current state

The pipeline writes to the `faa-registry` R2 bucket via long-lived API
credentials stored in GitHub Actions secrets:

- `FAA_R2_ACCESS_KEY_ID`
- `FAA_R2_SECRET_ACCESS_KEY`

Scope: full read/write on the `faa-registry` bucket (configured during
PMB-114 R0).

### 4.2 What the AC asks for vs. what Cloudflare offers

The AC text reads: "R2 bucket access policy limits writes to GH Actions
OIDC role; no long-lived keys in secrets."

Cloudflare R2 **does not** natively federate with GitHub Actions OIDC
the way AWS S3 does (no `sts:AssumeRoleWithWebIdentity` equivalent on
the R2 / Cloudflare API). The closest free-tier-friendly substitutes are:

1. **Scoped R2 API token, single-bucket, write-only.** A new token minted
   in the Cloudflare dashboard against the `faa-registry` bucket alone,
   with `Object Read & Write` permission (no account-level access, no
   other bucket access). Rotation cadence: quarterly or on personnel
   change.
2. **Per-workflow short-lived presigned URL.** A CEO-held master credential
   mints a 1-hour presigned URL per run via a setup step. Not feasible
   today because the lakeFS upload path uses its own `lakectl` flow.
3. **Self-hosted STS broker.** Out of scope for the free tier.

### 4.3 Decision

Option 1 (scoped single-bucket token + rotation runbook) is the chosen
substitute. It is a strict improvement over the current account-scoped
token and matches the AC's intent (least-privilege, rotatable). The
actual swap requires CEO action to mint the new token in the Cloudflare
dashboard and replace `FAA_R2_*` GH secrets; tracked as a PMB-110
follow-up child issue.

### 4.4 Rotation procedure (when the new token lands)

1. CEO: mint a new R2 API token in Cloudflare dashboard:
   - **Permissions:** Object Read & Write.
   - **Scope:** Bucket → `faa-registry` only.
   - **TTL:** none (rotated manually).
2. CEO: copy the access key id + secret into GH Actions secrets:
   - `FAA_R2_ACCESS_KEY_ID` ← new key id.
   - `FAA_R2_SECRET_ACCESS_KEY` ← new secret.
3. CEO: re-dispatch `faa-ingest.yml` with `storage_mode=r2`,
   `with_transform=false` as a smoke (the raw stage only writes objects;
   doesn't touch Postgres). Confirm the workflow goes green and the run
   summary shows fresh ETags.
4. CEO: revoke the old token in the Cloudflare dashboard.

If step 3 fails: roll the secrets back to the old values immediately
(do not revoke until smoke is green).

---

## 5. Postgres role separation (AC 4)

### 5.1 The boundary

Migration `0034_faa_registry_roles.sql` (in this repo) creates two
roles in the FAA Supabase project:

- `faa_registry_pipeline_rw` — DML on every `faa_registry.*` table +
  USAGE on sequences. Used by the pipeline service account (today the
  GH-Actions-side `FAA_DATABASE_URL` connection).
- `faa_registry_runtime_ro` — SELECT-only on every `faa_registry.*`
  table. Used by the maintenance app's downstream FAA lookup path
  (not yet wired — the maintenance app does not read FAA data today;
  this role is staged ahead of that work).

Both roles are NOINHERIT NOLOGIN — actual login users are granted
membership and inherit privileges via `SET ROLE`/role membership. This
lets us rotate the login secret independent of ACL changes.

### 5.2 Future tables inherit grants

The migration installs `ALTER DEFAULT PRIVILEGES IN SCHEMA faa_registry`
for both roles. Any new table added to `faa_registry` by a future
migration (running as the schema owner) inherits the same grants
automatically. No per-migration grant boilerplate needed.

### 5.3 Apply procedure

Same as every FAA migration today — `workflow_dispatch` of
`.github/workflows/faa-db-migrate.yml` with input
`migration_file=0034_faa_registry_roles.sql`. The migration is
idempotent: re-runs on already-migrated DBs are no-ops.

### 5.4 Pipeline secret cutover (separate from the migration)

The migration **creates** the roles. Switching the GH Actions secret
`FAA_DATABASE_URL` from the current postgres-owner connection string
to a `faa_registry_pipeline_rw` membership is a separate, riskier swap
because today's connection string lives on the Supabase pooler. Staged
as a PMB-110 follow-up child issue.

---

## 6. Audit log (PM addendum, CTO refinement)

### 6.1 Table

Migration `0035_faa_registry_audit_log.sql` adds
`faa_registry.faa_registry_audit_log`:

```text
id                bigserial primary key
accessed_at       timestamptz (default now())
tenant_id         uuid
principal         text
request_id        text          ← CTO refinement (PMB-110 comment 0ee63128)
n_number          text
columns_returned  text[]
metadata          jsonb
```

The `request_id` column ties audit rows back to the originating HTTP
request — "show me every FAA lookup that the request which mutated
work-order Y performed" — and is cheap to add now, painful to backfill
once the table is live.

### 6.2 Retention

90 days, **discretionary**. Per CTO confirmation on PMB-110: no Part 91
recordkeeping floor applies to derived public-dataset access logs. We
can lower or raise this without touching a regulation.

### 6.3 Retention purge (cron — not yet wired)

```sql
DELETE FROM faa_registry.faa_registry_audit_log
WHERE accessed_at < now() - interval '90 days';
```

Run quarterly or on disk-pressure. Wire as a scheduled job when the
audit log starts receiving writes (today the maintenance-app side does
not read FAA data yet, so the table is empty).

### 6.4 Canada / GDPR caveat

When the next regime (Canada — seam K1/K2) ships, `principal` may
include PII (operator name / email). At that point this table falls
under GDPR/PIPEDA independent of FAA Part 91; SecurityEngineer (when
hired) should sign off on `principal` content + retention. Safer
default: store `tenant_id` + `user_id` (opaque), not raw identity strings.

---

## 7. Recovery playbook

### 7.1 "The cron failed last night"

1. Open the GH Issue auto-filed by the workflow. Click the run URL.
2. Identify the failing step from the Actions UI:
   - **download step:** transient FAA outage or schema change.
     Re-dispatch the workflow. If it fails again, check
     <https://registry.faa.gov> in a browser.
   - **lakeFS upload step:** check lakeFS deployment health
     <https://lakefs-faa.fly.dev> (PMB-139).
   - **transform / pg-load step:** check `faa_registry.snapshot_manifest`
     for partial state. Bronze and gold are idempotent; pg-load runs in
     a transaction so a failure leaves the prior snapshot intact.
3. Fix the cause (or note "transient FAA outage, retry tomorrow"),
   re-dispatch with `workflow_dispatch`, close the GH Issue once green.

### 7.2 "We need to roll back yesterday's snapshot"

The lakeFS branch flow tags every commit `ingest-YYYY-MM-DD`. Revert via:

```bash
lakectl revert lakefs://faa-registry/main <commit-id>
```

Tag for the bad snapshot is `ingest-<date>`; the previous-good tag is
the one before it in `lakectl log`.

For Postgres rollback: SCD-2 `aircraft_registry_history` carries the
prior `valid_to`-bounded rows, so re-running pg-load against the
previous gold snapshot reconciles `_current` automatically. Detailed
flow lives in the `transform/` package README.

### 7.3 "The pipeline_runs row is stuck in `running` for hours"

The workflow's `finishRun(failed)` only fires when the Node process
throws. A wedged GH Actions runner that aborts mid-step leaves
`pipeline_runs.status='running'` forever. Manual clean-up:

```sql
UPDATE faa_registry.pipeline_runs
SET status = 'failed',
    finished_at = now(),
    error_message = 'manually marked failed: stuck in running'
WHERE id = <id>;
```

Do **not** delete the row — it's the only forensic record of the run.

---

## 8. Open follow-ups

- R2 OIDC / scoped-token cutover (CEO action; PMB-110 follow-up).
- Pipeline `FAA_DATABASE_URL` cutover to `faa_registry_pipeline_rw`
  membership (CEO + DevOpsEngineer; PMB-110 follow-up).
- Synthetic-fail input on `faa-ingest.yml` for testable alert path.
- Audit-log purge cron (only needed when the maintenance app starts
  writing audit rows; not on critical path today).
- PagerDuty / Grafana upgrade triggered by multi-recipient on-call.
