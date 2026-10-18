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



def _err(e: Exception) -> str:
    """Short, secret-free description of an upload error (HTTP status + the start of the body, when there is one)."""
    code = getattr(e, "code", None)
    if code is not None:
        body = ""
        try:
            body = e.read()[:160].decode("utf-8", "replace")   # type: ignore[attr-defined]
        except Exception:
            pass
        return f"{type(e).__name__} {code} {body}".strip()
    resp = getattr(e, "response", None)
    if isinstance(resp, dict) and resp.get("Error"):
        return f"{type(e).__name__} {resp['Error'].get('Code', '')}".strip()
    return type(e).__name__


R2_KEYS = ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_URL")
# Durable copy of the R2 write keys in the PRIVATE Supabase `deploy` bucket (service role only). Every pod already holds
# the service role key, so a pod started without R2 env (stop/resume of an old pod, manual create, wiped /root) still
# writes R2.
R2_ENV_OBJECT = os.environ.get("TAPESTRY_R2_ENV_OBJECT", "deploy/secrets/r2.env")


def ensure_r2_env(env=None, fetch=None, force: bool = False) -> str:
    """Fill missing R2_* vars from the durable copy. Returns 'env', 'supabase' or 'none'. Never logs values.
    force=True (key rotation: the current keys stopped working) re-reads the copy and OVERWRITES env values; it then
    returns 'supabase' only if at least one value actually changed."""
    env = os.environ if env is None else env
    if not force and all(env.get(k) for k in R2_KEYS):
        return "env"
    url, key = (env.get("SUPABASE_URL") or "").rstrip("/"), env.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not (url and key):
        return "none"

    def _get() -> bytes:
        req = urllib.request.Request(f"{url}/storage/v1/object/{R2_ENV_OBJECT}",
                                     headers={"Authorization": f"Bearer {key}", "apikey": key})
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.read()
    try:
        text = (fetch or _get)().decode("utf-8", "replace")
    except Exception as e:
        logger.error("R2 keys missing from env and the durable copy (%s) could not be read: %s", R2_ENV_OBJECT, _err(e))
        return "none"
    got = 0
    for line in text.splitlines():
        line = line.strip().removeprefix("export ")
        if "=" not in line or line.startswith("#"):
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k.startswith("R2_") and v and (not env.get(k) or (force and env.get(k) != v)):
            env[k] = v
            got += 1
    ok = all(env.get(k) for k in R2_KEYS)
    if force:
        logger.warning("R2 key refresh from %s: %d value(s) changed", R2_ENV_OBJECT, got)
        return "supabase" if ok and got else "none"
    logger.warning("R2 keys were missing from the pod env; loaded %d from %s (%s)", got, R2_ENV_OBJECT,
                   "complete" if ok else "STILL INCOMPLETE")
    return "supabase" if ok else "none"


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

    off_reason = ""     # why R2 is not in use (surfaced in /health); never contains secret values
    creds_source = ""   # "env" | "supabase" (durable copy) | "none"

    @classmethod
    def from_env(cls) -> "R2Public | None":
        """R2 is always the write destination. There is no off switch: a legacy TAPESTRY_R2=0 is ignored, and missing
        keys are pulled from the durable copy. Only when that fails too does the pod run degraded (loudly)."""
        e = os.environ
        if e.get("TAPESTRY_R2") == "0":
            logger.warning("TAPESTRY_R2=0 is ignored: R2 is always the strip write destination")
        cls.creds_source = ensure_r2_env(e)
        missing = [k for k in R2_KEYS if not e.get(k)]
        if missing:
            cls.off_reason = "missing " + ",".join(missing)
            logger.error("R2 WRITES UNAVAILABLE (%s): strips go to Supabase Storage only. /health status=degraded",
                         cls.off_reason)
            return None
        try:
            return cls(e["R2_ENDPOINT"], e["R2_ACCESS_KEY_ID"], e["R2_SECRET_ACCESS_KEY"],
                       e.get("R2_BUCKET", "tapestry-strips"), e["R2_PUBLIC_URL"])
        except Exception as ex:
            cls.off_reason = f"init failed: {type(ex).__name__}"
            logger.exception("R2 init failed; staying on Supabase Storage")
            return None

    # r2.dev answers 403 to urllib's default "Python-urllib" agent, which made cors_ok() always False
    # (so every strip was also copied to Supabase) and get() always miss.
    SITE = os.environ.get("TAPESTRY_SITE_URL", "https://infinite-tapestry.vercel.app").rstrip("/")
    UA = f"infinite-tapestry/1.0 (+{SITE})"

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
                                         headers={"Origin": self.SITE, "User-Agent": self.UA})
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
        # Fast lane: strip/tile uploads + strip rows on UPLOAD_WORKERS threads, newest strips first (priority, seq).
        # Slow lane: one ordered thread for canvas.png + the state row (state must never point past its canvas).
        self._q: "queue.PriorityQueue[tuple]" = queue.PriorityQueue(maxsize=4000)
        self._slow: "queue.Queue[tuple]" = queue.Queue(maxsize=200)
        self._seq = 0
        self._seq_lock = threading.Lock()
        self.uploaded = 0
        self.failed = 0
        self.dropped = 0
        self._rows: list[dict] = []
        self._rows_lock = threading.Lock()
        self.row_batches = 0
        self.last_error = ""
        self.r2 = R2Public.from_env()
        self.r2_write_ok: bool | None = None
        self.r2_error = ""
        self.r2_failed = 0
        for n in range(self.UPLOAD_WORKERS):
            threading.Thread(target=self._run, args=(self._q, True), name=f"mirror-{n}", daemon=True).start()
        threading.Thread(target=self._run, args=(self._slow, False), name="mirror-slow", daemon=True).start()
        threading.Thread(target=self._r2_watch, name="r2-watch", daemon=True).start()
        threading.Thread(target=self._row_flusher, name="row-flush", daemon=True).start()

    R2_RECHECK_S = float(os.environ.get("TAPESTRY_R2_RECHECK_S", "300"))
    on_r2_change = None   # optional callback(ok: bool, reason: str), e.g. an ops event for the admin panel

    def r2_ok(self) -> bool:
        return self.r2 is not None and self.r2_write_ok is not False

    def _r2_watch(self) -> None:
        """Write check now, then every few minutes while degraded: re-reads keys (env or the durable copy), so a fixed
        key heals without a restart; logs an ERROR each round so a Supabase-only pod is never silent."""
        last = None
        while True:
            if self.r2 is None:
                self.r2 = R2Public.from_env()
            if self.r2 is not None:
                self._r2_check()
                if self.r2_write_ok is False and ensure_r2_env(os.environ, force=True) == "supabase":
                    # keys were rotated (CI refreshed the durable copy): rebuild the client with the new ones
                    fresh = R2Public.from_env()
                    if fresh is not None:
                        self.r2 = fresh
                        R2Public.creds_source = "supabase"
                        self._r2_check()
            ok = self.r2 is not None and self.r2_write_ok is True
            if not ok:
                logger.error("R2 DEGRADED: %s", self.r2_error or R2Public.off_reason or "write check failed")
            if ok != last and self.on_r2_change:
                try:
                    self.on_r2_change(ok, "" if ok else (self.r2_error or R2Public.off_reason))
                except Exception:
                    pass
            last = ok
            # healthy: re-check every 30 min, or as soon as uploads start failing (e.g. a revoked key)
            wait, seen = (self.R2_RECHECK_S if not ok else max(self.R2_RECHECK_S, 1800)), self.r2_failed
            t_end = time.time() + wait
            while time.time() < t_end and not (ok and self.r2_failed - seen >= 3):
                time.sleep(min(15.0, max(0.05, t_end - time.time())))

    UPLOAD_WORKERS = int(os.environ.get("TAPESTRY_UPLOAD_WORKERS", "4"))
    PRIO_STRIP, PRIO_ROW, PRIO_TILE = 0, 1, 2

    def _r2_check(self) -> None:
        """Startup write check: a broken key/bucket must be loud, not a silent fall back to Supabase."""
        try:
            self.r2.put(f"{self.prefix}/_health/write-check.txt", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()).encode(),
                        "text/plain")
            self.r2_write_ok, self.r2_error = True, ""
            logger.info("R2 write check OK (bucket %s, prefix %s)", self.r2.bucket, self.prefix)
        except Exception as e:
            self.r2_write_ok, self.r2_error = False, _err(e)
            logger.error("R2 WRITE CHECK FAILED (%s): strips will NOT reach the R2 CDN", self.r2_error)

    def health(self) -> dict:
        r2 = ({"configured": True, "write_ok": self.r2_write_ok, "error": self.r2_error, "failed": self.r2_failed,
               "cors": bool(self.r2._cors[1]), "source": R2Public.creds_source} if self.r2 is not None
              else {"configured": False, "write_ok": False, "error": R2Public.off_reason, "source": R2Public.creds_source})
        return {"r2": r2, "uploaded": self.uploaded, "failed": self.failed, "queue": self._q.qsize(),
                "slow_queue": self._slow.qsize(), "last_error": self.last_error,
                "dropped_no_r2": self.dropped, "supabase_storage_writes": 0}

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
        """Where viewers load strips: always R2 when it is configured (new strips exist nowhere else). Supabase only
        when the pod has no R2 at all (degraded; old strips still load from there)."""
        if self.r2 is not None:
            if not self.r2.cors_ok():
                logger.warning("R2 public bucket answered without CORS; viewers fall back to Supabase for old strips")
            return f"{self.r2.public_url}/{self.prefix}/strips/"
        return self.supabase_public_base()

    def fallback_base(self) -> str | None:
        """Read-only fallback for strips written before R2-only (the old R2 gap is being backfilled)."""
        return self.supabase_public_base() if self.r2 is not None else None

    def r2_key(self, path: str) -> str:
        """Every binary asset lives on R2 under the session prefix: public:strips/x -> live-sdxl/strips/x,
        canvas.png -> live-sdxl/canvas.png, crops/x -> live-sdxl/crops/x."""
        return f"{self.prefix}/{path[len('public:'):] if path.startswith('public:') else path}"

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

    def _next(self) -> int:
        with self._seq_lock:
            self._seq += 1
            return self._seq

    def put(self, path: str, data: bytes, ctype: str, after=None) -> None:
        """Queue an upload. `after` (optional) runs once it has succeeded (e.g. the strip's DB row)."""
        try:
            if not path.startswith("public:"):
                self._slow.put_nowait((path, data, ctype, after))
                return
            prio = self.PRIO_STRIP if path.startswith("public:strips/") else self.PRIO_TILE
            self._q.put_nowait((prio, self._next(), path, data, ctype, after))
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

    def db_async(self, fn, slow: bool = True) -> None:
        """Run a DB write on an uploader thread: the ordered slow lane (state) or the fast lane (strip rows)."""
        try:
            if slow:
                self._slow.put_nowait(("__call__", fn, "", None))
            else:
                self._q.put_nowait((self.PRIO_ROW, self._next(), "__call__", fn, "", None))
        except queue.Full:
            self.failed += 1

    def save_strip_row(self, s: Strip, now: bool = True) -> None:
        ext = _strip_ext(s.jpeg)
        row = {"session": self.prefix, "idx": s.index, "width": s.width, "height": s.height,
               "overlap": s.overlap, "prompt": s.prompt[:500], "path": f"{self.prefix}/strips/{s.index:08d}.{ext}",
               "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(s.created_at or time.time())),
               "scene": s.scene}
        # Batched: one upsert per ROW_FLUSH_S instead of one request per strip (Supabase request/log budget).
        with self._rows_lock:
            self._rows.append(row)

    ROW_FLUSH_S = float(os.environ.get("TAPESTRY_ROW_FLUSH_S", "10"))

    def flush_rows(self) -> int:
        with self._rows_lock:
            rows, self._rows = self._rows, []
        if not rows:
            return 0
        try:
            self._rest("POST", "strips?on_conflict=session,idx", rows, "resolution=merge-duplicates,return=minimal")
            self.row_batches += 1
            return len(rows)
        except Exception as e:
            logger.warning("strip rows batch (%d) failed: %s; retrying next flush", len(rows), _err(e))
            with self._rows_lock:
                self._rows = rows + self._rows if len(self._rows) < 2000 else self._rows
            return 0

    def _row_flusher(self) -> None:
        while True:
            time.sleep(self.ROW_FLUSH_S)
            self.flush_rows()

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

    def latest_idx(self) -> int | None:
        """Highest strip index ever published (what viewers have seen)."""
        rows = self._rest("GET", f"strips?session=eq.{self.prefix}&select=idx&order=idx.desc&limit=1")
        return int(rows[0]["idx"]) if rows else None

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
        """R2 first; Supabase Storage is read-only fallback for old objects written before R2-only (never written now)."""
        if self.r2:
            data = self.r2.get(self.r2_key(path))
            if data:
                return data
        try:
            return self._req("GET", path)
        except Exception:
            return None

    def _run(self, q: "queue.Queue", prioritized: bool) -> None:
        while True:
            item = q.get()
            path, data, ctype, after = item[2:] if prioritized else item
            for attempt in range(3):
                try:
                    if path == "__call__":
                        data()
                    elif self.r2 is None:
                        # R2-only: binary assets never go to Supabase Storage. The pod keeps its local copy and
                        # /health is degraded until the watchdog brings R2 back.
                        self.dropped += 1
                        self.last_error = f"{path}: R2 unavailable ({R2Public.off_reason})"
                        if after is not None:   # metadata (strip row) is relational data: still written
                            try:
                                after()
                            except Exception as e:
                                logger.warning("post-upload step for %s failed: %s", path, _err(e))
                        break
                    else:
                        try:
                            self.r2.put(self.r2_key(path), data, ctype)
                            if self.r2_write_ok is False:
                                logger.info("R2 writes recovered")
                            self.r2_write_ok, self.r2_error = True, ""
                        except Exception as e:
                            self.r2_failed += 1
                            self.r2_error = _err(e)
                            if attempt == 2:
                                self.r2_write_ok = False
                                logger.error("R2 UPLOAD %s FAILED: %s", path, self.r2_error)
                            raise
                    self.uploaded += 1
                    if after is not None:
                        try:
                            after()
                        except Exception as e:
                            logger.warning("post-upload step for %s failed: %s", path, _err(e))
                    break
                except Exception as e:
                    if attempt == 2:
                        self.failed += 1
                        self.last_error = f"{path}: {_err(e)}"
                        logger.warning("Storage upload %s failed: %s", path, _err(e))
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
            # The DB row (what /api/live hands out) is written right after the image landed, so refs never 404.
            self.mirror.put(f"public:strips/{s.index:08d}.{ext}", s.jpeg, _strip_mime(ext),
                            after=lambda m=self.mirror: m.save_strip_row(s, now=False))
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
            # canvas.png (~8 MB PNG) is only a restore fallback: restarts rebuild the context from the published
            # strips. Encoding it on every strip cost ~1 s of the persist thread, so do it only when mirroring.
            if canvas is not None and (mirror_now or not (self.dir / "canvas.png").exists()):
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
            p = self.dir / "state.json"
            try:
                local = json.loads(p.read_text()) if p.exists() else None
            except Exception:
                local = None
            if local and (self.dir / "canvas.png").exists() and int(local.get("strip_index", 0)) >= int((state or {}).get("strip_index", 0)):
                logger.info("Restored state from local cache at strip %s (mirror at %s)", local.get("strip_index"), (state or {}).get("strip_index"))
                return local, Image.open(self.dir / "canvas.png").convert("RGB")
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
