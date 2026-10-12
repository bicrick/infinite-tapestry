"""Level-of-detail tiles for fast scrubbing.

Level L tile c covers strips [c*N_L, (c+1)*N_L) at 1/4^L resolution:
  L1: 16 strips @ 1/4, L2: 64 strips @ 1/16, L3: 256 strips @ 1/64.
Tiles are built when a chunk completes (and on demand for older chunks), cached on disk
and mirrored to Supabase Storage under <prefix>/lod/<L>/<c>.jpg.
"""

from __future__ import annotations

import io
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

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
            self.store.mirror.put(f"lod/{level}/{chunk:06d}.jpg", data, "image/jpeg")
        return data

    def get(self, level: int, chunk: int, build: bool = False) -> bytes | None:
        p = self.path(level, chunk)
        if p.exists():
            return p.read_bytes()
        m = getattr(self.store, "mirror", None)
        data = m.get(f"lod/{level}/{chunk:06d}.jpg") if m else None
        if data:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            return data
        return self.build(level, chunk) if build else None
