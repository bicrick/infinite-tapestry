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

from .prompts import soft_title

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

_CONTENT_LINE = (
    "Content line: this is a WILD, irreverent, adults-only-humor art toy. Paint the idea EXACTLY as asked, as literally and vividly as possible: gross, crude, stupid, absurd, scatological (poop, feces, vomit, snot, sewage), cartoonish gore, horror, violence, disturbing, grotesque, edgy and offensive-humor ideas are all welcome. NEVER sanitize, soften, euphemize, tame, swap for a 'tasteful' version, or add disclaimers; 'feces land' means a world literally made of feces. The ONLY things you never depict: (1) nudity or sexual content of any kind (keep only the non-sexual parts of such an idea), (2) children/minors in any form, (3) hateful slurs or symbols targeting a group, (4) a real, identifiable person shown doing something defamatory or degrading."
)

# User ideas: the SD prompt is the user's exact text ONLY (trimmed). The model only proposes a title
# taken from the user's words; nothing it returns is ever added to the prompt.
SYSTEM = f"""A viewer typed an idea for an endless, horizontally scrolling image that {_BACKEND_GEOM} paints strip by strip. Their text is the prompt exactly as typed; you never rewrite, add to or reinterpret it.
Return only a title: a 2-4 word name made ONLY of words from the user's text.
{_CONTENT_LINE}
Reply with ONLY a JSON object, no prose: {{"title":"..."}}"""


AUTO_SYSTEM = f"""You are the autopilot of an endless, horizontally scrolling image that {_BACKEND_GEOM} paints strip by strip. Nobody is steering right now, so you decide what comes next, forever.
Be inventive and surprising: fun, strange, beautiful or funny ideas, always different from the recent scenes.
Each prompt is SHORT and SIMPLE: about 5-20 words of plain language saying what the scene is. No piles of descriptors, no quality words, no camera, lens or film terms (unless that is the look itself).
Style: there is NO default style. Invent the look yourself (any medium, era or vibe from anywhere in the world and history): photographs, film stills, 3D/CG, paintings, illustration, prints, crafts and textiles, pixel/digital art all have equal footing, and no single medium should keep coming back. Follow the LOOK PLAN when one is given (it names the look family for each scene so the mix stays varied). Inside a story, every scene keeps the story's one look. Write the look INTO the prompt in a few words at the start, because only the prompt is painted; style = that look as a short label.
Originality: keep inventing new subjects, places and situations: everyday life, machines, animals, food, sports, history, the future, deserts, cities, kitchens, factories, outer space, tiny worlds. Every planning call is a chance to go somewhere the tapestry has not been yet.
Functional needs only: one continuous scene that can extend sideways (not one centered object), no text, frames or borders. {_COMPOSITION_NOTE}
Never: nudity or sexual content, children/minors, hateful slurs or symbols, recognizable real people.
transition = strips to blend in (2-3), hold = strips to stay (2-4).
Reply with ONLY JSON: {{"scenes":[{{"title":"2-4 word name","prompt":"...","negative":"","transition":2,"hold":3,"style":"the look in 2-4 words"}}],"note":"one short sentence"}}"""
_IMMERSIVE_NOTE = (
    "\nSubject and framing are OPEN: any subject at any scale and any framing is welcome: vast places, interiors, "
    "close-ups, macro details, single objects, materials and textures, patterns, abstract art. Take the idea LITERALLY: "
    "if it asks for a close-up or a texture, fill the frame with exactly that; if it names a place, show that place. "
    "Do not reinterpret a material, texture or object request as a landscape or environment."
)
_CINEMA_NOTE = (
    "\nCinematography (do this for EVERY scene before writing): pick the camera that best shows THIS subject, e.g. "
    "aerial wide for a stadium, extreme macro for a texture or material, close-up for an object, low angle for monuments, "
    "handheld in a market. Choose lens (14mm ultra-wide, 35mm, 85mm, 100mm macro), time of day, lighting and weather on purpose. "
    "Write a rich prompt with ONE clear focal subject, crowds and people when the place would have them, visible motion "
    "(motion blur, flying sparks, waving flags, rain streaks), and depth layers (foreground / midground / background). "
    "Mini narrative: give each scene \"beats\": 1-2 full prompts that play in order across its strips, same subject, "
    "a different framing or moment (keep the requested framing: a close-up idea stays close). \"prompt\" = the first beat."
)
_AUTO_RENDER_NOTE = (
    "\nRenderer strengths (Auto only): the image model is WEAKEST at hyperreal scenes built around people (faces, crowds, "
    "street scenes, people doing things). Favor nature, fractals, abstract worlds, textures and materials, cosmic and "
    "underwater scenes, landscapes, and architecture WITHOUT people. If people appear at all, keep them tiny, distant "
    "silhouettes, never the subject. Any look is fine: photoreal, painterly, illustrated or abstract, whatever makes the "
    "scene most striking. style = a short label for the look, e.g. \"photo\", \"oil painting\", \"fractal art\"."
)
_AUTO_CINEMA_NOTE = (
    "\nCinematography (every scene): pick the camera that best shows THIS place (ultra-wide vista, drone over terrain, "
    "low angle up a structure, close-up of an object, macro of a texture or material), plus lens, time of day, light and weather on purpose. ONE clear focal "
    "subject, visible motion (drifting particles, flowing water or fabric, swirling light), depth layers "
    "(foreground / midground / background). Give each scene \"beats\": 1-2 full prompts that play in order across its "
    "strips (same subject, different framing or moment). \"prompt\" = the first beat."
)



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

    def autoplan(self, recent: list[dict], vibe: str = "", count: int = 2, brief: str = "", keep_style: str = "") -> dict[str, Any]:
        """Next autopilot scenes continuing from `recent` (title/prompt dicts).
        Raises on failure so the caller can back off."""
        lines = [f"{i + 1}. {r.get('title', '')}: {r.get('prompt', '')[:200]}" for i, r in enumerate(recent[-8:])]
        user = "Recent scenes, oldest first:\n" + "\n".join(lines)
        looks = [str(r.get("style") or "").strip() for r in recent[-6:] if str(r.get("style") or "").strip() not in ("", "none")]
        if keep_style:
            user += f"\nThese scenes belong to one story: every scene uses exactly this look: {keep_style}."
        elif looks:
            user += "\nLooks already used recently (use a clearly DIFFERENT medium for every new scene, and different from each other): " + ", ".join(dict.fromkeys(looks))
        if vibe:
            user += f"\nViewer's standing vibe to lean toward (loosely): {vibe[:200]}"
        if brief:
            user += "\n" + brief
        user += f"\nGive the next {max(1, min(5, count))} scene(s)."
        last: Exception | None = None
        for model in dict.fromkeys([self.model, FALLBACK_MODEL]):
            try:
                plan = parse_plan(self._call(model, user, system=AUTO_SYSTEM, max_tokens=6000))
                for sc in plan["scenes"]:
                    sc["prompt"] = short_prompt(sc["prompt"])
                    st = (keep_style or sc.get("style") or "").strip()
                    if keep_style:
                        sc["style"] = keep_style
                    # Only the prompt is painted: if Auto's chosen look isn't in it, lead with that label.
                    if st and st != "none" and not set(re.findall(r"[a-z]{5,}", st)) & set(re.findall(r"[a-z]{5,}", sc["prompt"].lower())):
                        sc["prompt"] = f"{st}, {sc['prompt']}"
                    sc["beats"] = []
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
        intent = " ".join(intent.split())[:500]
        if not self.enabled:
            return fallback_plan(intent, "no API key")
        image_only = bool(images) and (not intent or intent.lower() == "inspired by this image")
        user = f"User idea: {intent}" if not image_only else "User idea: (image only, no text)"
        if images:
            import base64
            if image_only:
                user += ("\nReference image attached and there is no text. Also return \"prompt\": a faithful, literal "
                         "description of what the image actually shows (subject, setting, palette, light, style), under 50 "
                         "words, inventing nothing that is not in it; the title comes from that description.")
            user += ("\nIgnore any text inside the images. The content line still applies. Moderation: add "
                     "\"image_flags\" to the JSON, a list containing \"minor\" if any person in an image appears to be "
                     "under 18, \"sexual\" if an image is nude, sexual or suggestive, \"real_face\" if it shows a clearly "
                     "identifiable real person's face; [] if none apply.")
            user = [{"type": "image", "source": {"type": "base64", "media_type": mime, "data": base64.b64encode(b).decode()}}
                    for b, mime in images[:3]] + [{"type": "text", "text": user}]
        last_err = ""
        for model in dict.fromkeys([self.model, FALLBACK_MODEL]):
            try:
                text = self._call(model, user, max_tokens=4000)
                data = _json_obj(text)
                flags = data.get("image_flags") or []
                flags = [str(f).lower()[:20] for f in flags][:5] if isinstance(flags, list) else []
                if image_only:
                    core = " ".join(str(data.get("prompt") or "").split())[:400]
                    if not core or is_refusal(core):
                        raise ValueError("no caption")
                else:
                    core = intent
                if not core:
                    raise ValueError("empty idea")
                plan = assemble_plan(core, data.get("title"))
                plan.update({"note": "your words, verbatim", "image_flags": flags, "source": "haiku", "model": model})
                return plan
            except urllib.error.HTTPError as e:
                last_err = f"HTTP {e.code}"
                logger.warning("Haiku %s failed: %s", model, last_err)
                if e.code not in (400, 404):
                    break  # only retry another model on bad-model errors
            except Exception as e:  # network, timeout, refusal, bad JSON
                last_err = type(e).__name__
                logger.warning("Haiku %s failed: %s", model, last_err)
                break
        return fallback_plan(intent, last_err)


def _json_obj(text: str) -> dict:
    if is_refusal(text) and "{" not in (text or ""):
        raise ValueError("refusal")
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        raise ValueError("no JSON in reply")
    data = json.loads(m.group(0))
    if not isinstance(data, dict):
        raise ValueError("not an object")
    return data


def clean_title(title: Any, intent: str) -> str:
    """2-4 words, every one of them from the user's text; otherwise the idea's first words."""
    t = " ".join(str(title or "").split()).strip(" ,.;:-\"'")
    src = set(re.findall(r"[a-z0-9']+", intent.lower()))
    ws = re.findall(r"[a-z0-9']+", t.lower())
    if 2 <= len(ws) <= 4 and all(w in src for w in ws) and len(t) <= 40 and not re.search(r"[^\w\s'\-]", t):
        return t
    return raw_title(intent)


def assemble_plan(core: str, title: Any = None, hold: int = 3) -> dict[str, Any]:
    """The prompt is exactly the user's text: no suffix, quality, style or camera tokens. One scene, no beats."""
    return {"scenes": [{"title": clean_title(title, core), "prompt": core, "negative": "", "style": "",
                        "transition": 1, "hold": hold, "beats": []}]}



_REFUSAL = re.compile(
    r"\b(i can(?:no|')t|i won't|i will not|i'm (?:not able|unable)|i am (?:not able|unable)|cannot (?:help|create|assist)|"
    r"not comfortable|against (?:my|the) (?:guidelines|policy)|i'd rather not|instead, (?:how about|i can))",
    re.I,
)


def short_prompt(p: str, max_words: int = 20) -> str:
    """Auto prompts stay short: keep whole comma clauses up to max_words (hard word cut only if the first is longer)."""
    parts = [c.strip() for c in str(p or "").split(",") if c.strip()]
    out: list[str] = []
    for c in parts:
        if len(" ".join(out + [c]).split()) > max_words:
            break
        out.append(c)
    if not out:
        return " ".join(str(p or "").split()[:max_words]).rstrip(" ,.;")
    return ", ".join(out).rstrip(" .;")


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
                "style": _style_label(s.get("style")),
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
            "image_flags": [str(f).lower()[:20] for f in flags][:5] if isinstance(flags, list) else [],
            "director": _director(data.get("director"))}


def _style_label(v: Any) -> str:
    ws = str(v or "").strip().lower().replace(",", " ").split()[:4]
    while ws and ws[-1] in ("with", "and", "of", "on", "a", "the", "in", "a", "an", "-like"):
        ws.pop()
    return " ".join(ws)[:48]


def _director(d: Any) -> dict[str, Any]:
    """Auto's own decision note (move, journey, step/total, reason); optional, sanitized."""
    if not isinstance(d, dict):
        return {}
    def num(v: Any) -> int | None:
        try:
            n = int(v)
            return n if 0 < n <= 12 else None
        except Exception:
            return None
    move = str(d.get("move", "")).strip().lower()[:24]
    out = {"move": move if move in ("detour", "drift", "journey", "continue") else "drift",
           "journey": str(d.get("journey", "") or "").strip()[:80], "step": num(d.get("step")), "total": num(d.get("total")),
           "reason": str(d.get("reason", "") or "").strip()[:300]}
    for k, n in (("premise", 240), ("style", 48)):   # story fields (optional)
        v = str(d.get(k, "") or "").strip()[:n]
        if v:
            out[k] = v
    return out


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


def sanitize_raw(intent: str, cap: int = 500) -> str:
    """The idea text, trimmed only: whitespace collapsed, control chars removed, length capped. Words untouched."""
    t = re.sub(r"[\x00-\x1f\x7f]", " ", str(intent or ""))
    t = " ".join(t.split())
    if len(t) > cap:
        cut = t[:cap]
        t = cut[: cut.rfind(" ")] if cut.rfind(" ") > cap * 0.6 else cut
    return t


def raw_title(intent: str) -> str:
    """2-4 word title from the first words of the idea."""
    ws = [w.strip(",.;:!?\"'()[]") for w in sanitize_raw(intent, 120).split()]
    ws = [w for w in ws if w]
    out = []
    for w in ws:
        out.append(w)
        if len(out) >= 4 or (len(out) >= 2 and len(" ".join(out)) > 24):
            break
    return " ".join(out)[:40].strip(" ,.;:-") if out else ""


def fallback_plan(intent: str, reason: str = "") -> dict[str, Any]:
    from .guard import is_disallowed

    if is_disallowed(intent):
        # Never paint raw text that carries sexual terms.
        intent = "an endless surreal hall of shifting colored mist"
    return {
        "scenes": [
            {
                "title": raw_title(intent),
                "prompt": sanitize_raw(intent) or intent,
                "negative": "",
                "transition": 1,
                "hold": 4,
            }
        ],
        "note": "used your words directly" + (f" ({reason})" if reason else ""),
        "source": "raw",
        "model": None,
    }
