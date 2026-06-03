#!/usr/bin/env bash
# Idempotent migration runner for the production Postgres (Neon).
#
# Reads the connection string from $DATABASE_URL_DIRECT — the direct (non-pooled)
# Neon endpoint, never the pooled URL. Pooled endpoints multiplex sessions and
# break DDL that needs a stable connection.
#
# Tracks applied filenames in a `schema_migrations(filename text primary key,
# applied_at timestamptz)` table. Re-runs are no-ops; safe to invoke on every
# deploy.
#
# Usage:
#   DATABASE_URL_DIRECT="postgres://...?sslmode=require" packages/db/scripts/migrate.sh
#
# Requires: psql >= 14. macOS: `brew install postgresql@17`.

set -euo pipefail

if [[ -z "${DATABASE_URL_DIRECT:-}" ]]; then
  echo "error: DATABASE_URL_DIRECT is not set." >&2
  echo "       Set it to the Neon direct (non-pooler) connection string with sslmode=require." >&2
  exit 64
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "error: psql not on PATH. Install with: brew install postgresql@17" >&2
  exit 65
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migrations_dir="$here/../migrations"

if [[ ! -d "$migrations_dir" ]]; then
  echo "error: migrations dir not found at $migrations_dir" >&2
  exit 66
fi

# Sanity-check: refuse to run against a URL that doesn't enforce TLS.
case "$DATABASE_URL_DIRECT" in
  *sslmode=require*|*sslmode=verify-ca*|*sslmode=verify-full*) ;;
  *)
    echo "error: DATABASE_URL_DIRECT must include sslmode=require (or stricter)." >&2
    echo "       Append '?sslmode=require' to the connection string." >&2
    exit 67
    ;;
esac

# Pass select migration-time configuration through to the psql session as
# Postgres custom GUCs so DO blocks inside migrations can read them via
# `current_setting(..., true)`. Add new entries here as additional bootstrap
# parameters appear — never inline secrets into the SQL files.
#
#   PLATFORM_ADMIN_BOOTSTRAP_EMAIL → app.platform_admin_bootstrap_email
#     Used by migration 0023 (PMB-116) to seed the first row of
#     `platform_admins` for the email's matching user. No-op when unset.
PGOPTIONS_PARTS=()
if [[ -n "${PLATFORM_ADMIN_BOOTSTRAP_EMAIL:-}" ]]; then
  PGOPTIONS_PARTS+=("-c app.platform_admin_bootstrap_email=$PLATFORM_ADMIN_BOOTSTRAP_EMAIL")
fi
if [[ ${#PGOPTIONS_PARTS[@]} -gt 0 ]]; then
  export PGOPTIONS="${PGOPTIONS_PARTS[*]}"
fi

PSQL=(psql --set ON_ERROR_STOP=1 --no-psqlrc --quiet "$DATABASE_URL_DIRECT")

# Create the tracking table once. Idempotent.
"${PSQL[@]}" <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

applied=0
skipped=0
for sql_file in "$migrations_dir"/*.sql; do
  [[ -e "$sql_file" ]] || continue
  filename="$(basename "$sql_file")"

  already="$("${PSQL[@]}" --tuples-only --no-align <<SQL
SELECT 1 FROM schema_migrations WHERE filename = '$filename';
SQL
)"

  if [[ "$already" == "1" ]]; then
    echo "  skip  $filename (already applied)"
    skipped=$((skipped + 1))
    continue
  fi

  echo "  apply $filename"
  # Single-transaction apply: -1 wraps the file in BEGIN/COMMIT so a failure
  # rolls the whole migration back. The follow-up INSERT records success.
  "${PSQL[@]}" -1 --file="$sql_file"
  "${PSQL[@]}" <<SQL
INSERT INTO schema_migrations (filename) VALUES ('$filename');
SQL
  applied=$((applied + 1))
done

echo
echo "done. applied=$applied skipped=$skipped"
