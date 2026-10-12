"""Claude-driven autopilot: keeps the scene queue topped up with ever-evolving
auto scenes when nobody is steering. User scenes always go first."""

from __future__ import annotations

import asyncio
import logging
import os
import random
import time
from typing import Any, Callable

from .prompts import make_scene
from .themes import HeadlineCache, ThemeMemory, brief, has_cliche, mentions_minor, pick_mode

logger = logging.getLogger(__name__)

VARIATIONS = [
    "seen through warped glass", "at a stranger scale", "in shifting iridescent light",
    "slowly melting and reforming", "overgrown with luminous moss", "rendered as a faded fresco",
    "under a second, larger moon", "made of folded paper", "submerged in amber haze",
]


class Autopilot:
    def __init__(
        self,
        director: Any,
        interpreter: Any,
        on_change: Callable[[], None] = lambda: None,
        low_water: int = 3,
        min_interval: float = 2.0,
        token_budget: int | None = None,
        max_calls_per_hour: int = 300,
    ) -> None:
        self.director = director
        self.interpreter = interpreter
        self.on_change = on_change
        self.enabled = True
        self.vibe = ""
        self.low_water = low_water
        self.min_interval = min_interval
        self.token_budget = token_budget if token_budget is not None else int(
            os.environ.get("TAPESTRY_AUTOPILOT_TOKEN_BUDGET", "6000000"))
        self.max_calls_per_hour = max_calls_per_hour
        self._calls: list[float] = []
        self._next_allowed = 0.0
        self._failures = 0
        self.busy = False
        self.last_error = ""
        self.headlines = HeadlineCache()
        self.memory = ThemeMemory(40)
        self.last_mode = ""
        self.pressure: Callable[[], int] = lambda: 0  # waiting pool ideas -> keep Auto filler thin
        self.epoch = 0  # bumped on every user enqueue; stale auto results are discarded

    def state(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled, "vibe": self.vibe, "busy": self.busy,
            "error": self.last_error, "tokens": getattr(self.interpreter, "tokens_used", 0),
            "budget": self.token_budget, "mode": self.last_mode,
        }

    def configure(self, enabled: bool | None = None, vibe: str | None = None) -> None:
        if enabled is not None:
            self.enabled = bool(enabled)
        if vibe is not None:
            self.vibe = str(vibe).strip()[:200]
            self.director.drop_auto()  # regenerate toward the new vibe
            self._next_allowed = 0.0
        self.user_acted()

    def user_acted(self) -> None:
        self.epoch += 1
        self._next_allowed = min(self._next_allowed, time.monotonic() + 1.0)

    def _can_call(self) -> bool:
        now = time.monotonic()
        self._calls = [t for t in self._calls if now - t < 3600]
        return (
            getattr(self.interpreter, "enabled", False)
            and now >= self._next_allowed
            and len(self._calls) < self.max_calls_per_hour
            and getattr(self.interpreter, "tokens_used", 0) < self.token_budget
        )

    def _variation(self) -> None:
        """Claude unavailable and nothing queued: drift with a light variation."""
        d = self.director
        if d.upcoming_count() > 0:
            return
        cur = d.recent(1)[-1]
        base = cur["prompt"].split(", seen through")[0]
        mod = random.choice(VARIATIONS)
        d.add([make_scene(f"{base}, {mod}", cur.get("negative", ""), f"{cur['title'][:40]}, {mod.split()[-1]}",
                          20, 16, source="variation", origin="auto", style=cur.get("style"))])
        self.on_change()

    async def tick(self) -> None:
        d = self.director
        waiting = self.pressure()
        if waiting and hasattr(d, "trim_auto") and d.trim_auto(2):
            self.on_change()
        if not self.enabled or self.busy or d.upcoming_count() >= (2 if waiting else self.low_water):
            return
        if not self._can_call():
            if time.monotonic() >= self._next_allowed or not getattr(self.interpreter, "enabled", False):
                self._variation()
            return
        self.busy = True
        epoch = self.epoch
        self._calls.append(time.monotonic())
        try:
            heads = await asyncio.to_thread(self.headlines.sample, 6)
            mode = pick_mode(have_news=bool(heads))
            self.last_mode = mode
            plan = await asyncio.to_thread(self.interpreter.autoplan, d.recent(8), self.vibe, 2,
                                           brief(mode, heads, self.memory))
            if epoch != self.epoch:
                return  # user steered meanwhile; next tick plans from their scene
            from .guard import is_disallowed

            plan["scenes"] = [x for x in plan["scenes"] if not is_disallowed(x["prompt"])
                              and not has_cliche(x.get("title", "") + " " + x["prompt"])
                              and not mentions_minor(x.get("title", "") + " " + x["prompt"])
                              and not self.memory.is_repeat(x.get("title", ""))]
            if not plan["scenes"]:
                raise RuntimeError("blocked plan")
            for s in plan["scenes"]:
                self.memory.add(s.get("title", ""))
            d.add([make_scene(s["prompt"], s.get("negative", ""), s.get("title", ""), s.get("transition"),
                              s.get("hold"), source="", origin="auto", style=s.get("style"), beats=s.get("beats")) for s in plan["scenes"]])
            self._failures = 0
            self.last_error = ""
            self._next_allowed = time.monotonic() + self.min_interval
        except Exception as e:
            self._failures += 1
            self.last_error = str(e)[:120]
            backoff = min(120.0, 5.0 * 2 ** (self._failures - 1))
            self._next_allowed = time.monotonic() + backoff
            logger.warning("Autopilot call failed (%s); backing off %.0fs", self.last_error, backoff)
            self._variation()
        finally:
            self.busy = False
            self.on_change()

    async def run(self, period: float = 2.0) -> None:
        while True:
            try:
                await self.tick()
            except Exception:
                logger.exception("autopilot tick failed")
            await asyncio.sleep(period)
