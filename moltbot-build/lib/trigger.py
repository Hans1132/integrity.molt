"""Shared helper: wait until a trigger file is consumed (deleted) by a path-unit runner."""
from __future__ import annotations

import asyncio
from pathlib import Path


async def wait_consumed(trigger: Path, max_wait: float, poll_interval: float = 1.0) -> bool:
    """Poll until trigger file no longer exists, or max_wait seconds elapsed.

    Returns True if the file was removed within the window (the runner consumed it),
    False on timeout.

    Raises ValueError if poll_interval <= 0 or max_wait < 0. max_wait == 0 returns
    immediately based on a single existence check (degenerate but well-defined).
    """
    if poll_interval <= 0:
        raise ValueError(f"poll_interval must be > 0, got {poll_interval}")
    if max_wait < 0:
        raise ValueError(f"max_wait must be >= 0, got {max_wait}")
    if max_wait == 0:
        return not trigger.exists()
    waited = 0.0
    while waited < max_wait:
        if not trigger.exists():
            return True
        await asyncio.sleep(poll_interval)
        waited += poll_interval
    return False
