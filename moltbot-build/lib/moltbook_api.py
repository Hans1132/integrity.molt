"""Thin async client for moltbook.com REST API. Mirrors heartbeat.sh auth pattern.

Note on user-posts: empirical probing (2026-05-23) shows moltbook has no server-side
"list posts by user" endpoint. All filter params on /posts (author, author_name,
username, by, user, author_id, agent_id, ...) are silently ignored. The only routes
that work for our case are:
  - /posts?limit=N&cursor=...   generic mixed-author paginated feed
  - /home                       activity_on_your_posts (only posts with recent activity)
  - /agents/me                  the bot's own profile (posts_count, but no list)
So user_posts() does client-side filtering: page through /posts, keep only
author.name == username, stop when N matched or MAX_PAGES reached. Fallback to /home.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0)
PAGE_SIZE = 50
MAX_PAGES = 5  # cap: 5 * 50 = 250 posts scanned before giving up


class MoltbookAPI:
    def __init__(self, base_url: str, api_key: str) -> None:
        self._base = base_url.rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        }

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> tuple[int, Any]:
        url = f"{self._base}{path}"
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            r = await client.get(url, headers=self._headers, params=params)
            try:
                return r.status_code, r.json()
            except ValueError:
                return r.status_code, {"raw": r.text[:500]}

    async def user_posts(self, username: str, limit: int) -> tuple[int, Any]:
        """Page through /posts client-side; filter by author.name == username.
        Returns (200, {posts: [...], scanned: N, pages: K, source: 'feed'|'home'}) on success.
        On the very first page error, surface the HTTP status to the caller.
        """
        matched: list[dict] = []
        cursor: str | None = None
        scanned = 0
        pages = 0
        for _ in range(MAX_PAGES):
            params: dict[str, Any] = {"limit": PAGE_SIZE}
            if cursor:
                params["cursor"] = cursor
            status, body = await self._get("/posts", params)
            if status >= 400:
                if pages == 0:
                    return status, body
                break
            pages += 1
            posts = body.get("posts") if isinstance(body, dict) else None
            if not isinstance(posts, list) or not posts:
                break
            scanned += len(posts)
            for p in posts:
                author = (p.get("author") or {}).get("name")
                if author == username:
                    matched.append(p)
                    if len(matched) >= limit:
                        return 200, {"posts": matched, "scanned": scanned, "pages": pages, "source": "feed"}
            cursor = body.get("next_cursor")
            if not cursor or not body.get("has_more", True):
                break

        if matched:
            return 200, {"posts": matched, "scanned": scanned, "pages": pages, "source": "feed"}

        # No matches in feed scan. Try /home.activity_on_your_posts (posts with notifications).
        h_status, h_body = await self._get("/home")
        activity = []
        if h_status < 400 and isinstance(h_body, dict):
            activity = h_body.get("activity_on_your_posts") or []
        adapted = [
            {
                "id": e.get("post_id"),
                "title": e.get("post_title"),
                "created_at": e.get("updated_at") or e.get("created_at"),
                "comments": e.get("new_notification_count"),
                "submolt": "?",
                "author": {"name": username},
            }
            for e in activity[:limit]
        ]

        # Diagnostic: pull /agents/me to surface posts_count + last_active for the
        # operator. If posts_count > 0 but feed scan + activity both empty, the bot's
        # posts exist but are older than the feed window (moltbook /posts is capped
        # at ~2 days; no documented user-posts endpoint exists).
        m_status, m_body = await self._get("/agents/me")
        diag = ""
        if m_status < 400 and isinstance(m_body, dict):
            ag = m_body.get("agent") or {}
            pc = ag.get("posts_count")
            la = ag.get("last_active")
            if pc is not None:
                diag = f" /agents/me: posts_count={pc}, last_active={la}"

        if adapted:
            return 200, {"posts": adapted, "scanned": scanned, "pages": pages, "source": "home",
                         "note": f"feed scan found 0 by {username}; showing {len(adapted)} from /home.activity_on_your_posts.{diag}"}
        return 200, {"posts": [], "scanned": scanned, "pages": pages, "source": "feed",
                     "note": f"no posts by {username} in {scanned} feed entries (moltbook feed is ~2-day capped, no user-posts endpoint).{diag}"}

    async def post_by_id(self, post_id: str) -> tuple[int, Any]:
        return await self._get(f"/posts/{post_id}")

    async def feed(self, limit: int = 20) -> tuple[int, Any]:
        return await self._get("/feed", {"limit": limit})
