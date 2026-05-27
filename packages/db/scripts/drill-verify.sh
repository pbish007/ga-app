#!/usr/bin/env bash
# Restore-drill verifier: prints a deterministic row-count snapshot of the
# regime spine + every table the migrations create, as a single JSON object.
#
# Used by `drill-compare.sh` (which runs this against a source URL and a
# restored URL and diffs the two), and standalone by the J1.2 runbook
# section 3.7 when an operator wants to spot-check a Neon branch.
#
# Usage:
#   DATABASE_URL_DIRECT="postgres://...?sslmode=require" packages/db/scripts/drill-verify.sh
#
# Exit codes: 0 ok, 64 missing URL, 65 missing psql, 67 missing sslmode.

set -euo pipefail

if [[ -z "${DATABASE_URL_DIRECT:-}" ]]; then
  echo "error: DATABASE_URL_DIRECT is not set." >&2
  exit 64
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "error: psql not on PATH. Install with: brew install postgresql@17" >&2
  exit 65
fi

case "$DATABASE_URL_DIRECT" in
  *sslmode=require*|*sslmode=verify-ca*|*sslmode=verify-full*) ;;
  *)
    echo "error: DATABASE_URL_DIRECT must include sslmode=require (or stricter)." >&2
    exit 67
    ;;
esac

# Sample tables = regime spine + every domain table the migrations create.
# Verified against `pg_tables WHERE schemaname='public'` after migrations
# 0001..0014 were applied on 2026-05-27 (J1.2 drill). Listed explicitly so a
# renamed or dropped table in a future migration breaks the drill loudly
# instead of being silently skipped.
SAMPLE_TABLES=(
  schema_migrations
  regimes
  regime_inspection_program_templates
  regime_directive_sources
  regime_credential_types
  regime_rts_templates
  regime_retention_rules
  regime_inspection_program_intervals
  organizations
  organization_memberships
  users
  invitations
  documents
  app_roles
  app_permissions
  app_role_permissions
  user_credentials
  aircraft
  components
  component_installations
  flight_time_entries
  aircraft_inspection_subscriptions
  squawks
  squawk_photos
  maintenance_entries
  notification_preferences
  notifications
  email_outbox
)

PSQL=(psql --set ON_ERROR_STOP=1 --no-psqlrc --quiet --tuples-only --no-align "$DATABASE_URL_DIRECT")

# Server-side timestamp first so the captured-at field reflects the DB clock,
# not the client clock — useful when the operator is in a different timezone
# from the Neon project.
captured_at="$("${PSQL[@]}" -c "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"');" | tr -d '[:space:]')"
server_version="$("${PSQL[@]}" -c "SHOW server_version;" | tr -d '[:space:]')"

printf '{\n'
printf '  "captured_at_utc": "%s",\n' "$captured_at"
printf '  "server_version": "%s",\n' "$server_version"
printf '  "tables": {\n'

first=1
for table in "${SAMPLE_TABLES[@]}"; do
  # to_regclass returns NULL if the table doesn't exist — useful for telling
  # "migration not yet applied" apart from "table empty".
  exists="$("${PSQL[@]}" -c "SELECT to_regclass('public.${table}') IS NOT NULL;" | tr -d '[:space:]')"

  if [[ "$exists" == "t" ]]; then
    count="$("${PSQL[@]}" -c "SELECT count(*) FROM ${table};" | tr -d '[:space:]')"
    row="{\"exists\": true, \"rows\": ${count}}"
  else
    row='{"exists": false, "rows": null}'
  fi

  if [[ $first -eq 1 ]]; then
    first=0
  else
    printf ',\n'
  fi
  printf '    "%s": %s' "$table" "$row"
done

printf '\n  }\n'
printf '}\n'
