# Observability runbook

> **Audience:** any future operator coming to this cold — engineer, on-call, or the CEO.
> **Scope:** how production failures become human-visible signals today.
> **Owner of last resort:** CTO.

This runbook is the PMB-86 deliverable. It lists every failure signal we
currently emit, what fires it, and where it lands. If you add a new production
surface, add it here.

We do not yet have Slack, PagerDuty, or a metrics stack. The signals below are
deliberately low-tech (GitHub Issues + Vercel email) and are sized for the
current MVP. They should be replaced with structured alerts before the user
base grows.

---

## 1. GitHub Actions workflow failures (ops workflows)

**Workflows covered**

- `.github/workflows/db-migrate.yml` — production DB migrations.
- `.github/workflows/deploy-prod.yml` — manual prod deploy fallback (the native
  Vercel→GitHub integration in PMB-57 is the primary path).
- `.github/workflows/db-seed-demo.yml` — guarded reseed of the demo org.

**What fires it**

A final step in each workflow:

```yaml
- name: File GitHub issue on failure
  if: failure()
  uses: actions/github-script@v7
```

Any failed step in the job triggers the notifier. It uses the built-in
`GITHUB_TOKEN` (no rotatable secret), so the only permission required is
`issues: write` granted at the workflow level.

**Where it lands**

- A new GitHub Issue is filed in `pbish007/ga-app` titled
  `Workflow failed: <workflow> @ <short-sha>`, labelled `ops` +
  `workflow-failure`, and assigned to `@pbish007`.
- The issue body links back to the failed run (`Actions > Run #...`).
- GitHub emails issue assignees by default, so the CEO inbox gets a
  `[pbish007/ga-app] Workflow failed: ...` message within seconds of the
  failure. (User-level setting: <https://github.com/settings/notifications> →
  *Email* → *Participating, @mentions, and custom*.)

**How to test the alert path (without breaking prod)**

`db-migrate.yml` accepts a `synthetic_fail` boolean input. Dispatch with
`synthetic_fail=true` and the job fails before touching the database:

```bash
gh workflow run "DB migrate (production)" -f synthetic_fail=true
```

Expected outcome: a new issue is filed within ~30s, the CEO inbox receives the
notification email, and no database writes occurred. Close the issue once
verified.

For the other two workflows there is no synthetic mode (they are short enough
that a real run is the test); broken-image-build verification is left to the
Vercel signal in §2.

**How to silence (if the notifier itself is misbehaving)**

Temporarily remove the `File GitHub issue on failure` step from the offending
workflow file and re-deploy via PR. Do not disable the whole workflow.

---

## 2. Vercel build / deploy failures (native integration)

**What fires it**

Vercel's native GitHub integration (PMB-57) builds every push:

- Pushes to `main` → production build.
- PR branches → preview build.

If the build, install, or function bundle step fails, Vercel marks the
deployment as `ERROR` and (a) sets the GitHub commit status to failed and (b)
emails project owners on the team, subject to each owner's personal
notification preferences.

**Where it lands**

- GitHub commit status / PR check goes red — visible in any PR or commit view.
- Vercel emails `pbish007@gmail.com` (project owner). The email subject is
  `[ga-app] Deployment failed for <branch>`.
- The notification setting is **user-level**, not project-level: each Vercel
  user toggles failure emails at <https://vercel.com/account/notifications>
  under *Project Deployments → Failed*.

**Verifying the email path**

Vercel email preferences are per-user, so verification requires the recipient
to confirm. The board verification flow is:

1. Push a branch with an intentional build break (e.g. a TypeScript syntax
   error in `apps/web/app/`) to a PR. Do **not** merge to `main`.
2. Confirm the Vercel preview deployment for that commit appears as `ERROR`
   in the PR check.
3. The board confirms whether `pbish007@gmail.com` received the failure email.
4. If not, the CEO flips *Project Deployments → Failed* at
   <https://vercel.com/account/notifications>, and step 1–3 are repeated.

PMB-86 carries the initial verification. Future verification only needs to
happen when notification preferences or project ownership change.

**How to silence (if a noisy preview build is filling the inbox)**

Mute that single preview deployment from the Vercel dashboard, or revert /
close the PR so no new builds run. Do not turn the project-level email off.

---

## 3. CI failures (`.github/workflows/ci.yml`)

CI runs on every PR and push to `main` (lint, typecheck, test, TLS gate,
build). Failures show as a red check on the PR and block merge via the
`required status checks` setting on `main` (managed in GitHub branch
protection — not in this repo).

We do **not** file a GitHub Issue on CI failure: the red check on an active PR
is already loud enough, and CI failures on `main` should not happen (they would
mean an unprotected merge). If that assumption stops holding, add a notifier
step to `ci.yml` mirroring §1.

---

## 4. Runtime / application errors

Application-level error reporting (5xx, unhandled exceptions, slow queries) is
**not yet wired**. The current surfaces are:

- Vercel function logs (`vercel logs <deployment-url>` or the dashboard).
- Neon query logs (Neon console → `ga-app-prod` → Monitoring).

Wiring a structured error sink (Sentry, Vercel Observability, etc.) is tracked
separately under the PMB-83 onboarding batch; until then this is a documented
gap, not a closed loop.

---

## 5. Adding a new signal

When you add a new production surface (job, cron, webhook), you owe this
runbook a new section before merging. The minimum is:

- **What fires it** — code path or trigger.
- **Where it lands** — exact recipient (email, channel, dashboard URL).
- **How to test** — a non-destructive way to fire the alert.
- **How to silence** — for the case where the notifier is the problem.

If you cannot answer all four, the surface is not production-ready.
