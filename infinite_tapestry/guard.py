"""Content line: "wild west except sexual content".

Gore, horror, surreal and disturbing are fine. Sexual content and nudity are
not (public app). Two checks:
- is_blocked: minor/age term + sexual term. Hard block that must never be removed.
- is_sexual: any sexual/nudity term. Rejected on user input and swapped out of
  final SD prompts. Generated pixels are additionally checked by nsfw.py."""

from __future__ import annotations

import re

_MINOR = re.compile(
    r"\b(child|children|kid|kids|minor|minors|underage|under-age|teen|teens|teenage|teenager|preteen|pre-teen|"
    r"tween|loli|lolicon|shota|shotacon|toddler|infant|baby|babies|schoolgirl|schoolboy|little girl|little boy|"
    r"young girl|young boy|juvenile|pubescent|prepubescent|jailbait|"
    r"(?:[1-9]|1[0-7])\s*(?:yo|y/o|yrs?|years?)(?:[\s-]*old)?)\b",
    re.I,
)
_SEXUAL = re.compile(
    r"\b(sex|sexy|sexual|sexualized|nude|nudes|naked|nudity|erotic|erotica|porn|porno|pornographic|nsfw|explicit|"
    r"topless|bottomless|lingerie|aroused|arousal|genital|genitals|breasts?|nipples?|orgasm|seductive|sensual|"
    r"fetish|bdsm|lewd|hentai|undress|undressed|undressing|strip|stripping|intercourse|masturbat\w*)\b",
    re.I,
)


def is_blocked(*texts: str) -> bool:
    joined = " ".join(t for t in texts if t)
    return bool(_MINOR.search(joined) and _SEXUAL.search(joined))


_SEXUAL_STRICT = re.compile(
    r"\b(sex|sexy|sexual|sexualized|sexually|nude|nudes|naked|nudity|erotic|erotica|porn|porno|pornographic|nsfw|"
    r"topless|bottomless|lingerie|aroused|arousal|genital|genitals|penis|vagina|vulva|nipples?|orgasm|seductive|"
    r"sensual|fetish|bdsm|lewd|hentai|undress|undressed|undressing|stripper|striptease|intercourse|masturbat\w*|"
    r"boobs?|tits|bare[- ]breasted|breasts|onlyfans|xxx|horny|kinky)\b",
    re.I,
)


def is_sexual(*texts: str) -> bool:
    return bool(_SEXUAL_STRICT.search(" ".join(t for t in texts if t)))


def is_disallowed(*texts: str) -> bool:
    """Anything we refuse to paint: sexual content, and (always) sexualized minors."""
    return is_blocked(*texts) or is_sexual(*texts)
