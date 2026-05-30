"""/refreshidentity — pull docs/IDENTITY.md from repo, parse, atomic-write identity.env."""
from __future__ import annotations

import datetime as dt
import logging
import os
import re
import subprocess
import tempfile
from pathlib import Path

from telegram import Update
from telegram.ext import ContextTypes

from lib.config import Config
from lib.parse_identity import ParseError, parse, to_env
from lib.trigger import wait_consumed

log = logging.getLogger(__name__)

MAX_WAIT = 30.0
TG_LIMIT = 4000

# Match KEY=value lines from a generated identity.env; values are either:
#   - single-quoted (ANSI-C-escape '\\'' for internal quotes), captured as group(2)
#   - unquoted bare token (e.g. MOLTBOT_TOPICS_COUNT=15), captured as group(3)
ENV_LINE_RE = re.compile(
    r"^([A-Z_][A-Z0-9_]*)=(?:'((?:[^']|'\\'')*)'|(\S+))$", re.MULTILINE
)


def _unescape(v: str) -> str:
    return v.replace("'\\''", "'")


def _read_current_env(path: Path) -> dict[str, str]:
    """Read existing identity.env into {KEY: value} dict; missing file → empty dict.
    Handles both single-quoted values (with ANSI-C escape unescape) and unquoted tokens.
    """
    if not path.is_file():
        return {}
    out: dict[str, str] = {}
    for m in ENV_LINE_RE.finditer(path.read_text()):
        quoted, bare = m.group(2), m.group(3)
        out[m.group(1)] = _unescape(quoted) if quoted is not None else bare
    return out


def _write_atomic(target: Path, content: str) -> None:
    """Write to a tempfile in the same dir, then os.replace (POSIX atomic rename)."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".identity.", dir=str(target.parent))
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.chmod(tmp, 0o644)
        os.replace(tmp, target)
    except Exception:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def _diff_report(old: dict[str, str], new_parsed: dict, commit: str) -> str:
    """Human-readable diff for Telegram reply. Each line is one field."""
    lines = []

    def cmp_str(label: str, old_val: str, new_val: str) -> None:
        if old_val == new_val:
            lines.append(f"{label}: unchanged")
        elif not old_val:
            lines.append(f"{label}: set to '{new_val[:60]}'")
        else:
            short_old = old_val[:60] + ("…" if len(old_val) > 60 else "")
            short_new = new_val[:60] + ("…" if len(new_val) > 60 else "")
            lines.append(f"{label}: '{short_old}' → '{short_new}'")

    cmp_str("ROLE", old.get("MOLTBOT_ROLE", ""), new_parsed["role"])
    cmp_str("TAGLINE", old.get("MOLTBOT_TAGLINE", ""), new_parsed["tagline"])
    cmp_str("CONTACT", old.get("MOLTBOT_CONTACT", ""), new_parsed["contact"])
    cmp_str("TONE", old.get("MOLTBOT_TONE", ""), new_parsed["tone"])

    old_topic_count = int(old.get("MOLTBOT_TOPICS_COUNT", "0") or "0")
    new_topic_count = len(new_parsed["topics"])
    if old_topic_count == new_topic_count:
        lines.append(f"TOPICS: {new_topic_count} items, unchanged count")
    else:
        delta = new_topic_count - old_topic_count
        sign = "+" if delta > 0 else ""
        lines.append(f"TOPICS: {old_topic_count} → {new_topic_count} ({sign}{delta})")

    old_commit = old.get("MOLTBOT_IDENTITY_COMMIT", "")
    if old_commit == commit and old_commit:
        lines.append(f"identity already up-to-date (commit {commit})")
    return "\n".join(lines)


def make_handler(cfg: Config):
    async def handler(update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        try:
            # 1. Snapshot current identity.env for diff
            old = _read_current_env(cfg.identity_env_file)

            # 2. Touch trigger so path-unit fires runner
            await update.message.reply_text("pulling docs/IDENTITY.md from repo…")
            cfg.identity_pull_trigger_file.parent.mkdir(parents=True, exist_ok=True)
            cfg.identity_pull_trigger_file.touch()

            # 3. Wait for runner to consume trigger (ExecStartPost removes it)
            consumed = await wait_consumed(cfg.identity_pull_trigger_file, MAX_WAIT)
            if not consumed:
                await update.message.reply_text(
                    f"pull exceeded {int(MAX_WAIT)}s, aborting (identity.env unchanged)"
                )
                return

            # 4. Read + parse the freshly checked-out file
            md_path = cfg.identity_repo_path / "docs" / "IDENTITY.md"
            if not md_path.is_file():
                await update.message.reply_text(
                    f"{md_path} not present after pull — identity.env unchanged"
                )
                return
            try:
                parsed = parse(md_path.read_text())
            except ParseError as e:
                await update.message.reply_text(
                    f"parse failed: {type(e).__name__}: {e}\nidentity.env unchanged"
                )
                return

            # 5. Look up the commit SHA that the file was just checked out FROM.
            # The runner does `git checkout origin/main -- docs/IDENTITY.md` which extracts
            # one file but does NOT move HEAD. So `rev-parse HEAD` would return whatever
            # the working tree was on before (potentially stale). Use `origin/main` — the
            # ref that just supplied the file's content.
            try:
                r = subprocess.run(
                    ["git", "-C", str(cfg.identity_repo_path), "rev-parse", "--short", "origin/main"],
                    capture_output=True, text=True, timeout=5, check=True,
                )
                commit = r.stdout.strip() or "unknown"
            except (subprocess.SubprocessError, subprocess.TimeoutExpired):
                commit = "unknown"

            # 6. Atomic write
            now_iso = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            new_content = to_env(parsed, commit, now_iso)
            try:
                _write_atomic(cfg.identity_env_file, new_content)
            except OSError as e:
                await update.message.reply_text(f"write failed: {e} (identity.env unchanged)")
                return

            # 7. Diff and report
            diff = _diff_report(old, parsed, commit)
            text = f"*identity refreshed* (commit `{commit}`)\n```\n{diff}\n```"
            if len(text) > TG_LIMIT:
                text = text[:TG_LIMIT] + "…"
            await update.message.reply_markdown(text)
        except Exception as e:
            log.exception("refreshidentity failed")
            await update.message.reply_text(f"refreshidentity error: {type(e).__name__}: {e}")

    return handler
