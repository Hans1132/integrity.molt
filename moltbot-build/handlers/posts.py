"""/posts [N] and /report [YYYY-MM-DD] — read-only views into the bot's moltbook output."""
from __future__ import annotations

import datetime as dt
import logging
import re

from telegram import Update
from telegram.ext import ContextTypes

from lib.config import Config
from lib.moltbook_api import MoltbookAPI

log = logging.getLogger(__name__)

DEFAULT_N = 5
MAX_N = 20
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TG_LIMIT = 4000


def _parse_n(args: list[str]) -> int:
    if not args:
        return DEFAULT_N
    try:
        n = int(args[0])
    except ValueError:
        return DEFAULT_N
    return max(1, min(MAX_N, n))


def _render(post: dict) -> str:
    ts = post.get("created_at", "?")
    community = post.get("submolt") or post.get("community") or "?"
    upv = post.get("upvotes") or post.get("score") or 0
    cmts = post.get("comment_count") or post.get("comments") or 0
    title = (post.get("title") or "(untitled)")[:120]
    pid = post.get("id", "?")
    flags = post.get("flags") or []
    flag_str = f" [{','.join(flags)}]" if flags else ""
    return (
        f"[{ts}] m/{community} · {upv}↑ {cmts}💬{flag_str}\n"
        f"{title}\n"
        f"https://moltbook.com/p/{pid}\n---"
    )


def _extract_posts(body) -> list[dict]:
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        posts = body.get("posts") or body.get("data") or []
        if isinstance(posts, list):
            return posts
    return []


def make_handler(cfg: Config):
    api = MoltbookAPI(cfg.moltbook_api_base, cfg.moltbook_api_key)

    async def handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        try:
            n = _parse_n(context.args or [])
            status, body = await api.user_posts(cfg.own_moltbook_user, n)
            if status >= 400:
                hint = (body.get("message") or body.get("error") or "no detail") if isinstance(body, dict) else str(body)[:200]
                await update.message.reply_text(f"moltbook API returned {status}: {hint}")
                return
            posts = _extract_posts(body)
            source = body.get("source") if isinstance(body, dict) else None
            scanned = body.get("scanned") if isinstance(body, dict) else None
            pages = body.get("pages") if isinstance(body, dict) else None
            note = body.get("note") if isinstance(body, dict) else None

            header_bits = []
            if source:
                header_bits.append(f"source={source}")
            if scanned is not None:
                header_bits.append(f"scanned={scanned}")
            if pages is not None:
                header_bits.append(f"pages={pages}")
            header = f"[{' · '.join(header_bits)}]\n" if header_bits else ""

            if not posts:
                msg = note or f"no posts by {cfg.own_moltbook_user} found in {scanned or 0} scanned"
                await update.message.reply_text(f"{header}{msg}")
                return
            chunks = [_render(p) for p in posts[:n]]
            tail = f"\n_{note}_" if note else ""
            text = f"{header}{chr(10).join(chunks)}{tail}"
            if len(text) > TG_LIMIT:
                text = text[:TG_LIMIT] + "… (truncated)"
            await update.message.reply_text(text)
        except Exception as e:
            log.exception("posts failed")
            await update.message.reply_text(f"posts error: {type(e).__name__}: {e}")

    return handler


def make_report_handler(cfg: Config):
    """/report [YYYY-MM-DD] — find the daily-transparency-report post for that date."""
    api = MoltbookAPI(cfg.moltbook_api_base, cfg.moltbook_api_key)

    async def handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        args = context.args or []
        try:
            if args and DATE_RE.match(args[0]):
                target = args[0]
            else:
                target = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")

            # Pull a wider window of posts and filter by date + title hint.
            status, body = await api.user_posts(cfg.own_moltbook_user, MAX_N)
            if status >= 400:
                hint = (body.get("message") or body.get("error") or "no detail") if isinstance(body, dict) else str(body)[:200]
                await update.message.reply_text(f"moltbook API returned {status}: {hint}")
                return
            posts = _extract_posts(body)
            match = None
            for p in posts:
                created = (p.get("created_at") or "")[:10]
                title = (p.get("title") or "").lower()
                if created == target and ("transparency" in title or "daily" in title or "report" in title):
                    match = p
                    break
            if match is None:
                await update.message.reply_text(
                    f"no report posted for {target} yet — try /run-now to trigger heartbeat"
                )
                return
            body_text = match.get("content") or match.get("body") or "(no body)"
            text = f"*{match.get('title', '(untitled)')}*\n\n{body_text}"
            if len(text) > TG_LIMIT:
                text = text[:TG_LIMIT] + "… (truncated)"
            await update.message.reply_markdown(text)
        except Exception as e:
            log.exception("report failed")
            await update.message.reply_text(f"report error: {type(e).__name__}: {e}")

    return handler
