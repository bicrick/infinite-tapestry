"""Level-of-detail tiles for fast scrubbing.

Level L tile c covers strips [c*N_L, (c+1)*N_L) at 1/4^L resolution:
  L1: 16 strips @ 1/4, L2: 64 strips @ 1/16, L3: 256 strips @ 1/64.
Tiles are built when a chunk completes (and on demand for older chunks), cached on disk
and mirrored to R2 under <prefix>/lod/<L>/<c>.jpg.

Past L3 the macro pyramid (lodx.py: fixed-height WebP, x4 strips per level up to the whole timeline) is built the same
way when its chunk completes, plus the whole-timeline overview every 4096 strips. Those tiles are immutable: an
existing one (local or on the CDN) is never rebuilt or re-uploaded.

The blended pyramid (lodx.BLEND_LIVE / lodx.BLEND_X: same keys under lodb/ and lodxb/) is the same set of tiles with
the next chunk's first strip painted over each tile's right edge, so tile boundaries show the zoom-1 overlap blend
instead of a hard cut. A blended tile is built once the strip after its chunk exists.
"""

from __future__ import annotations

import io
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

from . import lodx

logger = logging.getLogger(__name__)
STRIPS_PER_TILE = {1: 16, 2: 64, 3: 256}
FACTOR = {1: 4, 2: 16, 3: 64}


class LodBuilder:
    def __init__(self, store, strip_width: int, height: int) -> None:
        self.store, self.sw, self.h = store, strip_width, height
        self.dir = Path(store.dir) / "lod"
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="lod")
        self._lock = threading.Lock()

    def path(self, level: int, chunk: int) -> Path:
        return self.dir / str(level) / f"{chunk:06d}.jpg"

    def on_strip(self, index: int) -> None:
        for level, n in STRIPS_PER_TILE.items():
            if (index + 1) % n == 0:
                self._pool.submit(self._safe_build, level, index // n)
        # macro pyramid (one worker: runs after the L1 it is built from)
        for k in lodx.LEVELS:
            if (index + 1) % lodx.STRIPS[k] == 0:
                self._pool.submit(self._safe_build_x, k, index // lodx.STRIPS[k])
        if (index + 1) % lodx.OV_STEP == 0:
            self._pool.submit(self._safe_build_ov, index + 1)
        # blended pyramid: chunk c of N strips is ready once strip N*(c+1) (this one) exists
        if index > 0:
            for level, n in STRIPS_PER_TILE.items():
                if index % n == 0:
                    self._pool.submit(self._safe, self.get_b, level, index // n - 1)
            for k in lodx.LEVELS:
                if index % lodx.STRIPS[k] == 0:
                    self._pool.submit(self._safe, self.get_xb, k, index // lodx.STRIPS[k] - 1)
            if index % lodx.OV_STEP == 0:
                self._pool.submit(self._safe, self.overview_b, index)

    @staticmethod
    def _safe(fn, *args) -> None:
        try:
            fn(*args, build=True)
        except Exception:
            logger.exception("blended LOD build failed %s%s", fn.__name__, args)

    def get_b(self, level: int, chunk: int, build: bool = False) -> bytes | None:
        """Blended live tile (lodb/<level>/<chunk>.jpg): same geometry as get(), edges blended with the next chunk."""
        rel = lodx.live_key(level, chunk)
        data = self._cached(rel)
        if data or not build:
            return data
        n = STRIPS_PER_TILE[level]
        if level == 1:
            meta = self.store.load_meta()
            strips = []
            for i in range(chunk * n, (chunk + 1) * n + 1):
                st = self.store.load_strip(i, meta.get(i))
                strips.append(st.jpeg if st else None)
            if strips[-1] is None:
                return None   # the next chunk's first strip is not there yet: no blend to paint
            data = lodx.l1_from_strips(strips, self.sw, self.h, n=n, quality=72)
        else:
            data = lodx.live_up([self.get_b(level - 1, chunk * 4 + j, build=True) for j in range(4)], *self.size(level))
        if data:
            self._publish(rel, data, "image/jpeg")
        return data

    def get_xb(self, level: int, chunk: int, build: bool = False) -> bytes | None:
        """Blended macro tile (lodxb/...), from blended children."""
        rel = lodx.key(level, chunk, lodx.BLEND_X)
        data = self._cached(rel)
        if data or not build:
            return data
        data = lodx.combine([self.get_b(1, chunk * 4 + j, build=True) if level == 2 else self.get_xb(level - 1, chunk * 4 + j, build=True)
                             for j in range(4)])
        if data:
            self._publish(rel, data)
        return data

    def overview_b(self, n: int, build: bool = True) -> bytes | None:
        rel = lodx.ov_key(n, lodx.BLEND_X)
        data = self._cached(rel)
        if data or not build:
            return data
        data = lodx.overview(n, lambda c: self.get_xb(5, c, build=True))
        if data:
            self._publish(rel, data)
        return data

    def _safe_build_x(self, level: int, chunk: int) -> None:
        try:
            self.get_x(level, chunk, build=True)
        except Exception:
            logger.exception("macro LOD build failed X%d c%d", level, chunk)

    def _safe_build_ov(self, n: int) -> None:
        try:
            self.overview(n)
        except Exception:
            logger.exception("overview build failed n=%d", n)

    def xpath(self, rel: str) -> Path:
        return self.dir.parent / rel

    def _cached(self, rel: str) -> bytes | None:
        p = self.xpath(rel)
        if p.exists():
            return p.read_bytes()
        m = getattr(self.store, "mirror", None)
        data = m.get(f"public:{rel}") if m else None
        if data:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        return data

    def _publish(self, rel: str, data: bytes, ctype: str = lodx.CTYPE) -> None:
        p = self.xpath(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        if getattr(self.store, "mirror", None):
            self.store.mirror.put(f"public:{rel}", data, ctype)

    def get_x(self, level: int, chunk: int, build: bool = False) -> bytes | None:
        """Macro tile X<level> chunk (lodx.STRIPS[level] strips), from its 4 children (L1 tiles for X2)."""
        rel = lodx.key(level, chunk)
        data = self._cached(rel)
        if data or not build:
            return data
        kids = [self.get(1, chunk * 4 + j, build=True) if level == 2 else self.get_x(level - 1, chunk * 4 + j, build=True)
                for j in range(4)]
        data = lodx.combine(kids)
        if data:
            self._publish(rel, data)
        return data

    def overview(self, n: int) -> bytes | None:
        """The whole-timeline overview for strips [0, n), n a multiple of lodx.OV_STEP (from the X5 tiles)."""
        rel = lodx.ov_key(n)
        data = self._cached(rel)
        if data:
            return data
        data = lodx.overview(n, lambda c: self.get_x(5, c, build=True))
        if data:
            self._publish(rel, data)
        return data

    def _safe_build(self, level: int, chunk: int) -> None:
        try:
            self.build(level, chunk)
        except Exception:
            logger.exception("LOD build failed L%d c%d", level, chunk)

    def size(self, level: int) -> tuple[int, int]:
        n, f = STRIPS_PER_TILE[level], FACTOR[level]
        return max(1, n * self.sw // f), max(1, self.h // f)

    def build(self, level: int, chunk: int) -> bytes | None:
        n, f = STRIPS_PER_TILE[level], FACTOR[level]
        w, h = self.size(level)
        if level == 1:
            full = Image.new("RGB", (n * self.sw, self.h))
            meta = self.store.load_meta()
            got = 0
            for i in range(chunk * n, (chunk + 1) * n):
                s = self.store.load_strip(i, meta.get(i))
                if not s:
                    continue
                im = Image.open(io.BytesIO(s.jpeg)).convert("RGB")
                full.paste(im, ((i - chunk * n) * self.sw - (im.width - self.sw), 0))
                got += 1
            if not got:
                return None
            tile = full.resize((w, h), Image.Resampling.BOX)
        else:
            sub = STRIPS_PER_TILE[level - 1]
            k = n // sub
            sw_prev, h_prev = self.size(level - 1)
            canvas = Image.new("RGB", (sw_prev * k, h_prev))
            got = 0
            for j in range(k):
                data = self.get(level - 1, chunk * k + j, build=True)
                if data:
                    canvas.paste(Image.open(io.BytesIO(data)).convert("RGB"), (j * sw_prev, 0))
                    got += 1
            if not got:
                return None
            tile = canvas.resize((w, h), Image.Resampling.BOX)
        buf = io.BytesIO()
        tile.save(buf, "JPEG", quality=72)
        data = buf.getvalue()
        p = self.path(level, chunk)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        if getattr(self.store, "mirror", None):
            # Public CDN bucket: viewers load overview tiles from there, not from the pod.
            self.store.mirror.put(f"public:lod/{level}/{chunk:06d}.jpg", data, "image/jpeg")
        return data

    def get(self, level: int, chunk: int, build: bool = False) -> bytes | None:
        p = self.path(level, chunk)
        if p.exists():
            return p.read_bytes()
        m = getattr(self.store, "mirror", None)
        data = (m.get(f"public:lod/{level}/{chunk:06d}.jpg") or m.get(f"lod/{level}/{chunk:06d}.jpg")) if m else None
        if data:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            return data
        return self.build(level, chunk) if build else None


MAX_CROP_STRIPS = 64


def crop_section(store, sw: int, height: int, a: int, b: int, w: int, h: int) -> bytes | None:
    """Stitch strips a..b and cover-fit them into w x h (used for profile thumbnails and share cards).

    The tapestry is append-only, so a finished section never changes: callers cache the result forever.
    """
    a, b = max(0, a), max(a, min(b, a + MAX_CROP_STRIPS - 1))
    key = f"crops/{a}-{b}-{w}x{h}.jpg"
    p = Path(store.dir) / key
    if p.exists():
        return p.read_bytes()
    m = getattr(store, "mirror", None)
    data = m.get(key) if m else None
    if not data:
        meta = store.load_meta()
        full = Image.new("RGB", ((b - a + 1) * sw, height))
        got = 0
        for i in range(a, b + 1):
            s = store.load_strip(i, meta.get(i))
            if not s:
                continue
            im = Image.open(io.BytesIO(s.jpeg)).convert("RGB")
            full.paste(im, ((i - a) * sw - (im.width - sw), 0))
            got += 1
        if not got:
            return None
        # cover-fit around the section centre
        scale = max(w / full.width, h / full.height)
        rw, rh = max(w, round(full.width * scale)), max(h, round(full.height * scale))
        im = full.resize((rw, rh), Image.Resampling.LANCZOS)
        x, y = (rw - w) // 2, (rh - h) // 2
        im = im.crop((x, y, x + w, y + h))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=84, optimize=True, progressive=True)
        data = buf.getvalue()
        if m:
            m.put(key, data, "image/jpeg")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return data
