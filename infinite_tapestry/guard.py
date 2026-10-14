"""Content line: "wild west except sexual content".

Gore, horror, surreal and disturbing are fine. Sexual content and nudity are
not (public app). Two checks:
- is_blocked: minor/age term + sexual term. Hard block that must never be removed.
- is_sexual: any sexual/nudity term. Rejected on user input and swapped out of
  final SD prompts. Generated pixels are additionally checked by nsfw.py."""

from __future__ import annotations

import re

# Benign phrases removed before any keyword match (mirrors ALLOW in web/lib/moderate.js and
# public.mod_allow in migration 019). They never touch the hard lines: "naked mole rat and naked women"
# still matches on the second "naked".
_ANIMALS = (r"animals?|elephants?|goats?|lambs?|sheep|deer|fawns?|bears?|pandas?|seals?|owls?|ducks?|ducklings?|chicks?|"
            r"birds?|turtles?|dragons?|dinosaurs?|whales?|dolphins?|foxes|fox|wolves|wolf|lions?|tigers?|cats?|kittens?|"
            r"dogs?|puppies|puppy|bunnies|bunny|rabbits?|penguins?|otters?|giraffes?|horses?|ponies|pony|monkeys?|koalas?|"
            r"sloths?|octopus(?:es)?|sharks?|cows?|pigs?|piglets?|yoda|groot|carrots?|spinach|corn|shower|grand|steps?|teeth")
_ALLOW = re.compile(r"\b(?:" + "|".join([
    r"naked mole[- ]?rats?", r"naked eye", r"naked flame", r"naked (?:tree|trees|branches)",
    r"(?:chicken|turkey|duck|pheasant) breasts?", r"breast ?strokes?", r"breastplates?",
    r"(?:blue|great|coal|marsh|willow|crested|long[- ]tailed) tits?", r"tit ?mouse", r"tit for tat",
    r"(?:comic|landing|film|las vegas|vegas|sunset|mobius|möbius|bacon|neon|led|light) strips?", r"strip malls?", r"strip mines?",
    r"(?:baby|babies|kid|kids) (?:" + _ANIMALS + r")",
    r"(?:kids|kid|children|child)['’]?s? (?:toys?|books?|drawings?|crayons?|cartoons?|tv|show|menu|meal|room|playground|blocks?|lego)",
    r"toy (?:box|store|shop|blocks?)", r"kid goats?", r"sex pistols", r"middlesex", r"sussex", r"essex",
]) + r")\b", re.I)


def _clean(texts) -> str:
    return _ALLOW.sub(" ", " ".join(t for t in texts if t))

_MINOR = re.compile(
    r"\b(child|children|kid|kids|minor|minors|underage|under-age|teen|teens|teenage|teenager|preteen|pre-teen|"
    r"tween|loli|lolicon|shota|shotacon|toddler|infant|baby|babies|schoolgirl|schoolboy|little girl|little boy|"
    r"young girl|young boy|juvenile|pubescent|prepubescent|jailbait|"
    r"(?:[1-9]|1[0-7])\s*(?:yo|y/o|yrs?|years?)(?:[\s-]*old)?)\b",
    re.I,
)
_SEXUAL = re.compile(
    r"\b(sex|sexy|sexual|sexualized|nude|nudes|naked|nudity|erotic|erotica|porn|porno|pornographic|nsfw|"
    r"topless|bottomless|lingerie|aroused|arousal|genital|genitals|breasts?|nipples?|orgasm|seductive|sensual|"
    r"fetish|bdsm|lewd|hentai|undress|undressed|undressing|stripper|striptease|intercourse|masturbat\w*)\b",
    re.I,
)


def is_blocked(*texts: str) -> bool:
    joined = _clean(texts)
    return bool(_MINOR.search(joined) and _SEXUAL.search(joined))


_SEXUAL_STRICT = re.compile(
    r"\b(sex|sexy|sexual|sexualized|sexually|nude|nudes|naked|nudity|erotic|erotica|porn|porno|pornographic|nsfw|"
    r"topless|bottomless|lingerie|aroused|arousal|genital|genitals|penis|vagina|vulva|nipples?|orgasm|seductive|"
    r"sensual|fetish|bdsm|lewd|hentai|undress|undressed|undressing|stripper|striptease|intercourse|masturbat\w*|"
    r"boobs?|tits|bare[- ]breasted|breasts|onlyfans|xxx|horny|kinky)\b",
    re.I,
)


def is_sexual(*texts: str) -> bool:
    return bool(_SEXUAL_STRICT.search(_clean(texts)))


def is_disallowed(*texts: str) -> bool:
    """Anything we refuse to paint: sexual content, and (always) sexualized minors."""
    return is_blocked(*texts) or is_sexual(*texts)


# Minimal hateful-slur screen (hard block alongside sexual content and minors).
_SLUR = re.compile(r"\b(n[i1]gg(?:er|a)s?|f[a@]gg?ots?|k[i1]kes?|sp[i1]cs?|ch[i1]nks?|tr[a@]nn(?:y|ies)|wetbacks?|r[e3]tards?)\b", re.I)


def mentions_minor(*texts: str) -> bool:
    return bool(_MINOR.search(_clean(texts)))


def has_slur(*texts: str) -> bool:
    return bool(_SLUR.search(_clean(texts)))


def hard_block_reason(*texts: str) -> str | None:
    """The ONLY idea-level blocks: sexual/nude (incl. minors + sexual) and hateful slurs. A minor mentioned
    without sexual content is not blocked. Gross, crude, gory,
    absurd and offensive-but-not-hateful ideas are painted as written."""
    if is_sexual(*texts) or is_blocked(*texts):   # sexual/nudity, and minors + sexual
        return "sexual"
    if has_slur(*texts):
        return "slur"
    return None
