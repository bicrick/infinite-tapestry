"""Style LoRAs (SDXL). Claude picks a style per scene; weights ramp across transitions.

Each style: LoRA repo + file, a trigger phrase prepended to the prompt, and a default weight.
"none" means the base model's own look. Unavailable LoRAs are skipped at load time.
"""

from __future__ import annotations

STYLES: dict[str, dict] = {
    "none": {"lora": None, "trigger": "", "weight": 0.0},
    "pixel art": {"lora": ("nerijs/pixel-art-xl", "pixel-art-xl.safetensors"), "trigger": "pixel art", "weight": 0.9},
    "watercolor": {"lora": ("ostris/watercolor_style_lora_sdxl", "watercolor_v1_sdxl.safetensors"), "trigger": "watercolor painting", "weight": 0.85},
    "cartoon": {"lora": ("Linaqruf/sdxl-cartoon-lora", None), "trigger": "cartoon illustration, flat colors, bold outlines", "weight": 0.8},
    "papercut": {"lora": ("TheLastBen/Papercut_SDXL", "papercut.safetensors"), "trigger": "papercut", "weight": 0.85},
    "ink": {"lora": None, "trigger": "ink wash drawing, sumi-e", "weight": 0.0},
    "oil": {"lora": None, "trigger": "impasto oil painting, visible brushstrokes", "weight": 0.0},
}


def normalize(style: str | None) -> str:
    s = (style or "none").strip().lower()
    return s if s in STYLES else "none"


def names() -> list[str]:
    return list(STYLES)


def trigger(style: str | None) -> str:
    return STYLES[normalize(style)]["trigger"]


def with_trigger(prompt: str, style: str | None) -> str:
    t = trigger(style)
    return f"{t}, {prompt}" if t and t.lower() not in prompt.lower() else prompt


def ramp(style_a: str | None, style_b: str | None, t: float) -> dict[str, float]:
    """Adapter weights for a strip t∈[0,1] of the way from scene A to scene B (smoothstep)."""
    a, b = normalize(style_a), normalize(style_b or style_a)
    tt = max(0.0, min(1.0, t))
    e = tt * tt * (3 - 2 * tt)
    w: dict[str, float] = {}
    if STYLES[a]["lora"]:
        w[a] = w.get(a, 0.0) + STYLES[a]["weight"] * (1 - e)
    if STYLES[b]["lora"]:
        w[b] = w.get(b, 0.0) + STYLES[b]["weight"] * e
    return {k: round(v, 3) for k, v in w.items() if v > 0.01}
