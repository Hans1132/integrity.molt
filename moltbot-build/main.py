"""Moltbot Telegram control bot — entrypoint."""
from __future__ import annotations

import logging
import sys

from telegram import Update
from telegram.ext import Application, ApplicationBuilder, CommandHandler

from handlers import identity, model, posts, runner, scan, status
from lib import config
from lib.auth import restricted

VERSION = "0.1.0"

HELP_TEXT = (
    f"moltbot v{VERSION} — private control plane for the integrity_molt agent.\n\n"
    "/status — bot uptime, last heartbeat, x402 health, current model, today's reports\n"
    "/posts [N] — list N latest posts from u/integrity_molt (default 5, max 20)\n"
    "/report [YYYY-MM-DD] — fetch the daily transparency report (default today)\n"
    "/scan <mint> — call x402 /scan/iris on a Solana mint address\n"
    "/model — show current LLM model and allowed list\n"
    "/model list — show allowed models only\n"
    "/model set <name> — change the model heartbeat.sh will use next run\n"
    "/refreshidentity — pull docs/IDENTITY.md from repo, refresh /etc/moltbot/identity.env\n"
    "/runnow — trigger /root/heartbeat.sh via path-unit\n"
    "/logs [N] — tail bot journal (default 20, max 100)\n"
    "/help — this message"
)


def _build_app(cfg: config.Config) -> Application:
    app = ApplicationBuilder().token(cfg.telegram_bot_token).build()
    auth = restricted(cfg.authorized_user_id)

    async def start(update: Update, _ctx) -> None:
        await update.message.reply_text(HELP_TEXT)

    app.add_handler(CommandHandler("start", auth(start)))
    app.add_handler(CommandHandler("help", auth(start)))
    app.add_handler(CommandHandler("status", auth(status.make_handler(cfg))))
    app.add_handler(CommandHandler("posts", auth(posts.make_handler(cfg))))
    app.add_handler(CommandHandler("report", auth(posts.make_report_handler(cfg))))
    app.add_handler(CommandHandler("scan", auth(scan.make_handler(cfg))))
    app.add_handler(CommandHandler("model", auth(model.make_handler(cfg))))
    app.add_handler(CommandHandler("refreshidentity", auth(identity.make_handler(cfg))))
    app.add_handler(CommandHandler("runnow", auth(runner.make_run_now(cfg))))
    app.add_handler(CommandHandler("logs", auth(runner.make_logs(cfg))))
    return app


def main() -> int:
    try:
        cfg = config.load()
    except RuntimeError as e:
        print(f"config error: {e}", file=sys.stderr)
        return 2

    logging.basicConfig(
        level=cfg.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # httpx INFO logs include the full request URL — leaks the bot token via /bot<token>/… path.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.info("moltbot v%s starting", VERSION)
    app = _build_app(cfg)
    # run_polling blocks; on stop it returns cleanly.
    app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
