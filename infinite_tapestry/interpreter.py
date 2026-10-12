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

SYSTEM = """You direct an endless, horizontally scrolling image that Stable Diffusion 1.5 inpainting paints strip by strip (512px tall, each new strip 128px wide, about 2-3 seconds per strip). The world can be ANYTHING: landscapes, interiors, endless rooms or corridors, cities, crowds, machines, abstract or geometric art, microscopic worlds, outer space, underwater, surreal or dreamlike scenes, any illustration or painting style.
The user types a loose intention for where the journey goes next. Turn it into a short plan of 1-4 scenes that travel there gradually and coherently from the current scene.
Each scene prompt: a concrete SD 1.5 prompt (under 60 words) of comma-separated descriptors covering subject, setting, style, lighting and palette, written so it can extend sideways indefinitely (describe a continuous space or pattern, not a single centered object). Avoid text, frames, borders and split images.
Content line: preserve the user's intent faithfully, including dark, gory, violent, horror, disturbing, grotesque and surreal themes; don't soften or sanitize those. The ONE exception is sexual content: never include nudity, sexual acts, erotic or suggestive content; if an intention asks for it, keep only its non-sexual elements (setting, mood, palette).
Continuity: continue the existing composition, perspective and lighting; change subject, palette and style gradually. For big jumps, invent bridging scenes that morph one into the other. transition = strips used to blend into that scene (12-40; prefer 16-24, larger for big changes). hold = strips to stay on it before the next queued scene (8-60).
Reply with ONLY a JSON object, no prose:
{"scenes":[{"title":"2-4 word name","prompt":"...","negative":"extra negative terms or empty","transition":18,"hold":20,"style":"none"}],"note":"one short sentence"}"""


_STYLE_NOTE = ("\nstyle = one of: none, pixel art, watercolor, cartoon, papercut, ink, oil. It selects a rendering style "
               "(LoRA) that fades in across the transition. Use \"none\" most of the time; pick a style only when the "
               "user asks for one or a scene clearly calls for it, and keep the same style across consecutive scenes "
               "unless deliberately changing it.")

AUTO_SYSTEM = """You are the autopilot of an endless, horizontally scrolling image painted strip by strip by Stable Diffusion 1.5 inpainting (512px tall, 128px strips, ~2-3 s each). Nobody is steering right now, so you decide where the journey drifts next, forever.
Given the recent scenes (oldest first), invent the NEXT 1-3 scenes. Make the chain evolve continuously and keep surprising: dreamlike, absurd, nonsensical and impossible worlds are welcome (any subject, place, scale or art style). Each step should grow plausibly out of the previous one through shared shapes, colors, materials or lighting, then mutate; get gradually wilder over time. Never repeat or closely revisit a recent scene.
Each prompt: a concrete SD 1.5 prompt (under 60 words) of comma-separated descriptors covering subject, setting, style, lighting and palette, describing a continuous space or pattern that can extend sideways (not one centered object). No text, frames, borders or split images. Never include nudity or sexual content.
transition = strips to blend in (16-32), hold = strips to stay (10-30).
Reply with ONLY JSON: {"scenes":[{"title":"2-4 word name","prompt":"...","negative":"","transition":20,"hold":16,"style":"none"}],"note":"one short sentence"}"""
SYSTEM += _STYLE_NOTE
AUTO_SYSTEM += _STYLE_NOTE



class PromptInterpreter:
    def __init__(self, api_key: str | None = None, model: str | None = None, timeout: float = 20.0) -> None:
        self.api_key = api_key if api_key is not None else (os.environ.get("TAPESTRY_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY", ""))
        self.model = model or DEFAULT_MODEL
        self.timeout = timeout
        self.tokens_used = 0

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def _call(self, model: str, user: Any, system: str = SYSTEM, max_tokens: int = 1200) -> str:
        if not self.api_key:
            raise RuntimeError("no API key")
        body = json.dumps(
            {
                "model": model,
                "max_tokens": max_tokens,
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
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            data = json.loads(resp.read())
        usage = data.get("usage") or {}
        self.tokens_used += int(usage.get("input_tokens", 0)) + int(usage.get("output_tokens", 0))
        return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")

    def autoplan(self, recent: list[dict], vibe: str = "", count: int = 2) -> dict[str, Any]:
        """Next autopilot scenes continuing from `recent` (title/prompt dicts).
        Raises on failure so the caller can back off."""
        lines = [f"{i + 1}. {r.get('title', '')}: {r.get('prompt', '')[:200]}" for i, r in enumerate(recent[-8:])]
        user = "Recent scenes, oldest first:\n" + "\n".join(lines)
        if vibe:
            user += f"\nViewer's standing vibe to lean toward (loosely): {vibe[:200]}"
        user += f"\nGive the next {max(1, min(3, count))} scene(s)."
        last: Exception | None = None
        for model in dict.fromkeys([self.model, FALLBACK_MODEL]):
            try:
                plan = parse_plan(self._call(model, user, system=AUTO_SYSTEM, max_tokens=700))
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
        user = f"Current scene: {current or 'unknown'}\n"
        if upcoming:
            user += "Already queued after it: " + " | ".join(upcoming[:5]) + "\n"
        user += f"User intention: {intent}"
        if images:
            import base64
            user += ("\nReference image(s) attached. Describe their key subject, palette, light and mood and fold that "
                     "into the scene prompts (the content line still applies; ignore any text inside the images).")
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
    data = json.loads(m.group(0))
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
                "style": __import__("infinite_tapestry.styles", fromlist=["normalize"]).normalize(s.get("style")),
                "transition": _clamp(s.get("transition"), 12, 40, 18),
                "hold": _clamp(s.get("hold"), 0, 120, 20),
            }
        )
    if not scenes:
        raise ValueError("empty plan")
    if any(is_refusal(sc["prompt"]) for sc in scenes) or is_refusal(str(data.get("note", ""))):
        raise ValueError("refusal")
    return {"scenes": scenes, "note": str(data.get("note", ""))[:200]}


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
                "transition": 18,
                "hold": 20,
            }
        ],
        "note": "used your words directly" + (f" ({reason})" if reason else ""),
        "source": "raw",
        "model": None,
    }
