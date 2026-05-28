# Database migrations runbook

> **Audience:** any future operator (engineer, on-call, or the CEO) coming to this cold.
> **Scope:** GA App production Postgres, hosted on Neon (`ga-app-prod`).
> **Owner of last resort:** CTO.

This runbook is the **intended** canonical way schema changes reach production.
It is the PMB-62 deliverable that replaces two stop-gaps used during the MVP
front-door push:

- pasting a Neon key into an issue comment to run `migrate.sh` from a dev box, and
- runtime admin DDL endpoints (`POST /api/admin/run-migrations`, since removed;
  `POST /api/admin/bootstrap-demo`, still live — retirement tracked in PMB-62).

> **Current status (2026-05-28):** the GitHub Actions path in §2 is wired but
> **not yet operational** — its `DATABASE_URL_DIRECT` secret is unset (see §3).
> Until that secret is set, migrations `0001`–`0016` were applied to prod via
> the temporary PMB-64 runtime endpoint. Setting the secret is what turns §2
> into the real path.

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

## 4. Demo data (re)seeding

Schema migrations never seed data. The board-acceptance demo org ("Blue Sky
Aviation (Demo)", PMB-60) is seeded separately by the idempotent library
`apps/web/lib/demo-seed.ts` (`bootstrapAndSeed`). It deletes and recreates only
the demo org/users, so its blast radius is the demo org alone.

Re-seed via the **DB seed demo (production)** workflow (manual dispatch,
requires typing the confirmation input). It runs the same library against
`DATABASE_URL_DIRECT` — so, like §2, it only works once that secret is set.
Until then, the live `bootstrap-demo` endpoint is the working reseed path. This
is a developer/demo convenience, not a production data path — production tenants
create their own data through the app.

## 5. History / current state (PMB-62)

- Migration `0016_grant_tenant_app_membership.sql` (the tenant_app role grants)
  was applied **and** recorded in `schema_migrations` on prod via the temporary
  `POST /api/admin/run-migrations` endpoint in PMB-64 (that endpoint has since
  been removed). It was **not** applied via the GitHub Actions workflow, which
  is still waiting on its secret (§3). Its grant scope was security-reviewed —
  see the PMB-62 `security-review` document.
- `POST /api/admin/bootstrap-demo` + `ADMIN_BOOTSTRAP_TOKEN` are **still live**.
  Retirement is tracked in PMB-62, gated on the PMB-60 demo sign-off (the demo
  still reseeds through this endpoint) plus the SecurityEngineer review.
  `ADMIN_BOOTSTRAP_TOKEN` was rotated during PMB-64; remove it from Vercel when
  the endpoint is retired.

Related: `docs/runbooks/postgres-restore.md`.
