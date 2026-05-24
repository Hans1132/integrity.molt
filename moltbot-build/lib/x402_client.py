"""Thin client for the local x402 server. 127.0.0.1 calls bypass rate limiter."""
from __future__ import annotations

import time
from typing import Any

import httpx

HEALTH_PATHS = ("/healthz", "/health")
TIMEOUT = httpx.Timeout(connect=2.0, read=10.0, write=5.0, pool=2.0)


class X402Client:
    def __init__(self, base_url: str) -> None:
        self._base = base_url.rstrip("/")

    async def health(self) -> tuple[bool, str]:
        """Return (is_up, hint).

        Semantics:
          - 2xx on a health endpoint → up.
          - 4xx → endpoint doesn't exist; try the next probe.
          - 5xx or timeout on the final probe → down.
        Fallback probe is /scan/iris (no params), which returns 400 if the server is alive
        (request validation rejects the empty token) — so any 4xx there counts as "up".
        """
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            for p in HEALTH_PATHS:
                try:
                    r = await client.get(f"{self._base}{p}")
                    if 200 <= r.status_code < 300:
                        return True, f"{p}={r.status_code}"
                    if r.status_code >= 500:
                        return False, f"{p}={r.status_code}"
                    # 3xx/4xx → endpoint missing or unexpected, fall through
                except httpx.HTTPError:
                    continue
            try:
                r = await client.get(f"{self._base}/scan/iris")
                if r.status_code < 500:
                    return True, f"/scan/iris={r.status_code} (server alive)"
                return False, f"/scan/iris={r.status_code}"
            except httpx.HTTPError as e:
                return False, f"unreachable: {type(e).__name__}"

    async def scan_iris(self, token_mint: str) -> tuple[int, Any, float]:
        url = f"{self._base}/scan/iris"
        start = time.monotonic()
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            r = await client.get(url, params={"token": token_mint})
            elapsed = time.monotonic() - start
            try:
                return r.status_code, r.json(), elapsed
            except ValueError:
                return r.status_code, {"raw": r.text[:500]}, elapsed
