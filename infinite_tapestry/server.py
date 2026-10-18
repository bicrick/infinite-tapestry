"""FastAPI app: static client + WebSocket strip stream with keep-alives."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import struct
import threading
import time

from . import pools
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

if TYPE_CHECKING:
    from .buffer import Strip, StripBuffer
    from .config import Config
    from .generator import StripGenerator

logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# Binary frame: magic(4) + index(u32) + width(u16) + height(u16) + overlap(u16)
# + prompt_len(u16) + prompt_utf8 + jpeg_bytes
MAGIC = b"ITAP"
HEADER_FMT = "!4sIHHHH"  # magic, index, width, height, overlap, prompt_len
HEADER_SIZE = struct.calcsize(HEADER_FMT)

# App-level keep-alive well under RunPod proxy idle timeout (~100s).
PING_INTERVAL_S = 20.0


RECENT_ON_CONNECT = 24


def apply_render_settings(r: dict, generator) -> dict:
    """Admin live settings (auto_config.render): scene widths and fresh-anchor seam/bridge. Clamped; no restart."""
    out = {}
    def num(k, lo, hi, cast=int):
        try:
            v = cast(r[k])
        except Exception:
            return None
        return max(lo, min(hi, v))
    a = (num("auto_min", 3, 30), num("auto_max", 3, 30))
    u = (num("user_min", 3, 30), num("user_max", 3, 30))
    d = generator.director
    if hasattr(d, "set_widths"):
        d.set_widths(auto=(min(a), max(a)) if None not in a else None, user=(min(u), max(u)) if None not in u else None)
        out["widths"] = dict(d.widths)
    cfg = generator.config
    sp = num("seam_px", 32, int(cfg.overlap))
    if sp is not None:
        cfg.anchor_seam_px = sp
    bs = num("bridge_strength", 0.3, 1.0, float)
    if bs is not None:
        cfg.anchor_bridge_strength = bs
    out.update(seam_px=cfg.anchor_seam_px, bridge_strength=cfg.anchor_bridge_strength)
    return out


def strip_scene_message(strip: "Strip") -> dict | None:
    """Per-strip scene label so clients caption what is on screen, not the director's plan (which runs ahead)."""
    sc = getattr(strip, "scene", None) or {}
    if not sc.get("title"):
        return None
    return {"type": "strip_scene", "i": int(strip.index),
            "s": [sc.get("title") or "", sc.get("by") or "", sc.get("style") or "", sc.get("origin") or ""]}


def strip_ref(strip: Any) -> dict:
    """Small JSON reference to a strip; the image itself comes from the public CDN."""
    g = (lambda k, d=None: strip.get(k, d)) if isinstance(strip, dict) else (lambda k, d=None: getattr(strip, k, d))
    sc = g("scene") or {}
    ref = {"i": int(g("index")), "w": int(g("width", 0) or 0), "h": int(g("height", 0) or 0),
           "o": int(g("overlap", 0) or 0), "p": (g("prompt", "") or "")[:160]}
    if sc.get("title"):
        ref["s"] = [sc.get("title") or "", sc.get("by") or "", sc.get("style") or "", sc.get("origin") or ""]
    return ref


def _on_loop(loop: asyncio.AbstractEventLoop) -> bool:
    try:
        return asyncio.get_running_loop() is loop
    except RuntimeError:
        return False


class Viewer:
    """One connected viewer: bounded queue of outbound messages."""

    __slots__ = ("q", "v2", "task", "kicked")

    def __init__(self, v2: bool) -> None:
        self.q: asyncio.Queue[Any] = asyncio.Queue(maxsize=CLIENT_QUEUE_MAX)
        self.v2 = v2
        self.task: asyncio.Task | None = None
        self.kicked = False

    def offer(self, item: Any) -> None:
        if self.kicked:
            return
        try:
            self.q.put_nowait(item)
        except asyncio.QueueFull:
            self.kicked = True  # too slow: drop it, it will reconnect and resync
            if self.task:
                self.task.cancel()


def encode_strip_message(strip: "Strip") -> bytes:
    prompt_bytes = strip.prompt.encode("utf-8")
    if len(prompt_bytes) > 65535:
        prompt_bytes = prompt_bytes[:65535]
    header = struct.pack(
        HEADER_FMT,
        MAGIC,
        int(strip.index),
        int(strip.width),
        int(strip.height),
        int(strip.overlap),
        len(prompt_bytes),
    )
    return header + prompt_bytes + strip.jpeg


class RateLimiter:
    """Per-key cooldown (e.g. per client IP)."""

    def __init__(self, cooldown_s: float) -> None:
        self.cooldown = cooldown_s
        self._last: dict[str, float] = {}

    def check(self, key: str) -> float:
        """Return 0 if allowed (and record), else seconds left to wait."""
        now = time.monotonic()
        left = self.cooldown - (now - self._last.get(key, -1e9))
        if left > 0:
            return left
        self._last[key] = now
        if len(self._last) > 5000:
            self._last.clear()
        return 0.0


def client_ip(ws: WebSocket) -> str:
    """Real client IP from the trusted proxy hop.

    RunPod's proxy sets ``cf-connecting-ip`` (and sometimes ``x-real-ip``). A
    viewer can spoof ``X-Forwarded-For``'s leftmost value to bypass the
    per-IP connection cap, so that header is only used as a last resort, and
    then from the rightmost (proxy-appended) hop.
    """
    for h in ("cf-connecting-ip", "true-client-ip", "x-real-ip"):
        v = (ws.headers.get(h) or "").strip()
        if v:
            return v.split(",")[0].strip()
    fwd = (ws.headers.get("x-forwarded-for") or "").strip()
    if fwd:
        parts = [p.strip() for p in fwd.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return ws.client.host if ws.client else "?"


MAX_INTENT_CHARS = 300
MAX_MESSAGE_BYTES = 4096
MAX_CONN_PER_IP = int(os.environ.get("TAPESTRY_MAX_CONN_PER_IP", "8"))
MAX_CONNECTIONS = int(os.environ.get("TAPESTRY_MAX_CONNECTIONS", "5000"))
# Per-viewer outbound queue (pre-serialized JSON). A viewer that falls this far
# behind is disconnected (it reconnects and resyncs) so memory stays bounded.
CLIENT_QUEUE_MAX = int(os.environ.get("TAPESTRY_CLIENT_QUEUE", "256"))
SEND_TIMEOUT_S = 15.0
DIRECTOR_MIN_INTERVAL_S = 0.5
CONTROL_TYPES = {"intent", "autopilot", "speed", "skip", "remove", "move", "edit", "play", "clear",
                 "configure", "set_prompt", "queue"}
MAX_QUEUE = 30


def _title_from_prompt(p: str) -> str:
    """Older strips (before scene metadata) get a title from the first clause of their prompt."""
    head = (p or "").split(",")[0].strip()
    words = head.split()[:5]
    return " ".join(w.capitalize() if len(w) > 3 else w for w in words)


def _reap(t) -> None:
    """Retrieve a finished per-viewer task's exception (disconnects) so asyncio doesn't log it as an error."""
    if not t.cancelled():
        t.exception()


def create_app(
    config: "Config",
    buffer: "StripBuffer",
    generator: "StripGenerator | None" = None,
    interpreter: Any = None,
    intent_cooldown: float = 2.0,
    control_cooldown: float = 0.2,
    clock_hz: float = 20.0,
    broadcast_hz: float = 4.0,
) -> FastAPI:
    """One shared tapestry: a single generator, one global timeline (scroll
    position + speed) ticked on the server and broadcast to every viewer, and
    one shared scene queue. Viewers can only pan back locally."""
    app = FastAPI(title="Infinite Tapestry", version="0.3.0")
    from fastapi.middleware.cors import CORSMiddleware

    from .prompts import make_scene
    from .timeline import Timeline

    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )
    base_target = buffer.target
    timeline = Timeline(config.strip_width, default_speed=config.scroll_speed)
    app.state.timeline = timeline
    clients: set[Viewer] = set()
    app.state.viewer_count = lambda: len(clients)   # ops heartbeat
    hub: dict[str, Any] = {"loop": None, "meta": None, "dir_json": None, "dir_at": 0.0, "dir_timer": None,
                           "public_base": None}
    conn_per_ip: dict[str, int] = {}
    intent_limit = RateLimiter(intent_cooldown)
    control_limit = RateLimiter(control_cooldown)
    clock_task: dict[str, asyncio.Task | None] = {"t": None}
    from .reactions import Reactions
    reactions = Reactions()
    app.state.reactions = reactions

    if interpreter is None:
        from .interpreter import PromptInterpreter

        interpreter = PromptInterpreter()
    app.state.interpreter = interpreter

    autopilot = None
    if generator is not None:
        from .autopilot import Autopilot

        autopilot = Autopilot(generator.director, interpreter, on_change=lambda: broadcast_director())
        autopilot.enabled = bool(getattr(config, "autopilot", True))
    app.state.autopilot = autopilot

    from .crowd import Crowd, Supa

    supa = Supa.from_env()
    crowd = None
    if supa and generator is not None and os.environ.get("TAPESTRY_CROWD", "1") == "1":
        crowd = Crowd(supa, generator.director, interpreter, generator,
                      broadcast=lambda m: broadcast(m), on_change=lambda: broadcast_director(), mock=config.mock)
        crowd.viewers = lambda: len(clients)   # priority queue engages with a big audience
    if generator is not None:   # reactions on the scene on stage stretch its hold (LiveDirector._hold_len)
        generator.director.heat = lambda since: sum(sum(reactions.by_strip[i].values()) for i in range(since, since + 40) if i in reactions.by_strip)
    app.state.crowd = crowd
    if autopilot is not None and supa is not None:
        def _auto_cfg() -> dict | None:
            rows = supa.rest("GET", "auto_config?id=eq.1&select=*")
            cfg = dict(rows[0]) if rows else {}
            try:
                st = supa.rest("GET", "story_playlist?status=in.(queued,playing)&order=position.asc,id.asc&limit=1"
                                      "&select=id,status,scene_index,story:stories(id,title,theme,style,scenes)")
                cfg["story"] = st[0] if st else None
            except Exception:
                logger.warning("story playlist fetch failed; keeping the current story")
            return cfg
        autopilot.config_fetch = _auto_cfg
        if generator is not None:
            autopilot.on_render = lambda r: apply_render_settings(r, generator)

        def _story_progress(pid: int, k: int) -> None:
            supa.rest("PATCH", f"story_playlist?id=eq.{int(pid)}&status=in.(queued,playing)",
                      {"status": "playing", "scene_index": int(k)}, prefer="return=minimal")
            supa.rest("PATCH", f"story_playlist?id=eq.{int(pid)}&started_at=is.null",
                      {"started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, prefer="return=minimal")

        def _story_done(pid: int) -> None:
            supa.rest("PATCH", f"story_playlist?id=eq.{int(pid)}&status=in.(queued,playing)",
                      {"status": "done", "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, prefer="return=minimal")
        def _decision(dec: dict) -> None:
            def go() -> None:
                try:
                    supa.rest("POST", "auto_decisions", {k: dec.get(k) for k in ("move", "journey", "step", "total", "reason", "titles")})
                except Exception:
                    logger.warning("auto decision log failed")
            threading.Thread(target=go, daemon=True).start()
        autopilot.decision_log = _decision
        autopilot.story_progress = lambda pid, k: threading.Thread(target=_story_progress, args=(pid, k), daemon=True).start()
        autopilot.story_done = _story_done
    if generator is not None:
        def _on_flag(scene: dict) -> None:
            """Explicit output after one repaint: strike the source idea(s) and log it (runs on the generator thread)."""
            ids = [i for i in (scene or {}).get("idea_ids") or []]
            logger.warning("explicit-output strike: scene=%r ideas=%s", (scene or {}).get("title"), ids)
            if supa is None:
                return
            try:
                if ids:
                    supa.rest("PATCH", "ideas?id=in.(%s)" % ",".join(str(i) for i in ids), {"status": "rejected"}, "return=minimal")
                supa.audit("nsfw_output_strike", ",".join(str(i) for i in ids),
                           {"title": (scene or {}).get("title"), "by": (scene or {}).get("by"), "origin": (scene or {}).get("origin")})
            except Exception:
                logger.exception("strike bookkeeping failed")
        generator.on_flag = _on_flag
    if autopilot and crowd:
        autopilot.pressure = lambda: len(crowd.pending)

    upcoming_box = {"seq": 0, "items": None}

    def build_upcoming(st: dict) -> list[dict]:
        """Public Next list: queued user scenes, then waiting pool ideas. Auto's filler is never listed, so viewers
        don't feel they compete with it (user ideas always play ahead of Auto anyway; admins see Auto's plan in the dashboard)."""
        items = st.get("items") or []
        users = [dict(i, kind="scene") for i in items if i.get("origin") != "auto"]
        woven = {x for i in items for x in (i.get("idea_ids") or [])}
        pool = [{"id": f"idea-{p['id']}", "kind": "idea", "origin": "user", "title": p["body"][:80],
                 "prompt": p["body"], "by": "@" + p["handle"] if p.get("handle") else None, "image": p.get("image"),
                 "idea_id": p["id"], "votes": p.get("votes", 0), "place": p.get("place"), "eta": p.get("eta")}
                for p in (crowd.pending if crowd else []) if p["id"] not in woven]
        return users + pool

    def director_state() -> dict[str, Any] | None:
        if not generator:
            return None
        st = generator.director.state()
        st["autopilot"] = autopilot.state() if autopilot else None
        st["fuel"] = crowd.state() if crowd else None
        up = build_upcoming(st)
        st["items"] = [i for i in (st.get("items") or []) if i.get("origin") != "auto"]  # public payload: hide Auto's queue
        if up != upcoming_box["items"]:
            upcoming_box["items"] = up
            upcoming_box["seq"] += 1
        st["upcoming"], st["upcoming_seq"] = up, upcoming_box["seq"]
        return st

    def gpu_stats() -> dict[str, Any] | None:
        return generator.stats() if generator else None

    def clock_msg() -> dict[str, Any]:
        return {"type": "clock", **timeline.state(), "now": time.time(), "viewers": len(clients)}

    def broadcast(msg: Any) -> None:
        """Serialize once, enqueue the same string for every viewer (never blocks)."""
        text = msg if isinstance(msg, str) else json.dumps(msg)
        loop = hub["loop"]
        if loop is not None and not _on_loop(loop):
            loop.call_soon_threadsafe(broadcast, text)
            return
        for c in list(clients):
            c.offer(text)

    def director_json(max_age: float = 1.0) -> str:
        """Cached serialized director state (shared by every viewer)."""
        now = time.monotonic()
        if hub["dir_json"] is None or now - hub["dir_at"] > max_age:
            hub["dir_json"], hub["dir_at"] = json.dumps(director_state()), now
        return hub["dir_json"]

    def _flush_director() -> None:
        hub["dir_timer"] = None
        cur = director_json(0.0)
        hub["last_dir_sent"] = time.monotonic()
        if cur != hub.get("dir_broadcast"):
            hub["dir_broadcast"] = cur
            broadcast('{"type": "director", "director": ' + cur + "}")

    def broadcast_director(immediate: bool = False) -> None:
        """Debounced: at most one director broadcast per DIRECTOR_MIN_INTERVAL_S, only when it changed."""
        loop = hub["loop"]
        if loop is None:
            try:
                loop = hub["loop"] = asyncio.get_running_loop()
            except RuntimeError:
                return
        if not _on_loop(loop):
            loop.call_soon_threadsafe(broadcast_director, immediate)
            return
        if immediate:
            if hub["dir_timer"] is not None:
                hub["dir_timer"].cancel()
            _flush_director()
            return
        if hub["dir_timer"] is not None:
            return
        wait = DIRECTOR_MIN_INTERVAL_S - (time.monotonic() - hub.get("last_dir_sent", 0.0))
        if wait <= 0:
            _flush_director()  # leading edge: immediate when idle
        else:
            hub["dir_timer"] = loop.call_later(wait, _flush_director)  # trailing edge

    def public_base() -> str | None:
        # Re-checked every few minutes so R2 takes over as soon as its CORS policy is live.
        if hub["public_base"] is None or time.time() - hub.get("public_at", 0) > 120:
            mirror = getattr(getattr(generator, "store", None), "mirror", None)
            hub["public_base"] = mirror.public_base() if mirror and hasattr(mirror, "public_base") else ""
            fb = mirror.fallback_base() if mirror and hasattr(mirror, "fallback_base") else None
            hub["fallback_base"] = fb or ""
            hub["public_at"] = time.time()
        return hub["public_base"] or None

    def cdn_bases() -> dict:
        b = public_base()
        out = {"strip_base": b, "lod_base": b[:-len("strips/")] + "lod/"}
        fb = hub.get("fallback_base")
        if fb:
            out.update(strip_base_fb=fb, lod_base_fb=fb[:-len("strips/")] + "lod/")
        return out

    def strip_meta() -> dict[int, dict]:
        """Strip metadata index, loaded once and extended as strips arrive (no per-request file scans)."""
        if hub["meta"] is None:
            store = getattr(generator, "store", None)
            hub["meta"] = store.load_meta() if store is not None else {}
        return hub["meta"]

    def on_hub_strip(strip: "Strip") -> None:
        """Runs on the event loop once per new strip: one tiny JSON for all v2 viewers."""
        m = hub["meta"]
        if m is not None:
            m[int(strip.index)] = {"index": strip.index, "width": strip.width, "height": strip.height,
                                   "overlap": strip.overlap, "prompt": strip.prompt, "scene": strip.scene}
        ref = json.dumps({"type": "strip", **strip_ref(strip)})
        status = json.dumps({"type": "status", "buffer": buffer.peek_depth(), "last_index": int(strip.index),
                             "gpu": gpu_stats()})
        for c in list(clients):
            if c.v2:
                c.offer(ref)
                c.offer(status)

    async def clock_loop() -> None:
        """Advance the shared timeline; ack the buffer from the shared position."""
        last = time.monotonic()
        since_bcast = 0.0
        while True:
            await asyncio.sleep(1.0 / clock_hz)
            now = time.monotonic()
            dt, last = min(0.5, now - last), now
            stats = gpu_stats() or {}
            produced_px = buffer.produced * config.strip_width
            timeline.step(dt, produced_px, stats.get("px_per_sec"))
            if timeline.pos is None and getattr(generator, "restored_pos", None):
                timeline.pos = min(float(generator.restored_pos), produced_px)
            pos = timeline.pos or 0.0
            if generator is not None:
                generator.timeline_pos = pos
            visible_through = int(pos // config.strip_width) - 1
            if visible_through >= 0:
                buffer.acknowledge(visible_through)
            since_bcast += dt
            n = len(clients)
            # Big audiences: fewer clock ticks (clients extrapolate between them).
            hz = broadcast_hz if n < 200 else (2.0 if n < 600 else 1.0)
            if since_bcast >= 1.0 / min(broadcast_hz, hz) and clients:
                since_bcast = 0.0
                broadcast(clock_msg())

    def ensure_crowd() -> None:
        """Start (or restart) the crowd meter/pull loop. Safe when crowd is None."""
        c = clock_task.get("crowd")
        if crowd and (c is None or c.done()):
            clock_task["crowd"] = asyncio.get_running_loop().create_task(crowd.run())

    def ensure_reactions() -> None:
        r = clock_task.get("react")
        if r is None or r.done():
            clock_task["react"] = asyncio.get_running_loop().create_task(reactions.run(broadcast))

    def ensure_clock() -> None:
        ensure_reactions()
        t = clock_task["t"]
        if t is None or t.done():
            clock_task["t"] = asyncio.get_running_loop().create_task(clock_loop())
        ensure_crowd()
        a = clock_task.get("auto")
        if autopilot and (a is None or a.done()):
            clock_task["auto"] = asyncio.get_running_loop().create_task(autopilot.run())
        tr = clock_task.get("trans")
        if (generator is not None and getattr(config, "vision_transitions", False) and not config.mock
                and interpreter.enabled and (tr is None or tr.done())):
            from .transitions import Transitioner

            app.state.transitioner = getattr(app.state, "transitioner", None) or Transitioner(generator.director, generator, interpreter)
            clock_task["trans"] = asyncio.get_running_loop().create_task(app.state.transitioner.run())

    app.state.config = config
    app.state.buffer = buffer
    app.state.generator = generator
    app.state.ensure_clock = ensure_clock
    app.state.ensure_crowd = ensure_crowd

    @app.on_event("startup")
    async def _startup_crowd() -> None:
        # Fuel burn + idea pull must run with 0 viewers (pod is still billing).
        # Clock/timeline stays viewer-driven via ensure_clock on WS connect.
        ensure_crowd()
        loop = hub["loop"] = asyncio.get_running_loop()
        pools.install_diagnostics(loop)   # kill -USR1: thread stacks, -USR2: asyncio tasks (server.log)
        buffer.subscribe(lambda st: loop.call_soon_threadsafe(on_hub_strip, st))
        if generator is not None and getattr(generator, "store", None) is not None:
            await asyncio.to_thread(strip_meta)

    @app.on_event("shutdown")
    async def _shutdown_persist() -> None:
        # Graceful restart: force-save director state (incl. queued ideas) so
        # nothing the director already pulled is lost across a SIGTERM restart.
        st = getattr(generator, "store", None) if generator else None
        if st is not None:
            try:
                st.save_state(generator.snapshot_state(), generator.canvas, force=True)
                logger.info("Shutdown: director state saved")
            except Exception:
                logger.exception("Shutdown state save failed")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "mock": config.mock,
            "buffer": buffer.peek_depth(),
            "strip_index": generator.strip_index if generator else None,
            "gpu": gpu_stats(),
            "timeline": timeline.state(),
            "viewers": len(clients),
            "interpreter": bool(interpreter.enabled),
            "pools": pools.backlog(),
            "clock": bool(clock_task.get("t") and not clock_task["t"].done()),
            "auto": ({"busy": autopilot.busy, "error": autopilot.last_error, "hour_tokens": autopilot._hour_tokens()}
                     if autopilot else None),
            "overdue": generator.director.overdue() if generator is not None and hasattr(generator.director, "overdue") else 0,
        }

    @app.get("/lod/{level}/{chunk}.jpg")
    async def lod_tile(level: int, chunk: int) -> Response:
        from .lod import STRIPS_PER_TILE

        store = getattr(generator, "store", None)
        lod = getattr(store, "lod", None)
        if lod is None or level not in STRIPS_PER_TILE or chunk < 0:
            return Response(status_code=404)
        n = STRIPS_PER_TILE[level]
        idx = generator.strip_index
        if (chunk + 1) * n > idx:  # chunk still filling: not cacheable yet
            return Response(status_code=404)
        data = await pools.heavy(lod.get, level, chunk, True)
        if not data:
            return Response(status_code=404)
        return Response(data, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*"})

    @app.get("/crop/{a}/{b}.jpg")
    async def crop(a: int, b: int, w: int = 600, h: int = 315) -> Response:
        """A finished section of the tapestry as an image (thumbnails, share cards)."""
        from .lod import crop_section

        store = getattr(generator, "store", None)
        w, h = max(64, min(1600, w)), max(64, min(1000, h))
        if store is None or a < 0 or b < a or b >= generator.strip_index:
            return Response(status_code=404)
        data = await pools.heavy(crop_section, store, config.strip_width, config.height, a, b, w, h)
        if not data:
            return Response(status_code=404)
        return Response(data, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*"})

    _runs_cache: dict[str, Any] = {"n": -1, "runs": []}

    def scene_runs(store) -> list[list]:
        """Run-length scene index: [[start_strip, title, by, style, origin], ...] for live captions while scrubbing."""
        meta = store.load_meta()
        if len(meta) == _runs_cache["n"]:
            return _runs_cache["runs"]
        runs: list[list] = []
        for i in sorted(meta):
            m = meta[i]
            sc = m.get("scene") or {}
            title = sc.get("title") or _title_from_prompt(m.get("prompt", ""))
            row = [i, title, sc.get("by") or "", sc.get("style") or "", sc.get("origin") or ""]
            if not runs or runs[-1][1:] != row[1:]:
                runs.append(row)
        _runs_cache.update(n=len(meta), runs=runs)
        return runs

    @app.get("/timeline")
    async def timeline_points(points: int = 300) -> dict[str, Any]:
        """Sampled (strip index, unix time) pairs so the client can label its scrubber with wall-clock time."""
        idx = max(0, generator.strip_index - 1)
        points = max(2, min(600, points))
        step = max(1, idx // points)
        want = sorted(set(list(range(0, idx + 1, step)) + [idx]))
        store = getattr(generator, "store", None)
        out: dict[int, float] = {}
        if store is not None:
            meta = await pools.heavy(store.load_meta)
            for i in want:
                t = (meta.get(i) or {}).get("created_at")
                if t:
                    out[i] = float(t)
            miss = [i for i in want if i not in out]
            if miss and getattr(store, "mirror", None):
                try:
                    out.update(await pools.heavy(store.mirror.strip_times, miss, timeout=30))
                except Exception:
                    pass
        scenes = await pools.heavy(scene_runs, store) if store is not None else []
        return {"max": idx, "points": sorted([i, t] for i, t in out.items()), "now": time.time(), "scenes": scenes}

    @app.get("/export.png")
    async def export_png(scale: float = 1.0, last: int = 0, start: int = 0, end: int = -1, max_strips: int = 4000):
        """Stitch the stored history into one PNG. scale in (0,1]; last=N keeps the newest N strips."""
        from fastapi.responses import Response

        store = getattr(generator, "store", None)
        if store is not None:
            total = generator.strip_index
            first = max(0, total - last) if last > 0 else max(0, start)
            hi = total - 1 if end < 0 else min(end, total - 1)
            if (hi - first + 1) > max_strips:
                first = hi - max_strips + 1
            strips = await pools.heavy(store.strips_between, first, hi)
        else:
            strips = buffer.snapshot()
            if last > 0:
                strips = strips[-last:]
        if not strips:
            return Response(status_code=404, content=b"no strips yet")
        scale = max(0.05, min(1.0, float(scale)))

        def build() -> bytes:
            import io as _io

            from PIL import Image

            sw = config.strip_width
            base = strips[0].index
            width = (strips[-1].index - base + 1) * sw
            canvas = Image.new("RGB", (width, config.height))
            for st in strips:
                img = Image.open(_io.BytesIO(st.jpeg)).convert("RGB")
                ov = max(0, img.width - sw)  # robust even when metadata is missing
                x = (st.index - base) * sw - (ov if st.index != base else 0)
                if st.index == base and ov:
                    img = img.crop((ov, 0, img.width, img.height))
                if scale < 1.0:
                    # Downscale per strip so huge exports never allocate full-res.
                    pass
                canvas.paste(img, (x, 0))
            if scale < 1.0:
                canvas = canvas.resize((max(1, int(width * scale)), max(1, int(config.height * scale))), Image.Resampling.LANCZOS)
            out = _io.BytesIO()
            canvas.save(out, format="PNG", optimize=False)
            return out.getvalue()

        data = await pools.heavy(build)
        name = f"infinite-tapestry-{strips[0].index}-{strips[-1].index}.png"
        return Response(content=data, media_type="image/png",
                        headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})

    @app.get("/config")
    async def get_config() -> dict[str, Any]:
        return config.client_dict()

    def unpack_buffer_target() -> None:
        buffer.set_target(int(base_target * max(1.0, timeline.multiplier)))

    @app.websocket("/ws")
    async def stream_endpoint(ws: WebSocket) -> None:
        ip = client_ip(ws)
        # Accept first — Starlette cannot usefully close a WS before accept — then
        # immediately drop over-cap peers so the 8/IP limit is enforced.
        await ws.accept()
        if conn_per_ip.get(ip, 0) >= MAX_CONN_PER_IP or len(clients) >= MAX_CONNECTIONS:
            await ws.close(code=1013)
            return
        conn_per_ip[ip] = conn_per_ip.get(ip, 0) + 1
        ensure_clock()
        user: dict | None = None
        logger.debug("WebSocket client connected from %s", ip)
        loop = asyncio.get_running_loop()
        # v2 viewers get small JSON strip refs and load images from the CDN;
        # legacy (cached old JS) viewers still get binary strips.
        v2 = ws.query_params.get("v") == "2" and public_base() is not None
        viewer = Viewer(v2)
        queue = viewer.q
        clients.add(viewer)
        intent_tasks: set[asyncio.Task] = set()

        unsubscribe = lambda: None  # noqa: E731
        if not v2:
            def on_strip(strip: "Strip") -> None:
                loop.call_soon_threadsafe(viewer.offer, strip)

            unsubscribe = buffer.subscribe(on_strip)
        last_index = -1

        async def send_text(text: str) -> None:
            await asyncio.wait_for(ws.send_text(text), SEND_TIMEOUT_S)

        async def notice(text: str, **extra: Any) -> None:
            await ws.send_json({"type": "notice", "text": text, **extra})

        def refs_between(start: int, end: int) -> list[dict]:
            meta = strip_meta()
            have = {s.index: s for s in buffer.strips_between(start, end)}
            out = []
            for i in range(start, end + 1):
                s = have.get(i) or meta.get(i)
                if s is not None:
                    out.append(strip_ref(s))
            return out

        try:
            from .crowd import GPU_CENTS_PER_HOUR

            await ws.send_json(
                {"type": "config", **config.client_dict(), "interpreter": bool(interpreter.enabled),
                 "limits": {"intent_chars": MAX_INTENT_CHARS, "intent_cooldown": intent_cooldown},
                 "gpu_cents_per_hour": GPU_CENTS_PER_HOUR, **(cdn_bases() if v2 else {})}
            )
            await ws.send_json(clock_msg())
            if v2:
                recent = buffer.snapshot()[-RECENT_ON_CONNECT:]
                await send_text(json.dumps({"type": "strips", "items": [strip_ref(s) for s in recent]}))
                await send_text('{"type": "status", "buffer": ' + json.dumps(buffer.peek_depth()) +
                                ', "gpu": ' + json.dumps(gpu_stats()) + ', "director": ' + director_json() + "}")
            for strip in ([] if v2 else buffer.snapshot()[-RECENT_ON_CONNECT:]):
                await ws.send_bytes(encode_strip_message(strip))
                if (_sm := strip_scene_message(strip)):
                    await ws.send_json(_sm)
                last_index = max(last_index, strip.index)
            if not v2:
                await ws.send_json(
                    {"type": "status", "buffer": buffer.peek_depth(), "director": director_state(), "gpu": gpu_stats()}
                )

            async def push() -> None:
                nonlocal last_index
                while True:
                    try:
                        item = await asyncio.wait_for(queue.get(), timeout=PING_INTERVAL_S)
                    except asyncio.TimeoutError:
                        await ws.send_json({"type": "ping", "buffer": buffer.peek_depth(), "gpu": gpu_stats()})
                        if v2:
                            continue
                        for strip in buffer.strips_after(last_index):
                            await ws.send_bytes(encode_strip_message(strip))
                            if (_sm := strip_scene_message(strip)):
                                await ws.send_json(_sm)
                            last_index = strip.index
                        continue
                    if isinstance(item, str):
                        await send_text(item)
                        continue
                    if isinstance(item, dict):
                        await ws.send_json(item)
                        continue
                    strip = item
                    if strip.index <= last_index:
                        continue
                    await ws.send_bytes(encode_strip_message(strip))
                    if (_sm := strip_scene_message(strip)):
                        await ws.send_json(_sm)
                    last_index = strip.index
                    await send_text('{"type": "status", "buffer": ' + json.dumps(buffer.peek_depth()) +
                                    ', "last_index": ' + str(last_index) + ', "gpu": ' + json.dumps(gpu_stats()) +
                                    ', "director": ' + director_json() + "}")

            async def handle_intent(data: dict) -> None:
                text = str(data.get("text", "")).strip()
                if not text:
                    return
                if len(text) > MAX_INTENT_CHARS:
                    await notice(f"Keep it under {MAX_INTENT_CHARS} characters.")
                    return
                from .guard import is_blocked

                from .guard import is_sexual

                from .guard import hard_block_reason

                if hard_block_reason(text):
                    await notice("Anything goes here except sexual content, minors and slurs. Try another destination.")
                    return
                d = generator.director
                if len(d.state()["items"]) >= MAX_QUEUE:
                    await notice("The queue is full. Try again in a bit.")
                    return
                wait = intent_limit.check(ip)
                if wait:
                    await notice(f"Easy there. You can add another destination in {wait:.0f}s.", cooldown=wait)
                    return
                req_id = data.get("req")
                await ws.send_json({"type": "plan_pending", "req": req_id, "text": text})
                when = data.get("when", "end")
                if data.get("raw"):
                    from .interpreter import fallback_plan

                    plan = fallback_plan(text, "raw mode")
                else:
                    st = d.state()
                    users = [i["prompt"] for i in st["items"] if i.get("origin") != "auto"]
                    prev = users[-1] if (when == "end" and users) else (st["target"] or st["current"])
                    plan = await pools.control(interpreter.plan, text, prev, None, timeout=60)
                scenes = [
                    make_scene(s["prompt"], s.get("negative", ""), s.get("title", ""),
                               s.get("transition"), s.get("hold"), source=text, origin="user", style=s.get("style"), beats=s.get("beats"),
                               lora=__import__("infinite_tapestry.styles", fromlist=["x"]).explicit_lora(text))
                    for s in plan["scenes"]
                    if not is_blocked(s["prompt"], text) and not is_sexual(s["prompt"])
                ]
                if not scenes:
                    await notice("That prompt is blocked.")
                    return
                if user and user.get("handle"):
                    for sc in scenes:
                        sc["by"] = "@" + str(user["handle"])
                if autopilot:
                    autopilot.user_acted()
                if when == "now":
                    d.play_now(scenes[0], at=generator.strip_index)
                    d.add_user(scenes[1:], position="next")
                else:
                    d.add_user(scenes, position="next" if when == "next" else "end")
                await ws.send_json(
                    {"type": "plan", "req": req_id, "text": text,
                     "plan": {k: plan.get(k) for k in ("note", "source", "model")}, "scenes": scenes}
                )
                broadcast({"type": "activity", "text": text, "titles": [s["title"] for s in scenes], "when": when})
                broadcast_director(True)

            msg_count = [0, time.monotonic()]

            async def recv() -> None:
                nonlocal user
                while True:
                    raw = await ws.receive_text()
                    if len(raw) > MAX_MESSAGE_BYTES:
                        await notice("Message too large.")
                        continue
                    msg_count[0] += 1
                    if msg_count[0] > 120 and time.monotonic() - msg_count[1] < 10:
                        await ws.close(code=1008)  # flooding
                        return
                    if time.monotonic() - msg_count[1] >= 10:
                        msg_count[:] = [0, time.monotonic()]
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        data = {"type": raw}
                    if not isinstance(data, dict):
                        continue
                    t = data.get("type")
                    if t == "auth":
                        tok = str(data.get("token", ""))[:4096]
                        user = await asyncio.to_thread(supa.user_from_token, tok) if (supa and tok) else None
                        await ws.send_json({"type": "auth", "admin": bool(user and user.get("is_admin")),
                                            "handle": (user or {}).get("handle")})
                        continue
                    if t == "move":
                        # The queue is view-only: reordering is disabled for everyone (admins included).
                        await notice("The queue can't be reordered.")
                        continue
                    if t in CONTROL_TYPES and supa is not None and not (user and user.get("is_admin")):
                        # Production: the stage is steered by the crowd pool (Supabase) and admins.
                        await notice("Add your idea to the pool. The crowd and Auto decide what plays.")
                        continue
                    if t == "react":
                        try:
                            si = int(data.get("i", -1))
                        except (TypeError, ValueError):
                            si = -1
                        si = si if 0 <= si <= max(0, buffer.produced) else None
                        reactions.add(str(id(queue)), ip, data.get("k"), si, str(data.get("s", ""))[:120])
                        continue
                    if t == "ping":
                        await ws.send_json({"type": "pong"})
                    elif t in ("pong", "ack"):
                        pass  # acks are server-side now (shared timeline)
                    elif t in ("upcoming_request", "idea_added"):
                        if t == "idea_added" and crowd:
                            try:
                                await crowd.refresh_pending()
                            except Exception:
                                logger.exception("refresh_pending failed")
                        await send_text('{"type": "director", "director": ' +
                                        director_json(0.0 if t == "idea_added" else 1.0) + "}")
                    elif t == "status_request":
                        await send_text('{"type": "status", "buffer": ' + json.dumps(buffer.peek_depth()) +
                                        ', "gpu": ' + json.dumps(gpu_stats()) + ', "director": ' + director_json() + "}")
                        await ws.send_json(clock_msg())
                    elif t == "history":
                        start = max(0, int(data.get("start", 0)))
                        end = min(int(data.get("end", start)), start + 64)
                        if v2 and not data.get("bytes"):
                            await send_text(json.dumps({"type": "strips", "items": refs_between(start, end)}))
                            continue
                        end = min(end, start + 8) if v2 else end  # bytes fallback for strips missing on the CDN
                        found = buffer.strips_between(start, end)
                        have = {st.index for st in found}
                        store = getattr(generator, "store", None)
                        if store is not None and len(have) < end - start + 1:
                            # Older than the in-memory window: read from disk.
                            missing = [i for i in range(start, end + 1) if i not in have]
                            disk = await pools.heavy(store.strips_between, missing[0], missing[-1])
                            found = sorted(found + [d for d in disk if d.index not in have], key=lambda x: x.index)
                        for strip in found:
                            await ws.send_bytes(encode_strip_message(strip))
                            if (_sm := strip_scene_message(strip)):
                                await ws.send_json(_sm)
                    elif t == "intent" and generator:
                        task = asyncio.create_task(handle_intent(data))
                        task.add_done_callback(_reap)   # a viewer leaving mid-send is normal, not an error
                        intent_tasks.add(task)
                        task.add_done_callback(intent_tasks.discard)
                    elif t == "autopilot" and autopilot:
                        autopilot.configure(data.get("enabled"), data.get("vibe"))
                        broadcast_director(True)
                    elif t in ("speed", "skip", "remove", "move", "edit", "play", "clear",
                               "configure", "set_prompt", "queue") and generator:
                        wait = control_limit.check(ip)
                        if wait:
                            await notice(f"One change at a time. Try again in {wait:.0f}s.")
                            continue
                        d = generator.director
                        at = generator.strip_index
                        sid = data.get("id")
                        if t == "speed":
                            timeline.set_speed(data.get("mode"), data.get("manual"))   # fast-forward multiplier retired: any viewer could pin the shared stream at 8x
                            unpack_buffer_target()
                            broadcast(clock_msg())
                            continue
                        if t == "skip":
                            d.skip(at)
                        elif t == "remove":
                            d.remove(int(sid))
                        elif t == "move":
                            d.move(int(sid), int(data.get("to", 0)))
                        elif t == "edit":
                            from .guard import is_blocked

                            prompt = data.get("prompt")
                            from .guard import is_disallowed

                            if prompt and is_disallowed(str(prompt)):
                                await notice("That prompt is blocked.")
                                continue
                            d.edit(int(sid), prompt=str(prompt)[:MAX_INTENT_CHARS * 2] if prompt else None,
                                   title=data.get("title"), transition=data.get("transition"), hold=data.get("hold"))
                        elif t == "play":
                            d.play(int(sid), at=at)
                        elif t == "clear":
                            d.clear()
                        elif t == "configure":
                            d.configure(hold=data.get("hold"), blend=data.get("blend"), loop=data.get("loop"))
                        elif t == "set_prompt" and str(data.get("prompt", "")).strip():
                            d.set_prompt(str(data["prompt"])[:500], data.get("blend"), at=at)
                        elif t == "queue":
                            d.set_queue([str(p)[:500] for p in data.get("prompts", [])][:MAX_QUEUE],
                                        hold=data.get("hold"), blend=data.get("blend"), loop=data.get("loop"))
                        broadcast_director(True)

            push_task = asyncio.create_task(push())
            push_task.add_done_callback(_reap)
            viewer.task = push_task
            tasks = {push_task, asyncio.create_task(recv())}
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                exc = None if task.cancelled() else task.exception()
                if exc and not isinstance(exc, (WebSocketDisconnect, asyncio.CancelledError)):
                    raise exc
        except (WebSocketDisconnect, asyncio.CancelledError, asyncio.TimeoutError):
            logger.debug("WebSocket client disconnected")
        except Exception:
            logger.exception("WebSocket handler error")
        finally:
            conn_per_ip[ip] = max(0, conn_per_ip.get(ip, 1) - 1)
            clients.discard(viewer)
            reactions.forget(str(id(queue)))
            unsubscribe()
            try:
                await ws.close()
            except Exception:
                pass

    if STATIC_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="root")

    app.state.ws_ping_interval = PING_INTERVAL_S
    return app
