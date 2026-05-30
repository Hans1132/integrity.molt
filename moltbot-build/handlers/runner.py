"""/run-now and /logs handlers."""
from __future__ import annotations

import asyncio
import logging
import subprocess

from telegram import Update
from telegram.ext import ContextTypes

from lib.config import Config
from lib.trigger import wait_consumed

log = logging.getLogger(__name__)

MAX_WAIT = 120.0
LOG_DEFAULT_N = 20
LOG_MAX_N = 100
TG_LIMIT = 4000


def make_run_now(cfg: Config):
    async def handler(update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
        try:
            await update.message.reply_text("triggering heartbeat…")
            cfg.heartbeat_trigger_file.parent.mkdir(parents=True, exist_ok=True)
            cfg.heartbeat_trigger_file.touch()
            consumed = await wait_consumed(cfg.heartbeat_trigger_file, MAX_WAIT)
            if not consumed:
                await update.message.reply_text(
                    f"heartbeat exceeded {int(MAX_WAIT)}s, may still be running in background"
                )
                return
            # Pull the runner unit's recent journal. Run in a worker thread so the
            # async event loop isn't blocked by subprocess.run (which is sync).
            try:
                result = await asyncio.to_thread(
                    subprocess.run,
                    ["journalctl", f"_SYSTEMD_UNIT={cfg.heartbeat_runner_unit}", "-n", "30",
                     "--no-pager", "--output=short-iso"],
                    capture_output=True, text=True, timeout=10,
                )
                tail = result.stdout.strip() or "(no log lines)"
            except (subprocess.TimeoutExpired, FileNotFoundError) as e:
                tail = f"(journal read failed: {type(e).__name__})"
            if len(tail) > TG_LIMIT:
                tail = tail[-TG_LIMIT:]
            # Send as plain text (no Markdown) so any backticks/asterisks in log lines
            # can't break Telegram's parser.
            await update.message.reply_text(f"heartbeat finished.\n{tail}")
        except Exception as e:
            log.exception("run_now failed")
            await update.message.reply_text(f"run-now error: {type(e).__name__}: {e}")

    return handler


def make_logs(_cfg: Config):
    async def handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        args = context.args or []
        try:
            n = LOG_DEFAULT_N
            if args:
                try:
                    n = max(1, min(LOG_MAX_N, int(args[0])))
                except ValueError:
                    pass
            # Try system service first; if running under --user, fall back.
            for cmd in (
                ["journalctl", "_SYSTEMD_UNIT=moltbot.service", "-n", str(n),
                 "--no-pager", "--output=short-iso"],
                ["journalctl", "--user-unit", "moltbot", "-n", str(n),
                 "--no-pager", "--output=short-iso"],
            ):
                try:
                    r = await asyncio.to_thread(
                        subprocess.run, cmd, capture_output=True, text=True, timeout=10,
                    )
                    if r.returncode == 0 and r.stdout.strip():
                        out = r.stdout.strip()
                        if len(out) > TG_LIMIT:
                            out = out[-TG_LIMIT:]
                        # Plain text (no Markdown) to avoid parse failures on log content.
                        await update.message.reply_text(out)
                        return
                except (subprocess.TimeoutExpired, FileNotFoundError):
                    continue
            await update.message.reply_text("(no log lines accessible)")
        except Exception as e:
            log.exception("logs failed")
            await update.message.reply_text(f"logs error: {type(e).__name__}: {e}")

    return handler
