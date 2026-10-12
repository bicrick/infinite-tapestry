"""Durable history: strips + director/timeline state on disk, mirrored to
Supabase Storage when configured, restored on restart.

Layout under data_dir:
  strips/00000042.jpg   one file per strip (blended pixels, as sent to viewers)
  strips.jsonl          one JSON line of metadata per strip
  state.json            director + timeline + generator counters (atomic write)
  canvas.png            the generator's rolling context canvas
"""

from __future__ import annotations

import io
import json
import logging
import os
import queue
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image

from .buffer import Strip

logger = logging.getLogger(__name__)


class SupabaseMirror:
    """Fire-and-forget uploads to a Supabase Storage bucket (service role)."""

    def __init__(self, url: str, key: str, bucket: str = "tapestry", prefix: str = "live") -> None:
        self.url, self.key, self.bucket, self.prefix = url.rstrip("/"), key, bucket, prefix
        self._q: "queue.Queue[tuple[str, bytes, str]]" = queue.Queue(maxsize=2000)
        self.uploaded = 0
        self.failed = 0
        threading.Thread(target=self._run, name="supabase-mirror", daemon=True).start()

    @classmethod
    def from_env(cls) -> "SupabaseMirror | None":
        url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not (url and key) or os.environ.get("TAPESTRY_STORAGE_MIRROR", "1") == "0":
            return None
        return cls(url, key, os.environ.get("TAPESTRY_STORAGE_BUCKET", "tapestry"),
                   os.environ.get("TAPESTRY_STORAGE_PREFIX", "live"))

    def _req(self, method: str, path: str, data: bytes | None = None, ctype: str = "application/octet-stream") -> bytes:
        req = urllib.request.Request(
            f"{self.url}/storage/v1/object/{self.bucket}/{self.prefix}/{path}", data=data, method=method,
            headers={"Authorization": f"Bearer {self.key}", "apikey": self.key, "Content-Type": ctype, "x-upsert": "true"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()

    def put(self, path: str, data: bytes, ctype: str) -> None:
        try:
            self._q.put_nowait((path, data, ctype))
        except queue.Full:
            self.failed += 1

    def get(self, path: str) -> bytes | None:
        try:
            return self._req("GET", path)
        except Exception:
            return None

    def _run(self) -> None:
        while True:
            path, data, ctype = self._q.get()
            for attempt in range(3):
                try:
                    self._req("POST", path, data, ctype)
                    self.uploaded += 1
                    break
                except Exception as e:
                    if attempt == 2:
                        self.failed += 1
                        logger.warning("Storage upload %s failed: %s", path, type(e).__name__)
                    time.sleep(1 + attempt * 2)


class HistoryStore:
    def __init__(self, data_dir: str | os.PathLike, mirror: SupabaseMirror | None = None) -> None:
        self.dir = Path(data_dir)
        (self.dir / "strips").mkdir(parents=True, exist_ok=True)
        self.mirror = mirror
        self._lock = threading.Lock()
        self._last_state = 0.0

    # ---- strips ----
    def _strip_path(self, index: int) -> Path:
        return self.dir / "strips" / f"{index:08d}.jpg"

    def save_strip(self, s: Strip) -> None:
        meta = {"index": s.index, "width": s.width, "height": s.height, "overlap": s.overlap,
                "prompt": s.prompt, "created_at": s.created_at}
        with self._lock:
            self._strip_path(s.index).write_bytes(s.jpeg)
            with open(self.dir / "strips.jsonl", "a") as f:
                f.write(json.dumps(meta) + "\n")
        if self.mirror:
            self.mirror.put(f"strips/{s.index:08d}.jpg", s.jpeg, "image/jpeg")

    def load_meta(self) -> dict[int, dict]:
        out: dict[int, dict] = {}
        p = self.dir / "strips.jsonl"
        if p.exists():
            for line in p.read_text().splitlines():
                try:
                    m = json.loads(line)
                    out[int(m["index"])] = m
                except Exception:
                    continue
        return out

    def load_strip(self, index: int, meta: dict | None = None) -> Strip | None:
        p = self._strip_path(index)
        if not p.exists():
            return None
        m = meta or {}
        return Strip(index=index, width=m.get("width", 0), height=m.get("height", 0), overlap=m.get("overlap", 0),
                     jpeg=p.read_bytes(), prompt=m.get("prompt", ""), created_at=m.get("created_at", 0.0))

    def strips_between(self, start: int, end: int, meta: dict[int, dict] | None = None) -> list[Strip]:
        meta = meta if meta is not None else self.load_meta()
        out = []
        for i in range(max(0, start), end + 1):
            s = self.load_strip(i, meta.get(i))
            if s:
                out.append(s)
        return out

    def count(self) -> int:
        return len(list((self.dir / "strips").glob("*.jpg")))

    # ---- state ----
    def save_state(self, state: dict[str, Any], canvas: Image.Image | None = None, force: bool = False) -> bool:
        """Always written locally (consistent with the strips on disk); mirrored
        to Storage only when `force` or every 30 s to save bandwidth."""
        now = time.monotonic()
        mirror_now = force or now - self._last_state >= 30.0
        if mirror_now:
            self._last_state = now
        data = json.dumps(state).encode()
        with self._lock:
            tmp = self.dir / "state.json.tmp"
            tmp.write_bytes(data)
            os.replace(tmp, self.dir / "state.json")
            if canvas is not None:
                buf = io.BytesIO()
                canvas.save(buf, format="PNG")
                (self.dir / "canvas.png.tmp").write_bytes(buf.getvalue())
                os.replace(self.dir / "canvas.png.tmp", self.dir / "canvas.png")
                if self.mirror and mirror_now:
                    self.mirror.put("canvas.png", buf.getvalue(), "image/png")
        if self.mirror and mirror_now:
            self.mirror.put("state.json", data, "application/json")
        return True

    def load_state(self) -> tuple[dict | None, Image.Image | None]:
        p = self.dir / "state.json"
        state = json.loads(p.read_text()) if p.exists() else None
        canvas = None
        if (self.dir / "canvas.png").exists():
            canvas = Image.open(self.dir / "canvas.png").convert("RGB")
        if state is None and self.mirror:
            # Fresh disk (e.g. new pod): pull state + canvas + recent strips from Storage.
            raw = self.mirror.get("state.json")
            if raw:
                state = json.loads(raw)
                c = self.mirror.get("canvas.png")
                if c:
                    canvas = Image.open(io.BytesIO(c)).convert("RGB")
                last = int(state.get("strip_index", 0))
                for i in range(max(0, last - 200), last):
                    b = self.mirror.get(f"strips/{i:08d}.jpg")
                    if b:
                        self._strip_path(i).write_bytes(b)
                        with open(self.dir / "strips.jsonl", "a") as f:
                            f.write(json.dumps({"index": i, "width": state.get("strip_width", 128) + state.get("overlap", 0),
                                                "height": state.get("height", 512), "overlap": state.get("overlap", 0), "prompt": ""}) + "\n")
                logger.info("Restored state from Supabase Storage at strip %d", last)
        return state, canvas
