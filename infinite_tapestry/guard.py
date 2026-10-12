"""Hard content block that must never be removed: no sexualized minors.

Mature/dark/sexual adult content is allowed (private adult app). Any text that
combines a minor/age term with a sexual term is rejected, on user input and on
every final SD prompt."""

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
