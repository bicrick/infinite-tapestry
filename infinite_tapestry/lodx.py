"""Macro LOD pyramid ("lodx"): fixed-size overview tiles for zooming out to the whole timeline.

The live LOD tiles (lod.py) scale both axes by 1/4^L, so past L3 they collapse to a few pixels tall. Macro tiles keep
a fixed 1024 x 128 pixels at every level and only the horizontal span grows x4 per level:

  level k (2..8): STRIPS[k] = 16 * 4^(k-1) strips per tile  (X2 = 64, X3 = 256, X4 = 1024 ... X8 = 262144)
  key           : <prefix>/lodx/<k>/<chunk:06d>.webp        (immutable once written: only complete chunks exist)
  overview      : <prefix>/lodx/ov/<n:08d>.webp, 2048 x 128, strips [0, n) for n a multiple of OV_STEP (4096)

X2 is built from 4 live L1 tiles (1024 x 256, 16 strips each), every higher level from its 4 children, the overview
from the complete X5 tiles. Nothing here needs a GPU: it is downsampling only (Pillow, BOX filter).

Blended pyramid (BLEND_LIVE / BLEND_X prefixes): each strip image is its 256 px slot plus a 192 px inpainted blend that
is drawn over the end of the previous strip (that overdraw is the only blending the zoom-1 viewer does). An L1 tile that
composes only its own 16 strips misses the next chunk's first strip, so its last slot shows a raw cut at every tile
edge. The blended L1 also paints strip 16(c+1) (clipped to the tile), so it is exactly the zoom-1 composite,
downsampled; L2/L3 and X2..X8 + the overview are then built from those, unchanged otherwise.
The viewer picks the level by on-screen size, so any zoom needs a handful of tiles (see frontend/src/viewer/lod.ts).
"""

from __future__ import annotations

import io
from typing import Callable, Optional, Sequence

from PIL import Image

TILE_W, TILE_H = 1024, 128
LEVELS = tuple(range(2, 9))
STRIPS = {k: 16 * 4 ** (k - 1) for k in range(1, 9)}   # 1: the live L1 tile (16 strips)
OV_STEP = STRIPS[5]   # 4096
OV_W = 2048
QUALITY = 60
CTYPE = "image/webp"
CACHE = "public, max-age=31536000, immutable"


BLEND_LIVE = "lodb"    # blended L1..L3 (same geometry and JPEG as lod/)
BLEND_X = "lodxb"      # blended X2..X8 + overview (same geometry and WebP as lodx/)


def key(level: int, chunk: int, base: str = "lodx") -> str:
    return f"{base}/{level}/{chunk:06d}.webp"


def ov_key(n: int, base: str = "lodx") -> str:
    return f"{base}/ov/{n:08d}.webp"


def live_key(level: int, chunk: int, base: str = BLEND_LIVE) -> str:
    return f"{base}/{level}/{chunk:06d}.jpg"


def complete_chunks(level: int, max_index: int) -> int:
    """Chunks of `level` that are complete when strips [0, max_index] exist (the viewer's rule: (c+1)*N <= max_index)."""
    return max(0, max_index // STRIPS[level])


def encode(im: Image.Image) -> bytes:
    b = io.BytesIO()
    im.save(b, "WEBP", quality=QUALITY, method=6)
    return b.getvalue()


def _open(data: Optional[bytes]) -> Optional[Image.Image]:
    if not data:
        return None
    try:
        return Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        return None


def combine(children: Sequence[Optional[bytes]], fill=(10, 10, 12)) -> Optional[bytes]:
    """4 children (left to right, each covering a quarter of the parent) -> one 1024 x 128 tile.
    Children may be live L1 tiles (1024 x 256) or macro tiles (1024 x 128); a missing child stays `fill`."""
    ims = [_open(c) for c in children]
    if not any(ims):
        return None
    q = TILE_W  # each child is drawn at TILE_W wide, then the 4x-wide strip is downsampled to TILE_W
    canvas = Image.new("RGB", (4 * q, TILE_H), fill)
    for j, im in enumerate(ims):
        if im is not None:
            canvas.paste(im.resize((q, TILE_H), Image.Resampling.BOX), (j * q, 0))
    return encode(canvas.resize((TILE_W, TILE_H), Image.Resampling.BOX))


def overview(n: int, x5: Callable[[int], Optional[bytes]], fill=(10, 10, 12)) -> Optional[bytes]:
    """Whole-timeline overview of strips [0, n) (n a multiple of OV_STEP) from the X5 tiles, OV_W x TILE_H."""
    k = n // OV_STEP
    if k <= 0:
        return None
    cw = 256   # each X5 tile drawn 256 wide (a quarter-resolution of its 1024), then fitted to OV_W
    canvas = Image.new("RGB", (k * cw, TILE_H), fill)
    got = 0
    for c in range(k):
        im = _open(x5(c))
        if im is not None:
            canvas.paste(im.resize((cw, TILE_H), Image.Resampling.BOX), (c * cw, 0))
            got += 1
    if not got:
        return None
    return encode(canvas.resize((OV_W, TILE_H), Image.Resampling.BOX))


def l1_from_strips(strips: Sequence[Optional[bytes]], sw: int, h: int, n: Optional[int] = None,
                   quality: int = 80) -> Optional[bytes]:
    """A live L1 tile (n slots, default len(strips)) composed from the strips like the viewer draws them (each strip
    image starts `overlap` before its slot, later strips paint over earlier ones), returned as a JPEG at 1/4 scale.
    Blended: pass n=16 and 17 strips, the 17th being the next chunk's first, whose blend covers the last slot."""
    n = len(strips) if n is None else n
    full = Image.new("RGB", (n * sw, h), (10, 10, 12))
    got = 0
    for j, s in enumerate(strips):
        im = _open(s)
        if im is None:
            continue
        if im.height != h:
            im = im.resize((round(im.width * h / im.height), h), Image.Resampling.BILINEAR)
        full.paste(im, (j * sw - (im.width - sw), 0))
        got += 1
    if not got:
        return None
    b = io.BytesIO()
    full.resize((n * sw // 4, h // 4), Image.Resampling.BOX).save(b, "JPEG", quality=quality)
    return b.getvalue()


def live_up(children: Sequence[Optional[bytes]], w: int, h: int, quality: int = 72) -> Optional[bytes]:
    """L2 / L3 live tile (w x h JPEG) from its 4 children laid side by side, like lod.LodBuilder."""
    ims = [_open(c) for c in children]
    if not any(ims):
        return None
    cw = next(im for im in ims if im is not None).size
    canvas = Image.new("RGB", (cw[0] * len(ims), cw[1]))
    for j, im in enumerate(ims):
        if im is not None:
            canvas.paste(im.resize(cw, Image.Resampling.BOX), (j * cw[0], 0))
    b = io.BytesIO()
    canvas.resize((w, h), Image.Resampling.BOX).save(b, "JPEG", quality=quality)
    return b.getvalue()
