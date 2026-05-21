#!/usr/bin/env bash
# Restore-drill comparator: runs `drill-verify.sh` against a source and a
# restored URL, diffs the row counts, and writes a JSON artifact suitable for
# attaching to the J1.2 ticket (PMB-22) and the runbook verification log.
#
# Wall-clock duration is captured around the restored-side verifier call —
# that is the *verification* leg of the drill. The *restore* leg (creating
# the Neon branch) is timed by the operator and passed in as
# RESTORE_DURATION_SECONDS so both numbers land in the same artifact.
#
# Usage:
#   SOURCE_DATABASE_URL=...       # direct URL of the source/primary branch
#   RESTORED_DATABASE_URL=...     # direct URL of the freshly-created branch
#   RESTORE_DURATION_SECONDS=180  # operator-measured Neon branch-create time
#   OUT_DIR=./drill-out           # optional; defaults to ./drill-out
#   packages/db/scripts/drill-compare.sh
#
# Exit 0 = counts match, 1 = mismatch.

set -euo pipefail

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL must be set}"
: "${RESTORED_DATABASE_URL:?RESTORED_DATABASE_URL must be set}"
: "${RESTORE_DURATION_SECONDS:=0}"
: "${OUT_DIR:=./drill-out}"

mkdir -p "$OUT_DIR"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="$here/drill-verify.sh"

echo "==> drill: verifying SOURCE"
DATABASE_URL_DIRECT="$SOURCE_DATABASE_URL" "$VERIFY" > "$OUT_DIR/source.json"

echo "==> drill: verifying RESTORED (timed)"
start=$(date -u +%s)
DATABASE_URL_DIRECT="$RESTORED_DATABASE_URL" "$VERIFY" > "$OUT_DIR/restored.json"
end=$(date -u +%s)
verify_duration=$((end - start))

# Diff the two JSON outputs with python (avoid jq dependency; python is
# already required by anyone who can run vercel CLI). Fidelity = row count
# matches per table, AND existence flag matches per table.
python3 - "$OUT_DIR/source.json" "$OUT_DIR/restored.json" "$RESTORE_DURATION_SECONDS" "$verify_duration" "$OUT_DIR/report.json" <<'PY'
import json, sys
src_path, dst_path, restore_secs, verify_secs, out_path = sys.argv[1:]
src = json.load(open(src_path))
dst = json.load(open(dst_path))

rows = []
mismatches = []
for table in sorted(set(src["tables"]) | set(dst["tables"])):
    s = src["tables"].get(table, {"exists": False, "rows": None})
    d = dst["tables"].get(table, {"exists": False, "rows": None})
    ok = s == d
    rows.append({
        "table": table,
        "source": s,
        "restored": d,
        "ok": ok,
    })
    if not ok:
        mismatches.append(table)

report = {
    "source_captured_at_utc": src["captured_at_utc"],
    "restored_captured_at_utc": dst["captured_at_utc"],
    "source_server_version": src["server_version"],
    "restored_server_version": dst["server_version"],
    "restore_duration_seconds": int(restore_secs),
    "verify_duration_seconds": int(verify_secs),
    "total_duration_seconds": int(restore_secs) + int(verify_secs),
    "ok": not mismatches,
    "mismatched_tables": mismatches,
    "tables": rows,
}
with open(out_path, "w") as f:
    json.dump(report, f, indent=2)
print(json.dumps({k: v for k, v in report.items() if k != "tables"}, indent=2))
if mismatches:
    sys.exit(1)
PY
