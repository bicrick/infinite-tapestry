"""Viewer reactions: a fixed emoji set, token-bucket limited per connection and per IP,
aggregated server-side and broadcast as one small batched-count message (cheap at 1000+ viewers).
Per-strip counts are kept for 'most laughed' / variable scene length and mirrored to Supabase."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import urllib.request
from collections import defaultdict
from typing import Any, Callable

logger = logging.getLogger(__name__)

EMOJI = ("😂", "🔥", "🤯", "❤️", "💀")
KEYS = ("lol", "fire", "mind", "love", "dead")  # stable ascii keys used on the wire/DB


class Bucket:
    __slots__ = ("tokens", "at")

    def __init__(self, burst: float) -> None:
        self.tokens, self.at = burst, time.monotonic()

    def take(self, rate: float, burst: float) -> bool:
        now = time.monotonic()
        self.tokens = min(burst, self.tokens + (now - self.at) * rate)
        self.at = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False


class Reactions:
    def __init__(self, rate: float = 1.0, burst: float = 5, ip_rate: float = 4.0, ip_burst: float = 15,
                 batch_s: float = 0.5, persist_s: float = 20.0) -> None:
        self.rate, self.burst, self.ip_rate, self.ip_burst = rate, burst, ip_rate, ip_burst
        self.batch_s, self.persist_s = batch_s, persist_s
        self.sess: dict[str, Bucket] = {}
        self.ips: dict[str, Bucket] = {}
        self.pending: dict[str, int] = defaultdict(int)
        self.by_strip: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self.dirty: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self.scene_title: dict[int, str] = {}

    def add(self, sid: str, ip: str, key: Any, strip: int | None, title: str = "") -> bool:
        if key not in KEYS:
            return False
        s = self.sess.get(sid) or self.sess.setdefault(sid, Bucket(self.burst))
        i = self.ips.get(ip) or self.ips.setdefault(ip, Bucket(self.ip_burst))
        if not s.take(self.rate, self.burst):
            return False
        if not i.take(self.ip_rate, self.ip_burst):
            return False
        self.pending[key] += 1
        if strip is not None and strip >= 0:
            self.by_strip[strip][key] += 1
            self.dirty[strip][key] += 1
            if title:
                self.scene_title[strip] = title[:120]
        return True

    def forget(self, sid: str) -> None:
        self.sess.pop(sid, None)

    def take_batch(self) -> dict[str, int] | None:
        if not self.pending:
            return None
        out = dict(self.pending)
        self.pending.clear()
        return out

    def take_dirty(self) -> list[dict]:
        rows = [{"strip": k, "counts": dict(v), "title": self.scene_title.get(k, "")} for k, v in self.dirty.items()]
        self.dirty.clear()
        if len(self.by_strip) > 20000:  # bound memory; DB keeps the history
            for k in sorted(self.by_strip)[:10000]:
                self.by_strip.pop(k, None)
                self.scene_title.pop(k, None)
        return rows

    def gc(self) -> None:
        now = time.monotonic()
        for d in (self.sess, self.ips):
            for k in [k for k, b in d.items() if now - b.at > 120]:
                d.pop(k, None)

    async def run(self, broadcast: Callable[[Any], None]) -> None:
        last_persist = last_gc = time.monotonic()
        while True:
            await asyncio.sleep(self.batch_s)
            try:
                b = self.take_batch()
                if b:
                    broadcast({"type": "react", "c": b})
                now = time.monotonic()
                if now - last_persist >= self.persist_s:
                    last_persist = now
                    rows = self.take_dirty()
                    if rows:
                        await asyncio.to_thread(persist, rows)
                if now - last_gc >= 60:
                    last_gc = now
                    self.gc()
            except Exception:
                logger.exception("reactions loop")


def persist(rows: list[dict]) -> None:
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        return
    req = urllib.request.Request(url.rstrip("/") + "/rest/v1/rpc/add_reactions", method="POST",
                                 data=json.dumps({"p_rows": rows}).encode(),
                                 headers={"apikey": key, "authorization": "Bearer " + key,
                                          "content-type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=8).read()
    except Exception as e:  # counts stay in memory; best-effort mirror
        logger.warning("add_reactions failed: %s", e)
