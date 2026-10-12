"""Stochastic mood/genre rotation for Auto's self-generated scenes, so idle/drifting
Auto swings between quirky and genuinely beautiful instead of one uniform tone."""

from __future__ import annotations

import collections
import random

# (key, weight, beautiful, relax_cliche, brief)
MOODS = [
    ("serene beauty", 9, True, True, "SERENE AND BEAUTIFUL: a calm, breathtaking place with soft light and harmony; pure beauty, no jokes."),
    ("sweeping landscape", 9, True, True, "SWEEPING NATURE/LANDSCAPE: a vast, specific real-world landscape (named region, terrain, weather) shot ultra-wide; awe and scale."),
    ("golden-hour cinematic", 8, True, True, "GOLDEN-HOUR CINEMATIC: a specific place at golden hour or blue hour, long shadows, warm rim light, film-still beauty."),
    ("cosmic", 6, True, True, "COSMIC: awe-inspiring space or sky phenomena seen from a specific vantage (planet surface, observatory, orbit); grand and quiet."),
    ("underwater", 6, True, True, "UNDERWATER: immersive, specific underwater world (kelp cathedral, shipwreck, deep trench, sunbeams through swells); luminous and beautiful."),
    ("botanical macro", 5, True, True, "BOTANICAL MACRO: the camera tiny among giant leaves, petals, dew and pollen, a whole world at insect scale; lush and delicate."),
    ("epic weather", 6, True, True, "EPIC WEATHER: dramatic weather over a specific place (supercell, sea fog rolling in, snow squall, monsoon); powerful and gorgeous."),
    ("architectural", 6, True, False, "ARCHITECTURAL: a stunning real or imagined interior/exterior (cathedral, brutalist atrium, temple, grand station); symmetry, light shafts, scale."),
    ("abstract color field", 4, True, True, "ABSTRACT COLOR FIELDS: an immersive space of flowing color, light and texture (ink in water, silk, pigment clouds); painterly and beautiful."),
    ("cozy", 5, False, False, "COZY: a warm, inviting lived-in place (rainy-night cafe, cabin, bookshop, night market) with glowing lamps and comfort."),
    ("still life", 4, True, False, "STILL LIFE, IMMERSIVE: a vast painterly Dutch-master style still life you stand inside (towering fruit, drapery, candlelight, chiaroscuro)."),
    ("funky", 5, False, False, "FUNKY: groovy, retro, colorful energy (disco, 70s funk, roller rink, psychedelic patterns); rhythm and swagger."),
    ("bubbly/playful", 5, False, False, "BUBBLY/PLAYFUL: light, joyful, bouncy (bubbles, balloons, candy colors, soft shapes); delight without sarcasm."),
    ("surreal", 5, False, False, "SURREAL: a dreamlike, uncanny but beautiful world (Magritte/Dali logic, impossible geometry), eerie calm."),
    ("quirky gag", 4, False, False, "QUIRKY/ABSURD: an ordinary place with one ridiculous twist, deadpan documentary framing."),
    ("topical", 3, False, False, "TOPICAL: riff visually on a current event or season (no real people, no slogans, no sides)."),
    ("wildcard", 4, False, False, "WILDCARD: pick a genre, era, art movement or culture you have NOT used recently (e.g. ukiyo-e, art deco, Soviet mosaic, Persian miniature, vaporwave) and go all in."),
]
_BY_KEY = {m[0]: m for m in MOODS}


class MoodRotator:
    """Weighted random mood, held for a random 1-3 auto scenes, never one of the last few."""

    def __init__(self, rng: random.Random | None = None, avoid: int = 4) -> None:
        self.rng = rng or random.Random()
        self.recent: collections.deque[str] = collections.deque(maxlen=avoid)
        self.current = ""
        self.left = 0

    def _pick(self) -> str:
        cands = [m for m in MOODS if m[0] not in self.recent]
        # nudge toward beauty if the last two picks were both non-beautiful
        boost = 1.6 if sum(1 for k in list(self.recent)[-2:] if not _BY_KEY[k][2]) >= 2 else 1.0
        w = [m[1] * (boost if m[2] else 1.0) for m in cands]
        return self.rng.choices([m[0] for m in cands], w)[0]

    def next(self, scenes: int = 2) -> str:
        if self.left <= 0 or not self.current:
            self.current = self._pick()
            self.recent.append(self.current)
            self.left = self.rng.randint(1, 3)
        self.left -= scenes
        return self.current

    @staticmethod
    def relax_cliche(key: str) -> bool:
        return bool(key in _BY_KEY and _BY_KEY[key][3])

    def brief(self, key: str) -> str:
        m = _BY_KEY[key]
        seed = self.rng.randint(1000, 9999)
        return (f"MOOD FOR THIS BATCH (overrides the default tone) -> {m[4]} "
                "Do NOT default to quirky, gross or jokey unless this mood asks for it; when the mood is beautiful, "
                "make it sincerely, stunningly beautiful. Specific beats generic. Keep the scene immersive and wide. "
                f"Variation seed {seed}: let it push you to an unexpected subject, place and palette.")


def beautiful_share() -> float:
    tot = sum(m[1] for m in MOODS)
    return sum(m[1] for m in MOODS if m[2]) / tot
