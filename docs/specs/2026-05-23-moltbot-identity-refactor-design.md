# moltbot identity refactor + self-update — design

**Date:** 2026-05-23
**Status:** draft, awaiting operator review
**Owner:** Hans (integrity.molt)
**Brainstormed in:** session "moltbot" (claude-opus-4-7)

---

## Problem

`daily-post.sh` (cron `0 14 */2 * *`) generates moltbook posts via OpenRouter Gemini Flash. Empirical evidence from `/root/heartbeat.log{.gz,.1.gz,...}` shows 4/4 most recent tip-mode posts opened with "API key management" theme — full repetition. Operator wants topic diversity *and* the long-deferred identity rewrite from "security scanner" (legacy) to "security oracle" (current product positioning).

Three root causes for the repetition:

1. **LLM primacy bias** — the prompt lists 5 topics as a flat enumeration; Gemini Flash strongly biases to the first item ("API key management").
2. **Stateless prompts** — the LLM has no memory of what was already posted; identical prompt every run.
3. **Generic instructions** — no hook to ground tip in a concrete on-chain event/scan finding.

Additionally:

4. `daily-post.sh` and `heartbeat.sh` both hard-code `"model": "google/gemini-2.5-flash"` — operator's `/model set anthropic/claude-opus-4-7` (written into `/etc/moltbot/llm-config.env`) is silently ignored because no script reads `MOLTBOT_LLM_MODEL`.
5. Identity strings ("AI security auditor", offerings list, prices) are scattered across `daily-post.sh`, `heartbeat.sh`, `workspace/SOUL.md`, `workspace/HEARTBEAT.md`. Stale terminology ("security scanner") propagates everywhere.

## Goal

A single repo-controlled source-of-truth for identity, atomically refreshed from Telegram on demand, plus prompt rewrites that guarantee topic diversity.

## Non-goals

- Scheduled refresh (operator selected on-demand only).
- LLM-based extract from prosaic README (operator selected structured markdown parse).
- Webhook handler reacting to repo push events.
- Multi-source identity merge (README + CHANGELOG + IDENTITY).
- `heartbeat.sh` reply/comment/DM prompt rewrites — those react to varying inputs (different commenter, different post) so have inherent variation; YAGNI.
- Verifying the Telegram bot responds correctly after deploy — operator tests from phone.

---

## Architecture

```
┌─────────────────────────┐                                    
│ Operator edits          │  git commit + push                 
│ docs/IDENTITY.md        │ ─────────────────────► GitHub:     
│ (local laptop)          │                        Hans1132/   
└─────────────────────────┘                        integrity.molt
                                                          │     
        ─ /refreshidentity in Telegram ─►                  │     
        ┌───────────────────────────┐                     │     
        │ moltbot.service           │                     │     
        │ (user: moltbot)           │                     │     
        └───────────────────────────┘                     │     
                  │                                       │     
                  │ touch /var/run/moltbot/trigger-identity-pull
                  ▼                                       │     
        ┌───────────────────────────┐                     │     
        │ moltbot-identity-         │                     │     
        │ pull-runner.service       │ ─── git fetch +     │     
        │ (root, oneshot)           │     git checkout ───►│     
        └───────────────────────────┘     -- docs/IDENTITY.md
                  │                                              
                  │ runner exits, trigger file removed          
                  ▼                                              
        ┌───────────────────────────┐                            
        │ moltbot reads             │                            
        │ /root/x402-server/        │                            
        │   docs/IDENTITY.md,       │                            
        │ parses, atomic writes     │                            
        │ /etc/moltbot/identity.env │                            
        └───────────────────────────┘                            
                  │                                              
                  │ diff old vs new, reply to operator           
                  ▼                                              
              Telegram                                          

Next cron run of daily-post.sh / heartbeat.sh:
        source /etc/moltbot/identity.env
        prompts compose $MOLTBOT_ROLE, $MOLTBOT_TAGLINE,
        $MOLTBOT_FREE_SKILLS, $MOLTBOT_PAID_SKILLS, $TOPIC_OF_DAY
```

### Key boundaries

- **Repo `docs/IDENTITY.md`** is canonical truth — versioned, PR-reviewable, atomic via git.
- **path-unit pattern** keeps `NoNewPrivileges=true` on `moltbot.service` (same trick already used for `/runnow`).
- **`git checkout origin/main -- docs/IDENTITY.md`** (NOT `git pull`) bounds blast radius — runner never touches anything outside that one file, so operator's in-progress work elsewhere in the working tree is safe.
- **Parse is deterministic regex** (no LLM in extract pipeline) — predictable, no halucinated prices.
- **`/etc/moltbot/identity.env`** is local cache; `daily-post.sh` + `heartbeat.sh` `source` it (zero network in hot path).
- **`/etc/moltbot/llm-config.env`** (operator-controlled via `/model set`) stays separate from `identity.env` (repo-controlled) — different update cycles, neither overwrites the other.

---

## Data shapes

### `docs/IDENTITY.md` (canonical, committed to git)

Strict markdown structure. Required sections (`## <name>` heading). Parser raises on missing required section.

```markdown
# integrity_molt identity

## Role
security oracle for Solana

## Tagline
On-chain risk scoring (IRIS 0-100), rug detection, wallet profiling, signed receipts.
Built on x402 payment protocol. Verifiable at intmolt.org/jwks.json.

## Free skills
- quick_scan: free automated on-chain analysis
- scan_address: detailed account inspection
- verify_receipt: validate Ed25519 signed reports
- new_spl_feed: latest SPL mints
- program_verification_status: OtterSec verify.osec.io lookup

## Paid skills (x402 USDC)
- agent_token_scan: $0.15
- governance_change: $0.15
- token_audit: $0.75
- wallet_profile: $0.75
- adversarial_sim: $4.00
- deep_audit: $5.00

## Contact
@integrity_molt_bot on Telegram · intmolt.org · A2A relay multiclaw.moltid.workers.dev

## Topics
- Mint authority risks (when an active mint can dilute supply unexpectedly)
- Freeze authority traps (tokens that can freeze user wallets mid-trade)
- LP token concentration (DeFi pools with top-holder dominance)
- Solana program upgrade authority (mutable programs = trust risk)
- Cross-program invocation (CPI) attack surfaces
- Wallet age vs treasury size red flags
- Governance proposal review patterns
- Rug pull post-mortems (anonymized real cases)
- AI agent prompt injection on autonomous wallets
- Off-chain oracle manipulation in DeFi
- Sandwich attack mechanics on Solana DEXes
- Multisig threshold analysis (when 1-of-N is silently risky)
- Compressed NFT (cNFT) authority misconfigurations
- OtterSec verify status as trust signal
- SPL token-2022 extension footguns

## Tone
Security expert voice — specific, technical, citations to on-chain data when possible.
No emojis, no hashtags, no marketing buzzwords. Sign as: - integrity_molt
```

**Required sections**: `Role`, `Tagline`, `Free skills`, `Paid skills`, `Contact`, `Topics`, `Tone`. Parser raises `ParseError` if any missing.

**Topics**: must have ≥5 items as `- ` bullets. Operator can grow the list any time by committing IDENTITY.md updates.

### `/etc/moltbot/identity.env` (parsed cache, source-able by bash)

```bash
# Auto-generated from docs/IDENTITY.md at 2026-05-23T13:45:12Z. DO NOT EDIT.
MOLTBOT_ROLE='security oracle for Solana'
MOLTBOT_TAGLINE='On-chain risk scoring (IRIS 0-100), rug detection, wallet profiling, signed receipts. Built on x402 payment protocol. Verifiable at intmolt.org/jwks.json.'
MOLTBOT_FREE_SKILLS='quick_scan: free automated on-chain analysis
scan_address: detailed account inspection
verify_receipt: validate Ed25519 signed reports
new_spl_feed: latest SPL mints
program_verification_status: OtterSec verify.osec.io lookup'
MOLTBOT_PAID_SKILLS='agent_token_scan: $0.15
governance_change: $0.15
token_audit: $0.75
wallet_profile: $0.75
adversarial_sim: $4.00
deep_audit: $5.00'
MOLTBOT_CONTACT='@integrity_molt_bot on Telegram · intmolt.org · A2A relay multiclaw.moltid.workers.dev'
MOLTBOT_TONE='Security expert voice — specific, technical, citations to on-chain data when possible. No emojis, no hashtags, no marketing buzzwords. Sign as: - integrity_molt'
MOLTBOT_TOPICS_COUNT=15
MOLTBOT_TOPIC_0='Mint authority risks (when an active mint can dilute supply unexpectedly)'
MOLTBOT_TOPIC_1='Freeze authority traps (tokens that can freeze user wallets mid-trade)'
# ... TOPIC_2 through TOPIC_14
MOLTBOT_IDENTITY_UPDATED_AT='2026-05-23T13:45:12Z'
MOLTBOT_IDENTITY_COMMIT='7c07f4b'
```

ANSI-C-style quoted strings (`'`-quoted with `'\''` escape) so bash and `python-dotenv` parse identically.

### Topic rotation — anti-repetition mechanism

Three independent layers; each compensates if another degrades.

| Layer | Mechanism | Failure mode it covers |
|---|---|---|
| 1. Deterministic rotation | `TOPIC_IDX=$((DAY_OF_YEAR % MOLTBOT_TOPICS_COUNT))`<br>`TOPIC_VAR="MOLTBOT_TOPIC_${TOPIC_IDX}"`<br>`TOPIC_OF_DAY="${!TOPIC_VAR}"` (bash indirect expansion) | LLM primacy bias |
| 2. History injection | `RECENT POSTS (DO NOT repeat themes): {last 5 daily-post titles from heartbeat.log archives}` | Topic-pool drift / two similar topics |
| 3. Scan-stats hook | `RECENT FINDING: {last scan summary from /root/scanner/reports/*.txt}` | Generic abstract advice |

15-day cycle for full coverage. Operator extends by adding bullets to IDENTITY.md.

---

## `/refreshidentity` flow + parse logic

### systemd units (path-unit pattern, same as existing `/runnow`)

`/etc/systemd/system/moltbot-identity-pull-trigger.path`:

```ini
[Unit]
Description=Watch for moltbot identity-pull trigger

[Path]
PathExists=/var/run/moltbot/trigger-identity-pull
Unit=moltbot-identity-pull-runner.service

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/moltbot-identity-pull-runner.service`:

```ini
[Unit]
Description=Pull docs/IDENTITY.md from integrity.molt repo

[Service]
Type=oneshot
WorkingDirectory=/root/x402-server
ExecStart=/usr/bin/git fetch --quiet origin main
ExecStart=/usr/bin/git checkout --quiet origin/main -- docs/IDENTITY.md
ExecStartPost=/bin/rm -f /var/run/moltbot/trigger-identity-pull
TimeoutStartSec=30
```

### Parser (`lib/parse_identity.py` in moltbot)

Pure Python, no third-party deps. Strict mode: missing required section → `ParseError`; <5 topics → `ParseError`. Caller validates result before overwriting `identity.env`.

```python
"""Parse docs/IDENTITY.md → key-value mapping for identity.env."""
import re

REQUIRED_SECTIONS = ("Role", "Tagline", "Free skills", "Paid skills",
                     "Contact", "Topics", "Tone")
SECTION_RE = re.compile(r'^##\s+(.+?)\s*$', re.MULTILINE)
BULLET_RE = re.compile(r'^[-*]\s+(.+)$')


class ParseError(Exception): pass


def parse(md_text: str) -> dict:
    matches = list(SECTION_RE.finditer(md_text))
    if not matches:
        raise ParseError("no '## ' sections found")
    sections = {}
    for i, m in enumerate(matches):
        name = m.group(1).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(md_text)
        sections[name] = md_text[start:end].strip()
    missing = [s for s in REQUIRED_SECTIONS if s not in sections]
    if missing:
        raise ParseError(f"missing required sections: {missing}")
    topics = [
        BULLET_RE.match(line).group(1).strip()
        for line in sections["Topics"].splitlines()
        if BULLET_RE.match(line.strip())
    ]
    if len(topics) < 5:
        raise ParseError(f"need ≥5 topics, found {len(topics)}")
    return {
        "role": sections["Role"],
        "tagline": sections["Tagline"],
        "free_skills": sections["Free skills"],
        "paid_skills": sections["Paid skills"],
        "contact": sections["Contact"],
        "tone": sections["Tone"],
        "topics": topics,
    }


def to_env(parsed: dict, commit_sha: str, timestamp_iso: str) -> str:
    def q(s):
        return "'" + s.replace("'", "'\\''") + "'"
    lines = [
        f"# Auto-generated from docs/IDENTITY.md at {timestamp_iso}. DO NOT EDIT.",
        f"MOLTBOT_ROLE={q(parsed['role'])}",
        f"MOLTBOT_TAGLINE={q(parsed['tagline'])}",
        f"MOLTBOT_FREE_SKILLS={q(parsed['free_skills'])}",
        f"MOLTBOT_PAID_SKILLS={q(parsed['paid_skills'])}",
        f"MOLTBOT_CONTACT={q(parsed['contact'])}",
        f"MOLTBOT_TONE={q(parsed['tone'])}",
        f"MOLTBOT_TOPICS_COUNT={len(parsed['topics'])}",
    ]
    for i, t in enumerate(parsed['topics']):
        lines.append(f"MOLTBOT_TOPIC_{i}={q(t)}")
    lines.append(f"MOLTBOT_IDENTITY_UPDATED_AT={q(timestamp_iso)}")
    lines.append(f"MOLTBOT_IDENTITY_COMMIT={q(commit_sha)}")
    return "\n".join(lines) + "\n"
```

### Handler (`handlers/identity.py` in moltbot)

```python
async def handler(update, context):
    # 1. Snapshot current identity.env for diff
    old = read_current_identity(cfg)

    # 2. Trigger pull via path-unit
    await update.message.reply_text("pulling docs/IDENTITY.md from repo…")
    cfg.identity_pull_trigger.parent.mkdir(parents=True, exist_ok=True)
    cfg.identity_pull_trigger.touch()

    # 3. Poll for trigger consumption (max 30s)
    consumed = await wait_trigger_consumed(cfg.identity_pull_trigger, max_wait=30)
    if not consumed:
        await update.message.reply_text("pull exceeded 30s, aborting")
        return

    # 4. Parse pulled file
    try:
        md = Path("/root/x402-server/docs/IDENTITY.md").read_text()
        parsed = parse(md)
    except (FileNotFoundError, ParseError) as e:
        await update.message.reply_text(f"parse failed: {type(e).__name__}: {e}")
        return  # keep old identity.env intact

    # 5. Get commit SHA the file was just checked out FROM.
    # The runner does `git checkout origin/main -- docs/IDENTITY.md` (file-only,
    # HEAD does not move), so `rev-parse HEAD` would return the stale working-tree
    # commit. Resolve `origin/main` instead — the ref that supplied the content.
    commit = subprocess.run(
        ["git", "-C", "/root/x402-server", "rev-parse", "--short", "origin/main"],
        capture_output=True, text=True, timeout=5,
    ).stdout.strip() or "unknown"

    # 6. Atomic write
    new_content = to_env(parsed, commit, dt.datetime.now(dt.UTC).isoformat())
    write_atomic(cfg.identity_env_file, new_content)

    # 7. Diff and report
    diff_lines = diff_identity(old, parsed, commit)
    await update.message.reply_markdown(
        f"*identity refreshed* (commit `{commit}`)\n```\n{diff_lines}\n```"
    )
```

### Diff report format (operator sees)

```
identity refreshed (commit 7c07f4b)

ROLE: 'security scanner' → 'security oracle for Solana'
TAGLINE: changed (387 chars)
FREE_SKILLS: 4 → 5 items (added: program_verification_status)
PAID_SKILLS: 6 items, unchanged
TOPICS: 5 → 15 items (added 10)
TONE: unchanged
CONTACT: unchanged

next daily-post.sh / heartbeat.sh run uses new values.
```

Unchanged refresh: `identity already up-to-date (commit 7c07f4b)`.

### Edge cases

| Failure | Detection | Bot response | `identity.env` state |
|---|---|---|---|
| Repo network unreachable | `git fetch` exit ≠ 0 (oneshot fails) | trigger file persists past 30s → "pull exceeded 30s, aborting" | unchanged |
| `IDENTITY.md` missing in HEAD | `Path.is_file() == False` after pull | "docs/IDENTITY.md not in repo HEAD" | unchanged |
| Required section missing | `ParseError("missing required sections: [...]")` | quoted error | unchanged |
| <5 topics | `ParseError("need ≥5 topics...")` | quoted error | unchanged |
| Trigger not consumed in 30s | timeout in handler | "pull exceeded 30s" | unchanged |
| Atomic write fails | `OSError` from `os.replace` | "write failed: <err>" | unchanged (rename is atomic) |

**Invariant**: `identity.env` is written **only if the entire flow succeeds**. No partial state.

---

## `daily-post.sh` + `heartbeat.sh` integration

### `daily-post.sh` — full refactor

```diff
@@ top of file @@
+ # --- moltbot integration ---
+ source /etc/moltbot/llm-config.env 2>/dev/null || true   # existing
+ source /etc/moltbot/identity.env 2>/dev/null || true     # NEW
+ # --- end moltbot integration ---

@@ call_openrouter @@
-    \"model\": \"google/gemini-2.5-flash\",
+    \"model\": \"${MOLTBOT_LLM_MODEL:-google/gemini-2.5-flash}\",

@@ before PROMPT= block @@
+ # Topic rotation (1 topic per day of year, deterministic)
+ DAY_OF_YEAR=$(date -u +%-j)
+ TOPIC_COUNT=${MOLTBOT_TOPICS_COUNT:-1}
+ TOPIC_IDX=$(( DAY_OF_YEAR % TOPIC_COUNT ))
+ TOPIC_VAR="MOLTBOT_TOPIC_${TOPIC_IDX}"
+ TOPIC_OF_DAY="${!TOPIC_VAR:-AI agent security on Solana}"
+
+ # Recent post titles (last 5 distinct, from rotated heartbeat.log archives)
+ RECENT_TITLES=$(
+   zcat -f /root/heartbeat.log* 2>/dev/null \
+     | grep '\[daily-post\] Post type:' \
+     | sed -E 's|.*Generated \([0-9]+ chars\):[ ]*||; s|\.\.\.$||' \
+     | head -5 \
+     | awk '{print "- " $0}'
+ )

@@ tip prompt rewritten @@
- PROMPT="You are integrity_molt, an AI security auditor on Solana.
- Write ... Topics: API key management, ..."
+ PROMPT="You are integrity_molt, a ${MOLTBOT_ROLE:-security oracle for Solana}.
+ ${MOLTBOT_TAGLINE}
+
+ Write a short Moltbook post (3-5 sentences) about ONE specific topic:
+   TOPIC: ${TOPIC_OF_DAY}
+
+ Ground the tip in a concrete example. If a recent scan finding is provided, cite it.
+
+ RECENT FINDING (from last scan report, may be empty):
+ ${LATEST_SCAN_SUMMARY}
+
+ RECENT POSTS (DO NOT repeat these themes or phrasings):
+ ${RECENT_TITLES}
+
+ Tone: ${MOLTBOT_TONE}
+ End with: 'Free quick scans available — DM @integrity_molt_bot or ask in replies.'
+ No emojis. No markdown headers."

@@ showcase prompt — same identity-var substitution, keeps existing scan-injection logic @@

@@ CTA suffix @@
- CTA="...0.01 USDC via x402. Contact: @integrity_molt_bot on Telegram."
+ # Compose CTA from identity (pricing always in sync with repo)
+ CTA_PAID=$(echo "$MOLTBOT_PAID_SKILLS" | tr '\n' '|' | sed 's/|/ · /g; s/ · $//')
+ CTA="

+ Quick scans: free. Paid: ${CTA_PAID}. Contact: ${MOLTBOT_CONTACT}."
```

Bash idiom note: `"${!TOPIC_VAR}"` is bash **indirect variable expansion** — looks up the variable whose name is the value of `TOPIC_VAR`. All identity vars use `${VAR:-default}` fallback so the script degrades gracefully to existing behavior if `identity.env` is missing or empty.

### `heartbeat.sh` — minimal touch (YAGNI)

```diff
@@ top of file (after existing moltbot integration block) @@
+ source /etc/moltbot/identity.env 2>/dev/null || true

@@ inside call_openrouter() — sed substitution (pattern-based, not line-number-based) @@
-    \"model\": \"google/gemini-2.5-flash\",
+    \"model\": \"${MOLTBOT_LLM_MODEL:-google/gemini-2.5-flash}\",
```

Implementation note: use `sed` pattern match (not line number — line numbers drift across heartbeat.sh edits). Replace the literal `"google/gemini-2.5-flash"` everywhere it appears in heartbeat.sh — empirical scan confirms 1 occurrence (in `call_openrouter()`). If heartbeat.sh ever grows additional model literals, the same `sed` pattern catches them all.

Reply/comment/DM prompts not rewritten. They react to varying inputs (different commenter, different post body) so have inherent variation; repetition isn't a documented problem there. Operator can later add identity vars to those prompts as a 5-min change because `source identity.env` is already in place.

### New file tree under `moltbot-build/`

```
moltbot-build/
├── .env.example
├── README.md                                 (UPDATE: document /refreshidentity + identity.env)
├── install.sh                                (UPDATE: 2 new systemd units, IDENTITY.md scaffold, bootstrap parse)
├── main.py                                   (UPDATE: register /refreshidentity handler)
├── requirements.txt
├── etc/
│   ├── allowed-models.txt
│   ├── identity.env.example                  (NEW: empty scaffold)
│   ├── IDENTITY.md.template                  (NEW: starter for repo's docs/IDENTITY.md)
│   └── llm-config.env
├── handlers/
│   ├── __init__.py
│   ├── identity.py                           (NEW: /refreshidentity handler, ~90 LOC)
│   ├── model.py
│   ├── posts.py
│   ├── runner.py
│   ├── scan.py
│   └── status.py                             (UPDATE: append "identity: $ROLE (commit, age)" line)
├── lib/
│   ├── __init__.py
│   ├── auth.py
│   ├── config.py                             (UPDATE: identity_pull_trigger, identity_env_file fields)
│   ├── llm_config.py
│   ├── moltbook_api.py
│   ├── parse_identity.py                     (NEW: ~80 LOC)
│   └── x402_client.py
└── systemd/
    ├── moltbot-heartbeat-runner.service
    ├── moltbot-heartbeat-trigger.path
    ├── moltbot-identity-pull-runner.service  (NEW)
    ├── moltbot-identity-pull-trigger.path    (NEW)
    └── moltbot.service                       (UNCHANGED — /etc/moltbot already in ReadWritePaths)

repo /root/x402-server/:
└── docs/
    └── IDENTITY.md                           (NEW: canonical truth, committed to git)
```

**LOC delta** (Python): ~195 new (90 handler + 80 parse_identity + 10 config + 15 status). Total grows 715 → ~910 LOC; over original 800 budget but justified by approved scope expansion.

### `install.sh` additions (idempotent, append to existing steps)

```bash
# 7b. scaffold docs/IDENTITY.md if missing
if [[ -d /root/x402-server/docs ]] && [[ ! -f /root/x402-server/docs/IDENTITY.md ]]; then
    say "scaffolding docs/IDENTITY.md (operator must review + git commit + push)"
    install -m 0644 "$SRC_DIR/etc/IDENTITY.md.template" /root/x402-server/docs/IDENTITY.md
fi

# 7c. bootstrap /etc/moltbot/identity.env from local docs/IDENTITY.md if missing
if [[ ! -f /etc/moltbot/identity.env ]] && [[ -f /root/x402-server/docs/IDENTITY.md ]]; then
    say "parsing local docs/IDENTITY.md → /etc/moltbot/identity.env"
    "$APP_DIR/venv/bin/python" -c "
import sys; sys.path.insert(0, '$APP_DIR')
from lib.parse_identity import parse, to_env
import datetime as dt
md = open('/root/x402-server/docs/IDENTITY.md').read()
env = to_env(parse(md), 'bootstrap', dt.datetime.now(dt.UTC).isoformat())
open('/etc/moltbot/identity.env','w').write(env)
"
    chown moltbot:moltbot /etc/moltbot/identity.env
fi

# step 8: extend systemd unit list
- for unit in moltbot.service moltbot-heartbeat-trigger.path moltbot-heartbeat-runner.service; do
+ for unit in moltbot.service \
+             moltbot-heartbeat-trigger.path moltbot-heartbeat-runner.service \
+             moltbot-identity-pull-trigger.path moltbot-identity-pull-runner.service; do
```

### `/status` integration (bonus)

```
bot uptime: 7m
last heartbeat.sh: 2026-05-23 14:30 UTC (2m ago)
x402 service: up (/health=200)
llm model: anthropic/claude-opus-4-7
identity: security oracle for Solana (commit 7c07f4b, 2h ago)    ← NEW LINE
scan reports today: 1
```

---

## Acceptance

After deploy:

1. `docs/IDENTITY.md` exists in repo, committed.
2. `/etc/moltbot/identity.env` exists on VPS, owned `moltbot:moltbot`, mode `0644`, contains all `MOLTBOT_*` vars.
3. `systemctl status moltbot-identity-pull-trigger.path` shows `active (waiting)`.
4. From Telegram: `/refreshidentity` returns "identity refreshed (commit …)" with a diff or "already up-to-date" within 30 s.
5. After `/refreshidentity` succeeds, `cat /etc/moltbot/identity.env | grep MOLTBOT_IDENTITY_COMMIT` shows the new commit SHA.
6. Manually editing `docs/IDENTITY.md` to remove the `## Topics` section and re-running `/refreshidentity` produces `parse failed: ParseError: missing required sections: ['Topics']` and **does not** overwrite the live `identity.env`.
7. Running `/root/daily-post.sh` produces a post whose tip references the topic at `MOLTBOT_TOPIC_$((DAY_OF_YEAR % 15))` (cross-check with `[daily-post] Generated …` log line).
8. Running `/root/daily-post.sh` twice in a row produces tips that **do not share opening phrasing** (history-aware prompt cites the just-posted title in `RECENT POSTS`).
9. `journalctl -u moltbot.service` shows no `PermissionError`, no `Traceback`, no `KeyError`.
10. `/status` in Telegram shows new `identity:` line with role + commit + age.

## Rollback

- If `/refreshidentity` poisons `identity.env`: parse error path keeps old file intact; nothing to roll back.
- If a new `IDENTITY.md` ships bad content (typo in role, wrong price): operator reverts commit on GitHub, runs `/refreshidentity` — old content re-pulled.
- If `daily-post.sh` patch breaks: restore from `.pre-moltbot-fix.bak` written by `install.sh`.
- If `heartbeat.sh` patch breaks: restore from `.pre-moltbot.bak` (already exists from prior install) or `.pre-moltbot-fix.bak` (this install writes a new one before patching again).

## Risks

- **Operator forgets to `git push` IDENTITY.md changes** — `/refreshidentity` pulls origin/main; pre-push edits not visible. Mitigation: diff report shows commit SHA, operator can verify.
- **`docs/IDENTITY.md` and `/etc/moltbot/identity.env` drift in dev vs prod** — prod always reflects last successful `/refreshidentity`. Doc that `/refreshidentity` is required after IDENTITY.md commits.
- **Bash quoting bug in `to_env()`** — single-quote escaping for content containing `'` (e.g., "don't repeat") needs careful testing. Plan: unit test in implementation phase with fixtures containing `'`, `"`, `\n`, `$VAR`, backticks.
- **Topic rotation collision with manual showcase scan reuse** — if showcase mode (even days) tries to use TOPIC_OF_DAY but no recent scan matches that topic, falls back to LLM creativity. Acceptable.
