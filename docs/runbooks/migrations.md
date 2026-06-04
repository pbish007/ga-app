# Database migrations runbook

> **Audience:** any future operator (engineer, on-call, or the CEO) coming to this cold.
> **Scope:** GA App production Postgres, hosted on Neon (`ga-app-prod`).
> **Owner of last resort:** CTO.

This runbook is the **intended** canonical way schema changes reach production.
It is the PMB-62 deliverable that replaces two stop-gaps used during the MVP
front-door push:

- pasting a Neon key into an issue comment to run `migrate.sh` from a dev box, and
- runtime admin DDL endpoints (`POST /api/admin/run-migrations` and the
  one-shot demo-bootstrap admin endpoint, both retired — the latter in
  PMB-62 after PMB-60 demo sign-off; the standing replacement is the admin
  tenant API described in §4).

> **Current status (2026-06-03):** the GitHub Actions path in §2 is the live
> canonical path — the `DATABASE_URL_DIRECT` GH Actions secret is set. Use it
> for any new migration. (Historical: migrations `0001`–`0016` were applied to
> prod via the temporary PMB-64 runtime endpoint before the secret existed;
> later migrations from `0017` onward run through §2.)

---

## 1. How migrations work

- SQL files live in `packages/db/migrations/NNNN_name.sql`, applied in
  filename order.
- `packages/db/scripts/migrate.sh` applies every file not yet recorded in the
  `schema_migrations(filename, applied_at)` table, each inside a single
  transaction, then records the filename. **Re-runs are no-ops** — running it
  with nothing new pending is safe.
- The script connects via `$DATABASE_URL_DIRECT` — the Neon **direct
  (non-pooled)** endpoint, with `sslmode=require`. The pooled endpoint
  multiplexes sessions and breaks DDL that needs a stable connection.

Write migrations to be idempotent where practical (e.g. `CREATE TABLE IF NOT
EXISTS`, `GRANT` — which is a no-op when already held). Migration 0016 is
grant-only and fully idempotent.

## 2. Applying migrations to production (the canonical path)

Migrations run from **GitHub Actions**, not a dev box. The production
connection string is held only as the repo secret `DATABASE_URL_DIRECT`
(Settings → Secrets and variables → Actions). It is never pulled to disk and
never pasted into a comment.

1. Merge the migration to `main`.
2. Trigger the **DB migrate (production)** workflow:
   ```
   gh workflow run "DB migrate (production)"
   ```
   (or the Actions tab → *DB migrate (production)* → *Run workflow*).
3. Watch the run; confirm the `apply`/`skip` summary lists your migration as
   `apply`.

### Verifying what is recorded

```
gh workflow run "DB migrate (production)"   # re-run is a no-op; tail the log
```

The tail prints `done. applied=<n> skipped=<m>`. To inspect the ledger
directly, run against the direct endpoint:

```sql
SELECT filename, applied_at FROM schema_migrations ORDER BY filename;
```

## 3. Setting / rotating the secret

`DATABASE_URL_DIRECT` is the Neon **direct** connection string with
`?sslmode=require`. It is a standing credential (contains the role password),
so it belongs in GitHub Actions secrets — masked, write-only, never echoed.

- Set / rotate it from the Neon console (project `ga-app-prod`,
  `royal-darkness-36853636`) → Connection details → **Direct connection**, then
  `gh secret set DATABASE_URL_DIRECT` (or the Actions UI).
- Rotate by resetting the role password in Neon and updating both this secret
  and the Vercel `DATABASE_URL_DIRECT` runtime var.

> **Do not paste this value into an issue comment.** A standing DB credential
> can't be cleanly revoked the way a short-lived Neon API key can.

## 4. Demo data (re)seeding (V1: admin API)

Schema migrations never seed data. The board-acceptance demo content
("Blue Sky Aviation (Demo)", PMB-60) is seeded per-tenant by the idempotent
library `apps/web/lib/demo-seed.ts` (`seedDemoContent`), driven by the
admin API:

1. Create the demo tenant (org + primary admin user) via
   `POST /api/admin/tenants` — primary admins use the admin UI at
   `/admin/tenants/new`.
2. (Re)seed the canonical demo aircraft + subscriptions + open squawk +
   draft maintenance entry into that tenant via
   `POST /api/admin/tenants/:id/reseed-demo` — exposed in the admin UI as
   the **Reseed demo content** button on `/admin/tenants/:id`. The button
   is gated client-side to tenants whose org name matches `DEMO_ORG_NAME`
   ("Blue Sky Aviation (Demo)") or ends in `(Demo)`.

Both routes require a `requirePlatformAdmin` session. Re-running the
reseed deletes the tenant's aircraft (cascading to subscriptions, flight
time, squawks, maintenance entries) and re-inserts the canonical demo
shape — blast radius is the single tenant, not the whole database. This
is a developer/demo convenience; production tenants create their own
data through the normal app surfaces.

The pre-V1 path — the `DB seed demo (production)` GH workflow + the
one-shot `bootstrap-demo` admin endpoint — is retired (PMB-120, PMB-62).

## 5. Runtime env wiring — `DATABASE_URL` parity across Preview + Production (PMB-131)

The runtime web app authenticates as the non-bypass-RLS `tenant_runtime`
role provisioned by migration `0018`. Its password is set out-of-band on
the Neon side (see migration `0018` header). Vercel's `DATABASE_URL` env
var holds that connection string and is marked **sensitive** — meaning
once set, the value is never readable back through `vercel env pull` or
the dashboard. That property is what makes Preview vs Production drift
hard to detect after the fact.

### The rule

**`DATABASE_URL` in the Preview environment scope MUST hold the same
value as the Production environment scope.** Preview deploys today
share the production Neon endpoint (project `royal-darkness-36853636`,
branch `production`). This is the explicit decision recorded in
PMB-131:

- **Decision:** share the production Neon endpoint — Preview = Prod.
- **Why:** simplest, zero new infra. No second seed pipeline. Auth /
  RLS / RBAC paths exercised on preview are the same code paths
  running in production, so a preview verification is meaningful.
- **Mitigation for cross-tenant blast radius:** preview deploys are
  protection-gated behind the Vercel automation-bypass token, so only
  CI/QA-authorized callers can hit them. Smoke flows create
  throwaway tenants prefixed `smoke:` / `pmb129-cleanup-*` that are
  reaped on a documented cadence. Destructive endpoints remain auth-
  gated by `requirePlatformAdmin`; no preview-vs-prod fork is
  required in code.

### Symptom of breakage

If Preview `DATABASE_URL` drifts (wrong password, stale Neon branch
URL, missing entirely), the symptom is `POST /api/auth/login` →
HTTP 500 with the Postgres SQLSTATE 28P01 error
`password authentication failed for user 'tenant_runtime'` in the
Vercel function log. **Every** preview deploy will fail this way
until the env var is repaired and a fresh deploy is triggered.

### Setting / rotating Preview `DATABASE_URL`

Because the var is sensitive, the only operators who can hand it to
Vercel are the ones holding the standing tenant_runtime password
(today: CEO, via the original PMB-74 rollout). Two paths:

**Path A — Vercel dashboard (recommended; zero downtime):**

1. Go to Vercel → project `ga-app` → Settings → Environment
   Variables → **Production** scope.
2. Open the existing `DATABASE_URL` row. The sensitive value is
   masked but the holder of the original credential can re-paste it.
3. Switch the scope filter to **Preview**, remove the existing
   `DATABASE_URL` entry, then add a new one with the same value as
   Production, scope = **all Preview branches**, type = **sensitive**.
4. Trigger a fresh preview deploy (push to a feature branch, or
   `vercel --target=preview` from `apps/web`).
5. Verify with §5.2 below.

**Path B — CLI (same prereq: holder has the value to hand):**

```bash
cd apps/web
# Remove the drifted Preview value (idempotent; ignore "not found")
vercel env rm DATABASE_URL preview --yes
# Paste the production value when prompted; mark sensitive
vercel env add DATABASE_URL preview --sensitive
# (paste value, then Enter)
```

A new preview deploy must be triggered after the env var change —
Vercel does not retroactively rebuild existing previews.

> **Do not rotate the tenant_runtime password just to "fix" Preview.**
> Rotating means a brief window where production auth fails until
> both env vars are updated and both targets redeployed. Path A above
> takes Production through zero risk.

### 5.1 Smoke verification

Once the Preview env is repaired and a new preview deploy is Ready,
run the existing fresh-tenant smoke against the preview URL:

```bash
gh workflow run "Fresh-tenant smoke (PMB-121)" \
  --field base_url=https://<preview-url>
```

A passing run proves `POST /api/auth/login` returned 200 for the QA
platform admin (`SMOKE_PLATFORM_ADMIN_EMAIL`) — that is exactly the
PMB-131 acceptance criterion.

If you only need the login probe (no tenant mutation), an inline
curl is sufficient:

```bash
curl -i -X POST https://<preview-url>/api/auth/login \
  -H "Content-Type: application/json" \
  -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" \
  -d '{"email":"qa-smoke-admin@gaapp.io","password":"…"}'
```

Expected: `HTTP/2 200` with a `Set-Cookie: ga_session=…` header.
Anything 500 with body `{"error":"server_error"}` means the env var
is still drifted; check the Vercel function log for SQLSTATE 28P01.

### 5.2 Future deploy-chain changes — keep this from regressing

Any future change that touches Vercel env vars or rotates the
tenant_runtime password MUST update **both** Production and Preview
scopes in the same heartbeat, and MUST run §5.1 against a fresh
preview deploy before closing. The asymmetry of "sensitive vars can't
be read back" means there is no automated drift detector — discipline
is the only mitigation.

## 6. History / current state (PMB-62)

- Migration `0016_grant_tenant_app_membership.sql` (the tenant_app role grants)
  was applied **and** recorded in `schema_migrations` on prod via the temporary
  `POST /api/admin/run-migrations` endpoint in PMB-64 (that endpoint has since
  been removed). It was **not** applied via the GitHub Actions workflow, which
  is still waiting on its secret (§3). Its grant scope was security-reviewed —
  see the PMB-62 `security-review` document.
- `POST /api/admin/bootstrap-demo` + `ADMIN_BOOTSTRAP_TOKEN` are **retired**
  (PMB-62, after PMB-60 demo sign-off and the SecurityEngineer review on
  PMB-73). Route deleted; Vercel env var removed.
- The `DB seed demo (production)` GH workflow + the
  `apps/web/scripts/seed-demo.mjs` runner that backed it are **retired**
  (PMB-120, V1 managed onboarding). Replacement: the admin
  `POST /api/admin/tenants/:id/reseed-demo` route (§4).

Related: `docs/runbooks/postgres-restore.md`.
