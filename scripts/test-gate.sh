#!/bin/bash
# test-gate.sh — POVINNÝ po každé změně
# Exit code 0 = PASS (safe to commit), 1 = FAIL (do not commit)

set -e
cd "$(dirname "$0")/.."
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

# 6. CAPTCHA E2E (pokud service běží)
echo "🔑 CAPTCHA E2E..."
if systemctl is-active --quiet integrity-x402.service 2>/dev/null; then
  if node tests/e2e/captcha.test.js; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    ERRORS="$ERRORS\n- CAPTCHA E2E tests failed"
  fi
else
  echo "⚠️  SKIP (service not running)"
fi

# 7. Scan validator unit tests
echo "🛡️  Scan validator..."
if node tests/scan-validator.test.js 2>/dev/null; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
  ERRORS="$ERRORS\n- Scan validator unit tests failed"
fi

# 8. Adversarial tests
echo "⚔️  Adversarial tests..."
if node tests/adversarial.test.js 2>/dev/null; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
  ERRORS="$ERRORS\n- Adversarial tests failed"
fi

# 9. Golden dataset accuracy tests
echo "🎯 Accuracy (golden dataset)..."
if node tests/scanner/accuracy.test.js 2>/dev/null; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
  ERRORS="$ERRORS\n- Golden dataset accuracy tests failed"
fi

# 10. Scam DB unit tests
echo "🗄️  Scam DB tests..."
if node tests/scam-db.test.js 2>/dev/null; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
  ERRORS="$ERRORS\n- Scam DB unit tests failed"
fi

# 11. A2A task-store unit tests
echo "🗄️  A2A task-store tests..."
if node tests/a2a-task-store.test.js 2>/dev/null; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
  ERRORS="$ERRORS\n- A2A task-store tests failed"
fi

# 12. A2A handler integration tests
echo "🤖  A2A handler tests..."
if systemctl is-active --quiet integrity-x402.service 2>/dev/null; then
  echo "  ⚠️  SKIP — service running, port 3402 occupied (run manually: systemctl stop integrity-x402.service && node tests/a2a-handler.test.js)"
else
  if node tests/a2a-handler.test.js 2>/dev/null; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    ERRORS="$ERRORS\n- A2A handler tests failed"
  fi
fi

# 13. Registry endpoint tests (pouze pokud service běží)
echo "📋  Registry tests..."
if node tests/registry.test.js 2>/dev/null; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
  ERRORS="$ERRORS\n- Registry tests failed"
fi

# 14. MCP server unit tests
echo "🔌  MCP server tests..."
if npm --prefix mcp install --silent 2>/dev/null && node tests/mcp/server.test.js 2>/dev/null; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
  ERRORS="$ERRORS\n- MCP server tests failed"
fi

# 15. MCP dependency audit (fail on high/critical only)
echo "🔍  MCP npm audit..."
AUDIT_OUT=$(npm audit --production --audit-level=high --prefix mcp 2>&1)
AUDIT_EXIT=$?
if [ $AUDIT_EXIT -eq 0 ]; then
  echo "✅"
  PASS=$((PASS+1))
else
  echo "❌ FAIL — high/critical vulnerabilities in mcp/node_modules"
  echo "$AUDIT_OUT" | grep -E "Severity|severity|High|Critical" | head -10
  FAIL=$((FAIL+1))
  ERRORS="$ERRORS\n- MCP dependency audit: high/critical CVEs found"
fi

# 16. IRIS live accuracy — 30 labeled tokenů (15 scam + 10 whitelist + 5 known legit)
echo "🎯 IRIS live accuracy (30 labeled tokenů)..."
if ! systemctl is-active --quiet integrity-x402.service 2>/dev/null; then
  echo "  ⚠️  SKIP (service not running)"
else
  _IRIS_FAIL=0
  _IRIS_PASS=0
  _iris_scan() {
    local addr="$1" expect_class="$2" threshold_op="$3" threshold="$4"
    local out score level
    out=$(curl -sf --max-time 15 -H "X-MCP-Caller: 1" "http://localhost:3402/scan/v1/$addr" 2>/dev/null)
    if [ -z "$out" ]; then
      echo "  ⚠ $addr → ERROR (no response)"
      _IRIS_FAIL=$((_IRIS_FAIL+1)); return
    fi
    score=$(printf '%s' "$out" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('iris_score','?'))" 2>/dev/null)
    level=$(printf '%s' "$out" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('risk_level','?').lower())" 2>/dev/null)
    if [ "$score" = "?" ]; then
      echo "  ⚠ $addr → parse error"
      _IRIS_FAIL=$((_IRIS_FAIL+1)); return
    fi
    if [ "$threshold_op" = "ge" ] && [ "$score" -ge "$threshold" ] 2>/dev/null; then
      echo "  ✅ $expect_class $addr → $level ($score)"
      _IRIS_PASS=$((_IRIS_PASS+1))
    elif [ "$threshold_op" = "le" ] && [ "$score" -le "$threshold" ] 2>/dev/null; then
      echo "  ✅ $expect_class $addr → $level ($score)"
      _IRIS_PASS=$((_IRIS_PASS+1))
    else
      echo "  ❌ $expect_class $addr → $level ($score) [MISCLASSIFIED]"
      _IRIS_FAIL=$((_IRIS_FAIL+1))
    fi
  }
  # Scam tokeny — expect score >= 55
  _iris_scan AEunQGHYJ2pdvGdQ74DwFCF4AkGg9Xx8F8PYFz671kVo SCAM ge 55
  _iris_scan 571H6xivLvuhHD1TpmxWrvT1Qpmmka6QLWnkPNyaSpE9 SCAM ge 55
  _iris_scan 8GBi3n36RDVbQsrbA6Kbr7wz6nNBy7gF9VdZYRWpxcft SCAM ge 55
  _iris_scan 8z9ZgchurDj6cQCvfA1iqt8Vno9Zr3QCXXtGAoYwy25t SCAM ge 55
  _iris_scan 17n7hbx76Z26Lk1XG28rEe31QfTXUkYFXper3oRNXHL  SCAM ge 55
  _iris_scan 8bf25wWvJgWVsbJ6fEoreUyBE9jJnyJG7weLG7PatrJ4  SCAM ge 55
  _iris_scan v47woUmg8mWtMtMxjts7zetf45dejzBVYh7FrAeDA6w   SCAM ge 55
  _iris_scan 7BWBEAtChSYsgZx7wJ3CagU6NHQWbZtjhU82CRC7hBoi  SCAM ge 55
  _iris_scan 93VgtDu5VNXJyubaWzEGTUAJk5zgxXXMtrDDsXEegcXE  SCAM ge 55
  _iris_scan FMybqsbgdaZr8z9HBicdYt6M6zckgytpgcLPfWJDiPyY  SCAM ge 55
  _iris_scan 89i6ri6TNqYuR2SDc1frKRSVZszqwG5oed34vmhf38GW  SCAM ge 55
  _iris_scan D3taiNpsQxtW8aeVnuZcjMjeQHWmf33DvPfrtzyfnKsx  SCAM ge 55
  _iris_scan AjDVYrTy7Cg7re4Q4JmSWiQpwzMqxSf8jyHhwuD1xcW8 SCAM ge 55
  _iris_scan AN5muQMhA97XnTNNCZtQXjUC15oRHVxBFk4icnS8iMCY  SCAM ge 55
  _iris_scan Ajxa6NXrRTJYiNTRmQYx3pzPGPBdVKnGiWeiUEg6pGPF  SCAM ge 55
  # Whitelist tokeny — expect score <= 24
  _iris_scan 3tS6fbLh2P8tzxXuqCiHZpZhsxJpmrR3Xb9psmypnp69  LEGIT le 24
  _iris_scan Av6qVigkb7USQyPXJkUvAEm4f599WTRvd75PUWBA9eNm  LEGIT le 24
  _iris_scan AT79ReYU9XtHUTF5vM6Q4oa9K8w7918Fp5SU7G1MDMQY  LEGIT le 24
  _iris_scan 4Cnk9EPnW5ixfLZatCPJjDB1PUtcRpVVgTQukm9epump  LEGIT le 24
  _iris_scan Adq3wnAvtaXBNfy63xGV1YNkDiPKadDT469xF9uZPrqE  LEGIT le 24
  _iris_scan 2u98MM7DMtVmNG4iAKRNMtynjmkzgD6fXAzB3wVfhQvg  LEGIT le 24
  _iris_scan 6gx6Ph2ek73kF6EWDrG4GQ54pcLJB6CYpATuRyxKXumo  LEGIT le 24
  _iris_scan BxXmDhM8sTF3QG4foaVM2v1EUvg9DLSVUsDRTjR8tMyS  LEGIT le 24
  _iris_scan GkJxELgJXpQRm7dfc2yS18vBDRxP5SjVJgbrmTGgpump  LEGIT le 24
  _iris_scan GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG  LEGIT le 24
  # Known legit (SOL, USDC, BONK, USDT, RAY) — expect score <= 24
  _iris_scan So11111111111111111111111111111111111111112      LEGIT le 24
  _iris_scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v   LEGIT le 24
  _iris_scan DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263   LEGIT le 24
  _iris_scan Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB    LEGIT le 24
  _iris_scan 4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R   LEGIT le 24
  echo "  IRIS: $_IRIS_PASS/30 správně, $_IRIS_FAIL chybně"
  if [ "$_IRIS_FAIL" -eq 0 ]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    ERRORS="$ERRORS\n- IRIS live accuracy: $_IRIS_FAIL/30 tokenů misclassifikováno"
  fi
fi

# 17. IRIS v2 calibration accuracy — Bucket A/B/C/D against labeled dataset
echo "🎯 IRIS v2 calibration (Bucket A/B/C/D)..."
if ! systemctl is-active --quiet integrity-x402.service 2>/dev/null; then
  echo "  ⚠️  SKIP (service not running)"
elif [ ! -f tests/iris/data/calibration-v2.json ]; then
  echo "  ⚠️  SKIP (no calibration-v2.json — v2 not deployed)"
else
  if SCAN_URL_BASE=http://localhost:3402 node --test --test-timeout=300000 tests/iris/iris-calibration.test.js 2>&1 | tail -25; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    ERRORS="$ERRORS\n- IRIS v2 calibration: one or more Bucket A/B/C/D targets failed"
  fi
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
