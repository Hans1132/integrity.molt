# OpenClaw deployment audit — 2026-05-22

Read-only forensic snapshot of the openclaw stack on this VPS. No processes touched, no files modified. Sensitive values redacted (`first4...last4`).

## Audit-scope correction (read first)

Task description assumed code at `/root/openclaw/`. **That path does not exist.** Actual layout discovered:

| Component                 | Path                                          | Size  |
|---------------------------|-----------------------------------------------|-------|
| openclaw npm package (installed) | `/usr/lib/node_modules/openclaw/`        | 1.4 G |
| openclaw CLI symlink      | `/usr/bin/openclaw` → above                   | —     |
| openclaw user data        | `/root/.openclaw/`                            | 1.5 M |
| Agent workspace (`clawd`) | `/root/clawd/` (also referenced as workspace) | 188 K |
| Local `intmolt` clone     | `/root/intmolt/`                              | 132 K (out of scope) |
| Local `integrity.molt`    | `/root/integrity.molt/`                       | 6.3 M (out of scope) |
| Production backend        | `/root/x402-server/`                          | (separate workload) |

Audit scoped to the four openclaw-related paths plus cross-checks against `/root/x402-server/`.

---

## 1. Filesystem inventory — `NOTE`

### 1.1 Installed package `/usr/lib/node_modules/openclaw/`

`package.json` highlights:
- `name`: openclaw
- `version`: 2026.3.8
- `description`: Multi-channel AI gateway with extensible messaging integrations
- `bin`: `openclaw → openclaw.mjs`
- `main`: `dist/index.js`
- `type`: module
- `repository`: github.com/openclaw/openclaw
- `license`: MIT
- Plugin SDK exports: `telegram`, `discord`, `slack`, `signal`, `imessage`, `whatsapp`, `line`, `msteams`

Top-level `dependencies` (depth 0, partial — `npm ls --depth=0` reported **6 UNMET DEPENDENCY** entries):

```
@agentclientprotocol/sdk@0.15.0
@aws-sdk/client-bedrock@3.1004.0
@buape/carbon@0.0.0-beta-20260216184201
@clack/prompts@1.1.0
@discordjs/voice@0.19.0
@grammyjs/runner@2.0.3
@grammyjs/transformer-throttler@1.2.1
@grammyjs/types@3.25.0
@homebridge/ciao@1.3.5
@larksuiteoapi/node-sdk@1.59.0
@line/bot-sdk@10.6.0
@lydell/node-pty@1.2.0-beta.3
@mariozechner/pi-agent-core@0.57.1
@mariozechner/pi-ai@0.57.1
@mariozechner/pi-coding-agent@0.57.1
@mariozechner/pi-tui@0.57.1
@mozilla/readability@0.6.0
@napi-rs/canvas@0.1.96
@sinclair/typebox@0.34.48
@slack/bolt@4.6.0
@slack/web-api@7.14.1
@whiskeysockets/baileys@7.0.0-rc.9
ajv@8.18.0
chalk@5.6.2
chokidar@5.0.0
cli-highlight@2.1.11
commander@14.0.3
croner@10.0.1
discord-api-types@0.38.41
dotenv@17.3.1
[... output truncated by audit ...]

UNMET DEPENDENCY @lit-labs/signals@^0.2.0
UNMET DEPENDENCY @lit/context@^1.1.6
UNMET DEPENDENCY @types/markdown-it@^14.1.2
UNMET DEPENDENCY @types/qrcode-terminal@^0.12.2
UNMET DEPENDENCY @typescript/native-preview@7.0.0-dev.20260308.1
UNMET DEPENDENCY @vitest/coverage-v8@^4.0.18
```

The unmet entries are mostly dev/UI deps; gateway process runs fine without them, but the install is technically broken (a future `npm rebuild` could fail).

### 1.2 User data `/root/.openclaw/` (mode `drwx------`, root)

```
openclaw.json                (7.5 K, last touched 2026-03-20)
openclaw.json.bak[.1..4]     (5 historical config snapshots)
node.json                    (186 B)
update-check.json            (189 B, last touched 2026-05-22 23:12)
identity/device.json
identity/device-auth.json
devices/paired.json
devices/pending.json
cron/jobs.json
delivery-queue/failed/       (empty)
telegram/command-hash-default-b36f26ce4938c53e.txt
skills/metaplex -> ../../.agents/skills/metaplex   (symlink)
skills/solana-skills-plugin/  (SKILL.md + .skillfish.json)
memory/main.sqlite
canvas/index.html
agents/main/sessions/        (per-session jsonl logs + .reset rotations)
agents/main/agent/auth-profiles.json
workspace/                   (HEARTBEAT.md, BOOTSTRAP.md, IDENTITY.md, SOUL.md, TOOLS.md, USER.md, AGENTS.md, .git, .openclaw/workspace-state.json)
logs/config-audit.jsonl      (5.3 K, last write 2026-03-16)
```

### 1.3 `openclaw.json` (top-level key shape, secrets redacted)

| Key path | Value (redacted) |
|---|---|
| `meta.lastTouchedVersion` | `2026.3.8` |
| `meta.lastTouchedAt` | `2026-03-16T22:48:55Z` |
| `auth.profiles.openai:default.{provider,mode}` | `openai`, `api_key` |
| `auth.profiles.openrouter:default.{provider,mode}` | `openrouter`, `api_key` |
| `models.providers.openai.baseUrl` | `https://openrouter.ai/api/v1` |
| `models.providers.openai.apiKey` | `sk-o...2e91` (REDACTED, len 73) |
| `models.providers.openrouter.apiKey` | `sk-o...2e91` (REDACTED, len 73) — **same key as openai profile** |
| `models.providers.openrouter.models[]` | 7 models incl. `anthropic/claude-sonnet-4-5`, `claude-sonnet-4`, `claude-haiku-4-5`, `openai/gpt-4o`, `gpt-4o-mini`, `google/gemini-2.5-flash`, `deepseek/deepseek-chat` |
| `agents.defaults.model.primary` | `openai/gpt-4o-mini` |
| `agents.defaults.workspace` | `/root/clawd/workspace` |
| `agents.list[0].id` | `main` |
| `agents.list[0].identity.name` | `integrity.molt Agent` |
| `agents.list[0].identity.theme` | `molt.id autonomous agent` |
| `agents.list[0].identity.emoji` | `🦞` |
| `channels.telegram.enabled` | `true` |
| `channels.telegram.dmPolicy` | `open` |
| `channels.telegram.botToken` | `8601...wKdw` (REDACTED, len 46) |
| `channels.telegram.groupPolicy` | `allowlist` |
| `channels.telegram.webhookUrl` | `https://intmolt.org/telegram-webhook` |
| `channels.telegram.webhookSecret` | `de3a...66ca` (REDACTED, len 64) |
| `channels.telegram.webhookPath` | `/telegram-webhook` |
| `channels.telegram.webhookHost` | `0.0.0.0` |
| `channels.telegram.webhookPort` | `8787` |
| `gateway.port` | `18789` |
| `gateway.mode` | `local` |
| `gateway.bind` | `lan` |
| `gateway.controlUi.allowInsecureAuth` | **`true`** |
| `gateway.controlUi.dangerouslyDisableDeviceAuth` | **`true`** |
| `gateway.auth.mode` | `token` |
| `gateway.auth.token` | `8b5e...d894` (REDACTED, len 64) |
| `skills.load.watch` | `true` |
| URL `https://multiclaw.moltid.workers.dev` is whitelisted somewhere in config (line 221) | |

`NOTE` — config last touched 2026-03-20; never updated when the bot token rotated/expired (see §6).

### 1.4 Identity files

`/root/.openclaw/identity/device.json` (mode 600):
- `version`: 1
- `deviceId`: `036614...4542` (32-byte hex, len 64)
- `publicKeyPem`: PEM, len 113 (single-line redacted view)
- `privateKeyPem`: PEM, len 119 (REDACTED)
- `createdAtMs`: 1773076222384 (2026-03-05)

`/root/.openclaw/identity/device-auth.json`:
- `tokens.node.token`: `8uz_Fv...-q8I` (len 43)
- `tokens.operator.token`: `h4TF-K...87MA` (len 43)
- Both bound to `deviceId` `036614...4542`.

`/root/.openclaw/devices/paired.json` — single pairing:
- key: `036614...4542`
- `displayName`: `integrity.molt`
- `clientId`: `node-host`
- `clientMode`: `node`
- `role`: `node`
- Public key Ed25519 base64-ish, len 43.

### 1.5 README / BOOTSTRAP / HEARTBEAT (workspace)

`workspace/HEARTBEAT.md` (first 40 lines) is the **authoritative behavioral spec** for the moltbook bot. Key excerpts:

```
# Periodic tasks for the moltbook agent (integrity_molt).
# Runs via heartbeat-secure.sh every 30 minutes.
# Agent identity: integrity_molt on moltbook | integrity.molt on Solana (molt.id)
# Core asset: 2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy
# A2A endpoint: POST https://intmolt.org/a2a (JSON-RPC 2.0)

## Active tasks
### 1. Reply to comments on own posts ...
### 2. Feed engagement (upvote 3, comment on 1) ...
### 3. Token audit outreach (up to 3 DMs/day, $0.75 USDC) ...

## Identity context (for AI prompts)
- Moltbook username: integrity_molt
- Website: https://intmolt.org
- Signed receipts: Ed25519, verifiable at https://intmolt.org/jwks.json
- Free skills: quick_scan, scan_address, verify_receipt, new_spl_feed, program_verification_status
- Paid skills: agent_token_scan ($0.15), governance_change ($0.15), token_audit ($0.75),
  wallet_profile ($0.75), adversarial_sim ($4.00), deep_audit ($5.00)
```

`BOOTSTRAP.md` and `IDENTITY.md` are **template files** ("you just woke up", "fill this in") — they were not edited; identity is in `openclaw.json` and `HEARTBEAT.md` instead.

`/root/clawd/workspace/HEARTBEAT.md` is a near-duplicate of the `.openclaw/workspace/` one. `clawd` looks like a parallel/legacy workspace tree that the running gateway treats as primary (`agents.defaults.workspace = /root/clawd/workspace`).

---

## 2. Process and service — `OK` (with notes)

### 2.1 Process snapshot

| Field | Value |
|---|---|
| PID | 19934 |
| PPID | 19921 (`/usr/lib/systemd/systemd --user`) |
| User | root |
| cmdline | `openclaw-gateway` (argv0 only; real executable is node) |
| exe | `/usr/bin/node` |
| cwd | `/root` |
| State | `Ssl` (sleeping, waiting in `ep_poll`) |
| Elapsed | 19d 00h 38m |
| CPU consumed | 5d 13h 27m (avg **29%**, matches snapshot) |
| %CPU now | 29.1 |
| %MEM now | 36.1 |
| Threads | 11 |
| VmRSS | 1.49 GB |
| VmSwap | 119 MB (peak 747 MB per systemd accounting) |
| VmPeak | 23.8 GB (virtual; not resident) |
| Open files limit | 1,048,576 |
| Max processes limit | 15,360 |
| Lock file | `/tmp/openclaw-0/gateway.a504a3cd.lock` (fd 22) |
| Children | **none** (no `ps --ppid 19934` rows; 11 threads, 0 subprocs) |

`NOTE` — the user-supplied "120% CPU sustained" did not reproduce; current and 19-day-average is ~29%. The number may have come from a transient `top` sample during a Telegram retry burst, or from a different reporting tool.

### 2.2 Systemd unit (user-level)

No system-wide unit exists for openclaw. The process is managed by **per-user systemd as root**:

```
Unit file: /root/.config/systemd/user/openclaw-gateway.service
Loaded:    enabled, active (running) since 2026-05-03 23:11:04 UTC
Cgroup:    /user.slice/user-0.slice/user@0.service/app.slice/openclaw-gateway.service
ExecStart: /usr/bin/node /usr/lib/node_modules/openclaw/dist/index.js gateway --port 18789
Restart=always, RestartSec=5, KillMode=control-group
Environment=OPENROUTER_API_KEY=sk-or-v1-7c7f...8262e91   ← plaintext in unit file
```

A second unit `openclaw-node.service` exists in unit-files (disabled, not running).

`RISK (low)` — the OpenRouter API key is **persisted in plaintext in three places**: the systemd unit (mode of `~/.config/systemd/user/*` not separately checked), the process environment (readable by root only via `/proc/<pid>/environ`), and `openclaw.json` (mode 600, root). Any one disclosure leaks a usable LLM-billing credential.

### 2.3 Open file descriptors (28 total)

- `1`, `2` → socket `[68021]` (systemd journal stream)
- `21`, `26`, `27` → listening TCP sockets (see §3)
- `24`, `25` → UDP 5353 mDNS sockets (`@homebridge/ciao` zeroconf library)
- `22` → `/tmp/openclaw-0/gateway.a504a3cd.lock`
- Multiple `anon_inode:[eventpoll|io_uring|eventfd]` and pipe pairs (libuv internals)
- `0` → `/dev/null`
- **Zero descriptors under `/root/x402-server`** (grep `x402` → no hits)

---

## 3. Network surface — `OK` (firewall covers the public bind)

### 3.1 Sockets owned by PID 19934

| Proto | Bind | Port | Notes |
|---|---|---|---|
| TCP LISTEN | `127.0.0.1` | `18791` | loopback only — internal IPC |
| TCP LISTEN | `127.0.0.1` | `18792` | loopback only — internal IPC |
| TCP LISTEN | **`0.0.0.0`** | **`18789`** | gateway port — bound to all interfaces |
| UDP UNCONN | `0.0.0.0` | `5353` | mDNS (zeroconf, `ciao`) — two sockets |

No outbound ESTABLISHED connections were observed during the audit window (Telegram polling uses short-lived HTTPS that closes between samples).

### 3.2 Firewall

`ufw status verbose`:

```
Status: active
Default: deny (incoming), allow (outgoing)
Allowed inbound: 22/tcp, 80/tcp, 443/tcp (v4 + v6)
```

`iptables` INPUT policy DROP; UFW chains enforce the same. The DROP packet counter (`533K, 34M`) confirms active scrubbing.

**Conclusion:** port `18789` and UDP `5353` are bound to `0.0.0.0` but **not reachable from the internet** — UFW silently drops anything that's not 22/80/443. Inside the host (e.g. via SSH tunnel or a compromised colocated process) they are reachable.

### 3.3 External endpoints referenced (from grep over configs)

- `https://intmolt.org/telegram-webhook` — webhook for Telegram updates
- `https://intmolt.org/a2a` — A2A JSON-RPC endpoint (called from `HEARTBEAT.md`)
- `https://intmolt.org/jwks.json` — public-key advertisement
- `https://multiclaw.moltid.workers.dev` — Cloudflare worker relay (line 221 of `openclaw.json`; cross-referenced from `x402-server/server.js:1392, 1528`)
- `https://app.molt.id/integrity` — moltbook profile (referenced in `x402-server/server.js:1403, 1527`)
- `https://openrouter.ai/api/v1` — LLM provider
- `https://www.moltbook.com/api/v1` — moltbook REST API (consumed by `/root/heartbeat.sh`, **not** by the openclaw process)
- Telegram API (api.telegram.org) — used by gateway

---

## 4. Identity, keys, integration with molt.id & integrity.molt — `NOTE`

### 4.1 Address grep (case-sensitive, exact strings)

| String | Hits |
|---|---|
| `BFmkPKu2tS9RoMufgJUd9GyabzC91hriAbMS6Hmr8TX6` (Asset Signer PDA) | **0 hits** in `/root/.openclaw/`, `/usr/lib/node_modules/openclaw/`, `/root/clawd/`, `/root/.agents/` |
| `2tWPw22bqgLaLdYCwe7599f7guQudwKpCCta4gvhgZZy` (Core NFT asset) | 2 hits — `/root/.openclaw/workspace/HEARTBEAT.md:6`, `/root/clawd/workspace/HEARTBEAT.md:6` (both header comments, identical) |
| `HNhZiuihyLWbjH2Nm2WsEZiPGybjnRjQCptasW76Z7DY` (owner) | Several hits — all inside one historical session log `agents/main/sessions/7b0329cc-*.jsonl.reset.2026-05-06T*.jsonl` where the agent was asked by the user to *scan that wallet* (the address is the scan target, not a key holder for openclaw) |

### 4.2 Identity & branding string grep (`openclaw.json`, `identity/`, `devices/`, `agents/`)

```
openclaw.json:185: "name": "integrity.molt Agent"
openclaw.json:186: "theme": "molt.id autonomous agent"
openclaw.json:208: "webhookUrl": "https://intmolt.org/telegram-webhook"
openclaw.json:221:        "https://multiclaw.moltid.workers.dev"
devices/paired.json:50:   "displayName": "integrity.molt"
```

### 4.3 Keypair files found

| Path | Size | Mode | Owner | Form |
|---|---|---|---|---|
| `/root/.openclaw/identity/device.json` | (small JSON) | 600 | root | PEM-encoded Ed25519 (?) `publicKeyPem` + `privateKeyPem` |
| `/root/.openclaw/identity/device-auth.json` | (small JSON) | 600 | root | Opaque bearer tokens (node + operator), 43-char base64ish |

**No** Solana keypair JSON (64-byte byte-array shape), no `id.json`, no `*.pem` standalone, no `*.key`, no `mnemonic*` file. The openclaw device keys are for the openclaw control protocol — they are **not** Solana wallets.

### 4.4 Cross-check: does `x402-server` reference openclaw keys or process?

Grep over `/root/x402-server/` (excluding `node_modules`):

```
server.js:1387: ## A2A Relay (via moltbook)
server.js:1389: Agents in the molt.id ecosystem can also call integrity.molt via the moltbook relay:
server.js:1392: POST https://multiclaw.moltid.workers.dev/c/integrity/a2a
server.js:1403: - **moltbook profile:** https://app.molt.id/integrity
server.js:1527:       moltbook:     'https://app.molt.id/integrity',
server.js:1528:       a2a_relay:    'https://multiclaw.moltid.workers.dev/c/integrity/a2a',
```

The only crossover is the **public** A2A relay URL (which is hosted on Cloudflare Workers, not on this VPS) — i.e. integrity.molt advertises that agents can reach it via the moltbook relay. **There is no reference to any openclaw filename, keypair, port, or process from x402-server.**

Grep for openclaw paths/ports in `x402-server/.env`, `server.js`, `config/`, and `/etc/systemd/system/integrity*.service`:

```
(no hits to '.openclaw', 'openclaw-gateway', '18789', '18791', '18792')
```

(Substring-collision hits to "18789" inside `/root/x402-server/data/scam-datasets/solrpds_*.csv` are unrelated — they appear in Solana base58 addresses and transaction signatures.)

### 4.5 Key-fingerprint comparison

The integrity.molt receipt-signer key (kid `integrity-molt-primary-2026`) lives in `/root/x402-server/src/crypto/` and is loaded by `server.js`. The openclaw device key is the `publicKeyPem`/`privateKeyPem` pair in `/root/.openclaw/identity/device.json` (PEM, 113/119 chars). **Their on-disk encodings differ (Ed25519 raw vs PEM) and the openclaw key is sized for a different purpose (device-pairing protocol).** A bit-level fingerprint comparison was not performed because (a) the audit is read-only redact-on-print, and (b) format mismatch already makes accidental reuse unlikely.

### 4.6 Does the Asset Signer PDA (`BFmkPKu2tS9...`) appear in openclaw tx code?

No hits anywhere under `/root/.openclaw/`, `/usr/lib/node_modules/openclaw/`, or `/root/clawd/`. Openclaw does not sign or send Solana transactions — it only invokes shell tools (e.g. `/root/scanner/quick-scan.sh`) and HTTP endpoints.

---

## 5. Skills, plugins, hooks — `NOTE` (one suspicious log line)

### 5.1 User-installed skills `/root/.openclaw/skills/`

| Name | Source | Entry | Notes |
|---|---|---|---|
| `metaplex` | symlink → `/root/.agents/skills/metaplex/` | `SKILL.md` (8.2 K) + `references/` | Shared with whatever uses `/root/.agents/` |
| `solana-skills-plugin` | local copy, mode 700 | `SKILL.md` (10 K) + `.skillfish.json` (249 B) | Last touched 2026-05-12 |

No explicit permission declarations in either skill manifest (skim of `SKILL.md` files — full content not redumped here).

### 5.2 Skills shipped inside the npm package `/usr/lib/node_modules/openclaw/skills/`

54 directories. Sample (alphabetical): `1password, apple-notes, apple-reminders, bear-notes, blogwatcher, blucli, bluebubbles, camsnap, canvas, clawhub, coding-agent, discord, eightctl, gemini, gh-issues, gifgrep, github, gog, goplaces, healthcheck, himalaya, imsg, mcporter, model-usage, nano-banana-pro, nano-pdf, notion, obsidian, openai-image-gen, openai-whisper, openai-whisper-api, openhue, oracle, ordercli, peekaboo, sag, session-logs ...`

The **`coding-agent`** skill is the one that exec'd `/root/scanner/quick-scan.sh` in the historical session log — i.e. it grants the LLM unrestricted shell exec.

### 5.3 Hooks

`/root/.openclaw/cron/jobs.json` exists (not parsed here — file is openclaw's internal cron, scheduled via `croner@10.0.1`); no shell hooks observed in the FS scan.

### 5.4 Channel integrations

Only **Telegram** is enabled. `dmPolicy=open`, `groupPolicy=allowlist`. Webhook target `https://intmolt.org/telegram-webhook` with a 64-char secret. Bot token currently returns **401 Unauthorized** (see §6).

### 5.5 Suspicious skill-loader log line

Journal (today) contains:

```
[skills] Skipping skill path that resolves outside its configured root.
```

`NOTE` — that's openclaw refusing to load *something*. Likely the `metaplex` symlink that points into `../../.agents/`, which would resolve outside the skills root. Functionally fine (refusal is a safety feature), but it means the `metaplex` skill is **not active** in the running gateway despite being listed.

---

## 6. Activity profile — why the elevated CPU — `RISK (operational)`

### 6.1 Active log

The process writes to its systemd journal (fd 1/2 → journal socket). No standalone `.log` file is open. Last hour ≈ **300 journal lines** for unit `openclaw-gateway.service`.

### 6.2 Last 200 lines (representative)

```
2026-05-22T23:48:01 [telegram] setMyCommands failed: Call to 'setMyCommands' failed! (401: Unauthorized)
2026-05-22T23:48:01 [telegram] command sync failed: GrammyError: Call to 'setMyCommands' failed! (401: Unauthorized)
2026-05-22T23:49:22 [telegram] [default] starting provider
2026-05-22T23:49:22 [skills] Skipping skill path that resolves outside its configured root.
2026-05-22T23:49:22 [telegram] getMe failed: Call to 'getMe' failed! (401: Unauthorized)
2026-05-22T23:49:22 [telegram] [default] channel exited: Call to 'getMe' failed! (401: Unauthorized)
2026-05-22T23:49:22 [telegram] [default] auto-restart attempt 6/10 in 172s
2026-05-22T23:49:22 [telegram] deleteMyCommands failed: ... (401)
2026-05-22T23:49:22 [telegram] setMyCommands failed: ... (401)
2026-05-22T23:49:22 [telegram] command sync failed: ... (401)
(loop continues every ~170 s)
```

### 6.3 Last-24h hourly line counts (truncated to last 25 buckets)

```
8, 2, 32, 8, 8, 8, 1, 8, 2, 24, 16, 8, 8, 8, 2, 32, 8, 8, 8, 1, 2, 24, 8, 8, 8
```

The bursts (24-32 lines) align with the 172-second retry cycle described in the loop. Average ~5 messages/min, peaks at ~32/min during retry.

### 6.4 Top repeating patterns (last 1000 lines)

Each line is salted with a millisecond timestamp, so naive uniq returns 1 hit per line. By **message body** (ignoring timestamps) the leaderboard is:

1. `[telegram] getMe failed: ... (401: Unauthorized)` — ≈40% of lines
2. `[telegram] setMyCommands failed: ... (401)` — ≈18%
3. `[telegram] command sync failed: GrammyError: ... (401)` — ≈18%
4. `[telegram] [default] auto-restart attempt N/10 in 172s` — ≈10%
5. `[telegram] deleteMyCommands failed: ... (401)` — ≈10%

### 6.5 Process state hint

`wchan` is `ep_poll` (epoll wait), state `Ssl` — normal libuv idle. The CPU is **not** from a tight busy loop; it's from waking every few seconds for Telegram polling/retry plus mDNS heartbeats. With 11 threads and Node's GC, the cumulative ~29% on a small VPS is plausible.

### 6.6 Verdict

`RISK (operational)` — the 5d+ of CPU time over a 19-day uptime is **wasted work driven by a dead Telegram bot token**. The gateway will never recover until either (a) the bot token is rotated in `openclaw.json` and the service restarted, or (b) the Telegram channel is disabled. It does not look like a security incident or a compromised dependency — just a failed integration.

A separate concern: VmSwap peaked at **747 MB**. The host has had to swap this process at some point, which on a single-VPS shared with `integrity-x402.service` could degrade latency for paid scans.

---

## 7. Cross-contamination with integrity.molt — `OK` (clean separation)

| Question | Answer | Evidence |
|---|---|---|
| Does openclaw hold an fd under `/root/x402-server`? | **No** | `ls -la /proc/19934/fd/ \| grep x402` → no hits |
| Does openclaw config reference `127.0.0.1:3402` or `intmolt.org`? | Yes (`intmolt.org` only, as the webhook + A2A endpoint) | `openclaw.json:208`, `HEARTBEAT.md` lines 7, 28 |
| Does openclaw reference `localhost:3402` / `127.0.0.1:3402`? | **No** | grep negative |
| Shared SQLite file, log dir, or `.env`? | **No** — openclaw writes only under `/root/.openclaw/` and `/root/clawd/`. `intmolt.db` is touched only by `x402-server`. | fd list does not include `intmolt.db` |
| Same Ed25519 signing key as integrity.molt's `integrity-molt-primary-2026`? | **No** — format mismatch (raw vs PEM) and different on-disk roles. Bit-fingerprint not performed (read-only constraint). | §4.5 |
| Does `BFmkPKu2tS9...` PDA appear as source/dest/signer in openclaw tx code? | **No** — openclaw has no Solana-signing code path. | §4.6 |
| Does `intmolt-x402.service` start, depend on, or know about openclaw? | **No** (separate user-vs-system systemd, no `After=`/`Requires=` link) | unit lists |

**Conclusion:** the two workloads share the same host and the same operator identity, and they cooperate *over the public network* (openclaw → `https://intmolt.org/a2a`, integrity.molt advertises `https://multiclaw.moltid.workers.dev/c/integrity/a2a` as an inbound A2A relay), but they are not coupled at the filesystem or process level. Compromise of one does not directly compromise the other beyond what any attacker with `root` on this host can do.

---

## 8. Persistence & blast radius — `NOTE`

### 8.1 Cron entries (root crontab)

```
0 */12 * * *  /root/scanner/outreach.sh             >> /root/heartbeat.log
0 14 */2 * *  /root/daily-post.sh
0 20 * * *    /root/scanner/daily-reputation-report.sh >> /root/heartbeat.log
0 8 * * *     /root/proactive-scan.sh
0 3 * * *     find /root/scanner/reports/ -type f -mtime +7 -delete
*/30 * * * *  /root/heartbeat-secure.sh         (symlink → /root/heartbeat.sh)
*/30 * * * *  /root/scripts/disk-alert.sh
0 3 * * *     /root/scripts/cleanup.sh
*/5 * * * *   /root/scripts/uptime-check.sh
*/15 * * * *  df -h / | awk ... DISK_WARNING_*
0 * * * *     /root/scripts/abuse-monitor.sh
# (one disabled line: watchlist-checker.sh)
```

**`heartbeat-secure.sh`** (called every 30 min) is the moltbook bot driver — it reads `/root/.secrets/moltbook_api_key`, hits `https://www.moltbook.com/api/v1`, and is the script described in `HEARTBEAT.md`. It calls the moltbook API directly with shell + `jq`; it does **not** route through the openclaw process. The openclaw gateway is responsible only for the Telegram channel and the LLM coding-agent.

Cron file `/etc/cron.d/intmolt-backup` exists (intmolt backup, not openclaw).

### 8.2 Systemd timers

System-wide: only standard Ubuntu timers (fwupd, dpkg-db-backup, logrotate, sysstat, certbot, apt-daily, etc.) — none reference openclaw or molt.

User: only `launchpadlib-cache-clean.timer`.

### 8.3 Autostart from shell rc files

`grep openclaw|moltbook|clawd ~/.bashrc ~/.profile /etc/rc.local /etc/profile.d/*` → **no hits**. The only autostart path is the user systemd unit.

### 8.4 Why root?

`ExecStart` runs under `user@0.service` (root's user instance). The unit does not bind to a port < 1024, does not write to `/etc`, does not need raw sockets. It writes to `/root/.openclaw/`, `/root/clawd/workspace/`, `/tmp/openclaw-0/`, and exec's external shell tools that presently live under `/root/`.

`RISK (privilege)` — there is **no operational reason** for openclaw to run as root. A dedicated `openclaw` system user owning `/root/.openclaw/` (renamed to `/home/openclaw/.openclaw/`) and `/root/clawd/workspace/` (or `/var/lib/openclaw/`) would shrink blast radius dramatically: today, a prompt-injection that escapes the `coding-agent` skill executes shell **as root** on the same host as `integrity.molt`.

Combined with §1.3 (`gateway.controlUi.dangerouslyDisableDeviceAuth = true` and `gateway.controlUi.allowInsecureAuth = true`), an attacker who can reach `127.0.0.1:18789–18792` (e.g. via a separate exploit that gives them a userland foothold) gets root-level coding-agent access without authentication.

---

## 9. Version, updates, dependencies — `NOTE`

- `openclaw --version` → `OpenClaw 2026.3.8 (3caab92)`
- Installed at `/usr/lib/node_modules/openclaw/` (global npm; not a project local install)
- Update-check file `/root/.openclaw/update-check.json` last written **2026-05-22 23:12** — the gateway checks for updates, did not self-upgrade.
- Top-level deps depth 0: see §1.1. **Six UNMET DEPENDENCY** entries — install is partially broken but the gateway runs.
- Most recently modified user-data files (top 5):

```
2026-05-22 23:42:59  /root/.openclaw/agents/main/sessions/sessions.json
2026-05-22 23:42:59  /root/.openclaw/agents/main/agent/auth-profiles.json
2026-05-22 23:42:59  /root/.openclaw/agents/main/sessions/90758ada-0470-48fa-b1fd-e101bbf5e1d6.jsonl
2026-05-22 23:12:50  /root/.openclaw/update-check.json
2026-05-22 03:42:57  /root/.openclaw/agents/main/sessions/7e428f31-...jsonl.reset.2026-05-22T04-12-57.jsonl
```

There **is** ongoing agent activity (session log written 6 minutes before the audit), so the gateway is doing real work *despite* the dead Telegram channel — most likely something is dialing the loopback gateway port (18791/18792) directly.

- `/root/.openclaw/workspace` is `git init`'d but has **no commits** (`fatal: your current branch 'master' does not have any commits yet`).

---

## Top things to know

1. Path in the brief (`/root/openclaw/`) doesn't exist — real install is the npm package at `/usr/lib/node_modules/openclaw/` plus user data at `/root/.openclaw/`.
2. The 29% (not 120%) sustained CPU is **wasted retries against a dead Telegram bot token** — rotate the token or disable the Telegram channel and the noise stops.
3. openclaw runs as **root under per-user systemd** with `dangerouslyDisableDeviceAuth=true` and `allowInsecureAuth=true` — a prompt-injection in the `coding-agent` skill = root shell on the same host as `integrity.molt`.
4. OpenRouter API key is duplicated in plaintext across the systemd unit file, `openclaw.json`, and the live process env — single rotation point must touch all three.
5. Filesystem isolation from `integrity.molt` is **clean** (no shared fds, DBs, or keys). Coupling is purely over the public network (webhook + A2A relay).
6. Port `18789` is bound to `0.0.0.0` but UFW only allows 22/80/443 inbound — gateway is not internet-reachable today; if UFW ever drops, it instantly is.
7. The user-systemd workspace `/root/.openclaw/workspace/` has `git init` but zero commits — nothing about the bot's identity/spec is versioned.
