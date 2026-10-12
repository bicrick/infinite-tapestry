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

SYSTEM = """You direct an endless, slowly scrolling panoramic landscape painted strip by strip by Stable Diffusion 1.5 inpainting (512px tall, each strip 128px wide, about 2-3 seconds per strip).
The user types a loose intention for where the journey goes next. Turn it into a short plan of 1-4 scenes that travel there gradually and coherently from the current scene.
Rules for each scene prompt: a concrete SD 1.5 prompt (under 60 words) describing a wide horizontal landscape vista with a consistent horizon line; comma-separated descriptors; include lighting, palette, and "panoramic landscape, wide shot"; no people close-up, no text, no frames, no split images.
transition = strips used to blend into that scene (4-32; slow/gradual drift -> larger). hold = strips to stay on it before the next queued scene (8-60).
Reply with ONLY a JSON object, no prose:
{"scenes":[{"title":"2-4 word name","prompt":"...","negative":"extra negative terms or empty","transition":12,"hold":20}],"note":"one short sentence"}"""


class PromptInterpreter:
    def __init__(self, api_key: str | None = None, model: str | None = None, timeout: float = 20.0) -> None:
        self.api_key = api_key if api_key is not None else os.environ.get("ANTHROPIC_API_KEY", "")
        self.model = model or DEFAULT_MODEL
        self.timeout = timeout

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def _call(self, model: str, user: str) -> str:
        body = json.dumps(
            {
                "model": model,
                "max_tokens": 1200,
                "system": SYSTEM,
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
        return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")

    def plan(self, intent: str, current: str = "", upcoming: list[str] | None = None) -> dict[str, Any]:
        """Return {"scenes": [...], "note": str, "source": "haiku"|"raw", "model": str|None}."""
        intent = intent.strip()[:500]
        if not self.enabled:
            return fallback_plan(intent, "no API key")
        user = f"Current scene: {current or 'unknown'}\n"
        if upcoming:
            user += "Already queued after it: " + " | ".join(upcoming[:5]) + "\n"
        user += f"User intention: {intent}"
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


def parse_plan(text: str) -> dict[str, Any]:
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
                "transition": _clamp(s.get("transition"), 4, 32, 12),
                "hold": _clamp(s.get("hold"), 0, 120, 20),
            }
        )
    if not scenes:
        raise ValueError("empty plan")
    return {"scenes": scenes, "note": str(data.get("note", ""))[:200]}


def _clamp(v: Any, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def fallback_plan(intent: str, reason: str = "") -> dict[str, Any]:
    return {
        "scenes": [
            {
                "title": intent[:40],
                "prompt": f"{intent}, panoramic landscape, wide shot, detailed",
                "negative": "",
                "transition": 12,
                "hold": 20,
            }
        ],
        "note": "used your words directly" + (f" ({reason})" if reason else ""),
        "source": "raw",
        "model": None,
    }
