"""Reference-image registry for image ideas (IP-Adapter steering).

Images live only in server memory, keyed by scene id, so they never ride along in
director state broadcasts. Moderation happens before registration (NSFW classifier
in crowd._load_ref + Claude vision flags in the plan).

Face mode (later, paid): IP-Adapter FaceID / InstantID to put a *specific person*
into the tapestry. NOT shipped. Hooks:
  - scenes carry ref_mode = "style" (default) | "face"
  - face_mode_allowed() is the single gate; it must check a paid entitlement, a
    recorded consent, and a live-selfie match between the uploader and the face
    in the reference before returning True. Today it always returns False and
    face requests are downgraded to style mode (identity not preserved).
"""

from __future__ import annotations

import io
import threading
from collections import OrderedDict

from PIL import Image

STYLE_SCALE = 0.55      # moderate: the reference flavors the scene, the prompt still leads
MAX_REFS = 32
BLOCK_FLAGS = {"minor", "sexual"}

_lock = threading.Lock()
_refs: "OrderedDict[int, Image.Image]" = OrderedDict()


def put(scene_id: int, jpeg: bytes) -> None:
    im = Image.open(io.BytesIO(jpeg)).convert("RGB")
    im.thumbnail((512, 512))
    with _lock:
        _refs[scene_id] = im
        while len(_refs) > MAX_REFS:
            _refs.popitem(last=False)


def get(scene_id: int | None) -> Image.Image | None:
    if scene_id is None:
        return None
    with _lock:
        return _refs.get(scene_id)


def blocked(flags) -> bool:
    return bool(BLOCK_FLAGS & {str(f).lower() for f in (flags or [])})


def face_mode_allowed(user_id: str | None, scene: dict) -> bool:
    """Future paid face mode gate: entitlement + consent + live-selfie match. Not shipped."""
    return False


def schedule(id_a: int | None, id_b: int | None, t: float) -> tuple[int | None, float]:
    """Which reference drives this strip and at what IP-Adapter scale.
    Ramps the outgoing ref down and the incoming ref up across the blend."""
    tt = max(0.0, min(1.0, t))
    tt = tt * tt * (3 - 2 * tt)
    wa = (1 - tt) if get(id_a) is not None else 0.0
    wb = tt if (id_b is not None and get(id_b) is not None) else 0.0
    if wa == 0.0 and wb == 0.0:
        return None, 0.0
    return (id_a, STYLE_SCALE * wa) if wa >= wb else (id_b, STYLE_SCALE * wb)
