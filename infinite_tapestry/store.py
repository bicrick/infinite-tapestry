"""Durable history: strips + director/timeline state on disk, mirrored to
Supabase Storage when configured, restored on restart.

Layout under data_dir:
  strips/00000042.webp  one file per strip (blended pixels, as sent to viewers; legacy .jpg kept)
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


def _strip_ext(data: bytes) -> str:
    """Detect stored strip extension from payload magic bytes."""
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return "jpg"


def _strip_mime(ext: str) -> str:
    return "image/webp" if ext == "webp" else "image/jpeg"



class R2Public:
    """Public strip/tile CDN on Cloudflare R2 (S3 API, zero egress fees)."""

    CACHE = "public, max-age=31536000, immutable"  # strip + tile keys never change

    def __init__(self, endpoint: str, key_id: str, secret: str, bucket: str, public_url: str) -> None:
        import boto3
        from botocore.config import Config

        self.bucket, self.public_url = bucket, public_url.rstrip("/")
        self.s3 = boto3.client("s3", endpoint_url=endpoint, aws_access_key_id=key_id,
                               aws_secret_access_key=secret, region_name="auto",
                               config=Config(retries={"max_attempts": 3}, connect_timeout=10, read_timeout=30))
        self._cors: tuple[float, bool] = (0.0, False)

    @classmethod
    def from_env(cls) -> "R2Public | None":
        e = os.environ
        need = ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_URL")
        if not all(e.get(k) for k in need) or e.get("TAPESTRY_R2", "1") == "0":
            return None
        try:
            return cls(e["R2_ENDPOINT"], e["R2_ACCESS_KEY_ID"], e["R2_SECRET_ACCESS_KEY"],
                       e.get("R2_BUCKET", "tapestry-strips"), e["R2_PUBLIC_URL"])
        except Exception:
            logger.exception("R2 init failed; staying on Supabase Storage")
            return None

    # r2.dev answers 403 to urllib's default "Python-urllib" agent, which made cors_ok() always False
    # (so every strip was also copied to Supabase) and get() always miss.
    UA = "infinite-tapestry/1.0 (+https://infinite-tapestry.vercel.app)"

    def put(self, key: str, data: bytes, ctype: str) -> None:
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=ctype, CacheControl=self.CACHE)

    def get(self, key: str) -> bytes | None:
        try:
            req = urllib.request.Request(f"{self.public_url}/{key}", headers={"User-Agent": self.UA})
            with urllib.request.urlopen(req, timeout=15) as r:
                return r.read()
        except Exception:
            return None

    def cors_ok(self) -> bool:
        """Browsers read strips via fetch/canvas, so only serve from R2 once the bucket sends CORS."""
        at, ok = self._cors
        if time.time() - at < (600 if ok else 120):
            return ok
        try:
            req = urllib.request.Request(f"{self.public_url}/_probe.txt", method="GET",
                                         headers={"Origin": "https://infinite-tapestry.vercel.app", "User-Agent": self.UA})
            with urllib.request.urlopen(req, timeout=10) as r:
                ok = bool(r.headers.get("Access-Control-Allow-Origin"))
        except Exception:
            ok = False
        self._cors = (time.time(), ok)
        return ok


class SupabaseMirror:
    """Fire-and-forget uploads to a Supabase Storage bucket (service role)."""

    def __init__(self, url: str, key: str, bucket: str = "tapestry", prefix: str = "live") -> None:
        self.url, self.key, self.bucket, self.prefix = url.rstrip("/"), key, bucket, prefix
        self._q: "queue.Queue[tuple[str, bytes, str]]" = queue.Queue(maxsize=2000)
        self.uploaded = 0
        self.failed = 0
        self.r2 = R2Public.from_env()
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

    def supabase_public_base(self) -> str:
        return f"{self.url}/storage/v1/object/public/{self.public_bucket}/{self.prefix}/strips/"

    def r2_live(self) -> bool:
        return bool(self.r2 and self.r2.cors_ok())

    def public_base(self) -> str:
        """Where viewers load strips: R2 once it serves CORS, else the Supabase public bucket."""
        if self.r2_live():
            return f"{self.r2.public_url}/{self.prefix}/strips/"
        return self.supabase_public_base()

    def fallback_base(self) -> str | None:
        return self.supabase_public_base() if self.r2_live() else None

    def _supabase_public_too(self) -> bool:
        # Keep the Supabase copy until browsers can read R2; TAPESTRY_SUPABASE_PUBLIC=1 forces dual writes.
        return os.environ.get("TAPESTRY_SUPABASE_PUBLIC") == "1" or not self.r2_live()

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
        ext = _strip_ext(s.jpeg)
        row = {"session": self.prefix, "idx": s.index, "width": s.width, "height": s.height,
               "overlap": s.overlap, "prompt": s.prompt[:500], "path": f"{self.prefix}/strips/{s.index:08d}.{ext}",
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
        if path.startswith("public:") and self.r2:
            data = self.r2.get(f"{self.prefix}/{path[len('public:'):]}")
            if data:
                return data
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
                    elif path.startswith("public:") and self.r2:
                        self.r2.put(f"{self.prefix}/{path[len('public:'):]}", data, ctype)
                        if self._supabase_public_too():
                            try:
                                self._req("POST", path, data, ctype)
                            except Exception as e:
                                logger.warning("Supabase public copy %s failed: %s", path, type(e).__name__)
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
    def _strip_path(self, index: int, ext: str = "webp") -> Path:
        return self.dir / "strips" / f"{index:08d}.{ext}"

    def _find_strip_path(self, index: int) -> Path | None:
        for ext in ("webp", "jpg"):
            p = self._strip_path(index, ext)
            if p.exists():
                return p
        return None

    def save_strip(self, s: Strip) -> None:
        ext = _strip_ext(s.jpeg)
        meta = {"index": s.index, "width": s.width, "height": s.height, "overlap": s.overlap,
                "prompt": s.prompt, "created_at": s.created_at, "scene": s.scene, "ext": ext}
        with self._lock:
            self._strip_path(s.index, ext).write_bytes(s.jpeg)
            with open(self.dir / "strips.jsonl", "a") as f:
                f.write(json.dumps(meta) + "\n")
        if self.mirror:
            # One durable copy, in the public CDN bucket (viewers fetch it directly).
            self.mirror.put(f"public:strips/{s.index:08d}.{ext}", s.jpeg, _strip_mime(ext))
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
        p = self._find_strip_path(index)
        if p is None:
            # Cache miss: fetch from durable Storage and re-cache (webp first, then legacy jpg).
            data = None
            ext = "jpg"
            if self.mirror:
                for e in ("webp", "jpg"):
                    data = (self.mirror.get(f"public:strips/{index:08d}.{e}")
                            or self.mirror.get(f"strips/{index:08d}.{e}"))
                    if data:
                        ext = e
                        break
            if not data:
                return None
            p = self._strip_path(index, ext)
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
        d = self.dir / "strips"
        return len({p.stem for p in list(d.glob("*.jpg")) + list(d.glob("*.webp"))})

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
