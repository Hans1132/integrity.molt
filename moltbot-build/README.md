# moltbot

Private Telegram control bot for the `integrity_molt` moltbook agent.
Replaces the openclaw Telegram channel with a small, non-root, polling-only Python service.

## What it does

- `/status` — bot uptime, last `heartbeat.sh` timestamp, x402 health, current LLM model, today's scan-report count
- `/posts [N]` — show latest N posts by `u/integrity_molt` (default 5, max 20)
- `/report [YYYY-MM-DD]` — fetch the daily transparency report for that date (default today UTC)
- `/scan <mint>` — call `http://127.0.0.1:3402/scan/iris?token=<mint>` (free, loopback-exempt)
- `/model` / `/model list` / `/model set <name>` — read/list/switch the model heartbeat.sh uses
- `/run-now` — trigger `/root/heartbeat.sh` via a systemd path-unit (no sudo)
- `/logs [N]` — tail moltbot's own journal (default 20, max 100)

All commands are gated by a single-user whitelist (`AUTHORIZED_USER_ID`). Other users get silent reject + log line.

## Architecture

```
Telegram  ← polling →  moltbot.service (user moltbot)
                              │
                              │ touch trigger file
                              ▼
              /var/run/moltbot/trigger-heartbeat
                              │
                              ▼  (systemd path unit watches)
              moltbot-heartbeat-runner.service (root, oneshot)
                              │
                              ▼
                       /root/heartbeat.sh
```

Why path-unit, not sudo: keeps `NoNewPrivileges=true` on the bot's service, no setuid escalation in the bot's tree, narrow contract (one file, one effect).

## Install

Run as root from the unpacked tree:

```bash
./install.sh
cp /opt/moltbot/.env.example /opt/moltbot/.env
$EDITOR /opt/moltbot/.env                                # TELEGRAM_BOT_TOKEN, AUTHORIZED_USER_ID
chown moltbot:moltbot /opt/moltbot/.env && chmod 0600 /opt/moltbot/.env
systemctl enable --now moltbot.service
journalctl -u moltbot.service -f
```

`install.sh` is idempotent — re-run after pulling code updates.

## File layout

```
/opt/moltbot/             — Python source, venv, .env
/etc/moltbot/             — llm-config.env (writable by moltbot), allowed-models.txt
/var/run/moltbot/         — trigger-heartbeat, last-heartbeat
/etc/systemd/system/      — three units (moltbot.service, …-trigger.path, …-runner.service)
```

## Permissions model

- `moltbot` user owns `/opt/moltbot/` and `/etc/moltbot/llm-config.env`
- `moltbook-readers` group has read on `/root/scanner/` (recursive) and `/root/.secrets/moltbook_api_key`
- `moltbot` is a member of `moltbook-readers`
- No write access anywhere under `/root/` from the bot's service (enforced by systemd `ReadWritePaths=`)

### Heads-up: `/root` traversal

Because the scanner files live under `/root/`, the installer relaxes `/root` from `700` to `710` (group-traverse only, no list, no read) so the moltbot user can `cd` into `/root/scanner/`. The same is done for `/root/.secrets/`. **Effect:** any process in the `moltbook-readers` group can `stat` files under `/root` if it knows the exact filename, but cannot enumerate. If this is unacceptable, edit `install.sh` step 6 to bind-mount `/root/scanner` and `/root/.secrets/moltbook_api_key` under `/var/lib/moltbot/` instead.

## Heartbeat integration

`install.sh` patches `/root/heartbeat.sh` once (idempotently) to:

1. `source /etc/moltbot/llm-config.env` — so `MOLTBOT_LLM_MODEL` overrides the model literal
2. `touch /var/run/moltbot/last-heartbeat` — so `/status` can show freshness

A `.pre-moltbot.bak` snapshot of the original `heartbeat.sh` is kept next to it.

**Note:** `heartbeat.sh` currently hard-codes `"model": "google/gemini-2.5-flash"` inside `call_openrouter()`. To make `/model set` effective, you must also edit the script body to replace the literal with `"${MOLTBOT_LLM_MODEL:-google/gemini-2.5-flash}"` in each of the four call sites — installer does not touch the body to avoid breaking the script.

## Out of scope

Multi-user, webhook mode, database, wallet signing, paid x402 scans, Discord/Slack/etc., posting to moltbook (heartbeat.sh keeps that role).

## Uninstall

```bash
systemctl disable --now moltbot.service moltbot-heartbeat-trigger.path
rm /etc/systemd/system/moltbot.service /etc/systemd/system/moltbot-heartbeat-*.{path,service}
systemctl daemon-reload
rm -rf /opt/moltbot /etc/moltbot /var/run/moltbot
userdel moltbot
groupdel moltbook-readers      # only if no other consumer
mv /root/heartbeat.sh.pre-moltbot.bak /root/heartbeat.sh
```
