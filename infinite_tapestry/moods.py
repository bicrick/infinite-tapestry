"""Stochastic mood/genre rotation for Auto's self-generated scenes, so idle/drifting
Auto swings between quirky and genuinely beautiful instead of one uniform tone."""

from __future__ import annotations

import collections
import random

# (key, weight, beautiful, relax_cliche, brief)
MOODS = [
    ("serene", 6, True, True, "SERENE: a calm, peaceful scene."),
    ("landscape", 6, True, True, "LANDSCAPE: some kind of land, sea or sky, anywhere real or imagined."),
    ("cosmic", 5, True, True, "COSMIC: space, sky phenomena or fractal structures."),
    ("underwater", 5, True, True, "UNDERWATER: something under water."),
    ("tiny world", 5, True, True, "TINY WORLD: a world at insect scale or smaller."),
    ("weather", 5, True, True, "WEATHER: weather as the main event."),
    ("architecture", 5, True, False, "ARCHITECTURE: buildings, rooms or structures, real or impossible."),
    ("abstract", 5, True, True, "ABSTRACT: shapes, color, pattern, texture or fractals."),
    ("fractal", 4, True, True, "FRACTAL: a fractal or recursive world."),
    ("materials", 5, True, True, "MATERIALS: a world made of one unexpected material (cloth, candy, glass, rust...)."),
    ("cozy", 5, False, False, "COZY: a warm, inviting place."),
    ("still life", 4, True, False, "STILL LIFE: objects arranged into a whole world."),
    ("funky", 5, False, False, "FUNKY: groovy, retro, colorful energy."),
    ("playful", 5, False, False, "PLAYFUL: light, joyful, bouncy."),
    ("surreal", 5, False, False, "SURREAL: dream logic, impossible things."),
    ("quirky gag", 5, False, False, "QUIRKY: an ordinary place with one ridiculous twist."),
    ("topical", 2, False, False, "TOPICAL: riff on a current event or season (no real people, no slogans, no sides)."),
    ("wildcard", 6, False, False, "WILDCARD: anything at all, in a medium, era or culture you have not used recently."),
]
_BY_KEY = {m[0]: m for m in MOODS}


class MoodRotator:
    """Weighted random mood = a themed journey of 2-4 auto scenes, then a switch to a different mood."""

    def __init__(self, rng: random.Random | None = None, avoid: int = 4) -> None:
        self.rng = rng or random.Random()
        self.recent: collections.deque[str] = collections.deque(maxlen=avoid)
        self.current = ""
        self.left = 0
        self.fresh = True  # first batch of a new journey
        self.weights: dict[str, float] = {}  # admin overrides (auto_config.mood_weights); missing keys keep defaults

    def _pick(self) -> str:
        wt = lambda m: float(self.weights.get(m[0], m[1]))
        cands = [m for m in MOODS if m[0] not in self.recent and wt(m) > 0] or [m for m in MOODS if wt(m) > 0] or MOODS
        # nudge toward beauty if the last two picks were both non-beautiful
        boost = 1.0   # no lean toward any mood or look
        w = [max(wt(m), 1e-6) * (boost if m[2] else 1.0) for m in cands]
        return self.rng.choices([m[0] for m in cands], w)[0]

    def next(self, scenes: int = 2) -> str:
        if self.left <= 0 or not self.current:
            self.current = self._pick()
            self.recent.append(self.current)
            self.left = self.rng.randint(2, 4)
            self.fresh = True
        else:
            self.fresh = False
        self.left -= scenes
        return self.current

    def brief(self, key: str) -> str:
        m = _BY_KEY[key]
        extra = (" This is a BEAUTY mood: no humor, no gags, no animals doing jobs, no mashing an ordinary/bureaucratic "
                 "thing into nature, no absurd twist. One coherent, real-feeling, stunning place." if m[2] else
                 " Humor, gags and absurd twists are welcome here.")
        seed = self.rng.randint(1000, 9999)
        journey = ("THEMED JOURNEY: START a new journey now: pick ONE specific theme for this mood that differs from the "
                   "recent scenes, and make these scenes explore it (different places, angles, palettes within that theme). "
                   if self.fresh else
                   "THEMED JOURNEY: CONTINUE the journey of the most recent auto scenes: same specific theme, new place, "
                   "angle or twist within it; it will switch to something different afterwards. ")
        return (journey + f"MOOD FOR THIS BATCH (overrides the default tone) -> {m[4]} "
                "Do NOT default to quirky, gross or jokey unless this mood asks for it; when the mood is beautiful, "
                "make it sincerely, stunningly beautiful. Specific beats generic. "
                "Keep people out of focus: no faces or crowds; at most tiny, distant figures."
                + extra + f" Variation seed {seed}: let it push you to an unexpected subject, place and palette.")


