"""FastAPI app: static client + WebSocket strip stream with keep-alives."""

from __future__ import annotations

import asyncio
import json
import logging
import struct
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
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


def create_app(
    config: "Config",
    buffer: "StripBuffer",
    generator: "StripGenerator | None" = None,
) -> FastAPI:
    app = FastAPI(title="Infinite Tapestry", version="0.1.0")
    app.state.config = config
    app.state.buffer = buffer
    app.state.generator = generator

    if STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "mock": config.mock,
            "buffer": buffer.peek_depth(),
            "strip_index": generator.strip_index if generator else None,
        }

    @app.get("/config")
    async def get_config() -> dict[str, Any]:
        return config.client_dict()

    @app.websocket("/ws")
    async def stream_endpoint(ws: WebSocket) -> None:
        """Push strips to the client; JSON ping/pong keeps proxies awake."""
        await ws.accept()
        logger.info("WebSocket client connected from %s", ws.client)

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=32)

        def on_strip(strip: "Strip") -> None:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, strip)
            except Exception:
                pass

        unsubscribe = buffer.subscribe(on_strip)
        last_index = -1

        try:
            await ws.send_json({"type": "config", **config.client_dict()})

            # Catch-up from history so a refresh isn't blank.
            for strip in buffer.snapshot():
                await ws.send_bytes(encode_strip_message(strip))
                last_index = max(last_index, strip.index)

            async def push_strips() -> None:
                nonlocal last_index
                while True:
                    try:
                        item = await asyncio.wait_for(queue.get(), timeout=PING_INTERVAL_S)
                    except asyncio.TimeoutError:
                        depth = buffer.peek_depth()
                        await ws.send_json(
                            {
                                "type": "ping",
                                "buffer": depth,
                                "low": bool(depth["low"]),
                            }
                        )
                        # Also poll history in case a notify was missed.
                        for strip in buffer.strips_after(last_index):
                            await ws.send_bytes(encode_strip_message(strip))
                            last_index = strip.index
                        continue

                    strip = item
                    if strip.index <= last_index:
                        continue
                    await ws.send_bytes(encode_strip_message(strip))
                    last_index = strip.index
                    await ws.send_json(
                        {
                            "type": "status",
                            "buffer": buffer.peek_depth(),
                            "last_index": last_index,
                        }
                    )

            async def recv_client() -> None:
                while True:
                    raw = await ws.receive_text()
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        data = {"type": raw}

                    msg_type = data.get("type") if isinstance(data, dict) else None
                    if msg_type == "ping":
                        await ws.send_json({"type": "pong"})
                    elif msg_type == "pong":
                        pass
                    elif msg_type == "ack":
                        idx = int(data.get("index", -1))
                        if idx >= 0:
                            buffer.acknowledge(idx)
                    elif msg_type == "status_request":
                        await ws.send_json(
                            {"type": "status", "buffer": buffer.peek_depth()}
                        )

            push_task = asyncio.create_task(push_strips())
            recv_task = asyncio.create_task(recv_client())
            done, pending = await asyncio.wait(
                {push_task, recv_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
            for t in done:
                exc = t.exception()
                if exc and not isinstance(
                    exc, (WebSocketDisconnect, asyncio.CancelledError)
                ):
                    raise exc
        except WebSocketDisconnect:
            logger.info("WebSocket client disconnected")
        except Exception:
            logger.exception("WebSocket handler error")
        finally:
            unsubscribe()
            try:
                await ws.close()
            except Exception:
                pass

    app.state.ws_ping_interval = PING_INTERVAL_S
    return app
