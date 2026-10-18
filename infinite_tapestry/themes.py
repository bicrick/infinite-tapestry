"""Fresh autopilot themes: cached news/trend headlines, a cliche ban list, and a
rolling memory of recent themes so the journey doesn't loop on reefs and meadows."""

from __future__ import annotations

import collections
import html
import os
import logging
import random
import re
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET

logger = logging.getLogger(__name__)

FEEDS = [
    "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",
    "https://news.google.com/rss/headlines/section/topic/SCIENCE?hl=en-US&gl=US&ceid=US:en",
    "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en",
    "https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=en-US&gl=US&ceid=US:en",
    "https://www.reddit.com/r/popular/top/.rss?t=day",
]
REFRESH_S = 30 * 60

CLICHES = [
    "coral reef", "reef", "meadow", "wildflower field", "flower field", "enchanted forest", "misty forest",
    "forest path", "sunset beach", "tropical beach", "beach at sunset", "golden hour field", "rolling hills",
    "mountain lake", "aurora", "northern lights", "nebula", "galaxy swirl", "cherry blossom", "zen garden",
    "bioluminescent", "floating islands", "crystal cave", "underwater kingdom", "cyberpunk city", "neon city",
    "steampunk", "lavender field", "waterfall", "jellyfish",
]
_CLICHE_RE = re.compile(r"\b(" + "|".join(re.escape(c) for c in CLICHES) + r")s?\b", re.I)

# Headlines touching these are skipped entirely (tragedy, minors, sexual content).
_SKIP_RE = re.compile(
    r"\b(kill\w*|dead|death|dies|died|shoot\w*|murder\w*|rape\w*|sex\w*|porn\w*|child\w*|kid|kids|teen\w*|"
    r"minor|minors|abuse\w*|suicide|massacre|war|bomb\w*|hostage|attack\w*|strike\w*|execut\w*|raid\w*|fraud|crash\w*|shooting|victim\w*|nsfw|nude\w*)\b", re.I)

MODES = [("news", 0.35), ("funny", 0.30), ("cinematic", 0.35)]
MODE_BRIEF = {
    "news": ("TOPICAL: riff on ONE of today's headlines below as a playful, visual, wordless scene (the vibe, objects "
             "or setting of the story, exaggerated or reimagined). Not propaganda, no slogans or text, no taking sides, "
             "no recognizable real people (symbolic objects, places, animals or tiny distant figures instead), nothing sexual, no minors."),
    "funny": ("FUNNY/ABSURD: a visual gag that reads instantly without text: an ordinary real-world place with one "
              "ridiculous twist carried by objects, scale, materials or animals (not close-up people). Deadpan framing makes it funnier. Avoid the overused 'animals "
              "doing office jobs' trope unless it's truly fresh."),
    "cinematic": ("SPECIFIC PLACE: a striking, specific, non-cliche place or moment, in whatever look you like."),
}


SPARKS = ["a mundane workplace", "a weird scale shift", "an animal doing a human job", "an obsolete technology",
          "a holiday or season right now", "a sports venue", "a food", "a transit system", "a niche hobby",
          "an architectural style", "a weather event", "a science discovery", "a retail store", "a museum",
          "a giant everyday object", "a time-of-day lighting", "an industrial site", "a festival or parade"]


def has_cliche(text: str) -> bool:
    return bool(_CLICHE_RE.search(text or ""))


class HeadlineCache:
    def __init__(self, feeds: list[str] | None = None, refresh_s: float = REFRESH_S, timeout: float = 8.0) -> None:
        self.feeds = feeds if feeds is not None else (
            [] if os.environ.get("TAPESTRY_HEADLINES", "1") == "0" else FEEDS)
        self.refresh_s = refresh_s
        self.timeout = timeout
        self._items: list[str] = []
        self._fetched = 0.0
        self._lock = threading.Lock()

    def _fetch_one(self, url: str) -> list[str]:
        req = urllib.request.Request(url, headers={"User-Agent": "infinite-tapestry/1.0 (headline themes)"})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            root = ET.fromstring(r.read())
        out = []
        for el in root.iter():
            if el.tag.endswith("item") or el.tag.endswith("entry"):
                t = next((c.text for c in el if c.tag.endswith("title")), None)
                if t:
                    t = html.unescape(t).strip()
                    t = re.sub(r"\s+-\s+[^-]{2,40}$", "", t)  # drop " - Publisher"
                    if 12 < len(t) < 200 and not _SKIP_RE.search(t):
                        out.append(t)
        return out[:25]

    def headlines(self) -> list[str]:
        with self._lock:
            if self._items and time.time() - self._fetched < self.refresh_s:
                return list(self._items)
            items: list[str] = []
            for url in self.feeds:
                try:
                    items += self._fetch_one(url)
                except Exception as e:
                    logger.info("headline feed failed (%s): %s", url.split("/")[2], type(e).__name__)
            if items:
                self._items = list(dict.fromkeys(items))
            self._fetched = time.time()  # also rate-limits retries on failure
            return list(self._items)

    def sample(self, k: int = 6) -> list[str]:
        h = self.headlines()
        return random.sample(h, min(k, len(h)))


class ThemeMemory:
    def __init__(self, size: int = 40) -> None:
        self.titles: collections.deque[str] = collections.deque(maxlen=size)

    def add(self, title: str) -> None:
        if title:
            self.titles.append(title.strip()[:60])

    def is_repeat(self, title: str) -> bool:
        """Exact same title only (themed journeys are meant to share words)."""
        t = (title or "").strip().lower()[:60]
        return bool(t) and any(t == x.lower() for x in self.titles)


def pick_mode(rng: random.Random | None = None, have_news: bool = True) -> str:
    r = rng or random
    modes = [(m, w) for m, w in MODES if have_news or m != "news"]
    return r.choices([m for m, _ in modes], [w for _, w in modes])[0]


def brief(mode: str, headlines: list[str], memory: ThemeMemory, relax: bool = True, spark: bool = True) -> str:
    s = "THEME FOR THIS BATCH -> " + MODE_BRIEF[mode]
    if spark:
        s += "\nRandom spark for originality (use loosely or ignore): " + random.choice(SPARKS)
    if mode == "news" and headlines:
        s += "\nToday's headlines (pick one, render it visually):\n" + "\n".join(f"- {h}" for h in headlines)
    s += ("\nClassic subjects (reefs, nebulae, auroras, fractals, waterfalls...) are welcome when they fit; just make "
          "them SPECIFIC and surprising (unusual vantage, material, scale or light), never bland postcard filler.")
    if memory.titles:
        s += "\nTitles already used recently (do not reuse an exact title): " + "; ".join(memory.titles)
    return s


_MINOR_RE = re.compile(r"\b(child\w*|kid|kids|toddler\w*|bab(y|ies)|infant\w*|teen\w*|schoolgirl\w*|schoolboy\w*|minor|minors)\b", re.I)


def mentions_minor(text: str) -> bool:
    return bool(_MINOR_RE.search(text or ""))


def clean_title(text: str) -> str:
    """Keep Latin letters (incl. accents), digits, spaces and ordinary punctuation; drop stray
    non-Latin characters a model sometimes leaks into titles (e.g. a lone CJK ideograph)."""
    import unicodedata

    out = []
    for ch in str(text or ""):
        if ch.isascii():
            out.append(ch)
            continue
        o = ord(ch)
        if "LATIN" in unicodedata.name(ch, "") or 0xA0 <= o <= 0xBF or 0x2000 <= o <= 0x206F:
            out.append(ch)
    t = re.sub(r"\s+", " ", "".join(out)).strip()
    return re.sub(r"^[\s,;:.\-–—]+|[\s,;:\-–—]+$", "", t)
