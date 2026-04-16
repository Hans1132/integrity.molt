#!/bin/bash
# telegram-bot.sh — integrity.molt Telegram bot (long-polling)
#
# Příkazy:
#   /start, /help    — uvítání a nápověda
#   /scan <address>  — free quick scan (multi-agent swarm)
#   /token <address> — token audit (free, omezeno)
#   /status          — stav bota a statistiky
#   /verify          — info o verifikaci signed reportů
#
# Použití: bash /root/scanner/telegram-bot.sh
# Systemd: viz /etc/systemd/system/intmolt-bot.service
#
# FREE model: quick scany zdarma — nejrychlejší cesta k user volume.
# Placené scany (deep audit) jsou dostupné přes API s x402 platbou.

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$(cat /root/.secrets/telegram_bot_token 2>/dev/null)}"
if [ -z "$BOT_TOKEN" ]; then
    echo "FATAL: TELEGRAM_BOT_TOKEN not set and /root/.secrets/telegram_bot_token not found" >&2
    exit 1
fi

API="https://api.telegram.org/bot${BOT_TOKEN}"
SERVER_API="http://127.0.0.1:3402"
BOT_ADMIN_KEY=$(cat /root/.secrets/bot_admin_key 2>/dev/null)
if [ -z "$BOT_ADMIN_KEY" ]; then
    echo "FATAL: /root/.secrets/bot_admin_key not found" >&2
    exit 1
fi
ADMIN_CHAT_ID="${ADMIN_CHAT_ID:-$(cat /root/.secrets/admin_chat_id 2>/dev/null)}"
if [ -z "$ADMIN_CHAT_ID" ]; then
    echo "WARNING: ADMIN_CHAT_ID not set — /admin command will be inaccessible" >&2
fi
LOG="/var/log/intmolt/telegram-bot.log"
SCAN_LOG="/var/log/intmolt/bot-scans.log"
RATE_DIR="/tmp/intmolt-bot-rate"
OFFSET_FILE="/tmp/intmolt-bot-offset"

mkdir -p /var/log/intmolt "$RATE_DIR"

log() {
    local msg="[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [bot] $1"
    echo "$msg" >> "$LOG"
    echo "$msg" >&2
}

log_scan() {
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $1" >> "$SCAN_LOG"
}

# ── Rate limiting: max 3 free scany za den per user ──────────────────────────
check_rate_limit() {
    local user_id="$1"
    local rate_file="$RATE_DIR/${user_id}"
    local now=$(date +%s)
    local window=86400  # 1 den
    local max_scans=3

    # Vyčisti staré záznamy
    if [ -f "$rate_file" ]; then
        grep -v "^$" "$rate_file" | awk -v cutoff=$((now - window)) '$1 > cutoff' > "${rate_file}.tmp"
        mv "${rate_file}.tmp" "$rate_file"
        local count=$(wc -l < "$rate_file")
        if [ "$count" -ge "$max_scans" ]; then
            return 1  # rate limited
        fi
    fi
    echo "$now" >> "$rate_file"
    return 0
}

# ── Odeslání zprávy ───────────────────────────────────────────────────────────
send_message() {
    local chat_id="$1"
    local text="$2"
    local parse_mode="${3:-HTML}"

    # Zkrať na Telegram limit 4096 znaků
    if [ ${#text} -gt 4000 ]; then
        text="${text:0:3900}
[... zkráceno]"
    fi

    local escaped
    escaped=$(python3 -c "import sys,json; print(json.dumps(sys.argv[1]))" "$text" 2>/dev/null)
    if [ -z "$escaped" ]; then
        escaped='"'"$(echo "$text" | head -30)"'"'
    fi

    local resp
    resp=$(curl -s -X POST \
        -K <(printf 'url = "https://api.telegram.org/bot%s/sendMessage"' "${BOT_TOKEN}") \
        -H "Content-Type: application/json" \
        --max-time 15 \
        -d "{\"chat_id\":\"${chat_id}\",\"text\":${escaped},\"parse_mode\":\"${parse_mode}\"}" 2>/dev/null)

    # Pokud Telegram odmítl (HTML parse error), pošli jako plain text bez formátování
    local ok
    ok=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok','false'))" 2>/dev/null)
    if [ "$ok" != "True" ] && [ "$ok" != "true" ]; then
        log "send_message failed (parse_mode=$parse_mode), retrying as plain text. resp=${resp:0:200}"
        local plain
        plain=$(echo "$text" | sed 's/<[^>]*>//g')
        escaped=$(python3 -c "import sys,json; print(json.dumps(sys.argv[1]))" "$plain" 2>/dev/null)
        curl -s -X POST \
            -K <(printf 'url = "https://api.telegram.org/bot%s/sendMessage"' "${BOT_TOKEN}") \
            -H "Content-Type: application/json" \
            --max-time 15 \
            -d "{\"chat_id\":\"${chat_id}\",\"text\":${escaped}}" \
            > /dev/null 2>&1
    fi
}

send_typing() {
    local chat_id="$1"
    curl -s -X POST \
        -K <(printf 'url = "https://api.telegram.org/bot%s/sendChatAction"' "${BOT_TOKEN}") \
        -H "Content-Type: application/json" \
        --max-time 5 \
        -d "{\"chat_id\":\"${chat_id}\",\"action\":\"typing\"}" \
        > /dev/null 2>&1
}

# ── Formátování výstupu pro Telegram ─────────────────────────────────────────
format_for_telegram() {
    local raw="$1"
    # Odstraň box-drawing znaky, ANSI escape kódy, zkrať
    local cleaned
    cleaned=$(echo "$raw" \
        | grep -v '^[╔╚╗║╠╣╦╩╬═─┌┐└┘├┤┬┴┼│]' \
        | sed 's/\x1b\[[0-9;]*m//g' \
        | head -50)

    # HTML escape — nutné pro bezpečné vložení do <pre> bloku
    cleaned=$(echo "$cleaned" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')

    # Zkrácení
    if [ ${#cleaned} -gt 2500 ]; then
        cleaned="${cleaned:0:2400}
[... zkráceno — plný report přes API]"
    fi
    echo "$cleaned"
}

# ── Handler: /start a /help ───────────────────────────────────────────────────
handle_help() {
    local chat_id="$1"
    local username="${2:-friend}"
    send_message "$chat_id" "👋 <b>integrity.molt</b> — AI-native security scanner

<b>Solana:</b>
• <code>/scan &lt;address&gt;</code> — AI security scan (free, 3×/day)
• <code>/token &lt;mint_address&gt;</code> — SPL token audit (mint/freeze/distribution)

<b>EVM (ETH/BSC/Polygon/Arbitrum/Base):</b>
• <code>/evm &lt;0x_address&gt; [chain]</code> — EVM token scan
  Example: <code>/evm 0xdAC17F... ethereum</code>

<b>Smart Contract:</b>
• <code>/contract &lt;github_url&gt;</code> — Rust/Solidity audit (cargo-audit + AI)
  Example: <code>/contract https://github.com/owner/repo</code>

<b>Other:</b>
• <code>/upgrade</code> — subscription tiers and pricing
• <code>/status</code> — scanner status
• <code>/verify</code> — verify Ed25519 signed reports

<b>Why integrity.molt over Rugcheck:</b>
✅ Multi-agent AI swarm (not just rules)
✅ EVM + Solana + smart contract audit
✅ Ed25519 cryptographically signed reports
✅ x402 agent-to-agent payments

<b>Subscription from \$15/mo</b> — /upgrade for details"
}

# ── Handler: /scan ────────────────────────────────────────────────────────────
handle_scan() {
    local chat_id="$1"
    local user_id="$2"
    local address="$3"

    if [ -z "$address" ]; then
        send_message "$chat_id" "❌ Provide a Solana address: <code>/scan &lt;address&gt;</code>"
        return
    fi

    if ! echo "$address" | grep -qP '^[1-9A-HJ-NP-Za-km-z]{32,44}$'; then
        send_message "$chat_id" "❌ Invalid Solana address. Must be 32–44 base58 characters."
        return
    fi

    if ! check_rate_limit "$user_id"; then
        send_message "$chat_id" "⏳ Rate limit: max 3 free scans per day.

For unlimited scans: /upgrade
→ Pro Trader \$15/mo · Builder \$49/mo · Team \$299/mo"
        return
    fi

    send_typing "$chat_id"
    send_message "$chat_id" "🔍 Starting AI security scan for:
<code>${address}</code>

Pipeline: RPC → Sonnet executor → Opus advisor (if needed)
Please wait 30–60 seconds..."

    log "Scan started: address=$address chat_id=$chat_id user_id=$user_id"
    log_scan "scan|$user_id|$chat_id|$address|start"

    local safe_address
    safe_address=$(echo "$address" | tr -cd '1-9A-HJ-NP-Za-km-z' | cut -c1-44)

    # Volání interního bot endpointu s advisor pipeline
    local result
    result=$(curl -s -X POST "${SERVER_API}/internal/bot/quick" \
        -H "Content-Type: application/json" \
        -H "X-Admin-Key: ${BOT_ADMIN_KEY}" \
        --max-time 120 \
        -d "{\"address\":\"${safe_address}\"}" 2>/dev/null)

    if [ -z "$result" ]; then
        send_message "$chat_id" "❌ Server did not respond. Please try again in a moment."
        log_scan "scan|$user_id|$chat_id|$address|failed|no_response"
        return
    fi

    local error
    error=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',''))" 2>/dev/null)
    if [ -n "$error" ]; then
        send_message "$chat_id" "❌ Scan failed: ${error}"
        log_scan "scan|$user_id|$chat_id|$address|failed|$error"
        return
    fi

    # Parsování výsledku
    local report advisor_used provider risk_level risk_score
    report=$(echo "$result"       | python3 -c "import sys,json; print(json.load(sys.stdin).get('report',''))" 2>/dev/null)
    advisor_used=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('advisor_used',False))" 2>/dev/null)
    provider=$(echo "$result"     | python3 -c "import sys,json; print(json.load(sys.stdin).get('provider',''))" 2>/dev/null)
    risk_level=$(echo "$result"   | python3 -c "import sys,json; print(json.load(sys.stdin).get('risk_level','') or '')" 2>/dev/null)
    risk_score=$(echo "$result"   | python3 -c "import sys,json; v=json.load(sys.stdin).get('risk_score'); print(v if v is not None else '')" 2>/dev/null)

    local formatted
    formatted=$(format_for_telegram "$report")

    # Rizikový badge
    local risk_header=""
    if [ -n "$risk_level" ]; then
        local remoji="🟡"
        case "$risk_level" in
            low|safe)     remoji="🟢" ;;
            medium)       remoji="🟡" ;;
            high|avoid)   remoji="🔴" ;;
            critical)     remoji="🆘" ;;
        esac
        risk_header="${remoji} <b>Risk: ${risk_level^^}</b>"
        [ -n "$risk_score" ] && risk_header="${risk_header} | Score: ${risk_score}/100"
        risk_header="${risk_header}
"
    fi

    # Advisor badge
    local advisor_badge=""
    if [ "$advisor_used" = "True" ] || [ "$advisor_used" = "true" ]; then
        advisor_badge="
🧠 <i>Consulted Opus advisor (grey zone detected)</i>"
    fi

    send_message "$chat_id" "${risk_header}<pre>${formatted}</pre>${advisor_badge}

<i>Report signed Ed25519 · verify at: https://intmolt.org/verify.html</i>
<i>Deep audit (5 USDC): /upgrade · API docs: https://intmolt.org/openapi.json</i>"

    log_scan "scan|$user_id|$chat_id|$address|done|risk=$risk_level|score=$risk_score|advisor=$advisor_used|provider=$provider"
    log "Scan done: address=$address risk=$risk_level score=$risk_score advisor=$advisor_used"
}

# ── Handler: /token ───────────────────────────────────────────────────────────
handle_token() {
    local chat_id="$1"
    local user_id="$2"
    local address="$3"

    if [ -z "$address" ]; then
        send_message "$chat_id" "❌ Provide a mint address: <code>/token &lt;mint_address&gt;</code>"
        return
    fi

    if ! echo "$address" | grep -qP '^[1-9A-HJ-NP-Za-km-z]{32,44}$'; then
        send_message "$chat_id" "❌ Invalid Solana address."
        return
    fi

    if ! check_rate_limit "token_${user_id}"; then
        send_message "$chat_id" "⏳ Rate limit: max 3 token audits per day."
        return
    fi

    send_typing "$chat_id"
    send_message "$chat_id" "🪙 Starting token audit for:
<code>${address}</code>

Checking: mint/freeze authority, holder distribution, supply, Token-2022...
Preliminary results in a few seconds, full AI analysis follows shortly..."

    local safe_address
    safe_address=$(echo "$address" | tr -cd '1-9A-HJ-NP-Za-km-z' | cut -c1-44)

    local result
    result=$(curl -s -X POST "${SERVER_API}/internal/bot/token" \
        -H "Content-Type: application/json" \
        -H "X-Admin-Key: ${BOT_ADMIN_KEY}" \
        --max-time 90 \
        -d "{\"address\":\"${safe_address}\",\"chat_id\":\"${chat_id}\"}" 2>/dev/null)

    if [ -z "$result" ]; then
        send_message "$chat_id" "❌ Server did not respond. Please try again in a moment."
        return
    fi

    local error
    error=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',''))" 2>/dev/null)
    if [ -n "$error" ]; then
        send_message "$chat_id" "❌ Token audit failed: ${error}

Make sure the address is a valid SPL token mint."
        return
    fi

    local risk_score category summary advisor_used findings_text
    risk_score=$(echo "$result"   | python3 -c "import sys,json; v=json.load(sys.stdin).get('risk_score'); print(v if v is not None else '?')" 2>/dev/null)
    category=$(echo "$result"     | python3 -c "import sys,json; print(json.load(sys.stdin).get('category','?'))" 2>/dev/null)
    summary=$(echo "$result"      | python3 -c "import sys,json; print((json.load(sys.stdin).get('summary') or '')[:600])" 2>/dev/null)
    advisor_used=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('advisor_used',False))" 2>/dev/null)
    findings_text=$(echo "$result" | python3 -c "
import sys,json
d=json.load(sys.stdin)
findings=d.get('findings') or []
if not findings:
    print('✅ No significant findings.')
else:
    for f in findings[:8]:
        sev=str(f.get('severity','?')).upper()
        lbl=f.get('label') or f.get('title','?')
        emoji={'CRITICAL':'🆘','HIGH':'🔴','MEDIUM':'🟡','LOW':'🟢','INFO':'⚪'}.get(sev,'⚪')
        print(f'{emoji} [{sev}] {lbl}')
" 2>/dev/null)

    local cat_emoji="🟡"
    case "$category" in
        SAFE)   cat_emoji="🟢" ;;
        CAUTION) cat_emoji="🟡" ;;
        DANGER) cat_emoji="🔴" ;;
    esac

    local advisor_badge=""
    if [ "$advisor_used" = "True" ] || [ "$advisor_used" = "true" ]; then
        advisor_badge="
🧠 <i>Opus advisor consulted (score in grey zone)</i>"
    fi

    local findings_section=""
    [ -n "$findings_text" ] && findings_section="
--- Findings ---
${findings_text}"

    send_message "$chat_id" "${cat_emoji} <b>Token Audit</b> — ${category} | Score: ${risk_score}/100

<code>${address}</code>${findings_section}

${summary}${advisor_badge}

<i>Full token audit (0.75 USDC): https://intmolt.org · or /upgrade</i>"

    log "Token audit done: address=$address category=$category score=$risk_score advisor=$advisor_used"
}

# ── Handler: /status — veřejný ────────────────────────────────────────────────
handle_status() {
    local chat_id="$1"

    local stats
    stats=$(curl -s --max-time 5 "http://127.0.0.1:3402/stats" 2>/dev/null)
    local total_scans=0
    if [ -n "$stats" ]; then
        total_scans=$(echo "$stats" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total_scans',0))" 2>/dev/null || echo 0)
    fi

    local service_status="🟢 Online"
    if ! curl -s --max-time 3 "http://127.0.0.1:3402/api/v1/health" &>/dev/null; then
        service_status="🔴 Offline"
    fi

    send_message "$chat_id" "📊 <b>integrity.molt status</b>

⚡ Service: ${service_status}
🔄 Total scans: <b>${total_scans}</b>
💰 Pricing: Quick 0.50 USDC | Token 0.75 USDC | Deep 5.00 USDC

🌐 Web: https://intmolt.org
📄 API: https://intmolt.org/openapi.json"
}

# ── Handler: /admin — privátní, jen ADMIN_CHAT_ID ─────────────────────────────
handle_admin() {
    local chat_id="$1"

    # Autorizace
    if [ -z "$ADMIN_CHAT_ID" ] || [ "$chat_id" != "$ADMIN_CHAT_ID" ]; then
        send_message "$chat_id" "⛔ Unauthorized"
        log "ADMIN ACCESS DENIED: chat_id=$chat_id"
        return
    fi

    local stats
    stats=$(curl -s --max-time 5 "http://127.0.0.1:3402/stats" 2>/dev/null)
    local total_scans=0
    local today_scans=0
    local paid_scans=0
    local free_scans=0
    if [ -n "$stats" ]; then
        total_scans=$(echo "$stats" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total_scans',0))" 2>/dev/null || echo 0)
        today_scans=$(echo "$stats" | python3 -c "import sys,json; print(json.load(sys.stdin).get('scans_today',0))" 2>/dev/null || echo 0)
        paid_scans=$(echo "$stats" | python3 -c "import sys,json; print(json.load(sys.stdin).get('paid_scans',0))" 2>/dev/null || echo 0)
        free_scans=$(echo "$stats" | python3 -c "import sys,json; print(json.load(sys.stdin).get('free_scans',0))" 2>/dev/null || echo 0)
    fi

    # Advisor stats (posledních 7 dní)
    local advisor_stats advisor_line="⚠️ nedostupné"
    advisor_stats=$(curl -s --max-time 5 "http://127.0.0.1:3402/api/v1/stats/advisor?days=7" 2>/dev/null)
    if [ -n "$advisor_stats" ]; then
        advisor_line=$(echo "$advisor_stats" | python3 -c "
import sys,json
d=json.load(sys.stdin).get('stats',{})
total=d.get('total_scans') or 0
adv=d.get('advisor_scans') or 0
cost=d.get('total_cost_usd') or 0
llm_cost=d.get('llm_cost_usd') or cost
pct=round(100*adv/total,0) if total else 0
print(f'{adv}/{total} scanů ({int(pct)}%) · LLM \${llm_cost:.4f} · total \${cost:.4f}')
" 2>/dev/null || echo "⚠️ parse error")
    fi

    local rpc_status="✅ OK"
    local rpc_check
    rpc_check=$(curl -s -X POST "${SOLANA_RPC_URL:-https://api.mainnet-beta.solana.com}" \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
        --max-time 5 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('result','?'))" 2>/dev/null)
    if [ "$rpc_check" != "ok" ]; then
        rpc_status="⚠️ $rpc_check"
    fi

    send_message "$chat_id" "🔧 <b>Admin panel — integrity.molt</b>

🤖 <b>Pipeline</b>
  RPC → Sonnet executor → Opus advisor

🔗 <b>RPC stav</b>: ${rpc_status}

📊 <b>Scany</b>
  Total: <b>${total_scans}</b> | Dnes: <b>${today_scans}</b>
  Placené: <b>${paid_scans}</b> | Free: <b>${free_scans}</b>

🧠 <b>Advisor (7d)</b>: ${advisor_line}"
}

# ── Handler: /verify ──────────────────────────────────────────────────────────
handle_verify() {
    local chat_id="$1"
    send_message "$chat_id" "🔐 <b>Ed25519 Report Verification</b>

Every integrity.molt report is cryptographically signed with Ed25519.

<b>Online:</b>
→ https://intmolt.org/verify.html
Paste the JSON report and the page verifies the signature in your browser.

<b>Python:</b>
<pre>pip install PyNaCl
python3 verify-report.py report.signed.json</pre>

<b>What is verified:</b>
• Report originates from integrity.molt (not forged)
• Content was not altered after signing
• The signing key (key_id) is valid

<b>Current verify key:</b>
→ https://intmolt.org/services (field <code>reportSigning.verifyKey</code>)"
}

# ── Handler: /upgrade ────────────────────────────────────────────────────────
handle_upgrade() {
    local chat_id="$1"

    local trader_url="https://intmolt.org/subscribe/pro_trader"
    local builder_url="https://intmolt.org/subscribe/builder"
    local team_url="https://intmolt.org/subscribe/team"

    send_message "$chat_id" "📈 <b>Upgrade your monitoring</b>

🔹 <b>Pro Trader (\$15/mo)</b>
   20 addresses · all alerts · Telegram + email · weekly delta reports · unlimited scans · signed reports
   💳 Card: ${trader_url}
   💰 Crypto: 15 USDC → send to address below, then /activate &lt;tx_sig&gt; pro_trader

🔹 <b>Builder (\$49/mo)</b>
   100 addresses · all alerts + webhook · daily delta reports · 1 adversarial sim/month · API access (100 req/min) · priority queue
   💳 Card: ${builder_url}
   💰 Crypto: 49 USDC → /activate &lt;tx_sig&gt; builder

🔹 <b>Team (\$299/mo)</b>
   500 addresses · custom alert rules · unlimited adversarial sim · API (1000 req/min) · SLA 99.5% · priority support
   💳 Card: ${team_url}
   💰 Crypto: 299 USDC → /activate &lt;tx_sig&gt; team

Pay USDC to: <code>HNhZiuihyLWbjH2Nm2WsEZiPGybjnRjQCptasW76Z7DY</code>
Then: <code>/activate &lt;tx_signature&gt; &lt;tier&gt;</code>"
}

# ── Handler: /evm ────────────────────────────────────────────────────────────
handle_evm() {
    local chat_id="$1"
    local user_id="$2"
    local args="$3"

    # Parsuj adresu a volitelný chain
    local address chain
    address=$(echo "$args" | awk '{print $1}')
    chain=$(echo "$args" | awk '{print $2}')
    chain="${chain:-ethereum}"

    if [ -z "$address" ]; then
        send_message "$chat_id" "❌ Provide an EVM address: <code>/evm &lt;0x_address&gt; [chain]</code>

Supported chains: ethereum · bsc · polygon · arbitrum · base
Example: <code>/evm 0xdAC17F958D2ee523a2206206994597C13D831ec7 ethereum</code>"
        return
    fi

    if ! echo "$address" | grep -qP '^0x[0-9a-fA-F]{40}$'; then
        send_message "$chat_id" "❌ Invalid EVM address. Must start with <code>0x</code> + 40 hex characters."
        return
    fi

    local valid_chains="ethereum bsc polygon arbitrum base"
    if ! echo "$valid_chains" | grep -qw "$chain"; then
        send_message "$chat_id" "❌ Unknown chain: <b>${chain}</b>
Supported: ethereum · bsc · polygon · arbitrum · base"
        return
    fi

    # Rate limit — shares limit with /scan (3/day total)
    if ! check_rate_limit "$user_id"; then
        send_message "$chat_id" "⏳ Rate limit: max 3 free scans per day.

For unlimited scans: /upgrade
→ Pro Trader \$15/mo · Builder \$49/mo · Team \$299/mo"
        return
    fi

    send_typing "$chat_id"
    send_message "$chat_id" "🔍 Starting EVM scan for:
<code>${address}</code>
Chain: <b>${chain}</b>

Checking: ownership, supply, distribution, contract verification, findings...
Preliminary results in a few seconds, full AI analysis follows shortly..."

    log "EVM scan: address=$address chain=$chain chat_id=$chat_id"

    local result
    result=$(curl -s -X POST "${SERVER_API}/internal/bot/evm" \
        -H "Content-Type: application/json" \
        -H "X-Admin-Key: ${BOT_ADMIN_KEY}" \
        --max-time 90 \
        -d "{\"address\":\"${address}\",\"chain\":\"${chain}\",\"chat_id\":\"${chat_id}\"}")

    if [ -z "$result" ]; then
        send_message "$chat_id" "❌ Server did not respond. Please try again in a moment."
        return
    fi

    local error
    error=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null)
    if [ -n "$error" ]; then
        send_message "$chat_id" "❌ EVM scan failed: ${error}"
        return
    fi

    # ── Auto-detekce chainu: pokud není bytecode, zkus ostatní chainy ────────
    local no_bytecode
    no_bytecode=$(echo "$result" | python3 -c "
import sys,json
d=json.load(sys.stdin)
findings=d.get('findings',[])
print('yes' if any(f.get('category')=='existence' for f in findings) else 'no')
" 2>/dev/null)

    if [ "$no_bytecode" = "yes" ]; then
        # Zkontroluj ostatní chainy rychle (eth_getCode přes server)
        local other_chains="ethereum bsc polygon arbitrum base"
        local found_on=""
        for try_chain in $other_chains; do
            [ "$try_chain" = "$chain" ] && continue
            local probe
            probe=$(curl -s -X POST "${SERVER_API}/internal/bot/evm" \
                -H "Content-Type: application/json" \
                -H "X-Admin-Key: ${BOT_ADMIN_KEY}" \
                --max-time 20 \
                -d "{\"address\":\"${address}\",\"chain\":\"${try_chain}\"}" 2>/dev/null)
            local probe_no_code
            probe_no_code=$(echo "$probe" | python3 -c "
import sys,json
d=json.load(sys.stdin)
findings=d.get('findings',[])
print('yes' if any(f.get('category')=='existence' for f in findings) else 'no')
" 2>/dev/null)
            if [ "$probe_no_code" = "no" ]; then
                found_on="$try_chain"
                break
            fi
        done

        if [ -n "$found_on" ]; then
            send_message "$chat_id" "⚠️ Address has no bytecode on <b>${chain}</b> — but it is a contract on <b>${found_on}</b>!

Retry with the correct chain:
<code>/evm ${address} ${found_on}</code>"
            log_scan "evm|$user_id|$chat_id|$address|$chain|wrong_chain|found_on=$found_on"
            return
        fi

        # Opravdu není kontrakt na žádném chainu — zobraz výsledek níže
    fi

    # Parsuj výsledky
    local score risk_level recommendation name symbol verified age findings_text
    score=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('score','?'))" 2>/dev/null)
    risk_level=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('risk_level') or '').lower())" 2>/dev/null)
    recommendation=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('recommendation','?'))" 2>/dev/null)
    name=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('meta',{}).get('name') or 'unknown')" 2>/dev/null)
    symbol=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('meta',{}).get('symbol') or '?')" 2>/dev/null)
    verified=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('meta',{}).get('verified','?'))" 2>/dev/null)
    age=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('meta',{}).get('ageDays'); print(v if v is not None else '?')" 2>/dev/null)
    findings_text=$(echo "$result" | python3 -c "
import sys,json
d=json.load(sys.stdin)
findings=d.get('findings',[])
if not findings:
    print('✅ No significant findings.')
else:
    for f in findings[:10]:
        sev=f.get('severity','?').upper()
        cat=f.get('category','?')
        label=f.get('label','?')
        emoji={'CRITICAL':'🆘','HIGH':'🔴','MEDIUM':'🟡','LOW':'🟢'}.get(sev,'⚪')
        print(f'{emoji} [{sev}] [{cat}] {label}')
" 2>/dev/null)

    # Emoji podle risk_level (server pole), ne podle textu recommendation
    local emoji="🟡"
    case "$risk_level" in
        safe|low)     emoji="🟢" ;;
        medium)       emoji="🟡" ;;
        high|avoid)   emoji="🔴" ;;
        critical)     emoji="🆘" ;;
    esac
    # Fallback: pokud risk_level chybí, odvoď z score
    if [ -z "$risk_level" ] && [ "$score" != "?" ]; then
        if   [ "$score" -ge 60 ] 2>/dev/null; then emoji="🔴"
        elif [ "$score" -ge 30 ] 2>/dev/null; then emoji="🟡"
        elif [ "$score" -ge 10 ] 2>/dev/null; then emoji="🟢"
        fi
    fi

    send_message "$chat_id" "${emoji} <b>EVM Token Scan</b>

📛 <b>${name}</b> (${symbol}) — ${chain}
📍 <code>${address}</code>
✅ Verified: ${verified} | 📅 Age: ${age} days

🎯 <b>Risk Score: ${score}/100</b>
📋 Doporučení: <b>${recommendation}</b>

--- Findings ---
${findings_text}

<i>Full report: https://intmolt.org · API docs: https://intmolt.org/openapi.json</i>
<i>Subscription from \$15/mo — /upgrade</i>"

    log_scan "evm|$user_id|$chat_id|$address|$chain|score=$score|risk=$risk_level|rec=$recommendation"
}

# ── Handler: /contract ────────────────────────────────────────────────────────
handle_contract() {
    local chat_id="$1"
    local user_id="$2"
    local args="$3"

    # Parsuj GitHub URL a volitelný project_name
    local github_url project_name
    github_url=$(echo "$args" | awk '{print $1}')
    project_name=$(echo "$args" | awk '{$1=""; print $0}' | xargs)

    if [ -z "$github_url" ]; then
        send_message "$chat_id" "❌ Provide a GitHub URL: <code>/contract &lt;github_url&gt; [name]</code>

Example: <code>/contract https://github.com/owner/repo MyProtocol</code>

Audit includes: cargo-audit · clippy · semgrep · AI analysis
⏱ Takes 3–10 minutes for larger repos."
        return
    fi

    if ! echo "$github_url" | grep -qP '^https?://(github\.com|gitlab\.com)/[a-zA-Z0-9_.\-]+/[a-zA-Z0-9_.\-]+'; then
        send_message "$chat_id" "❌ Invalid URL. Provide a valid GitHub or GitLab URL.
Example: <code>https://github.com/owner/repo</code>"
        return
    fi

    # Rate limit: 1 contract audit per day (shares limit with /scan)
    if ! check_rate_limit "contract_${user_id}"; then
        send_message "$chat_id" "⏳ Rate limit: max 1 contract audit per day.

For unlimited audits: /upgrade
→ Builder \$49/mo · Team \$299/mo"
        return
    fi

    send_typing "$chat_id"
    send_message "$chat_id" "🔎 Starting smart contract audit for:
<code>${github_url}</code>

Pipeline: cargo-audit → clippy → semgrep → AI verification
⏱ Takes 3–10 minutes. Will notify when done..."

    log "Contract audit: url=$github_url user=$user_id"

    local payload
    if [ -n "$project_name" ]; then
        payload="{\"github_url\":\"${github_url}\",\"project_name\":\"${project_name}\"}"
    else
        payload="{\"github_url\":\"${github_url}\"}"
    fi

    local result
    result=$(curl -s -X POST "${SERVER_API}/internal/bot/contract" \
        -H "Content-Type: application/json" \
        -H "X-Admin-Key: ${BOT_ADMIN_KEY}" \
        --max-time 660 \
        -d "$payload")

    if [ -z "$result" ]; then
        send_message "$chat_id" "❌ Server did not respond or audit exceeded the time limit."
        return
    fi

    local error
    error=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null)
    if [ -n "$error" ]; then
        send_message "$chat_id" "❌ Contract audit failed: ${error}"
        return
    fi

    local proj_name language findings_count findings_text stats_text
    proj_name=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('project_name','?'))" 2>/dev/null)
    language=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('language','?'))" 2>/dev/null)
    findings_text=$(echo "$result" | python3 -c "
import sys,json
d=json.load(sys.stdin)
findings=d.get('findings',[])
if not findings:
    print('✅ No significant findings.')
else:
    for f in findings[:12]:
        sev=f.get('severity','?').upper()
        cat=f.get('category','?')
        title=f.get('title') or f.get('label','?')
        emoji={'CRITICAL':'🆘','HIGH':'🔴','MEDIUM':'🟡','LOW':'🟢','INFO':'⚪'}.get(sev,'⚪')
        print(f'{emoji} [{sev}] {title}')
" 2>/dev/null)
    stats_text=$(echo "$result" | python3 -c "
import sys,json
d=json.load(sys.stdin)
s=d.get('stats',{})
parts=[]
if s.get('files_scanned'): parts.append(f\"Soubory: {s['files_scanned']}\")
if s.get('lines_of_code'): parts.append(f\"LOC: {s['lines_of_code']}\")
if s.get('vulnerabilities'): parts.append(f\"Vuln: {s['vulnerabilities']}\")
print(' · '.join(parts) if parts else '')
" 2>/dev/null)

    local stats_line=""
    [ -n "$stats_text" ] && stats_line="
📊 ${stats_text}"

    send_message "$chat_id" "📋 <b>Smart Contract Audit</b>

🔗 <b>${proj_name}</b> (${language})
<code>${github_url}</code>${stats_line}

--- Findings ---
${findings_text}

<i>Full audit with PDF report: https://intmolt.org · API: https://intmolt.org/openapi.json</i>
<i>Builder \$49/mo — unlimited audits → /upgrade</i>"

    log_scan "contract|$user_id|$chat_id|$github_url|done"
}

# ── Hlavní polling loop ───────────────────────────────────────────────────────
main() {
    log "Telegram bot starting (long-polling mode)"

    # Načti poslední offset
    local offset=0
    if [ -f "$OFFSET_FILE" ]; then
        offset=$(cat "$OFFSET_FILE" 2>/dev/null || echo 0)
    fi

    log "Starting with offset=$offset"

    while true; do
        # Long-polling: čekej max 30 sekund na update
        local updates
        updates=$(curl -s --max-time 35 \
            -K <(printf 'url = "https://api.telegram.org/bot%s/getUpdates?offset=%s&timeout=30&allowed_updates=%%5B%%22message%%22%%5D"' "${BOT_TOKEN}" "${offset}") \
            2>/dev/null)

        if [ -z "$updates" ]; then
            log "Empty response from Telegram API, sleeping 5s"
            sleep 5
            continue
        fi

        local ok
        ok=$(echo "$updates" | python3 -c "import sys,json; print('ok' if json.load(sys.stdin).get('ok') else 'fail')" 2>/dev/null)
        if [ "$ok" != "ok" ]; then
            log "API error: $updates"
            sleep 10
            continue
        fi

        # Zpracuj každý update
        local count
        count=$(echo "$updates" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',[])))" 2>/dev/null || echo 0)

        if [ "$count" -gt 0 ]; then
            log "Processing $count updates"

            while IFS='|' read -r update_id chat_id user_id text; do
                [ -z "$update_id" ] && continue
                [ -z "$chat_id" ] && continue

                log "Update $update_id: chat=$chat_id user=$user_id text='${text:0:80}'"

                # Extrahuj příkaz a argument
                local cmd arg
                cmd=$(echo "$text" | awk '{print $1}' | tr '[:upper:]' '[:lower:]')
                arg=$(echo "$text" | awk '{$1=""; print $0}' | xargs)

                case "$cmd" in
                    /start|/help)
                        handle_help "$chat_id" "$user_id" &
                        ;;
                    /scan)
                        # Pokud není argument, hledej adresu v textu
                        if [ -z "$arg" ]; then
                            arg=$(echo "$text" | grep -oP '[1-9A-HJ-NP-Za-km-z]{32,44}' | head -1)
                        fi
                        handle_scan "$chat_id" "$user_id" "$arg" &
                        ;;
                    /token)
                        if [ -z "$arg" ]; then
                            arg=$(echo "$text" | grep -oP '[1-9A-HJ-NP-Za-km-z]{32,44}' | head -1)
                        fi
                        handle_token "$chat_id" "$user_id" "$arg" &
                        ;;
                    /evm)
                        handle_evm "$chat_id" "$user_id" "$arg" &
                        ;;
                    /contract)
                        handle_contract "$chat_id" "$user_id" "$arg" &
                        ;;
                    /status)
                        handle_status "$chat_id" &
                        ;;
                    /admin)
                        handle_admin "$chat_id" &
                        ;;
                    /verify)
                        handle_verify "$chat_id" &
                        ;;
                    /upgrade)
                        handle_upgrade "$chat_id" &
                        ;;
                    *)
                        # Pokud zpráva obsahuje Solana adresu, scan automaticky
                        local auto_addr
                        auto_addr=$(echo "$text" | grep -oP '[1-9A-HJ-NP-Za-km-z]{32,44}' | head -1)
                        if [ -n "$auto_addr" ]; then
                            send_message "$chat_id" "🔍 Detected Solana address — starting scan...
Or use <code>/scan ${auto_addr}</code> explicitly."
                            handle_scan "$chat_id" "$user_id" "$auto_addr" &
                        fi
                        ;;
                esac

                offset=$((update_id + 1))
            done < <(echo "$updates" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for u in data.get('result', []):
    uid = u.get('update_id', 0)
    msg = u.get('message', {})
    chat_id = msg.get('chat', {}).get('id', '')
    user_id = msg.get('from', {}).get('id', '')
    text = (msg.get('text') or '').strip().replace('|', ' ')
    print(f'{uid}|{chat_id}|{user_id}|{text}')
")

            # Ulož offset
            echo "$offset" > "$OFFSET_FILE"
        fi

        # Throttle při prázdných updatech
        sleep 1
    done
}

main
