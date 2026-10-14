"""Variety sources for Auto: every planning call gets a fresh random 'spark' (an era, a place, a subject family
and a look), and a note on which motifs have had a long run lately, so Auto keeps moving into new territory.
Everything here is phrased positively (what to explore), never as a list of banned things."""

from __future__ import annotations

import collections
import random
import re

ERAS = ["the Bronze Age", "the Jurassic", "the 1920s", "the 1950s", "the 1970s", "the 1980s", "the 1990s", "the far future",
        "the Ice Age", "the Renaissance", "the Victorian era", "the Space Age", "the Art Deco years", "the medieval era",
        "the Baroque", "the Roaring Twenties", "the dawn of the internet", "a post-human future", "prehistory", "the year 3000",
        "the Belle Epoque", "the Cold War", "the Age of Sail", "the Stone Age", "a retro-futurist 1960s", "today"]
PLACES = ["the Sahara", "the Scottish Highlands", "a Brazilian rainforest", "the Atacama desert", "Iceland's lava fields",
          "a Moroccan riad", "the Australian outback", "a Norwegian fjord", "the Amazon river", "the Swiss Alps", "Patagonia",
          "a Mexican plaza", "the Greek islands", "the Canadian Rockies", "a Nigerian market town", "the Mongolian steppe",
          "a Texas roadside", "the Arctic tundra", "the Mars surface", "the bottom of a swimming pool", "a suburban garage",
          "a Parisian rooftop", "a New Orleans jazz street", "a Kenyan savanna", "the Moon", "a coral atoll", "an Irish cliffside",
          "a Peruvian mountain village", "a Finnish sauna", "a Las Vegas casino", "an Italian kitchen", "a Detroit car factory",
          "a laundromat at 2 AM", "a toy shop at night", "inside a giant clock", "a library the size of a city", "a cloud city",
          "the inside of a beehive", "a desert gas station", "a bowling alley", "a Victorian greenhouse", "an orbiting space station"]
SUBJECTS = ["animals with jobs", "machines and engines", "food and cooking", "sports", "music and instruments", "weather events",
            "insects and tiny creatures", "vehicles", "architecture", "plants and fungi", "dinosaurs", "robots", "ocean life",
            "tools and workshops", "games and toys", "celebrations and parades", "transport and travel", "science lab experiments",
            "monsters and myths", "geology and crystals", "birds", "everyday objects at giant scale", "fashion and fabric",
            "space exploration", "farms and harvests", "trains", "circuses and fairs", "medieval knights", "cowboys and frontiers"]
LOOKS = ["crayon drawing", "claymation", "linocut print", "pixel art", "1980s airbrush poster", "comic book ink", "tin toy diorama",
         "risograph print", "chalk on a blackboard", "knitted wool", "papercraft", "low-poly 3D", "vintage travel poster",
         "blueprint diagram", "1970s sci-fi paperback cover", "children's picture book", "graffiti mural", "stop-motion felt",
         "lego bricks", "marker sketch", "psychedelic 60s poster", "Polaroid photo", "documentary photo", "Renaissance fresco",
         "cel-shaded cartoon", "mosaic tiles", "woodcut", "propaganda-style poster art", "art nouveau illustration", "neon sign",
         "chrome 3D render", "Saturday-morning cartoon", "oil painting", "glossy magazine photo", "scientific illustration",
         "cross-stitch", "watercolor field sketch", "16-bit video game", "Bauhaus geometric print", "film noir photo"]

_STOP = set("the a an of in on at and to with by from for into over under beneath above below within its his her their my our".split())


def motif_run(titles: list[str], top: int = 4, min_count: int = 3) -> list[str]:
    """Words that dominated recent titles (they have had their run)."""
    words = [w for t in titles for w in re.findall(r"[a-z]{4,}", str(t).lower()) if w not in _STOP]
    return [w for w, n in collections.Counter(words).most_common(top) if n >= min_count]


def spark(rng: random.Random | None = None) -> dict[str, str]:
    r = rng or random
    return {"era": r.choice(ERAS), "place": r.choice(PLACES), "subject": r.choice(SUBJECTS), "look": r.choice(LOOKS)}


def spark_line(s: dict[str, str]) -> str:
    return (f"Fresh spark for this pick (use any part that inspires you): era {s['era']}; place {s['place']}; "
            f"subject family {s['subject']}; look {s['look']}.")
