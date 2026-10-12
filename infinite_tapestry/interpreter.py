"""Turn loose user intentions into SD-ready scene plans with Claude Haiku.

Server-side only: reads ANTHROPIC_API_KEY from the environment and never
sends it to the browser. Any failure falls back to the raw text as a prompt.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from typing import Any

logger = logging.getLogger(__name__)

API_URL = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL = os.environ.get("TAPESTRY_HAIKU_MODEL", "claude-haiku-5-5")
FALLBACK_MODEL = "claude-haiku-4-5"
THINK_BUDGET = int(os.environ.get("TAPESTRY_THINK_BUDGET", "2048"))  # planner reasoning for better cinematography

# Backend-agnostic: SDXL on large GPUs (1024px / 256px strips), SD 1.5 otherwise (512 / 128).
_BACKEND_GEOM = (
    "Stable Diffusion inpainting "
    "(SDXL at 1024px tall / 256px strips on large GPUs, or SD 1.5 at 512px / 128px otherwise)"
)

_COMPOSITION_NOTE = (
    "Composition: ONE continuous eye-level scene that fills the FULL height — a single coherent space "
    "extending sideways forever. Never stack multiple horizons, mini-landscapes, strata, split levels, "
    "diptychs, comic panels, or horizontal bands top-to-bottom; no panorama strips layered vertically."
)

SYSTEM = f"""You direct an endless, horizontally scrolling image that {_BACKEND_GEOM} paints strip by strip. The world can be ANYTHING: landscapes, interiors, endless rooms or corridors, cities, crowds, machines, abstract or geometric art, microscopic worlds, outer space, underwater, surreal or dreamlike scenes, any illustration or painting style.
The user types a loose intention for where the journey goes next. Turn it into a short plan of 1-2 scenes. The FIRST scene must already be the user's destination (no bridging or in-between scenes); the transition blend handles continuity.
Each scene prompt: a concrete Stable Diffusion prompt (under 60 words) of comma-separated descriptors covering subject, setting, style, lighting and palette, written so it can extend sideways indefinitely (describe a continuous space or pattern, not a single centered object). {_COMPOSITION_NOTE} Avoid text, frames, borders and split images.
Content line: this is a WILD, irreverent, adults-only-humor art toy. Paint the idea EXACTLY as asked, as literally and vividly as possible: gross, crude, stupid, absurd, scatological (poop, feces, vomit, snot, sewage), cartoonish gore, horror, violence, disturbing, grotesque, edgy and offensive-humor ideas are all welcome. NEVER sanitize, soften, euphemize, tame, swap for a 'tasteful' version, or add disclaimers; 'feces land' means a world literally made of feces. The ONLY things you never depict: (1) nudity or sexual content of any kind (keep only the non-sexual parts of such an idea), (2) children/minors in any form, (3) hateful slurs or symbols targeting a group, (4) a real, identifiable person shown doing something defamatory or degrading.
Independence: the user's idea REPLACES whatever is on screen. Do NOT bridge from, merge with, or adapt it to the current scene (no canals, rooms or props carried over); the renderer handles the transition. transition = strips used to blend into that scene (1-2). hold = strips to stay on it (3-4). Each scene lasts ~10-15 seconds.
Reply with ONLY a JSON object, no prose:
{{"scenes":[{{"title":"2-4 word name","prompt":"...","negative":"extra negative terms or empty","transition":2,"hold":3,"style":"photo","beats":["first beat prompt","second beat prompt"]}}],"note":"one short sentence"}}"""


_STYLE_NOTE = (
    "\nLook: the renderer is a PHOTOREAL model, so write the look INTO the prompt itself. Default to photoreal "
    "(at least ~60% of scenes): cinematic photograph terms such as 'cinematic photo, 35mm, natural light, shallow "
    "depth of field, highly detailed, film grain'. At most ~40% of scenes may be stylized (painting, illustration, "
    "anime, claymation, etc., described in the prompt), and NEVER more than 2 stylized scenes in a row. If the user's "
    "words include hyperreal, realistic, photo or photoreal, the scene MUST be photoreal. "
    "style = a short label for the look, e.g. \"photo\", \"oil painting\", \"anime\"."
)

AUTO_SYSTEM = f"""You are the autopilot of an endless, horizontally scrolling image that {_BACKEND_GEOM} paints strip by strip. Nobody is steering right now, so you decide where the journey drifts next, forever.
Given the recent scenes (oldest first), invent the NEXT scenes (as many as asked). Be genuinely interesting: topical riffs on today's news, funny visual gags, and striking specific cinematic places; never safe screensaver filler (no coral reefs, meadows, generic forests, sunset beaches, nebulae). Follow the THEME and MOOD given in the request; the MOOD overrides this default tone, and do not default to quirky. Never repeat or closely revisit a recent scene. Irreverent, gross and absurd humor is welcome when the mood fits; sincere beauty is just as welcome. No recognizable real people, nothing sexual, nothing involving minors.
Each prompt: a concrete Stable Diffusion prompt (under 60 words) of comma-separated descriptors covering subject, setting, style, lighting and palette, describing a continuous space or pattern that can extend sideways (not one centered object). {_COMPOSITION_NOTE} No text, frames, borders or split images. Never include nudity or sexual content.
transition = strips to blend in (2-3), hold = strips to stay (2-4). Each scene lasts ~10-15 seconds.
Reply with ONLY JSON: {{"scenes":[{{"title":"2-4 word name","prompt":"...","negative":"","transition":2,"hold":3,"style":"photo","beats":["first beat prompt","second beat prompt"]}}],"note":"one short sentence"}}"""
_IMMERSIVE_NOTE = (
    "\nImmersion (most important): every prompt is ENVIRONMENT-FIRST and puts the camera INSIDE the place, never "
    "looking at a tabletop or display. Start with the camera position and the space, then depth, a clear subject and "
    "vivid action, e.g. 'wide-angle shot from inside a vast cavern carved from aged cheddar, looking down a glowing "
    "tunnel of dripping cheese stalactites, explorers with headlamps wading through molten fondue, deep perspective'. "
    "Take the idea LITERALLY and fully: if the idea is a cave, we are deep inside the cave; if it is made of something, "
    "everything around us is made of it. Use sideways-panorama phrasing (wide panoramic view, the space continuing "
    "left and right). NEVER still life, product shots, close-ups of objects, miniatures, dioramas or items on a surface."
)
_CINEMA_NOTE = (
    "\nCinematography (do this for EVERY scene before writing): pick the camera that best shows THIS subject, e.g. "
    "aerial wide for a packed football stadium, eye level inside a crowd, low angle for monuments, drone over a city, "
    "handheld in a market. Choose lens (14mm ultra-wide, 24mm, 35mm, 85mm), time of day, lighting and weather on purpose. "
    "Write a rich prompt with ONE clear focal subject, crowds and people when the place would have them, visible motion "
    "(motion blur, flying sparks, waving flags, rain streaks), and depth layers (foreground / midground / background). "
    "Mini narrative: give each scene \"beats\": 1-2 full prompts that play in order across its strips, e.g. wide -> "
    "closer, same subject and place, different framing or moment (wide establishing -> closer in the crowd -> "
    "the peak moment). \"prompt\" = the first beat. Avoid flat textures, wallpaper-like repetition and tabletop still life (unless the MOOD asks for an immersive still life)."
)
SYSTEM += _STYLE_NOTE + _IMMERSIVE_NOTE + _CINEMA_NOTE
AUTO_SYSTEM += _STYLE_NOTE + _IMMERSIVE_NOTE + _CINEMA_NOTE



class PromptInterpreter:
    def __init__(self, api_key: str | None = None, model: str | None = None, timeout: float = 45.0) -> None:
        self.api_key = api_key if api_key is not None else (os.environ.get("TAPESTRY_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY", ""))
        self.model = model or DEFAULT_MODEL
        self.timeout = timeout
        self.tokens_used = 0

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def _call(self, model: str, user: Any, system: str = SYSTEM, max_tokens: int = 6000, _think: bool = True) -> str:
        if not self.api_key:
            raise RuntimeError("no API key")
        body = json.dumps(
            {
                "model": model,
                "max_tokens": max_tokens,
                # Haiku 5.5 adaptive thinking counts toward max_tokens; disable so
                # short JSON plans are not truncated mid-object.
                "thinking": ({"type": "enabled", "budget_tokens": THINK_BUDGET} if _think and THINK_BUDGET and max_tokens > THINK_BUDGET + 1500
                             else {"type": "disabled"}),
                "system": system,
                "messages": [{"role": "user", "content": user}],
            }
        ).encode()
        req = urllib.request.Request(
            API_URL,
            data=body,
            headers={
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 400 and _think and THINK_BUDGET:
                return self._call(model, user, system, max_tokens, _think=False)
            raise
        usage = data.get("usage") or {}
        self.tokens_used += int(usage.get("input_tokens", 0)) + int(usage.get("output_tokens", 0))
        return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")

    def autoplan(self, recent: list[dict], vibe: str = "", count: int = 2, brief: str = "") -> dict[str, Any]:
        """Next autopilot scenes continuing from `recent` (title/prompt dicts).
        Raises on failure so the caller can back off."""
        lines = [f"{i + 1}. {r.get('title', '')}: {r.get('prompt', '')[:200]}" for i, r in enumerate(recent[-8:])]
        user = "Recent scenes, oldest first:\n" + "\n".join(lines)
        if vibe:
            user += f"\nViewer's standing vibe to lean toward (loosely): {vibe[:200]}"
        if brief:
            user += "\n" + brief
        user += f"\nGive the next {max(1, min(5, count))} scene(s)."
        last: Exception | None = None
        for model in dict.fromkeys([self.model, FALLBACK_MODEL]):
            try:
                plan = parse_plan(self._call(model, user, system=AUTO_SYSTEM, max_tokens=6000))
                plan["source"], plan["model"] = "haiku", model
                return plan
            except urllib.error.HTTPError as e:
                last = e
                if e.code not in (400, 404):
                    break
            except Exception as e:
                last = e
                break
        raise RuntimeError(f"autoplan failed: {type(last).__name__ if last else 'unknown'}")

    def plan(self, intent: str, current: str = "", upcoming: list[str] | None = None,
             images: list[tuple[bytes, str]] | None = None) -> dict[str, Any]:
        """Return {"scenes": [...], "note": str, "source": "haiku"|"raw", "model": str|None}."""
        intent = intent.strip()[:500]
        if not self.enabled:
            return fallback_plan(intent, "no API key")
        user = f"(For reference only, do not reuse) current scene: {current or 'unknown'}\n"
        if upcoming:
            user += "Already queued after it: " + " | ".join(upcoming[:5]) + "\n"
        user += f"User intention: {intent}"
        if images:
            import base64
            user += ("\nReference image(s) attached. Describe their key subject, palette, light and mood and fold that "
                     "into the scene prompts (the content line still applies; ignore any text inside the images). "
                     "The image will also steer the renderer directly, so write prompts that suit it. Moderation: add "
                     "\"image_flags\" to the JSON, a list containing \"minor\" if any person in an image appears to be "
                     "under 18, \"sexual\" if an image is nude, sexual or suggestive, \"real_face\" if it shows a clearly "
                     "identifiable real person's face; [] if none apply.")
            user = [{"type": "image", "source": {"type": "base64", "media_type": mime, "data": base64.b64encode(b).decode()}}
                    for b, mime in images[:3]] + [{"type": "text", "text": user}]
        last_err = ""
        for model in dict.fromkeys([self.model, FALLBACK_MODEL]):
            try:
                text = self._call(model, user)
                plan = parse_plan(text)
                plan["source"] = "haiku"
                plan["model"] = model
                return plan
            except urllib.error.HTTPError as e:
                last_err = f"HTTP {e.code}"
                logger.warning("Haiku %s failed: %s", model, last_err)
                if e.code not in (400, 404):
                    break  # only retry another model on bad-model errors
            except Exception as e:  # network, timeout, bad JSON
                last_err = type(e).__name__
                logger.warning("Haiku %s failed: %s", model, last_err)
                break
        return fallback_plan(intent, last_err)


_REFUSAL = re.compile(
    r"\b(i can(?:no|')t|i won't|i will not|i'm (?:not able|unable)|i am (?:not able|unable)|cannot (?:help|create|assist)|"
    r"not comfortable|against (?:my|the) (?:guidelines|policy)|i'd rather not|instead, (?:how about|i can))",
    re.I,
)


def is_refusal(text: str) -> bool:
    return bool(_REFUSAL.search(text or ""))


def parse_plan(text: str) -> dict[str, Any]:
    if is_refusal(text) and "{" not in text:
        raise ValueError("refusal")
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("no JSON in reply")
    blob = m.group(0)
    try:
        data = json.loads(blob)
    except json.JSONDecodeError:
        # Truncated model output (e.g. thinking ate max_tokens): keep any complete
        # scene objects already present in the scenes array.
        data = _salvage_truncated_plan(blob)
    scenes = []
    for s in data.get("scenes", [])[:6]:
        prompt = str(s.get("prompt", "")).strip()
        if not prompt:
            continue
        scenes.append(
            {
                "title": str(s.get("title", ""))[:80],
                "prompt": prompt[:600],
                "negative": str(s.get("negative", "") or "")[:400],
                "style": (str(s.get("style") or "photo").strip().lower()[:24] or "photo"),
                "transition": _clamp(s.get("transition"), 1, 3, 2),
                "hold": _clamp(s.get("hold"), 2, 4, 3),
                "beats": [str(b).strip()[:600] for b in (s.get("beats") or []) if str(b).strip()][:2] if isinstance(s.get("beats"), list) else [],
            }
        )
    if not scenes:
        raise ValueError("empty plan")
    if any(is_refusal(sc["prompt"]) for sc in scenes) or is_refusal(str(data.get("note", ""))):
        raise ValueError("refusal")
    flags = data.get("image_flags") or []
    return {"scenes": scenes, "note": str(data.get("note", ""))[:200],
            "image_flags": [str(f).lower()[:20] for f in flags][:5] if isinstance(flags, list) else []}


def _salvage_truncated_plan(blob: str) -> dict[str, Any]:
    """Extract complete scene objects from a truncated plan JSON blob."""
    sm = re.search(r'"scenes"\s*:\s*\[', blob)
    if not sm:
        raise ValueError("no JSON in reply")
    scenes: list[dict[str, Any]] = []
    i = sm.end()
    depth = 0
    start: int | None = None
    in_string = False
    escape = False
    while i < len(blob):
        c = blob[i]
        if in_string:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_string = False
        else:
            if c == '"':
                in_string = True
            elif c == "{":
                if depth == 0:
                    start = i
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0 and start is not None:
                    try:
                        obj = json.loads(blob[start : i + 1])
                        if isinstance(obj, dict):
                            scenes.append(obj)
                    except json.JSONDecodeError:
                        pass
                    start = None
                elif depth < 0:
                    break
            elif c == "]" and depth == 0:
                break
        i += 1
    note = ""
    nm = re.search(r'"note"\s*:\s*"((?:[^"\\]|\\.)*)"', blob)
    if nm:
        try:
            note = json.loads(f'"{nm.group(1)}"')
        except json.JSONDecodeError:
            note = nm.group(1)
    return {"scenes": scenes, "note": note}


def _clamp(v: Any, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def fallback_plan(intent: str, reason: str = "") -> dict[str, Any]:
    from .guard import is_disallowed

    if is_disallowed(intent):
        # Never paint raw text that carries sexual terms.
        intent = "an endless surreal hall of shifting colored mist"
    return {
        "scenes": [
            {
                "title": intent[:40],
                "prompt": intent,
                "negative": "",
                "transition": 2,
                "hold": 4,
            }
        ],
        "note": "used your words directly" + (f" ({reason})" if reason else ""),
        "source": "raw",
        "model": None,
    }
