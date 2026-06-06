#!/usr/bin/env bash
# smoke-fresh-tenant.sh — C6 fresh-tenant end-to-end smoke test (PMB-121)
#
# Exercises the full provisioning path: platform-admin creates a tenant,
# primary admin logs in, adds an aircraft, creates a draft maintenance entry,
# and the audit trail is verified. The mechanic signoff step (scenario step 4)
# is partially exercised: the RBAC gate is verified via a 403 on an admin-role
# sign attempt. Full mechanic signoff requires a credential-seeding admin API
# that does not yet exist; see the NOTE section below.
#
# Required env vars:
#   BASE_URL                   e.g. https://ga-app-taupe.vercel.app
#   PLATFORM_ADMIN_EMAIL       email of an existing platform_admin row
#   PLATFORM_ADMIN_PASSWORD    password for that user
#
# Optional:
#   SMOKE_IDEMPOTENCY_KEY      idempotency key for the tenant create call;
#                              defaults to smoke-<unix-timestamp> to guarantee
#                              a fresh tenant each run
#   VERCEL_PROTECTION_BYPASS   when set, injects x-vercel-protection-bypass and
#                              x-vercel-set-bypass-cookie headers on every request
#                              (required to hit preview URLs gated by Vercel SSO)
#
# Exit codes:
#   0 — all asserted steps passed
#   1 — one or more assertions failed (detailed output above exit line)
#
# NOTE: mechanic signoff gap (follow-up required)
#   The scenario calls for a mechanic seat to sign the 100-hour entry.
#   Two capabilities not yet implemented block this:
#     (a) Invite acceptance API — additional-seat accounts are created via
#         email invite with no initial password; there is no HTTP endpoint to
#         accept an invitation programmatically.
#     (b) Credential-seeding API — signing requires an A&P/IA credential row
#         in user_credentials; there is no admin HTTP endpoint to insert one.
#   Until those endpoints land, this script validates the RBAC guard by
#   attempting to sign as the primary admin (role=admin) and asserting a 403.
#   When the credential API ships, extend step 6b with mechanic login + sign.
#
# Usage (local):
#   BASE_URL=https://ga-app-taupe.vercel.app \
#   PLATFORM_ADMIN_EMAIL=admin@example.com \
#   PLATFORM_ADMIN_PASSWORD=... \
#     bash apps/web/scripts/smoke-fresh-tenant.sh
#
# Usage (CI): see .github/workflows/smoke.yml

set -euo pipefail

# ── helpers ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS=0
FAIL=0

pass() { echo -e "${GREEN}✓${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}✗${NC} $1"; FAIL=$((FAIL + 1)); }
info() { echo -e "${YELLOW}→${NC} $1"; }
skip() { echo -e "${YELLOW}~${NC} SKIP: $1"; }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$label (got $actual)"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

assert_contains() {
  local label="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -qF "$expected"; then
    pass "$label"
  else
    fail "$label — expected to contain '$expected', got: $actual"
  fi
}

assert_nonempty() {
  local label="$1" actual="$2"
  if [ -n "$actual" ] && [ "$actual" != "null" ]; then
    pass "$label (got $actual)"
  else
    fail "$label — expected non-empty, got: '$actual'"
  fi
}

# curl wrapper that captures the HTTP status + body
# Usage: http_call <status_var> <body_var> <method> <path> [cookie_var] [extra_curl_args...]
# Writes HTTP status to <status_var>, response body to <body_var>.
http() {
  local status_var="$1" body_var="$2" method="$3" path="$4"
  shift 4
  local cookie_file="${1:-}"
  if [ -n "$cookie_file" ] && [ "${cookie_file:0:1}" != "-" ]; then
    shift
  else
    cookie_file=""
  fi

  local url="${BASE_URL}${path}"
  local tmpfile
  tmpfile=$(mktemp)

  local cookie_args=()
  if [ -n "$cookie_file" ] && [ -f "$cookie_file" ]; then
    cookie_args=(-b "$cookie_file" -c "$cookie_file")
  fi

  local bypass_args=()
  if [ -n "${VERCEL_PROTECTION_BYPASS:-}" ]; then
    # x-vercel-set-bypass-cookie is intentionally omitted: sending it on non-GET
    # requests causes Vercel to issue a 307 redirect to set the cookie, which
    # breaks POST bodies. The bypass token alone is sufficient for API calls.
    bypass_args=(
      -H "x-vercel-protection-bypass: ${VERCEL_PROTECTION_BYPASS}"
    )
  fi

  local status
  status=$(curl -s -o "$tmpfile" -w "%{http_code}" \
    -X "$method" \
    "${cookie_args[@]}" \
    "${bypass_args[@]}" \
    "$@" \
    "$url")

  local body
  body=$(cat "$tmpfile")
  rm -f "$tmpfile"

  eval "${status_var}='${status}'"
  # Use printf + eval to handle special chars in body
  printf -v "$body_var" '%s' "$body"
}

jq_field() { echo "$1" | jq -r "$2" 2>/dev/null || echo ""; }

# ── env validation ────────────────────────────────────────────────────────────

: "${BASE_URL:?BASE_URL is required (e.g. https://ga-app-taupe.vercel.app)}"
: "${PLATFORM_ADMIN_EMAIL:?PLATFORM_ADMIN_EMAIL is required}"
: "${PLATFORM_ADMIN_PASSWORD:?PLATFORM_ADMIN_PASSWORD is required}"

IDEMPOTENCY_KEY="${SMOKE_IDEMPOTENCY_KEY:-smoke-$(date +%s)}"
TS=$(date +%s)
ORG_NAME="smoke:fresh-tenant-${TS}"
ADMIN_EMAIL="smoke+admin+${TS}@smoke.invalid"
MECH_EMAIL="smoke+mech+${TS}@smoke.invalid"

echo ""
echo "═══════════════════════════════════════════════"
echo " PMB-121 fresh-tenant smoke  |  ${BASE_URL}"
echo " org: ${ORG_NAME}"
echo " idempotency-key: ${IDEMPOTENCY_KEY}"
echo "═══════════════════════════════════════════════"
echo ""

ADMIN_COOKIE=$(mktemp)
TENANT_COOKIE=$(mktemp)
trap 'rm -f "$ADMIN_COOKIE" "$TENANT_COOKIE"' EXIT

# ── Step 1: Platform admin login ──────────────────────────────────────────────

info "Step 1: platform admin login"

http STATUS BODY POST /api/auth/login "$ADMIN_COOKIE" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${PLATFORM_ADMIN_EMAIL}\",\"password\":\"${PLATFORM_ADMIN_PASSWORD}\"}"

assert_eq "1.1 platform admin login status" "200" "$STATUS"

PLATFORM_ADMIN_USER_ID=$(jq_field "$BODY" '.user.id')
assert_nonempty "1.2 platform admin user id" "$PLATFORM_ADMIN_USER_ID"

# ── Step 2: Provision fresh tenant ───────────────────────────────────────────

info "Step 2: provision tenant via POST /api/admin/tenants"

PROVISION_BODY=$(jq -n \
  --arg orgName "$ORG_NAME" \
  --arg email "$ADMIN_EMAIL" \
  --arg mechEmail "$MECH_EMAIL" \
  '{
    orgName: $orgName,
    orgType: "owner",
    primaryAdmin: { email: $email, generatePassword: true },
    additionalSeats: [{ email: $mechEmail, role: "mechanic" }]
  }')

http STATUS BODY POST /api/admin/tenants "$ADMIN_COOKIE" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  -d "$PROVISION_BODY"

assert_eq "2.1 provision status" "201" "$STATUS"

TENANT_ID=$(jq_field "$BODY" '.tenantId')
PRIMARY_ADMIN_USER_ID=$(jq_field "$BODY" '.primaryAdminUserId')
AUDIT_ID=$(jq_field "$BODY" '.auditId')
INITIAL_PASSWORD=$(jq_field "$BODY" '.initialPassword')

assert_nonempty "2.2 tenantId" "$TENANT_ID"
assert_nonempty "2.3 primaryAdminUserId" "$PRIMARY_ADMIN_USER_ID"
assert_nonempty "2.4 auditId" "$AUDIT_ID"
assert_nonempty "2.5 initialPassword echoed (mode a)" "$INITIAL_PASSWORD"

# ── Step 3: Primary admin login ───────────────────────────────────────────────

info "Step 3: primary admin login with generated credential"

http STATUS BODY POST /api/auth/login "$TENANT_COOKIE" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${INITIAL_PASSWORD}\"}"

assert_eq "3.1 primary admin login status" "200" "$STATUS"

LOGGED_IN_USER_ID=$(jq_field "$BODY" '.user.id')
assert_eq "3.2 logged-in user id matches provisioned id" \
  "$PRIMARY_ADMIN_USER_ID" "$LOGGED_IN_USER_ID"

# ── Step 4: Add aircraft ──────────────────────────────────────────────────────

info "Step 4: primary admin adds an aircraft"

AIRCRAFT_BODY=$(jq -n \
  --arg reg "N${TS: -5}SM" \
  '{
    registration: $reg,
    make: "Cessna",
    model: "172S",
    serial_number: "172S-SMOKE-001",
    year_manufactured: 2018,
    category: "airplane",
    aircraft_class: "single-engine land",
    time_source: "hobbs",
    airframe_total_time: 0
  }')

http STATUS BODY POST "/api/orgs/${TENANT_ID}/aircraft" "$TENANT_COOKIE" \
  -H "Content-Type: application/json" \
  -d "$AIRCRAFT_BODY"

assert_eq "4.1 create aircraft status" "201" "$STATUS"

AIRCRAFT_ID=$(jq_field "$BODY" '.id')
assert_nonempty "4.2 aircraft id" "$AIRCRAFT_ID"
assert_eq "4.3 aircraft tenant_id" "$TENANT_ID" "$(jq_field "$BODY" '.tenant_id')"

# ── Step 5: Create draft 100-hour maintenance entry ───────────────────────────

info "Step 5: create draft 100-hour maintenance entry"

ENTRY_BODY=$(jq -n --arg today "$(date +%Y-%m-%d)" \
  '{
    entry_type: "100_hour_inspection",
    work_performed: "Smoke test 100-hour inspection. Not a real maintenance record.",
    performed_on: $today,
    aircraft_total_time: 100
  }')

http STATUS BODY POST "/api/orgs/${TENANT_ID}/aircraft/${AIRCRAFT_ID}/maintenance-entries" "$TENANT_COOKIE" \
  -H "Content-Type: application/json" \
  -d "$ENTRY_BODY"

assert_eq "5.1 create maintenance entry status" "201" "$STATUS"

ENTRY_ID=$(jq_field "$BODY" '.id')
assert_nonempty "5.2 entry id" "$ENTRY_ID"
assert_eq "5.3 entry type" "100_hour_inspection" "$(jq_field "$BODY" '.entry_type')"
assert_eq "5.4 entry is unsigned (signed_at null)" "null" "$(jq_field "$BODY" '.signed_at')"

# ── Step 6a: RBAC guard — admin role cannot sign ──────────────────────────────
# Proves the signoff gate fires. Primary admin (role=admin) → expect 403.
# Full mechanic sign is blocked by missing: (a) invite acceptance API,
# (b) credential seeding API. See NOTE in script header.

info "Step 6a: RBAC gate — admin role sign attempt (expect 403)"

http STATUS BODY POST "/api/orgs/${TENANT_ID}/maintenance-entries/${ENTRY_ID}/sign" "$TENANT_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{}'

assert_eq "6a.1 admin sign blocked (403)" "403" "$STATUS"
assert_contains "6a.2 error body present" "error" "$BODY"

skip "6b mechanic signoff — invite acceptance + credential seeding API not yet implemented (see PMB-121 NOTE)"

# ── Step 7: Audit trail ───────────────────────────────────────────────────────

info "Step 7: audit trail — provisioning row appears in GET /api/admin/audit"

http STATUS BODY GET "/api/admin/audit?limit=20" "$ADMIN_COOKIE"

assert_eq "7.1 audit list status" "200" "$STATUS"

FOUND_AUDIT=$(echo "$BODY" | jq -r --arg id "$AUDIT_ID" \
  '.audit[] | select(.id == $id) | .id' 2>/dev/null || echo "")
assert_eq "7.2 provisioning audit row present" "$AUDIT_ID" "$FOUND_AUDIT"

RESULT_STATUS=$(echo "$BODY" | jq -r --arg id "$AUDIT_ID" \
  '.audit[] | select(.id == $id) | .resultStatus' 2>/dev/null || echo "")
assert_eq "7.3 audit row status=done" "done" "$RESULT_STATUS"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "───────────────────────────────────────────────"
printf "  Results: ${GREEN}%d passed${NC}  ${RED}%d failed${NC}\n" "$PASS" "$FAIL"
echo "  Tenant id:  ${TENANT_ID:-<not provisioned>}"
echo "  Audit id:   ${AUDIT_ID:-<not provisioned>}"
echo "  Org name:   ${ORG_NAME}"
echo "───────────────────────────────────────────────"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}SMOKE FAILED${NC} — see failures above"
  exit 1
fi

echo -e "${GREEN}SMOKE PASSED${NC}"
exit 0
