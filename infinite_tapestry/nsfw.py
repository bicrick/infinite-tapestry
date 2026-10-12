"""Open-source NSFW image classifier for generated strips.

Default model: Falconsai/nsfw_image_detection (ViT, Apache-2.0, labels
normal/nsfw). Loaded lazily on the GPU box; returns P(nsfw) for an image."""

from __future__ import annotations

import logging
from typing import Callable

from PIL import Image, ImageFilter

logger = logging.getLogger(__name__)

Classifier = Callable[[Image.Image], float]


def load_classifier(model_id: str, device: str = "cuda") -> Classifier | None:
    if not model_id:
        return None
    try:
        from transformers import pipeline

        clf = pipeline("image-classification", model=model_id, device=0 if device == "cuda" else -1)
    except Exception:
        logger.exception("NSFW classifier %s failed to load; image check disabled", model_id)
        return None
    logger.info("NSFW classifier ready: %s", model_id)

    def score(img: Image.Image) -> float:
        out = clf(img.convert("RGB"))
        for r in out:
            if str(r.get("label", "")).lower() in ("nsfw", "porn", "sexy", "hentai"):
                return float(r["score"])
        return 0.0

    return score


def obscure(img: Image.Image) -> Image.Image:
    """Last resort: heavy blur so nothing explicit is ever shown."""
    return img.filter(ImageFilter.GaussianBlur(radius=max(12, img.width // 8)))
