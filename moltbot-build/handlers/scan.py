"""/scan <mint> — call the local x402 server's /scan/iris (free tier, loopback-exempt)."""
from __future__ import annotations

import json
import logging
import re

from telegram import Update
from telegram.ext import ContextTypes

from lib.config import Config
from lib.x402_client import X402Client

log = logging.getLogger(__name__)

# Base58 alphabet excludes 0, O, I, l. Solana pubkeys are 32-44 chars.
BASE58_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")


def make_handler(cfg: Config):
    client = X402Client(cfg.x402_base_url)

    async def handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        args = context.args or []
        if not args:
            await update.message.reply_text("usage: /scan <token-mint-address>")
            return
        mint = args[0].strip()
        if not BASE58_RE.match(mint):
            await update.message.reply_text(
                "input does not look like a Solana mint (32-44 base58 chars)"
            )
            return
        try:
            status, body, elapsed = await client.scan_iris(mint)
            if status >= 500:
                await update.message.reply_text(f"x402 server error: HTTP {status}")
                return
            risk = (
                body.get("iris_score")
                or body.get("risk_score")
                or body.get("score")
                if isinstance(body, dict) else None
            )
            risk_str = f"{risk}" if risk is not None else "(no risk score in response)"
            payload = json.dumps(body, indent=2, default=str) if isinstance(body, dict) else str(body)
            if len(payload) > 500:
                payload = payload[:500] + "… (truncated)"
            # Plain text reply: payload may contain backticks/asterisks that would
            # break Markdown parsing. Operator readability is fine without formatting.
            text = (
                f"scan iris {mint[:8]}…{mint[-4:]}\n"
                f"http={status} · risk={risk_str} · {elapsed:.2f}s\n"
                f"{payload}"
            )
            await update.message.reply_text(text)
        except Exception as e:
            log.exception("scan failed")
            await update.message.reply_text(f"scan error: {type(e).__name__}: {e}")

    return handler
