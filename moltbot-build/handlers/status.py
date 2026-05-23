"""/status — bot uptime, heartbeat freshness, x402 health, current model, today's report count."""
from __future__ import annotations

import datetime as dt
import logging
import re
import time
from pathlib import Path

from telegram import Update
from telegram.ext import ContextTypes

from lib.config import Config
from lib.llm_config import current_model
from lib.x402_client import X402Client

log = logging.getLogger(__name__)

_STARTED_AT = time.monotonic()


def _fmt_uptime(seconds: float) -> str:
    seconds = int(seconds)
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, _ = divmod(rem, 60)
    parts = []
    if days:
        parts.append(f"{days}d")
    if hours or days:
        parts.append(f"{hours}h")
    parts.append(f"{minutes}m")
    return " ".join(parts)


def _heartbeat_age(marker: Path) -> str:
    if not marker.is_file():
        return "no marker file yet"
    age = time.time() - marker.stat().st_mtime
    when = dt.datetime.fromtimestamp(marker.stat().st_mtime, tz=dt.timezone.utc)
    return f"{when.strftime('%Y-%m-%d %H:%M UTC')} ({int(age // 60)}m ago)"


def _identity_summary(identity_env: Path) -> str:
    """Return 'role (commit, Xh ago)' or '(unset)' if identity.env missing/empty."""
    if not identity_env.is_file():
        return "(unset)"
    text = identity_env.read_text()
    role_m = re.search(r"^MOLTBOT_ROLE='((?:[^']|'\\'')*?)'", text, re.MULTILINE)
    commit_m = re.search(r"^MOLTBOT_IDENTITY_COMMIT='((?:[^']|'\\'')*?)'", text, re.MULTILINE)
    updated_m = re.search(r"^MOLTBOT_IDENTITY_UPDATED_AT='((?:[^']|'\\'')*?)'", text, re.MULTILINE)
    role = role_m.group(1) if role_m else "(unknown)"
    commit = commit_m.group(1) if commit_m else "?"
    age = "?"
    if updated_m:
        try:
            ts = dt.datetime.strptime(updated_m.group(1), "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=dt.timezone.utc
            )
            delta = dt.datetime.now(dt.timezone.utc) - ts
            hours = int(delta.total_seconds() // 3600)
            if hours < 1:
                age = f"{int(delta.total_seconds() // 60)}m ago"
            elif hours < 48:
                age = f"{hours}h ago"
            else:
                age = f"{hours // 24}d ago"
        except ValueError:
            pass
    return f"{role} (commit {commit}, {age})"


def _reports_today(reports_dir: Path) -> int:
    if not reports_dir.is_dir():
        return 0
    today = dt.date.today()
    return sum(
        1
        for f in reports_dir.iterdir()
        if f.is_file()
        and dt.date.fromtimestamp(f.stat().st_mtime) == today
    )


def make_handler(cfg: Config):
    client = X402Client(cfg.x402_base_url)

    async def handler(update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        try:
            uptime = _fmt_uptime(time.monotonic() - _STARTED_AT)
            heartbeat = _heartbeat_age(cfg.heartbeat_marker_file)
            up, hint = await client.health()
            health_str = f"{'up' if up else 'down'} ({hint})"
            model = current_model(cfg.llm_config_file) or "(unset)"
            reports = _reports_today(cfg.scanner_reports_dir)
            text = (
                f"*bot uptime:* {uptime}\n"
                f"*last heartbeat.sh:* {heartbeat}\n"
                f"*x402 service:* {health_str}\n"
                f"*llm model:* `{model}`\n"
                f"*identity:* {_identity_summary(cfg.identity_env_file)}\n"
                f"*scan reports today:* {reports}"
            )
            await update.message.reply_markdown(text)
        except Exception as e:
            log.exception("status failed")
            await update.message.reply_text(f"status error: {type(e).__name__}: {e}")

    return handler


# fromtimestamp(stat) returns local-time date; for mtime aggregation purposes
# (which is operator-facing, not legal) that's good enough on a UTC-set VPS.
