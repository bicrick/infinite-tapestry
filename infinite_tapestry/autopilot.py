"""Claude-driven autopilot: keeps the scene queue topped up with ever-evolving
auto scenes when nobody is steering. User scenes always go first."""

from __future__ import annotations

import asyncio
import logging
import os
import random
import time
from typing import Any, Callable

from .prompts import make_scene, soft_title
from .moods import MoodRotator
from .themes import HeadlineCache, ThemeMemory, brief, clean_title, mentions_minor, pick_mode

logger = logging.getLogger(__name__)

VARIATIONS = [
    "seen through warped glass", "at a stranger scale", "in shifting iridescent light",
    "slowly melting and reforming", "overgrown with luminous moss", "rendered as a faded fresco",
    "under a second, larger moon", "made of folded paper", "submerged in amber haze",
]


MOMENTUM_STEPS = 5  # auto scenes after a user idea before the normal mix resumes


def momentum_brief(recent: list[dict]) -> str:
    """Theme momentum: right after a user idea, Auto stays in that world and then drifts
    away gradually instead of jumping somewhere unrelated."""
    last_user = max((i for i, r in enumerate(recent) if r.get("origin") == "user"), default=None)
    if last_user is None:
        return ""
    k = len(recent) - 1 - last_user  # auto scenes already planned since the idea
    if k >= MOMENTUM_STEPS:
        return ""
    u = recent[last_user]
    idea = (u.get("source") or u.get("title") or "")[:200]
    steps = []
    for n in range(k + 1, k + 3):
        if n <= 2:
            steps.append(f"scene {n} after the idea: STAY IN THE SAME WORLD as the idea (same theme, materials and tone), "
                         "a neighboring place or different part of it, new camera angle and moment")
        elif n <= MOMENTUM_STEPS:
            away = {3: "the idea's world is now only a minority of the scene; a NEW main subject/place takes over",
                    4: "the idea's material/theme is GONE; keep only one small element (color, creature, prop or joke) from scene 3",
                    5: "a fresh scene that shares just one element with scene 4"}.get(n, "")
            steps.append(f"scene {n} after the idea: DRIFT AWAY one step: {away}")
        else:
            steps.append(f"scene {n}: free choice, loosely linked to the previous scene")
    return ("THEME MOMENTUM: a viewer just played the idea \"" + idea + "\" (scene \"" + str(u.get("title", "")) + "\"). "
            "Do not jump to something unrelated. " + "; ".join(steps) + ". Keep the idea's tone (if it was gross or absurd, "
            "stay gross or absurd). Theme momentum overrides the usual repeat rules for this world.")


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
        self.moods = MoodRotator()
        self.last_mood = ""
        self.pressure: Callable[[], int] = lambda: 0  # waiting pool ideas -> keep Auto filler thin
        self.epoch = 0  # bumped on every user enqueue; stale auto results are discarded
        self.admin_paused = False   # auto_config.paused (admin panel)
        self.admin_theme = ""
        self.config_fetch: Callable[[], dict | None] | None = None

    def state(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled, "vibe": self.vibe, "busy": self.busy,
            "error": self.last_error, "tokens": getattr(self.interpreter, "tokens_used", 0),
            "budget": self.token_budget, "mode": self.last_mode, "mood": self.last_mood,
            "paused": self.admin_paused, "theme": self.admin_theme,
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
        d.add([make_scene(f"{base}, {mod}", cur.get("negative", ""), soft_title(f"{cur['title']}, {mod.split()[-1]}"),
                          20, 16, source="variation", origin="auto", style=cur.get("style"))])
        self.on_change()

    async def tick(self) -> None:
        d = self.director
        waiting = self.pressure()
        if waiting and hasattr(d, "trim_auto") and d.trim_auto(2):
            self.on_change()
        if not self.enabled or self.admin_paused or self.busy or d.upcoming_count() >= (2 if waiting else self.low_water):
            return
        if not self._can_call():
            if time.monotonic() >= self._next_allowed or not getattr(self.interpreter, "enabled", False):
                self._variation()
            return
        self.busy = True
        epoch = self.epoch
        self._calls.append(time.monotonic())
        try:
            recent = d.recent(12)
            mom = momentum_brief(recent)
            last_user = max((i for i, r in enumerate(recent) if r.get("origin") == "user"), default=None)
            since = len(recent) - 1 - last_user if last_user is not None else 99
            mood = ""
            if mom:
                self.last_mode = "momentum"
                text = mom
                if since >= 2:  # drifting away: steer the new subject by a random mood
                    mood = self.moods.next(2)
                    text += "\nFor the drifting scenes, the NEW main subject follows this: " + self.moods.brief(mood)
            else:
                heads = await asyncio.to_thread(self.headlines.sample, 6)
                mood = self.moods.next(2)
                mode = "news" if mood == "topical" and heads else "cinematic"
                self.last_mode = mode
                text = brief(mode, heads, self.memory, spark=not self.moods.is_beautiful(mood)) + "\n" + self.moods.brief(mood)
            self.last_mood = mood
            plan = await asyncio.to_thread(self.interpreter.autoplan, recent[-8:], self.vibe, 2, text)
            if epoch != self.epoch:
                return  # user steered meanwhile; next tick plans from their scene
            from .guard import is_disallowed

            kept = []
            for x in plan["scenes"]:
                x["title"] = clean_title(x.get("title", "")) or clean_title(x["prompt"].split(",")[0])[:60]
                if is_disallowed(x["prompt"]) or mentions_minor(x["title"] + " " + x["prompt"]):
                    continue
                if not mom and self.memory.is_repeat(x["title"]):  # exact same title only
                    continue
                kept.append(x)
            plan["scenes"] = kept
            if not plan["scenes"]:
                raise RuntimeError("blocked plan")
            logger.info("autoplan mood=%s titles=%s", mood or self.last_mode, [s.get("title") for s in plan["scenes"]])
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

    def apply_config(self, cfg: dict | None) -> None:
        """Admin steering from Supabase auto_config: pause, a temporary theme, mood weights. No redeploy."""
        if not cfg:
            return
        paused = bool(cfg.get("paused"))
        if paused != self.admin_paused:
            self.admin_paused = paused
            self.on_change()
        theme = (cfg.get("theme") or "").strip()[:200]
        until = cfg.get("theme_until")
        try:
            from datetime import datetime, timezone
            live = bool(theme and until and datetime.fromisoformat(str(until).replace("Z", "+00:00")) > datetime.now(timezone.utc))
        except Exception:
            live = False
        want = theme if live else ""
        if want != self.admin_theme:
            self.admin_theme = want
            self.vibe = want
            if hasattr(self.director, "drop_auto"):
                self.director.drop_auto()  # regenerate toward the new theme
            self._next_allowed = 0.0
        w = cfg.get("mood_weights") or {}
        self.moods.weights = {str(k): float(v) for k, v in w.items() if isinstance(v, (int, float))}

    async def run(self, period: float = 2.0) -> None:
        last_cfg = 0.0
        while True:
            if self.config_fetch and time.monotonic() - last_cfg > 30:
                last_cfg = time.monotonic()
                try:
                    self.apply_config(await asyncio.to_thread(self.config_fetch))
                except Exception:
                    logger.warning("auto_config fetch failed")
            try:
                await self.tick()
            except Exception:
                logger.exception("autopilot tick failed")
            await asyncio.sleep(period)
