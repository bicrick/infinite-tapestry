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

    # Public, CDN-cached copy of every strip so viewers fetch images from the
    # Supabase CDN instead of the pod (the WS only carries small JSON refs).
    public_bucket = os.environ.get("TAPESTRY_PUBLIC_BUCKET", "strips")

    def public_base(self) -> str:
        return f"{self.url}/storage/v1/object/public/{self.public_bucket}/{self.prefix}/strips/"

    def _req(self, method: str, path: str, data: bytes | None = None, ctype: str = "application/octet-stream") -> bytes:
        bucket = self.bucket
        headers = {"Authorization": f"Bearer {self.key}", "apikey": self.key, "Content-Type": ctype, "x-upsert": "true"}
        if path.startswith("public:"):
            path, bucket = path[len("public:"):], self.public_bucket
            headers["cache-control"] = "max-age=31536000"  # strip keys are immutable
        req = urllib.request.Request(
            f"{self.url}/storage/v1/object/{bucket}/{self.prefix}/{path}", data=data, method=method, headers=headers,
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()

    def put(self, path: str, data: bytes, ctype: str) -> None:
        try:
            self._q.put_nowait((path, data, ctype))
        except queue.Full:
            self.failed += 1

    # ---- Postgres (PostgREST, service role) ----
    def _rest(self, method: str, path: str, body: Any = None, prefer: str = "") -> Any:
        req = urllib.request.Request(
            f"{self.url}/rest/v1/{path}", method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self.key}", "apikey": self.key,
                     "Content-Type": "application/json", **({"Prefer": prefer} if prefer else {})},
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            t = r.read()
            return json.loads(t) if t else None

    def db_async(self, fn) -> None:
        """Run a DB write on the uploader thread (ordered with uploads)."""
        try:
            self._q.put_nowait(("__call__", fn, ""))
        except queue.Full:
            self.failed += 1

    def save_strip_row(self, s: Strip) -> None:
        row = {"session": self.prefix, "idx": s.index, "width": s.width, "height": s.height,
               "overlap": s.overlap, "prompt": s.prompt[:500], "path": f"{self.prefix}/strips/{s.index:08d}.jpg",
               "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(s.created_at or time.time())),
               "scene": s.scene}
        self.db_async(lambda: self._rest("POST", "strips?on_conflict=session,idx", [row],
                                         "resolution=merge-duplicates,return=minimal"))

    def save_state_row(self, state: dict) -> None:
        row = {"id": self.prefix, "strip_index": int(state.get("strip_index", 0)), "data": state,
               "canvas_path": f"{self.prefix}/canvas.png", "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        self.db_async(lambda: self._rest("POST", "tapestry_state?on_conflict=id", [row],
                                         "resolution=merge-duplicates,return=minimal"))

    def load_state_row(self) -> dict | None:
        try:
            rows = self._rest("GET", f"tapestry_state?id=eq.{self.prefix}&select=data")
            return rows[0]["data"] if rows else None
        except Exception:
            logger.exception("Loading state from Postgres failed")
            return None

    def load_strip_rows(self, lo: int, hi: int) -> dict[int, dict]:
        rows = self._rest("GET", f"strips?session=eq.{self.prefix}&idx=gte.{lo}&idx=lte.{hi}&select=idx,width,height,overlap,prompt")
        return {r["idx"]: {"index": r["idx"], **r} for r in rows or []}

    def strip_times(self, idxs: list[int]) -> dict[int, float]:
        import calendar
        out: dict[int, float] = {}
        for k in range(0, len(idxs), 200):
            part = ",".join(str(i) for i in idxs[k:k + 200])
            rows = self._rest("GET", f"strips?session=eq.{self.prefix}&idx=in.({part})&select=idx,created_at") or []
            for r in rows:
                ts = r["created_at"][:19]
                out[r["idx"]] = calendar.timegm(time.strptime(ts, "%Y-%m-%dT%H:%M:%S"))
        return out

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
                    if path == "__call__":
                        data()
                    else:
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
                "prompt": s.prompt, "created_at": s.created_at, "scene": s.scene}
        with self._lock:
            self._strip_path(s.index).write_bytes(s.jpeg)
            with open(self.dir / "strips.jsonl", "a") as f:
                f.write(json.dumps(meta) + "\n")
        if self.mirror:
            # One durable copy, in the public CDN bucket (viewers fetch it directly).
            self.mirror.put(f"public:strips/{s.index:08d}.jpg", s.jpeg, "image/jpeg")
            self.mirror.save_strip_row(s)
        if getattr(self, "lod", None):
            self.lod.on_strip(s.index)

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
            # Cache miss: fetch from durable Storage and re-cache.
            data = None
            if self.mirror:  # newer strips live in the public bucket, older ones in the private one
                data = self.mirror.get(f"public:strips/{index:08d}.jpg") or self.mirror.get(f"strips/{index:08d}.jpg")
            if not data:
                return None
            p.write_bytes(data)
            if not meta and self.mirror:
                try:
                    meta = self.mirror.load_strip_rows(index, index).get(index)
                except Exception:
                    meta = None
        m = meta or {}
        return Strip(index=index, width=m.get("width", 0), height=m.get("height", 0), overlap=m.get("overlap", 0),
                     jpeg=p.read_bytes(), prompt=m.get("prompt", ""), created_at=m.get("created_at", 0.0),
                     scene=m.get("scene"))

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
            # canvas.png was queued just before, so state never points past it.
            self.mirror.save_state_row(state)
        return True

    def load_state(self) -> tuple[dict | None, Image.Image | None]:
        """Postgres is the source of truth; the local disk is only a cache.
        Falls back to the cache when Supabase isn't configured (dev/tests)."""
        if self.mirror:
            state = self.mirror.load_state_row()
            if state:
                canvas = None
                c = self.mirror.get("canvas.png")
                if c:
                    canvas = Image.open(io.BytesIO(c)).convert("RGB")
                logger.info("Restored state from Supabase at strip %s", state.get("strip_index"))
                return state, canvas
            return None, None
        p = self.dir / "state.json"
        state = json.loads(p.read_text()) if p.exists() else None
        canvas = None
        if (self.dir / "canvas.png").exists():
            canvas = Image.open(self.dir / "canvas.png").convert("RGB")
        return state, canvas
