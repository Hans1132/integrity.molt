#!/bin/bash
# install.sh — idempotent installer for moltbot Telegram control bot.
# Run as root. Safe to re-run.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR=/opt/moltbot
ETC_DIR=/etc/moltbot
RUN_DIR=/var/run/moltbot
SYSTEMD_DIR=/etc/systemd/system
USER=moltbot
GROUP=moltbot
READERS=moltbook-readers
HEARTBEAT=/root/heartbeat.sh
MARKER=/var/run/moltbot/last-heartbeat
LLM_CONF=$ETC_DIR/llm-config.env

say() { printf '[install] %s\n' "$*"; }

if [[ "$(id -u)" -ne 0 ]]; then
    echo "must be run as root" >&2
    exit 1
fi

# 1. user + group
if ! id "$USER" >/dev/null 2>&1; then
    say "creating system user $USER"
    useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" --no-create-home "$USER"
fi
if ! getent group "$READERS" >/dev/null 2>&1; then
    say "creating group $READERS"
    groupadd "$READERS"
fi
if ! id -nG "$USER" | tr ' ' '\n' | grep -qx "$READERS"; then
    say "adding $USER to $READERS"
    usermod -aG "$READERS" "$USER"
fi

# 2. directories
for d in "$APP_DIR" "$ETC_DIR" "$RUN_DIR"; do
    if [[ ! -d "$d" ]]; then
        say "creating $d"
        mkdir -p "$d"
    fi
done
chown -R "$USER:$GROUP" "$APP_DIR" "$RUN_DIR"
chown "$USER:$GROUP" "$ETC_DIR"
chmod 0750 "$APP_DIR" "$ETC_DIR" "$RUN_DIR"

# 3. copy source (excluding venv if already present)
say "copying source files"
rsync -a --delete \
    --exclude 'venv' \
    --exclude '__pycache__' \
    --exclude '.git' \
    --exclude 'systemd' \
    --exclude 'etc' \
    --exclude 'install.sh' \
    --exclude 'README.md' \
    --exclude '.env' \
    --exclude '.env.example' \
    "$SRC_DIR/" "$APP_DIR/"
# Carry templates separately so the destination tree is exactly what main.py expects.
install -m 0644 "$SRC_DIR/.env.example" "$APP_DIR/.env.example"
install -m 0644 "$SRC_DIR/README.md" "$APP_DIR/README.md"
install -m 0644 "$SRC_DIR/requirements.txt" "$APP_DIR/requirements.txt"

# 4. venv
if [[ ! -x "$APP_DIR/venv/bin/python" ]]; then
    say "creating venv"
    python3 -m venv "$APP_DIR/venv"
fi
say "installing requirements"
"$APP_DIR/venv/bin/pip" install --quiet --upgrade pip
"$APP_DIR/venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

chown -R "$USER:$GROUP" "$APP_DIR"

# 4b. configure git safe.directory for moltbot user so /refreshidentity's
# rev-parse can read /root/x402-server's .git (owned by root, accessed by moltbot)
say "configuring git safe.directory for $USER"
sudo -u "$USER" HOME="$APP_DIR" git config --global --add safe.directory /root/x402-server 2>/dev/null || true

# 5. /etc/moltbot defaults (don't overwrite if operator edited)
if [[ ! -f "$LLM_CONF" ]]; then
    say "writing default $LLM_CONF"
    install -m 0644 -o "$USER" -g "$GROUP" "$SRC_DIR/etc/llm-config.env" "$LLM_CONF"
fi
install -m 0644 -o "$USER" -g "$GROUP" "$SRC_DIR/etc/allowed-models.txt" "$ETC_DIR/allowed-models.txt"

# 6. scanner read access for moltbot group
# Trade-off: granting group traverse on /root is the cleanest fix.
# Alternative would be bind-mounting /root/scanner under /var/lib/, more invasive.
if [[ -d /root/scanner ]]; then
    root_mode=$(stat -c '%a' /root)
    if [[ "$root_mode" == "700" ]]; then
        say "granting $READERS group traverse on /root (700 -> 710)"
        chgrp "$READERS" /root
        chmod g+x /root
    fi
    say "granting $READERS group read on /root/scanner"
    chgrp -R "$READERS" /root/scanner
    find /root/scanner -type d -exec chmod g+rx {} \;
    find /root/scanner -type f -exec chmod g+r {} \;
fi
if [[ -f /root/.secrets/moltbook_api_key ]]; then
    say "granting $READERS group read on moltbook_api_key"
    # /root/.secrets itself is 700 — also needs g+x traverse for the group.
    secrets_mode=$(stat -c '%a' /root/.secrets)
    if [[ "$secrets_mode" == "700" ]]; then
        say "granting $READERS group traverse on /root/.secrets (700 -> 710)"
        chgrp "$READERS" /root/.secrets
        chmod g+x /root/.secrets
    fi
    chgrp "$READERS" /root/.secrets/moltbook_api_key
    chmod 0640 /root/.secrets/moltbook_api_key
fi

# 7. patch heartbeat.sh (idempotent — only insert if marker absent)
if [[ -f "$HEARTBEAT" ]]; then
    if ! grep -q 'moltbot integration' "$HEARTBEAT"; then
        say "patching $HEARTBEAT (insert llm-config source + marker touch)"
        cp -p "$HEARTBEAT" "$HEARTBEAT.pre-moltbot.bak"
        tmp=$(mktemp)
        {
            head -n 1 "$HEARTBEAT"
            cat <<PATCH

# --- moltbot integration (added by install.sh) ---
source /etc/moltbot/llm-config.env 2>/dev/null || true
mkdir -p /var/run/moltbot 2>/dev/null || true
touch $MARKER 2>/dev/null || true
chown moltbot:moltbot $MARKER 2>/dev/null || true
# --- end moltbot integration ---
PATCH
            tail -n +2 "$HEARTBEAT"
        } > "$tmp"
        chmod --reference="$HEARTBEAT" "$tmp"
        chown --reference="$HEARTBEAT" "$tmp"
        mv "$tmp" "$HEARTBEAT"
    else
        say "$HEARTBEAT already patched"
    fi
else
    say "WARNING: $HEARTBEAT not present — skip patching"
fi

# 7b. scaffold docs/IDENTITY.md if missing
if [[ -d /root/x402-server/docs ]] && [[ ! -f /root/x402-server/docs/IDENTITY.md ]]; then
    say "scaffolding /root/x402-server/docs/IDENTITY.md (operator must review + git commit + push)"
    install -m 0644 "$SRC_DIR/etc/IDENTITY.md.template" /root/x402-server/docs/IDENTITY.md
fi

# 7c. bootstrap /etc/moltbot/identity.env from local docs/IDENTITY.md if missing
if [[ ! -f /etc/moltbot/identity.env ]] && [[ -f /root/x402-server/docs/IDENTITY.md ]]; then
    say "parsing local docs/IDENTITY.md → /etc/moltbot/identity.env"
    PYTHONPATH="$APP_DIR" "$APP_DIR/venv/bin/python" -c "
from lib.parse_identity import parse, to_env
import datetime as dt
md = open('/root/x402-server/docs/IDENTITY.md').read()
env = to_env(parse(md), 'bootstrap', dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
open('/etc/moltbot/identity.env','w').write(env)
import os; os.chmod('/etc/moltbot/identity.env', 0o644)
"
    chown moltbot:moltbot /etc/moltbot/identity.env
fi

# 8. systemd units
for unit in moltbot.service \
            moltbot-heartbeat-trigger.path moltbot-heartbeat-runner.service \
            moltbot-identity-pull-trigger.path moltbot-identity-pull-runner.service; do
    src="$SRC_DIR/systemd/$unit"
    dst="$SYSTEMD_DIR/$unit"
    if ! cmp -s "$src" "$dst" 2>/dev/null; then
        say "installing $unit"
        install -m 0644 "$src" "$dst"
    fi
done
say "systemctl daemon-reload"
systemctl daemon-reload
say "enabling moltbot-heartbeat-trigger.path"
systemctl enable --now moltbot-heartbeat-trigger.path
say "enabling moltbot-identity-pull-trigger.path"
systemctl enable --now moltbot-identity-pull-trigger.path

cat <<EOF

[install] done.

next steps:
  1. cp $APP_DIR/.env.example $APP_DIR/.env
  2. edit $APP_DIR/.env — set TELEGRAM_BOT_TOKEN and AUTHORIZED_USER_ID
  3. chown $USER:$GROUP $APP_DIR/.env && chmod 0600 $APP_DIR/.env
  4. systemctl enable --now moltbot.service
  5. journalctl -u moltbot.service -f      # watch startup
EOF
