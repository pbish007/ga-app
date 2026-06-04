# lakeFS FAA — opensource deployment

Self-hosted opensource lakeFS that fronts the Cloudflare R2 bucket `faa-registry`.
Provisioned per [PMB-139](../../) (DevOps).

## Layout

- `Dockerfile` — pins the `treeverse/lakefs` image version.
- `fly.toml` — Fly.io app config (`lakefs-faa`, `iad`, shared-cpu-1x @ 256 MB, 3 GB volume mounted at `/data`, always-on).
- `../../.github/workflows/lakefs-faa-deploy.yml` — CI workflow that creates the app + volume on first run, sets all `LAKEFS_*` Fly secrets from GH secrets, and deploys the image.

## First-run runbook

1. **Provision Fly.io account** — sign in at https://fly.io with `pbish007@gmail.com`. Add a payment method (~$2.40/mo expected).
2. **Create a deploy token**: `fly tokens create deploy --expiry 8760h --name "lakefs-faa-deploy"`. Add it as the `FLY_API_TOKEN` GitHub secret.
3. **Provision an R2 token** scoped to bucket `faa-registry` (Cloudflare dashboard → R2 → Manage API Tokens → "Object Read & Write" on `faa-registry`). Add the access key + secret as `LAKEFS_R2_ACCESS_KEY_ID` and `LAKEFS_R2_SECRET_ACCESS_KEY` GitHub secrets.
4. **Set `LAKEFS_DATABASE_URL`** — Supabase session-mode pooler URL on the FAA project (ref `idjhuqubjgjloywsfgtu`), no `search_path`, port 5432:
   ```
   postgresql://postgres.idjhuqubjgjloywsfgtu:<password>@aws-1-us-east-1.pooler.supabase.com:5432/postgres
   ```
5. **Generate `LAKEFS_AUTH_ENCRYPT_SECRET_KEY`**: `openssl rand -hex 32`. Add as GH secret.
6. **Apply migration `0026_lakefs_metadata_schema.sql`** via the existing `faa-db-migrate.yml` workflow.
7. **Dispatch `lakeFS FAA — deploy`** with `ensure_app=true` for the first run.
8. **Bootstrap admin user** — once deploy is green, hit `https://lakefs-faa.fly.dev/setup_lakefs` once (or `flyctl ssh console --app lakefs-faa -C "lakefs setup --user-name <admin>"`). Capture the initial access key + secret. Treat as a one-time bootstrap — rotate before sharing.
9. **Create lakeFS repo `faa-registry`** with storage namespace `s3://faa-registry/` and default branch `main` via the UI or:
   ```
   lakectl repo create lakefs://faa-registry s3://faa-registry/ --default-branch main
   ```
10. **Smoke test**:
    ```
    echo "smoke $(date -u +%FT%TZ)" > smoke.txt
    lakectl fs upload lakefs://faa-registry/main/smoke.txt -s smoke.txt
    lakectl commit lakefs://faa-registry/main -m "smoke: initial upload"
    lakectl branch create lakefs://faa-registry/smoke -s lakefs://faa-registry/main
    lakectl fs rm lakefs://faa-registry/smoke/smoke.txt
    lakectl commit lakefs://faa-registry/smoke -m "smoke: delete on branch"
    lakectl merge lakefs://faa-registry/smoke lakefs://faa-registry/main
    lakectl log lakefs://faa-registry/main
    ```
11. **Add backend CI secrets**: `LAKEFS_ENDPOINT=https://lakefs-faa.fly.dev`, `LAKEFS_ACCESS_KEY_ID=<post-rotation key>`, `LAKEFS_SECRET_ACCESS_KEY=<post-rotation secret>`. The follow-up BackendEngineer issue will switch `.github/workflows/faa-ingest.yml` to write through lakeFS.

## Rotation / teardown

- **Rotate R2**: revoke + recreate the token in Cloudflare, update `LAKEFS_R2_*` GH secrets, re-dispatch `lakefs-faa-deploy`.
- **Rotate Postgres**: `alter user postgres password '…';` on Supabase, update `LAKEFS_DATABASE_URL` GH secret, re-dispatch.
- **Rotate lakeFS access key**: in the lakeFS UI, create a new key, update `LAKEFS_ACCESS_KEY_ID` / `LAKEFS_SECRET_ACCESS_KEY` GH secrets, delete the old key.
- **Tear down**: `flyctl apps destroy lakefs-faa --yes` + `drop schema lakefs cascade;` on Supabase. R2 bucket is untouched. Direct-to-R2 ingest paths are unaffected throughout.
