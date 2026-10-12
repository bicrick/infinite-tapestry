"""CPU mock inpainter for pipeline / frontend testing without a GPU."""

from __future__ import annotations

import hashlib
import time
from typing import TYPE_CHECKING

import numpy as np
from PIL import Image, ImageDraw, ImageFont

if TYPE_CHECKING:
    from .config import Config

from .inpaint import Inpainter


class MockInpainter(Inpainter):
    """Synthesize a plausible continuation of the masked region.

    Extends edge colors with noise and a drifting hue so the scroll visibly
    changes over time. Intentionally fast (~tens of ms) so buffer logic and
    the WebSocket client can be exercised on any machine.
    """

    def __init__(self, config: "Config") -> None:
        self.config = config
        self._calls = 0

    def generate(
        self,
        image: Image.Image,
        mask: Image.Image,
        prompt: str,
        negative_prompt: str = "",
        seed: int | None = None,
        prompt_b: str | None = None,
        t: float = 0.0,
    ) -> Image.Image:
        del negative_prompt  # unused in mock
        if prompt_b and t >= 0.5:
            prompt = prompt_b
        self._calls += 1
        # Simulate a little work so timing paths aren't unrealistically instant.
        time.sleep(0.05)

        arr = np.asarray(image.convert("RGB")).astype(np.float32)
        mask_arr = np.asarray(mask.convert("L"))
        h, w = arr.shape[:2]
        paint = mask_arr > 127

        if not paint.any():
            return image.copy()

        base_seed = seed if seed is not None else self.config.seed
        prompt_hash = int(hashlib.md5(prompt.encode("utf-8")).hexdigest()[:8], 16)
        rng = np.random.default_rng(base_seed + self._calls * 17 + (prompt_hash % 10_000))

        # Continuity: sample colors from the column just left of the mask.
        xs = np.where(paint.any(axis=0))[0]
        x0 = int(xs.min())
        context_col = max(0, x0 - 1)
        edge = arr[:, context_col : context_col + 1, :]  # (H, 1, 3)

        # Vertical gradient shift + horizontal progress within the strip.
        yy = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
        xx = np.linspace(0, 1, w, dtype=np.float32)[None, :, None]
        hue = np.array(
            [
                18 * np.sin(self._calls / 7.0 + prompt_hash % 7),
                14 * np.cos(self._calls / 11.0),
                20 * np.sin(self._calls / 5.0 + 1.3),
            ],
            dtype=np.float32,
        )

        noise = rng.normal(0.0, 8.0, size=arr.shape).astype(np.float32)
        # Soft horizontal bands so each strip looks distinct when scrolling.
        bands = 12.0 * np.sin(
            2 * np.pi * (2 + (self._calls % 5)) * xx + self._calls * 0.4
        )
        generated = edge + hue + noise + bands + (yy - 0.5) * 10.0
        generated = np.clip(generated, 0, 255)

        out = arr.copy()
        out[paint] = generated[paint]

        result = Image.fromarray(out.astype(np.uint8), mode="RGB")
        # Tiny label for debugging mock mode (top-left of masked region).
        draw = ImageDraw.Draw(result)
        label = f"mock#{self._calls}"
        try:
            font = ImageFont.load_default()
        except Exception:
            font = None
        draw.text((x0 + 4, 8), label, fill=(255, 255, 255), font=font)
        # Encode prompt influence as a thin color bar.
        bar_color = (
            80 + (prompt_hash & 0x7F),
            80 + ((prompt_hash >> 7) & 0x7F),
            80 + ((prompt_hash >> 14) & 0x7F),
        )
        draw.rectangle([x0, h - 6, w - 1, h - 1], fill=bar_color)
        return result
