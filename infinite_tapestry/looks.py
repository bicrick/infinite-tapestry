"""Auto's look mix. The renderer (RealVisXL) is a photoreal model, so Auto leans photographic:
about two of every three Auto scenes get a photographic look: a stylized scene is only allowed right
after two photographic ones (P P S P P S ...), so even if Auto takes every free slot stylized the mix stays ~67% photo. User ideas are never touched (their words, verbatim)."""

from __future__ import annotations

import random
import re

PHOTO_SHARE = 0.6        # minimum photographic share over the recent window
WINDOW = 5               # recent Auto scenes the quota looks at

PHOTO_LOOKS = ["cinematic photo", "documentary photo", "landscape photograph", "aerial drone photograph",
               "macro photograph", "underwater photograph", "long-exposure night photo", "golden hour photograph",
               "wildlife photograph", "architectural photograph", "35mm film photo", "editorial magazine photo",
               "misty morning photograph", "astrophotography", "street photograph", "film noir photo",
               "Polaroid photo", "glossy product photo", "nature documentary still", "storm chaser photograph"]

_PHOTO_WORDS = ("photo", "photograph", "cinematic", "film still", "documentary", "polaroid", "35mm", "realistic",
                "photoreal", "hyperreal", "astrophotography", "dslr", "drone shot", "documentary still")
# Painterly/graphic media: a label naming one of these is stylized even if it also says "photo".
_ART_WORDS = ("paint", "watercolo", "gouache", "pastel", "illustrat", "drawing", "sketch", "ink", "woodcut",
              "woodblock", "linocut", "print", "poster", "cartoon", "anime", "comic", "crayon", "chalk", "fresco",
              "mosaic", "stained glass", "embroider", "cross-stitch", "felt", "claymation", "pixel", "papercraft",
              "collage", "engraving", "picture book", "storybook", "lego", "diorama", "low-poly", "3d render")
_ART_RE = re.compile(r"\b(art|arts|artwork|artistic)\b")

PHOTO_NEGATIVE = ("painting, watercolor, oil painting, illustration, drawing, sketch, cartoon, anime, "
                  "brushstrokes, canvas texture, signature")


def is_photo(label: str | None) -> bool:
    s = str(label or "").lower()
    if not s or s == "none":
        return False
    if any(w in s for w in _ART_WORDS) or _ART_RE.search(s):
        return False
    # labels are cut to 24 chars ("glossy 1920s magazine ph"): a trailing "ph"/"pho"/"phot" is a photo
    return any(w in s for w in _PHOTO_WORDS) or bool(re.search(r"\bph(o|ot)?$", s))


def photo_needed(recent_styles: list[str]) -> bool:
    """True if the next Auto scene must be photographic (recent_styles oldest first, Auto scenes only)."""
    if not recent_styles:
        return True
    if len(recent_styles) < 2 or not (is_photo(recent_styles[-1]) and is_photo(recent_styles[-2])):
        return True   # a stylized scene only after two photographic ones
    win = recent_styles[-WINDOW:]
    return sum(is_photo(s) for s in win) / len(win) < PHOTO_SHARE


def slots(recent_styles: list[str], n: int) -> list[bool]:
    """Photo requirement for each of the next n scenes (simulating that required slots become photo
    and free slots become stylized, the worst case for the quota)."""
    hist, out = list(recent_styles), []
    for _ in range(n):
        need = photo_needed(hist)
        out.append(need)
        hist.append("photo" if need else "art")
    return out


def brief(req: list[bool]) -> str:
    parts = []
    for i, need in enumerate(req, 1):
        parts.append(f"scene {i}: PHOTOGRAPHIC look (a real photograph: e.g. " + ", ".join(random.sample(PHOTO_LOOKS, 3))
                     + "), no painting or illustration" if need else
                     f"scene {i}: free look (a photograph, or any painted/graphic/crafted medium)")
    return ("LOOK PLAN (required; the renderer is a photoreal model): " + "; ".join(parts) +
            ". Write the look as the first words of the prompt and as style.")


_LEAD = re.compile(r"^\s*([^,]{1,60}),\s*")


def force_photo(scene: dict, rng: random.Random | None = None) -> dict:
    """Make an Auto scene photographic when the quota required it but the plan came back stylized."""
    r = rng or random
    st = str(scene.get("style") or "")
    if is_photo(st):
        return scene
    look = r.choice(PHOTO_LOOKS)
    p = str(scene.get("prompt") or "")
    m = _LEAD.match(p)
    if m and (not st or st.lower() in m.group(1).lower() or m.group(1).lower() in st.lower()
              or any(w in m.group(1).lower() for w in _ART_WORDS)):
        p = p[m.end():]   # drop the stylized look clause the plan led with
    scene["prompt"] = f"{look}, {p}".strip(" ,")
    scene["style"] = look
    scene["beats"] = []
    return scene


def finalize(scene: dict, need_photo: bool) -> dict:
    """Apply the slot decision; photographic Auto scenes also get anti-painting negatives."""
    if need_photo:
        force_photo(scene)
    if is_photo(scene.get("style")):
        neg = str(scene.get("negative") or "")
        scene["negative"] = ", ".join(x for x in (neg, PHOTO_NEGATIVE) if x)
    return scene
