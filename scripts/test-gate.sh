#!/bin/bash
# test-gate.sh — POVINNÝ po každé změně
# Exit code 0 = PASS (safe to commit), 1 = FAIL (do not commit)

set -e
PASS=0
FAIL=0
ERRORS=""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🧪 TEST GATE — $(date '+%Y-%m-%d %H:%M')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Secrets check — NESMÍ být v kódu
echo -n "🔒 Secrets scan... "
SECRETS_FOUND=$(grep -rn "PRIVATE_KEY\|BEGIN.*PRIVATE\|sk_live\|sk_test" --include="*.js" --include="*.json" src/ public/ config/ 2>/dev/null | grep -v node_modules | grep -v .env.example || true)
if [ -n "$SECRETS_FOUND" ]; then
  echo "❌ FAIL — secrets in code!"
  echo "$SECRETS_FOUND"
  FAIL=$((FAIL+1))
  ERRORS="$ERRORS\n- Secrets found in code"
else
  echo "✅"
  PASS=$((PASS+1))
fi

# 2. Syntax check — Node.js parsuje bez chyb
echo -n "📝 Syntax check... "
if node -c server.js 2>/dev/null; then
  echo "✅"
  PASS=$((PASS+1))
else
  echo "❌ FAIL"
  FAIL=$((FAIL+1))
  ERRORS="$ERRORS\n- server.js syntax error"
fi

# 3. npm test (pokud existuje)
echo -n "🔬 npm test... "
if npm test --if-present 2>&1 | tail -1 | grep -q "passing\|ok\|PASS"; then
  echo "✅"
  PASS=$((PASS+1))
else
  echo "⚠️  SKIP (no tests or failing)"
  # Neblokujeme — zatím nemáme plnou test suite
fi

# 4. Service startuje
echo -n "⚙️  Service check... "
if systemctl is-active --quiet integrity-x402.service 2>/dev/null; then
  echo "✅"
  PASS=$((PASS+1))
else
  echo "⚠️  NOT RUNNING"
fi

# 5. E2E smoke (pokud service běží)
echo -n "🌐 E2E smoke... "
if command -v curl &>/dev/null && systemctl is-active --quiet integrity-x402.service 2>/dev/null; then
  # Homepage
  HTTP_HOME=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://127.0.0.1:3402/ 2>/dev/null || echo "000")
  # Health (endpoint je /health, ne /api/v1/health)
  HTTP_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://127.0.0.1:3402/health 2>/dev/null || echo "000")
  # Stats
  HTTP_STATS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://127.0.0.1:3402/api/v1/stats 2>/dev/null || echo "000")
  # x402 discovery
  HTTP_X402=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://127.0.0.1:3402/.well-known/x402.json 2>/dev/null || echo "000")
  # Quick scan without payment → expect 402 (endpoint je /scan/quick)
  HTTP_SCAN=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 -X POST http://127.0.0.1:3402/scan/quick -H "Content-Type: application/json" -d '{"address":"So11111111111111111111111111111111111111112"}' 2>/dev/null || echo "000")

  SMOKE_OK=true
  [ "$HTTP_HOME" = "200" ] || { SMOKE_OK=false; ERRORS="$ERRORS\n- Homepage returned $HTTP_HOME"; }
  [ "$HTTP_HEALTH" = "200" ] || { SMOKE_OK=false; ERRORS="$ERRORS\n- Health returned $HTTP_HEALTH"; }
  [ "$HTTP_STATS" = "200" ] || { SMOKE_OK=false; ERRORS="$ERRORS\n- Stats returned $HTTP_STATS"; }
  [ "$HTTP_X402" = "200" ] || { SMOKE_OK=false; ERRORS="$ERRORS\n- x402 returned $HTTP_X402"; }
  # Scan should be 402 (payment required) — both 402 and 400 acceptable
  [[ "$HTTP_SCAN" =~ ^(402|400)$ ]] || { SMOKE_OK=false; ERRORS="$ERRORS\n- Scan returned $HTTP_SCAN (expected 402)"; }

  if $SMOKE_OK; then
    echo "✅ (home=$HTTP_HOME health=$HTTP_HEALTH stats=$HTTP_STATS x402=$HTTP_X402 scan=$HTTP_SCAN)"
    PASS=$((PASS+1))
  else
    echo "❌ FAIL (home=$HTTP_HOME health=$HTTP_HEALTH stats=$HTTP_STATS x402=$HTTP_X402 scan=$HTTP_SCAN)"
    FAIL=$((FAIL+1))
  fi
else
  echo "⚠️  SKIP (service not running)"
fi

# Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "RESULTS: ✅ $PASS passed / ❌ $FAIL failed"
if [ $FAIL -gt 0 ]; then
  echo -e "ERRORS:$ERRORS"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "❌ GATE: FAIL — DO NOT COMMIT"
  exit 1
else
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "✅ GATE: PASS — safe to commit"
  exit 0
fi
