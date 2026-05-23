"""Shared helper: wait until a trigger file is consumed (deleted) by a path-unit runner."""
from __future__ import annotations

import asyncio
from pathlib import Path


async def wait_consumed(trigger: Path, max_wait: float, poll_interval: float = 1.0) -> bool:
    """Poll until trigger file no longer exists, or max_wait seconds elapsed.

    Returns True if the file was removed within the window (the runner consumed it),
    False on timeout.
    """
    waited = 0.0
    while waited < max_wait:
        if not trigger.exists():
            return True
        await asyncio.sleep(poll_interval)
        waited += poll_interval
    return False
