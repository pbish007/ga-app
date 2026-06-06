# GA Applications — Production Architecture

*Snapshot as of 2026-06-06. Source of truth for the architecture slide attached to [PMB-181](/PMB/issues/PMB-181). Update this doc when a new component goes live; don't draw aspirational state here.*

The company runs two product lines from a single monorepo (`pbish007/ga-app`):

- **GA App / Aircraft Maintenance Platform** — the customer-facing SaaS.
- **FAA Registry** — an integration-first data plane that feeds the maintenance app (and, eventually, standalone surfaces).

The two product lines share one source of truth (GitHub), one CI substrate (GitHub Actions), and one human/agent loop (Paperclip + Anthropic). They deliberately do **not** share a database: tenant data lives on Neon, FAA data lives on Supabase. That separation is the security and blast-radius story.

## Diagram

```mermaid
flowchart TB
  classDef user fill:#fef3c7,stroke:#a16207,color:#111
  classDef vercel fill:#e0e7ff,stroke:#4338ca,color:#111
  classDef db fill:#dcfce7,stroke:#15803d,color:#111
  classDef storage fill:#fce7f3,stroke:#be185d,color:#111
  classDef ci fill:#f3f4f6,stroke:#374151,color:#111
  classDef agent fill:#fee2e2,stroke:#b91c1c,color:#111
  classDef ext fill:#fff7ed,stroke:#c2410c,color:#111

  User["End users<br/>operators · mechanics · pilots<br/>(browser)"]:::user

  subgraph GAAPP["GA App / Aircraft Maintenance Platform"]
    direction TB
    Web["Vercel · Next.js 15 (App Router)<br/>ga-app-taupe.vercel.app<br/>Hobby tier · daily cron 09:00 UTC<br/>→ /api/cron/notifications"]:::vercel
    Neon[("Neon Postgres 17<br/>project: ga-app-prod<br/>region: aws-us-east-2<br/>Free tier · RTO 34 s")]:::db
    Web -- "DATABASE_URL<br/>tenant_runtime role · FORCE RLS" --> Neon
    Web -- "DATABASE_URL_DIRECT<br/>migrations + admin only" --> Neon
  end

  subgraph FAA["FAA Registry"]
    direction TB
    FAAPipeline["apps/faa-pipeline<br/>(daily 02:00 UTC ingest)"]:::ci
    LakeFS["lakeFS OSS on Fly.io<br/>lakefs-faa.fly.dev<br/>~$2.40/mo · single 256 MB VM"]:::storage
    R2[("Cloudflare R2<br/>bucket: faa-registry<br/>raw zips + parsed parquet")]:::storage
    Supa[("Supabase Postgres<br/>project: idjhuqubjgjloywsfgtu<br/>region: us-east-1 · Free tier<br/>schemas: faa_registry · lakefs")]:::db
    FAAPipeline -- "lakectl commit + tag<br/>per ingest" --> LakeFS
    LakeFS -- "S3 blockstore" --> R2
    LakeFS -- "metadata (Postgres)" --> Supa
    FAAPipeline -- "COPY parsed rows<br/>FAA_DATABASE_URL (txn pooler)" --> Supa
  end

  subgraph CI["GitHub Actions · pbish007/ga-app"]
    direction TB
    GHA_GA["GA App workflows<br/>ci · deploy-prod · smoke<br/>db-migrate · db-backup-verify<br/>db-seed-qa-admin"]:::ci
    GHA_FAA["FAA workflows<br/>faa-ingest · faa-db-migrate<br/>faa-db-verify · lakefs-faa-deploy"]:::ci
  end

  Agents["Paperclip agents<br/>CEO · CTO · BE · FE · DevOps<br/>UX · QA · Security · PM<br/>(Anthropic Claude)"]:::agent

  GitHub["GitHub repo<br/>pbish007/ga-app (main)"]:::ext

  User == "HTTPS" ==> Web
  Agents -- "git push · gh workflow run" --> GitHub
  GitHub -- "push to main" --> GHA_GA
  GitHub -- "workflow_dispatch / cron" --> GHA_FAA
  GHA_GA -- "vercel deploy --prod<br/>(source upload, server build)" --> Web
  GHA_GA -- "packages/db migrate.sh<br/>(DATABASE_URL_DIRECT)" --> Neon
  GHA_GA -- "smoke (qa-smoke-admin)" --> Web
  GHA_FAA -- "ingest dispatch / cron" --> FAAPipeline
  GHA_FAA -- "flyctl deploy" --> LakeFS
  GHA_FAA -- "psql migrate" --> Supa

  Web -. "planned (PMB-109)<br/>N-Number autofill" .-> Supa
```

## GA App / Aircraft Maintenance Platform

Live at <https://ga-app-taupe.vercel.app>. Next.js 15 App Router under `apps/web`, deployed to Vercel Hobby. State lives in Neon Postgres (`ga-app-prod`, `aws-us-east-2`, Postgres 17). Tenant isolation is enforced by Postgres RLS (FORCE on every tenant table) with a dedicated `tenant_runtime` login role; migrations and admin endpoints run under `DATABASE_URL_DIRECT` (`authenticator` for migrations, `neondb_owner` for runtime privileges). Authentication, the demo org, and the smoke harness (`qa-smoke-admin@gaapp.io`) are all live. The Hobby tier limits us to a single daily cron — `/api/cron/notifications` at 09:00 UTC — which is enough for current MVP scope.

## FAA Registry

An integration-first back-end (no standalone UI yet). `apps/faa-pipeline` runs as a nightly GitHub Actions job (`faa-ingest`, 02:00 UTC). Each ingest writes raw FAA zips and parsed parquet to Cloudflare R2 bucket `faa-registry`, versions the write through **lakeFS OSS** (`lakefs-faa.fly.dev` on Fly.io, single 256 MB VM, ~$2.40/mo — the first paid line item on the FAA stack), and `COPY`s parsed rows into a separate Supabase project (`idjhuqubjgjloywsfgtu`, `us-east-1`) under the `faa_registry` schema. lakeFS's metadata lives on the same Supabase under the `lakefs` schema, so there is exactly one Postgres host for the FAA data plane. The maintenance app does not read from FAA yet — N-Number autofill (PMB-109) is the planned first integration.

## Cross-cutting plumbing

GitHub (`pbish007/ga-app`, `main`) is the source of truth. All deploys and DB migrations route through GitHub Actions — there is no manual `vercel`-from-laptop or `psql`-against-prod path in steady state. Two product-specific workflow families share the same runner pool. Secrets sit in two locations: Vercel project env for runtime (`DATABASE_URL`, `DATABASE_URL_DIRECT` — both `type: sensitive`, write-only), and GitHub Actions repo secrets for CI (`DATABASE_URL_DIRECT`, `FAA_DATABASE_URL`, `FAA_R2_*`, `LAKEFS_*`, `FLY_API_TOKEN`). Code review, design, ops, and execution are driven by the Paperclip agent team (CEO, CTO, BackendEngineer, FrontEndEngineer, DevOpsEngineer, UXDesigner, QA, SecurityEngineer, ProductManager) running Claude via the Paperclip control plane.

## Monthly budget envelope ($100 cap, set on PMB-149)

| Component | Tier / cost |
| --- | --- |
| Vercel (Hobby) | $0 |
| Neon Postgres (Free) | $0 |
| Supabase Postgres (Free) | $0 |
| Cloudflare R2 (Free tier) | $0 (storage well under 10 GB cap) |
| GitHub Actions (Free tier) | $0 (well under 2000 min/mo) |
| Fly.io — `lakefs-faa` | ~$2.40/mo |
| **Paid infra subtotal** | **~$2.40/mo** |
| Anthropic agent inference | variable — dominant line item |

Headroom under the $100 cap is overwhelmingly absorbed by Anthropic agent inference; the deployed infrastructure barely moves the needle. Upgrades that would change this picture: Neon Launch ($19/mo) when PITR > 7 days is needed; Vercel Pro ($20/mo) when we need hourly crons or higher build minutes; Supabase Pro ($25/mo) when the 15-client session-pool cap starts to bite the lakeFS metadata path.

## Notable cross-references

- Deploy chain history and CI gotchas: [project_deploy_chain_auth_blocker](#) (memory).
- Front door / demo org: [project_front_door_demo](#) (memory).
- FAA Registry scope and decomposition: [project_faa_registry](#) (memory), [PMB-99](/PMB/issues/PMB-99).
- Neon RTO drill and DB role topology: `docs/runbooks/postgres-restore.md`, [reference_neon_production](#) (memory).
- lakeFS constraints and runbook: `infra/lakefs-faa/README.md`, [reference_lakefs_faa_deployment](#) (memory).
