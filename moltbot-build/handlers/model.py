"""/model — read/list/set the LLM model that heartbeat.sh will use on next run."""
from __future__ import annotations

import logging

from telegram import Update
from telegram.ext import ContextTypes

from lib import llm_config
from lib.config import Config

log = logging.getLogger(__name__)


def _list_text(allowed: list[str]) -> str:
    if not allowed:
        return "(no allowed models configured)"
    return "\n".join(f"- `{m}`" for m in allowed)


def make_handler(cfg: Config):
    async def handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        args = context.args or []
        try:
            current = llm_config.current_model(cfg.llm_config_file)
            allowed = llm_config.allowed_models(cfg.allowed_models_file)

            if not args:
                cur = f"`{current}`" if current else "(unset)"
                await update.message.reply_markdown(
                    f"*current model:* {cur}\n*allowed models:*\n{_list_text(allowed)}"
                )
                return

            sub = args[0].lower()
            if sub == "list":
                await update.message.reply_markdown(f"*allowed models:*\n{_list_text(allowed)}")
                return

            if sub == "set":
                if len(args) < 2:
                    await update.message.reply_text("usage: /model set <name>")
                    return
                name = args[1].strip()
                if name not in allowed:
                    await update.message.reply_text(
                        f"{name} not in allowed list, see /model list"
                    )
                    return
                llm_config.set_model(cfg.llm_config_file, name)
                await update.message.reply_markdown(f"model set to `{name}`")
                return

            await update.message.reply_text("usage: /model | /model list | /model set <name>")
        except Exception as e:
            log.exception("model failed")
            await update.message.reply_text(f"model error: {type(e).__name__}: {e}")

    return handler
