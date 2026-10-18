"""Auto's look variety. There is NO default style: each new Auto scene draws its look family at random
(uniformly) from the families that have NOT been used recently, so no medium (watercolor, oil, photo, ...)
can dominate or keep recurring. User ideas are never touched (their words, verbatim)."""

from __future__ import annotations

import random
import re

# Families and example looks (equal footing; the examples only seed Haiku's own invention).
FAMILIES: dict[str, list[str]] = {
    "photo": ["documentary photo", "aerial drone photograph", "macro photograph", "long-exposure night photo",
              "underwater photograph", "Polaroid snapshot", "wildlife photograph", "street photograph"],
    "film": ["1970s film still", "film noir still", "Technicolor movie still", "VHS camcorder frame",
             "wide anamorphic film still", "silent-film still"],
    "3d": ["chrome 3D render", "low-poly 3D", "isometric 3D render", "claymation", "glossy CGI animation still",
           "voxel art"],
    "painting": ["oil painting", "watercolor", "gouache", "Renaissance fresco", "ink wash painting", "acrylic pour",
                 "impressionist painting"],
    "illustration": ["comic book ink", "cel-shaded cartoon", "children's picture book", "marker sketch",
                     "scientific illustration", "art nouveau illustration", "anime background", "crayon drawing",
                     "chalk on a blackboard"],
    "print": ["linocut print", "risograph print", "woodcut", "vintage travel poster", "psychedelic 60s poster",
              "Bauhaus geometric print", "blueprint diagram", "Japanese woodblock print", "screen print"],
    "craft": ["knitted wool", "papercraft", "stop-motion felt", "cross-stitch", "lego bricks", "mosaic tiles",
              "stained glass", "tin toy diorama", "batik textile"],
    "digital": ["pixel art", "16-bit video game", "neon sign", "glitch art", "vaporwave", "ASCII-style terminal art"],
}

# Classifier keywords, checked in this order (first match wins).
_KEYS: list[tuple[str, tuple[str, ...]]] = [
    ("craft", ("knit", "wool", "felt", "papercraft", "paper cut", "papercut", "origami", "cross-stitch", "embroider",
               "lego", "brick", "mosaic", "stained glass", "tin toy", "diorama", "batik", "textile", "quilt",
               "collage", "enamel", "ceramic", "clay figure", "macrame", "tapestry weave")),
    ("digital", ("pixel", "8-bit", "16-bit", "video game", "neon", "glitch", "vaporwave", "ascii", "synthwave")),
    ("3d", ("3d", "render", "cgi", "low-poly", "voxel", "claymation", "isometric")),
    ("print", ("print", "woodcut", "woodblock", "linocut", "risograph", "poster", "engraving", "etching",
               "blueprint", "screen print", "lithograph", "letterpress", "cyanotype")),
    ("painting", ("paint", "watercolo", "gouache", "pastel", "oil", "fresco", "ink wash", "sumi", "impasto",
                  "acrylic", "tempera", "impressionis", "canvas", "mural")),
    ("illustration", ("illustrat", "drawing", "sketch", "cartoon", "anime", "manga", "comic", "picture book",
                      "storybook", "crayon", "chalk", "marker", "doodle", "cel-shaded", "ink", "graphic novel")),
    ("film", ("film still", "movie still", "film noir", "technicolor", "vhs", "camcorder", "anamorphic", "cinema",
              "cinematic", "silent-film", "super 8", "16mm")),
    ("photo", ("photo", "polaroid", "snapshot", "35mm", "dslr", "drone", "documentary", "realistic", "hyperreal",
               "astrophotograph", "magazine")),
]

LABEL_LEN = 24
STORY_MAX = 4     # a story keeps one look for at most 4 scenes, then Auto changes family
RECENT = 6        # recent Auto scenes the variety rule looks at
AVOID_LAST = 3    # a new (non-story) scene's family differs from the last 3 Auto scenes' families
MAX_SHARE = 2     # ...and no family may hold more than 2 of the last 6 (a story may run 3 in a row, then ends)


def family(label: str | None) -> str:
    # Classify the stored label (scene labels are cut to 24 chars) so a hybrid like "cel-shaded cartoon and
    # glossy 3D" counts as the same family before and after it is stored.
    s = str(label or "").lower().strip()[:LABEL_LEN]
    if not s or s == "none":
        return ""
    for fam, words in _KEYS:
        if any(w in s for w in words):
            return fam
    if re.search(r"\bph(o|ot)?$", s):   # labels are cut to 24 chars ("glossy 1920s magazine ph")
        return "photo"
    return "other"


def blocked(recent_styles: list[str]) -> set[str]:
    """Families the next Auto scene may not use (recent_styles oldest first, Auto scenes only)."""
    fams = [family(s) for s in recent_styles if family(s)]
    out = set(fams[-AVOID_LAST:])
    win = fams[-RECENT:]
    out |= {f for f in set(win) if win.count(f) >= MAX_SHARE}
    out.discard("other")
    return out


def story_may_continue(recent_styles: list[str], story_style: str | None, scenes_so_far: int = 0) -> bool:
    """A story keeps its one look for at most STORY_MAX scenes, at most 3 Auto scenes of its family in a row
    before another plan, and its family under 4 of the last 6."""
    if scenes_so_far >= STORY_MAX:
        return False
    f = family(story_style)
    if not f or f == "other":
        return True
    fams = [family(s) for s in recent_styles if family(s)]
    run = 0
    for x in reversed(fams):
        if x != f:
            break
        run += 1
    return run < 3 and fams[-RECENT:].count(f) < 4


def plan(recent_styles: list[str], n: int, rng: random.Random | None = None) -> list[str]:
    """Family for each of the next n scenes: uniform random among the families not blocked."""
    r = rng or random
    hist, out = list(recent_styles), []
    for _ in range(n):
        allowed = [f for f in FAMILIES if f not in blocked(hist)] or list(FAMILIES)
        f = r.choice(allowed)
        out.append(f)
        hist.append(FAMILIES[f][0])
    return out


def brief(fams: list[str], rng: random.Random | None = None) -> str:
    r = rng or random
    parts = [f"scene {i}: a {f.upper()} look (e.g. " + ", ".join(r.sample(FAMILIES[f], min(3, len(FAMILIES[f]))))
             + ", or your own look in that family)" for i, f in enumerate(fams, 1)]
    return ("LOOK PLAN (required, for variety; no style is the default): " + "; ".join(parts) +
            ". Write the look as the first words of the prompt and as style.")


_LEAD = re.compile(r"^\s*([^,]{1,60}),\s*")


def enforce(scene: dict, fam: str, recent_styles: list[str], rng: random.Random | None = None) -> dict:
    """If the plan came back in a blocked family, swap its look for one from the planned family."""
    r = rng or random
    st = str(scene.get("style") or "")
    got = family(st)
    if got and got != "other" and got not in blocked(recent_styles):
        return scene
    if got == "" and fam == "":
        return scene
    look = r.choice(FAMILIES.get(fam) or FAMILIES["photo"])
    p = str(scene.get("prompt") or "")
    m = _LEAD.match(p)
    if m and (family(m.group(1)) not in ("", "other") or (st and st.lower() in m.group(1).lower())):
        p = p[m.end():]   # drop the look clause the plan led with
    scene["prompt"] = f"{look}, {p}".strip(" ,")
    scene["style"] = look
    scene["beats"] = []
    return scene
