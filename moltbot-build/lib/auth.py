"""Whitelist decorator. Unauthorized users get a silent reject (logged, no reply)."""
from __future__ import annotations

import functools
import logging
from typing import Awaitable, Callable

from telegram import Update
from telegram.ext import ContextTypes

log = logging.getLogger(__name__)

Handler = Callable[[Update, ContextTypes.DEFAULT_TYPE], Awaitable[None]]


def restricted(authorized_id: int) -> Callable[[Handler], Handler]:
    def decorator(fn: Handler) -> Handler:
        @functools.wraps(fn)
        async def wrapped(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
            user = update.effective_user
            if user is None or user.id != authorized_id:
                uid = user.id if user else "?"
                uname = user.username if user else "?"
                log.warning("rejected unauthorized user id=%s username=%s", uid, uname)
                return
            await fn(update, context)
        return wrapped
    return decorator
