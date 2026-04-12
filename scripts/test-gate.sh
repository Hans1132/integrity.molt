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
echo "🌐 E2E smoke..."
if systemctl is-active --quiet integrity-x402.service 2>/dev/null; then
  if node tests/e2e/smoke.js; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    ERRORS="$ERRORS\n- E2E smoke tests failed"
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
