#!/usr/bin/env bash
# scripts/demo-a2a-oracle.sh — integrity.molt A2A oracle curl demo
#
# Usage:
#   bash scripts/demo-a2a-oracle.sh
#   BASE_URL=https://intmolt.org bash scripts/demo-a2a-oracle.sh
#
# Requires: curl, jq

set -euo pipefail

BASE_URL="${BASE_URL:-https://intmolt.org}"
SCAN_ADDR="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
RECEIPT_TMP="$(mktemp /tmp/intmolt-receipt-XXXXXX.json)"
trap 'rm -f "$RECEIPT_TMP"' EXIT

ok()   { echo "  [OK]  $*"; }
fail() { echo "  [FAIL] $*" >&2; exit 1; }
step() { echo; echo "── $* ──────────────────────────────────────────"; }

echo
echo "═══ integrity.molt A2A Oracle Demo ════════════════════════════════════"
echo "    BASE_URL: $BASE_URL"
echo "    Address:  $SCAN_ADDR"

# ── Step 1: Free scan ──────────────────────────────────────────────────────
step "1/4  GET /scan/v1/:address (free discovery)"

HTTP=$(curl -s -w "\n%{http_code}" "$BASE_URL/scan/v1/$SCAN_ADDR")
BODY=$(echo "$HTTP" | head -n -1)
CODE=$(echo "$HTTP" | tail -n 1)

[ "$CODE" -eq 200 ] || fail "scan returned HTTP $CODE"
echo "$BODY" > "$RECEIPT_TMP"

IRIS=$(echo "$BODY" | jq -r '.iris_score // "null"')
RISK=$(echo "$BODY" | jq -r '.risk_level // "null"')
SIG=$(echo "$BODY"  | jq -r '.signature  // "null"')

[ "$IRIS" != "null" ] || fail "iris_score missing in scan response"
[ "$SIG"  != "null" ] || fail "signature missing in scan response"
ok "iris_score=$IRIS  risk_level=$RISK"
ok "signature present (${#SIG} chars)"

# ── Step 2: Verify receipt ─────────────────────────────────────────────────
step "2/4  POST /verify/v1/signed-receipt (key-pinned verification)"

VERIFY_BODY="{\"envelope\": $(cat "$RECEIPT_TMP")}"
HTTP=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/verify/v1/signed-receipt" \
  -H "Content-Type: application/json" \
  -d "$VERIFY_BODY")
BODY=$(echo "$HTTP" | head -n -1)
CODE=$(echo "$HTTP" | tail -n 1)

[ "$CODE" -eq 200 ] || fail "verify returned HTTP $CODE"

MATH_VALID=$(echo "$BODY" | jq -r '.mathematically_valid // "null"')
REASON=$(echo "$BODY"     | jq -r '.reason // "null"')

[ "$MATH_VALID" = "true" ] || fail "mathematically_valid is not true (got $MATH_VALID); reason=$REASON"
ok "mathematically_valid=true"
ok "reason=$REASON"

KEY_PINNED=$(echo "$BODY" | jq -r '.key_pinned // "null"')
if [ "$KEY_PINNED" = "true" ]; then
  ok "key_pinned=true (production oracle key confirmed)"
else
  echo "  [INFO] key_pinned=false (expected in dev; production server has verify_key.bin)"
fi

# ── Step 3: SPL token feed ─────────────────────────────────────────────────
step "3/4  GET /feed/v1/new-spl-tokens (public pull-feed)"

HTTP=$(curl -s -w "\n%{http_code}" "$BASE_URL/feed/v1/new-spl-tokens")
BODY=$(echo "$HTTP" | head -n -1)
CODE=$(echo "$HTTP" | tail -n 1)

[ "$CODE" -eq 200 ] || fail "feed returned HTTP $CODE"

COUNT=$(echo "$BODY" | jq -r '.count // "null"')
MINTS_IS_ARRAY=$(echo "$BODY" | jq -r 'if .mints | type == "array" then "yes" else "no" end')

[ "$MINTS_IS_ARRAY" = "yes" ] || fail ".mints is not an array"
ok "mints is array, count=$COUNT"

# ── Step 4: Agent-card discovery ───────────────────────────────────────────
step "4/4  GET /.well-known/agent-card.json (A2A discovery)"

HTTP=$(curl -s -w "\n%{http_code}" "$BASE_URL/.well-known/agent-card.json")
BODY=$(echo "$HTTP" | head -n -1)
CODE=$(echo "$HTTP" | tail -n 1)

[ "$CODE" -eq 200 ] || fail "agent-card returned HTTP $CODE"

SKILL_COUNT=$(echo "$BODY" | jq '.skills | length // 0')
VERSION=$(echo "$BODY"     | jq -r '.version // "unknown"')

[ "$SKILL_COUNT" -gt 0 ] || fail "agent-card has no skills"
ok "version=$VERSION  skills=$SKILL_COUNT"

# ── Summary ────────────────────────────────────────────────────────────────
echo
echo "═══ DEMO OK ════════════════════════════════════════════════════════════"
echo "    Scan → signed receipt → server verify → SPL feed → agent-card"
echo "    All checks passed."
echo
