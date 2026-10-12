"""Vision-aware scene transitions (klein).

While a scene holds, look at what's actually on screen (small JPEG of the visible window) and ask
Auto (Haiku) how to get to the next queued scene: a shared bridge object, a material morph, a
cinematic pass-through (doorway, fog, crowd) or a plain blend for close scenes. Bridge strips are
inserted in front of the next scene. Bakeoff: tapestry-samples/blend2 + blend3.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import re

from .prompts import make_scene

logger = logging.getLogger(__name__)

SYSTEM = (
    "You direct transitions in an endless side-scrolling AI panorama. You see the current visible window (left=older, "
    "right=newest edge). Pick the best transition mode for how far apart the two scenes are: \"bridge\" (a shared object "
    "that belongs to both worlds), \"morph\" (keep the shapes/layout you see, change the material into the new world), "
    "\"passthrough\" (a cinematic doorway, window, fog bank or crowd you pass through), or \"interpolate\" (close scenes: "
    "smooth blend, no bridge). For bridge/morph/passthrough write 1-2 strip prompts (natural language, 1-2 sentences each) "
    "that grow out of the right edge and arrive in the next scene. Never sexual content or minors. "
    "Reply ONLY JSON: {\"mode\":\"...\",\"bridge\":[\"...\"]}"
)


class Transitioner:
    def __init__(self, director, generator, interpreter) -> None:
        self.director, self.generator, self.interpreter = director, generator, interpreter
        self._done: set = set()
        self.last: dict = {}

    def _next(self):
        with self.director._lock:
            if self.director._target is not None or not self.director._queue:
                return None, None
            nxt = self.director._queue[0]
            cur = self.director._current
        if nxt.get("bridge") or nxt.get("id") in self._done:
            return None, None
        return cur, nxt

    def _plan(self, cur: dict, nxt: dict, jpeg: bytes) -> dict:
        from .interpreter import DEFAULT_MODEL, FALLBACK_MODEL

        user = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                             "data": base64.b64encode(jpeg).decode()}},
                {"type": "text", "text": f"Current scene: {cur.get('title') or cur.get('prompt', '')[:80]}. "
                                         f"Next scene: {nxt.get('title', '')}: {nxt.get('prompt', '')[:400]}"}]
        for m in dict.fromkeys([DEFAULT_MODEL, FALLBACK_MODEL]):
            try:
                txt = self.interpreter._call(m, user, system=SYSTEM, max_tokens=800, _think=False)
                mm = re.search(r"\{.*\}", txt, re.S)
                return json.loads(mm.group(0)) if mm else {}
            except Exception as e:  # noqa: BLE001
                logger.warning("transition plan %s failed: %s", m, str(e)[:120])
        return {}

    def step(self) -> None:
        cur, nxt = self._next()
        if nxt is None:
            return
        self._done.add(nxt.get("id"))
        if len(self._done) > 500:
            self._done = {nxt.get("id")}
        canvas = self.generator.canvas
        cw = min(canvas.width, 2048)
        v = canvas.crop((canvas.width - cw, 0, canvas.width, canvas.height)).resize((cw // 4, 256))
        b = io.BytesIO()
        v.convert("RGB").save(b, "JPEG", quality=70)
        plan = self._plan(cur or {}, nxt, b.getvalue())
        from .guard import is_disallowed

        mode = str(plan.get("mode", ""))[:20]
        bridge = [str(p)[:600] for p in (plan.get("bridge") or []) if isinstance(p, str) and p.strip()][:2]
        bridge = [p for p in bridge if not is_disallowed(p)]
        self.last = {"mode": mode, "bridge": bridge, "to": nxt.get("title")}
        if mode == "interpolate" or not bridge:
            return
        if nxt.get("origin") == "user":
            bridge = bridge[:1]  # ideas stay fast: at most one bridge strip
        scenes = [make_scene(p, transition=1, hold=0, origin="auto", title=nxt.get("title", "")) for p in bridge]
        for s in scenes:
            s["bridge"] = True
        with self.director._lock:
            q = self.director._queue
            if q and q[0] is nxt:
                q[0:0] = scenes
                nxt["transition"] = 1
        logger.info("transition %s -> %s: %s (%d bridge strips)", (cur or {}).get("title"), nxt.get("title"), mode, len(scenes))

    async def run(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self.step)
            except Exception:  # noqa: BLE001
                logger.exception("transitioner tick failed")
            await asyncio.sleep(1.0)
