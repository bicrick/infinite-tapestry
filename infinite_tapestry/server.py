"""FastAPI app: static client + WebSocket strip stream with keep-alives."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import struct
import time
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
    fwd = ws.headers.get("x-forwarded-for") or ws.headers.get("cf-connecting-ip") or ""
    if fwd:
        return fwd.split(",")[0].strip()
    return ws.client.host if ws.client else "?"


MAX_INTENT_CHARS = 300
MAX_MESSAGE_BYTES = 4096
MAX_CONN_PER_IP = int(os.environ.get("TAPESTRY_MAX_CONN_PER_IP", "8"))
MAX_CONNECTIONS = int(os.environ.get("TAPESTRY_MAX_CONNECTIONS", "500"))
CONTROL_TYPES = {"intent", "autopilot", "speed", "skip", "remove", "move", "edit", "play", "clear",
                 "configure", "set_prompt", "queue"}
MAX_QUEUE = 30


def _title_from_prompt(p: str) -> str:
    """Older strips (before scene metadata) get a title from the first clause of their prompt."""
    head = (p or "").split(",")[0].strip()
    words = head.split()[:5]
    return " ".join(w.capitalize() if len(w) > 3 else w for w in words)


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
    clients: set[asyncio.Queue] = set()
    conn_per_ip: dict[str, int] = {}
    intent_limit = RateLimiter(intent_cooldown)
    control_limit = RateLimiter(control_cooldown)
    clock_task: dict[str, asyncio.Task | None] = {"t": None}

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
    app.state.crowd = crowd

    def director_state() -> dict[str, Any] | None:
        if not generator:
            return None
        st = generator.director.state()
        st["autopilot"] = autopilot.state() if autopilot else None
        st["fuel"] = crowd.state() if crowd else None
        return st

    def gpu_stats() -> dict[str, Any] | None:
        return generator.stats() if generator else None

    def clock_msg() -> dict[str, Any]:
        return {"type": "clock", **timeline.state(), "now": time.time(), "viewers": len(clients)}

    def broadcast(msg: Any) -> None:
        for q in list(clients):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                pass  # slow client; it will resync from history/clock

    def broadcast_director() -> None:
        broadcast({"type": "director", "director": director_state()})

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
            if since_bcast >= 1.0 / broadcast_hz and clients:
                since_bcast = 0.0
                broadcast(clock_msg())

    def ensure_crowd() -> None:
        """Start (or restart) the crowd meter/pull loop. Safe when crowd is None."""
        c = clock_task.get("crowd")
        if crowd and (c is None or c.done()):
            clock_task["crowd"] = asyncio.get_running_loop().create_task(crowd.run())

    def ensure_clock() -> None:
        t = clock_task["t"]
        if t is None or t.done():
            clock_task["t"] = asyncio.get_running_loop().create_task(clock_loop())
        ensure_crowd()
        a = clock_task.get("auto")
        if autopilot and (a is None or a.done()):
            clock_task["auto"] = asyncio.get_running_loop().create_task(autopilot.run())

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
        data = await asyncio.to_thread(lod.get, level, chunk, True)
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
        data = await asyncio.to_thread(crop_section, store, config.strip_width, config.height, a, b, w, h)
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
            meta = await asyncio.to_thread(store.load_meta)
            for i in want:
                t = (meta.get(i) or {}).get("created_at")
                if t:
                    out[i] = float(t)
            miss = [i for i in want if i not in out]
            if miss and getattr(store, "mirror", None):
                try:
                    out.update(await asyncio.to_thread(store.mirror.strip_times, miss))
                except Exception:
                    pass
        scenes = await asyncio.to_thread(scene_runs, store) if store is not None else []
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
            strips = await asyncio.to_thread(store.strips_between, first, hi)
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

        data = await asyncio.to_thread(build)
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
        if conn_per_ip.get(ip, 0) >= MAX_CONN_PER_IP or len(clients) >= MAX_CONNECTIONS:
            await ws.close(code=1013)
            return
        await ws.accept()
        conn_per_ip[ip] = conn_per_ip.get(ip, 0) + 1
        ensure_clock()
        user: dict | None = None
        logger.info("WebSocket client connected from %s", ip)
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=512)
        clients.add(queue)
        intent_tasks: set[asyncio.Task] = set()

        def on_strip(strip: "Strip") -> None:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, strip)
            except Exception:
                pass

        unsubscribe = buffer.subscribe(on_strip)
        last_index = -1

        async def notice(text: str, **extra: Any) -> None:
            await ws.send_json({"type": "notice", "text": text, **extra})

        try:
            from .crowd import GPU_CENTS_PER_HOUR

            await ws.send_json(
                {"type": "config", **config.client_dict(), "interpreter": bool(interpreter.enabled),
                 "limits": {"intent_chars": MAX_INTENT_CHARS, "intent_cooldown": intent_cooldown},
                 "gpu_cents_per_hour": GPU_CENTS_PER_HOUR}
            )
            await ws.send_json(clock_msg())
            for strip in buffer.snapshot()[-RECENT_ON_CONNECT:]:
                await ws.send_bytes(encode_strip_message(strip))
                last_index = max(last_index, strip.index)
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
                        for strip in buffer.strips_after(last_index):
                            await ws.send_bytes(encode_strip_message(strip))
                            last_index = strip.index
                        continue
                    if isinstance(item, dict):
                        await ws.send_json(item)
                        continue
                    strip = item
                    if strip.index <= last_index:
                        continue
                    await ws.send_bytes(encode_strip_message(strip))
                    last_index = strip.index
                    await ws.send_json(
                        {"type": "status", "buffer": buffer.peek_depth(), "last_index": last_index,
                         "director": director_state(), "gpu": gpu_stats()}
                    )

            async def handle_intent(data: dict) -> None:
                text = str(data.get("text", "")).strip()
                if not text:
                    return
                if len(text) > MAX_INTENT_CHARS:
                    await notice(f"Keep it under {MAX_INTENT_CHARS} characters.")
                    return
                from .guard import is_blocked

                from .guard import is_sexual

                if is_blocked(text) or is_sexual(text):
                    await notice("Anything goes here except sexual content. Try another destination.")
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
                    plan = await asyncio.to_thread(interpreter.plan, text, prev, None)
                scenes = [
                    make_scene(s["prompt"], s.get("negative", ""), s.get("title", ""),
                               s.get("transition"), s.get("hold"), source=text, origin="user", style=s.get("style"))
                    for s in plan["scenes"]
                    if not is_blocked(s["prompt"], text) and not is_sexual(s["prompt"])
                ]
                if not scenes:
                    await notice("That prompt is blocked.")
                    return
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
                broadcast_director()

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
                    if t in CONTROL_TYPES and supa is not None and not (user and user.get("is_admin")):
                        # Production: the stage is steered by the crowd pool (Supabase) and admins.
                        await notice("Add your idea to the pool. The crowd and Claude decide what plays.")
                        continue
                    if t == "ping":
                        await ws.send_json({"type": "pong"})
                    elif t in ("pong", "ack"):
                        pass  # acks are server-side now (shared timeline)
                    elif t == "status_request":
                        await ws.send_json({"type": "status", "buffer": buffer.peek_depth(),
                                            "director": director_state(), "gpu": gpu_stats()})
                        await ws.send_json(clock_msg())
                    elif t == "history":
                        start = max(0, int(data.get("start", 0)))
                        end = min(int(data.get("end", start)), start + 64)
                        found = buffer.strips_between(start, end)
                        have = {st.index for st in found}
                        store = getattr(generator, "store", None)
                        if store is not None and len(have) < end - start + 1:
                            # Older than the in-memory window: read from disk.
                            missing = [i for i in range(start, end + 1) if i not in have]
                            disk = await asyncio.to_thread(store.strips_between, missing[0], missing[-1])
                            found = sorted(found + [d for d in disk if d.index not in have], key=lambda x: x.index)
                        for strip in found:
                            await ws.send_bytes(encode_strip_message(strip))
                    elif t == "intent" and generator:
                        task = asyncio.create_task(handle_intent(data))
                        intent_tasks.add(task)
                        task.add_done_callback(intent_tasks.discard)
                    elif t == "autopilot" and autopilot:
                        autopilot.configure(data.get("enabled"), data.get("vibe"))
                        broadcast_director()
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
                            timeline.set_speed(data.get("mode"), data.get("manual"), data.get("multiplier"))
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
                        broadcast_director()

            tasks = {asyncio.create_task(push()), asyncio.create_task(recv())}
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if exc and not isinstance(exc, (WebSocketDisconnect, asyncio.CancelledError)):
                    raise exc
        except WebSocketDisconnect:
            logger.info("WebSocket client disconnected")
        except Exception:
            logger.exception("WebSocket handler error")
        finally:
            conn_per_ip[ip] = max(0, conn_per_ip.get(ip, 1) - 1)
            clients.discard(queue)
            unsubscribe()
            try:
                await ws.close()
            except Exception:
                pass

    if STATIC_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="root")

    app.state.ws_ping_interval = PING_INTERVAL_S
    return app
