#!/usr/bin/env bash
# Monthly backup-verification assertion. Runs drill-verify.sh against an
# ephemeral Neon branch and asserts the snapshot matches the in-repo
# baseline:
#
#   - every table in drill-verify.sh's SAMPLE_TABLES exists
#   - schema_migrations row count equals the number of *.sql files in
#     packages/db/migrations (the canonical source-of-truth list)
#   - regimes row count is exactly 1 (FAA spine, seeded by migration 0001)
#
# Writes a metrics report to $OUT_FILE (default ./backup-verify-out/report.json)
# and prints a compact summary to stdout. Exits 0 on match, 1 on mismatch.
#
# Usage:
#   DATABASE_URL_DIRECT="postgres://...?sslmode=require" \
#     packages/db/scripts/backup-verify-baseline.sh
#
# Optional env:
#   RESTORE_DURATION_SECONDS  Neon branch-create wall-clock from the caller
#                             (workflow times this around the API call).
#   OUT_FILE                  Where to write the report JSON.
#   MIGRATIONS_DIR            Override the migrations directory used to
#                             compute the expected schema_migrations row
#                             count. Defaults to ../migrations.

set -euo pipefail

: "${DATABASE_URL_DIRECT:?DATABASE_URL_DIRECT must be set}"
: "${RESTORE_DURATION_SECONDS:=0}"
: "${OUT_FILE:=./backup-verify-out/report.json}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="$here/drill-verify.sh"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$here/../migrations}"

if [[ ! -x "$VERIFY" ]]; then
  echo "error: drill-verify.sh not found or not executable at $VERIFY" >&2
  exit 64
fi

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "error: migrations dir not found at $MIGRATIONS_DIR" >&2
  exit 65
fi

mkdir -p "$(dirname "$OUT_FILE")"

snapshot_file="$(mktemp -t backup-verify-snapshot.XXXXXX.json)"
trap 'rm -f "$snapshot_file"' EXIT

echo "==> backup-verify: capturing snapshot from ephemeral branch (timed)"
verify_start=$(date -u +%s)
"$VERIFY" > "$snapshot_file"
verify_end=$(date -u +%s)
verify_duration=$((verify_end - verify_start))

expected_migrations=$(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d '[:space:]')

python3 - "$snapshot_file" "$expected_migrations" "$RESTORE_DURATION_SECONDS" "$verify_duration" "$OUT_FILE" <<'PY'
import json, sys, datetime

snap_path, expected_migrations, restore_secs, verify_secs, out_path = sys.argv[1:]
expected_migrations = int(expected_migrations)
restore_secs = int(restore_secs)
verify_secs = int(verify_secs)

with open(snap_path) as f:
    snap = json.load(f)

tables = snap["tables"]
sample_tables = list(tables.keys())
tables_total = len(sample_tables)

missing = [t for t, info in tables.items() if not info.get("exists")]
tables_matched = tables_total - len(missing)

schema_migrations = tables.get("schema_migrations", {})
schema_migrations_rows = schema_migrations.get("rows")
schema_migrations_ok = schema_migrations_rows == expected_migrations

regimes = tables.get("regimes", {})
regimes_rows = regimes.get("rows")
regimes_ok = regimes_rows == 1

failures = []
if missing:
    failures.append({
        "check": "all_sample_tables_exist",
        "missing": missing,
    })
if not schema_migrations_ok:
    failures.append({
        "check": "schema_migrations_row_count",
        "expected": expected_migrations,
        "actual": schema_migrations_rows,
    })
if not regimes_ok:
    failures.append({
        "check": "regimes_row_count",
        "expected": 1,
        "actual": regimes_rows,
    })

ok = not failures
report = {
    "captured_at_utc": snap.get("captured_at_utc"),
    "server_version": snap.get("server_version"),
    "restore_seconds": restore_secs,
    "verify_seconds": verify_secs,
    "total_seconds": restore_secs + verify_secs,
    "tables_total": tables_total,
    "tables_matched": tables_matched,
    "schema_migrations_expected": expected_migrations,
    "schema_migrations_actual": schema_migrations_rows,
    "regimes_actual": regimes_rows,
    "ok": ok,
    "failures": failures,
}

with open(out_path, "w") as f:
    json.dump(report, f, indent=2)

print(json.dumps(report, indent=2))
if not ok:
    sys.exit(1)
PY
