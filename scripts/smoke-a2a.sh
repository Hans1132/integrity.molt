#!/usr/bin/env bash
# scripts/smoke-a2a.sh — E2E smoke test for A2A Oracle endpoints
#
# Requires: curl, jq, a running server
#
# Usage:
#   bash scripts/smoke-a2a.sh
#   API_URL=https://intmolt.org bash scripts/smoke-a2a.sh
#
# Returns exit code 0 if all steps pass, 1 if any fail.

set -o pipefail

API_URL="${API_URL:-http://127.0.0.1:3402}"
TEST_ADDRESS="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

# ── Counters ──────────────────────────────────────────────────────────────────
PASS=0
FAIL=0

step_pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
step_fail() { echo "  FAIL  $1${2:+  →  $2}"; FAIL=$((FAIL + 1)); }

# ── Pre-flight: dependencies ──────────────────────────────────────────────────
for dep in curl jq; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "ABORT: '$dep' not found in PATH" >&2
    exit 2
  fi
done

echo ""
echo "A2A Oracle smoke test — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Target: $API_URL"
echo ""

# ── Step 1: GET /scan/v1/:address ─────────────────────────────────────────────
echo "Step 1: GET /scan/v1/$TEST_ADDRESS"

SCAN_RESPONSE=$(curl -s --max-time 15 \
  -H "Accept: application/json" \
  "${API_URL}/scan/v1/${TEST_ADDRESS}")

CURL_EXIT=$?
if [ $CURL_EXIT -ne 0 ]; then
  step_fail "scan request succeeded" "curl exit $CURL_EXIT"
else
  SCAN_STATUS_OK=$(echo "$SCAN_RESPONSE" | jq -r '.address // empty' 2>/dev/null)
  if [ -z "$SCAN_STATUS_OK" ]; then
    step_fail "scan response has .address field" "$(echo "$SCAN_RESPONSE" | head -c 200)"
  else
    step_pass "scan returned structured response for $TEST_ADDRESS"
  fi
fi

# ── Step 2: Extract signed envelope from scan response ───────────────────────
echo ""
echo "Step 2: Extract signed envelope from scan response"

SIGNATURE=$(echo "$SCAN_RESPONSE" | jq -r '.signature // empty' 2>/dev/null)
VERIFY_KEY=$(echo "$SCAN_RESPONSE" | jq -r '.verify_key // empty' 2>/dev/null)

if [ -z "$SIGNATURE" ] || [ "$SIGNATURE" = "null" ]; then
  step_fail "scan response contains non-null .signature" \
    "signature=$(echo "$SIGNATURE" | head -c 60)"
else
  step_pass "scan response contains signature (${#SIGNATURE} chars)"
fi

if [ -z "$VERIFY_KEY" ] || [ "$VERIFY_KEY" = "null" ]; then
  step_fail "scan response contains non-null .verify_key" \
    "verify_key=$(echo "$VERIFY_KEY" | head -c 60)"
else
  step_pass "scan response contains verify_key (${#VERIFY_KEY} chars)"
fi

# ── Step 3: POST /verify/v1/signed-receipt with the scan envelope ─────────────
echo ""
echo "Step 3: POST /verify/v1/signed-receipt (flat envelope from scan)"

# Wrap the flat scan response in { envelope: <scan_response> }
VERIFY_BODY=$(echo "$SCAN_RESPONSE" | jq '{envelope: .}')

VERIFY_RESPONSE=$(echo "$VERIFY_BODY" | curl -s --max-time 15 \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d @- \
  "${API_URL}/verify/v1/signed-receipt")

VERIFY_VALID=$(echo "$VERIFY_RESPONSE" | jq -r '.valid // empty' 2>/dev/null)
VERIFY_REASON=$(echo "$VERIFY_RESPONSE" | jq -r '.reason // empty' 2>/dev/null)

if [ "$VERIFY_VALID" = "true" ]; then
  step_pass "verify returned valid:true (reason: $VERIFY_REASON)"
else
  step_fail "verify returned valid:true" \
    "valid=$VERIFY_VALID reason=$VERIFY_REASON body=$(echo "$VERIFY_RESPONSE" | head -c 200)"
fi

# ── Step 4: GET /feed/v1/new-spl-tokens (no params) ──────────────────────────
echo ""
echo "Step 4: GET /feed/v1/new-spl-tokens"

FEED_RESPONSE=$(curl -s --max-time 15 \
  -H "Accept: application/json" \
  "${API_URL}/feed/v1/new-spl-tokens")

CURL_EXIT=$?
if [ $CURL_EXIT -ne 0 ]; then
  step_fail "feed request succeeded" "curl exit $CURL_EXIT"
else
  IS_ARRAY=$(echo "$FEED_RESPONSE" | jq -r 'if .mints | type == "array" then "yes" else "no" end' 2>/dev/null)
  MINT_COUNT=$(echo "$FEED_RESPONSE" | jq -r '.count // "?"' 2>/dev/null)
  if [ "$IS_ARRAY" = "yes" ]; then
    step_pass "feed response.mints is array (count: $MINT_COUNT)"
  else
    step_fail "feed response.mints is JSON array" \
      "$(echo "$FEED_RESPONSE" | head -c 200)"
  fi
fi

# ── Step 5: GET /feed/v1/new-spl-tokens?since=<ISO8601> ──────────────────────
echo ""
echo "Step 5: GET /feed/v1/new-spl-tokens?since= (ISO8601 param)"

SINCE_DATE=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -v -24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || echo "2026-04-23T00:00:00Z")

FEED_SINCE_RESPONSE=$(curl -s --max-time 15 \
  -H "Accept: application/json" \
  --get --data-urlencode "since=${SINCE_DATE}" \
  "${API_URL}/feed/v1/new-spl-tokens")

CURL_EXIT=$?
if [ $CURL_EXIT -ne 0 ]; then
  step_fail "feed?since= request succeeded" "curl exit $CURL_EXIT"
else
  IS_ARRAY2=$(echo "$FEED_SINCE_RESPONSE" | jq -r 'if .mints | type == "array" then "yes" else "no" end' 2>/dev/null)
  if [ "$IS_ARRAY2" = "yes" ]; then
    step_pass "feed?since=$SINCE_DATE → mints is array"
  else
    step_fail "feed?since= returns mints array" \
      "$(echo "$FEED_SINCE_RESPONSE" | head -c 200)"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "══════════════════════════════════════════════"

if [ $FAIL -gt 0 ]; then
  exit 1
fi
exit 0
