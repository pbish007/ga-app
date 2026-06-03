# GA App

General Aviation tooling — founding monorepo.

This is the working scaffold from **PMB-4**. Stack decisions live in **PMB-3 → `stack`** ADR.

## Repo shape

```
.
├── apps/
│   └── web/              # Next.js 15 app (App Router, React 19, TS strict)
├── packages/             # shared packages (db, calc, ui, config) — added per stack ADR as we need them
├── .github/workflows/    # CI on push (lint, typecheck, test, build)
├── package.json          # pnpm workspace root
└── pnpm-workspace.yaml
```

Routes today:
- `/` — landing
- `/health` — liveness probe, returns `{ status: "ok", service, commit, timestamp }`

## Dev loop

Requires **Node 20+** and **pnpm 9**.

```bash
# install
pnpm install

# run the web app at http://localhost:3000
pnpm dev

# in another shell, probe the health route
curl -s http://localhost:3000/health
```

## Test loop

```bash
pnpm lint        # next lint
pnpm typecheck   # tsc --noEmit, strict
pnpm test        # vitest run
pnpm build       # next build (production output)
```

These four commands also run in CI on every push and PR (`.github/workflows/ci.yml`).

## Deploy loop

Production hosting: **Vercel** (per stack ADR).

This repo is linked to **exactly one** Vercel project: `ga-app` (`prj_Z8UAfPx4m73Kt1xp2SL9sLZW7OUc`, rootDirectory `apps/web`, framework `nextjs`). Do not let Vercel auto-create a sibling project — a duplicate without a rootDirectory will fail every preview build and train the team to ignore red checks. See PMB-93 for the retirement of the stray `_default` project.

1. Create a Vercel project pointed at this repo. Root directory: `apps/web`. Build & install commands auto-detected (Next.js + pnpm).
2. Connect the GitHub repo. Vercel will deploy `main` to production and every PR to a preview URL on push.
3. After the first deploy, point the production URL to a custom domain when ready.

There is no separate deploy step — **a push to `main` deploys.** That is the deliverable shape from PMB-4.

### Environment

Local: copy `.env.example` to `apps/web/.env.local` and fill in the values. The file is gitignored by default — never commit a real connection string.

Production: every variable in `.env.example` MUST be set in the Vercel project's environment (Production scope). Vercel injects them at build and runtime. No secrets live in the repo.

Today's vars:

| Var | Required | Set by | Read by |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes (once Neon is provisioned) | Vercel env + `.env.local` | `packages/db/src/env.ts` |
| `DATABASE_URL_DIRECT` | yes for migrations / restore work | same | ops scripts only |

See `docs/runbooks/postgres-restore.md` for the full provisioning + restore playbook.

## Conventions

- TypeScript everywhere, `strict: true`. No silent fallbacks on safety-sensitive aviation math (deferred until `packages/calc` lands).
- Conventional Commits.
- Pre-commit hooks (husky + lint-staged) wired up as the codebase grows; not required for the scaffold heartbeat.
- All user-facing surfaces that show pilot-actionable numbers must carry the **"Not for navigational use"** banner.
