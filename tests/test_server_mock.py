"""End-to-end mock server: health, config, websocket strip + ping."""

from __future__ import annotations

import json
import struct
import time

import pytest
from fastapi.testclient import TestClient

from infinite_tapestry.buffer import StripBuffer
from infinite_tapestry.config import Config
from infinite_tapestry.generator import StripGenerator
from infinite_tapestry.mock_inpaint import MockInpainter
from infinite_tapestry.server import MAGIC, HEADER_FMT, create_app


@pytest.fixture
def mock_app():
    cfg = Config(
        mock=True,
        height=32,
        window_width=64,
        strip_width=16,
        overlap=4,
        buffer_target=3,
        buffer_min=1,
        scroll_speed=40,
    )
    buf = StripBuffer(target=cfg.buffer_target, minimum=cfg.buffer_min)
    gen = StripGenerator(cfg, MockInpainter(cfg), buf)
    gen.start()
    for _ in range(80):
        if buf.produced >= 2:
            break
        time.sleep(0.05)
    app = create_app(cfg, buf, gen)
    try:
        yield app, cfg, buf, gen
    finally:
        gen.stop()


def test_health_and_config(mock_app):
    app, cfg, buf, gen = mock_app
    client = TestClient(app)
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["mock"] is True

    r = client.get("/config")
    assert r.status_code == 200
    assert r.json()["strip_width"] == cfg.strip_width

    r = client.get("/")
    assert r.status_code == 200
    assert b"Infinite Tapestry" in r.content


def test_websocket_receives_strip_and_ping(mock_app):
    app, cfg, buf, gen = mock_app
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        cfg_msg = ws.receive_json()
        assert cfg_msg["type"] == "config"
        assert cfg_msg["height"] == cfg.height
        assert "gpu_cents_per_hour" in cfg_msg
        assert isinstance(cfg_msg["gpu_cents_per_hour"], (int, float))

        got_binary = False
        got_pong = False
        deadline = time.time() + 8

        # Ask for a pong up front; strips may also be waiting in the socket.
        ws.send_text(json.dumps({"type": "ping"}))

        while time.time() < deadline and not (got_binary and got_pong):
            msg = ws.receive()
            if msg.get("bytes") is not None:
                raw = msg["bytes"]
                assert raw[:4] == MAGIC
                _magic, index, width, height, _overlap, _plen = struct.unpack_from(
                    HEADER_FMT, raw, 0
                )
                assert width > 0 and height == cfg.height
                got_binary = True
                ws.send_text(json.dumps({"type": "ack", "index": index}))
            elif msg.get("text") is not None:
                data = json.loads(msg["text"])
                if data.get("type") == "pong":
                    got_pong = True
                elif data.get("type") == "ping":
                    ws.send_text(json.dumps({"type": "pong"}))
                    got_pong = True
            if got_binary and not got_pong:
                ws.send_text(json.dumps({"type": "ping"}))

        assert got_binary, "expected at least one strip frame"
        assert got_pong, "expected ping/pong keep-alive"


def test_startup_without_crowd_does_not_hang(mock_app):
    """Mock mode has no Supabase → crowd is None; startup must stay idle (no network)."""
    app, cfg, buf, gen = mock_app
    assert app.state.crowd is None
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        assert callable(app.state.ensure_crowd)
        app.state.ensure_crowd()  # no-op when crowd is None


def test_crowd_starts_on_startup_without_viewers(monkeypatch):
    """Crowd meter/pull must start at app startup, not wait for the first WS viewer."""
    started = []

    class FakeCrowd:
        def __init__(self, *a, **k):
            self.fuel_cents = None

        def state(self):
            return {"cents": None, "hours": None, "out": False, "gpu_cents_per_hour": 89}

        async def run(self):
            started.append(1)
            import asyncio
            await asyncio.Event().wait()

    monkeypatch.setenv("SUPABASE_URL", "http://example.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-key")
    monkeypatch.setenv("TAPESTRY_CROWD", "1")
    monkeypatch.setattr("infinite_tapestry.crowd.Crowd", FakeCrowd)

    cfg = Config(
        mock=True, height=32, window_width=64, strip_width=16, overlap=4,
        buffer_target=3, buffer_min=1, scroll_speed=40,
    )
    buf = StripBuffer(target=cfg.buffer_target, minimum=cfg.buffer_min)
    gen = StripGenerator(cfg, MockInpainter(cfg), buf)
    gen.start()
    try:
        for _ in range(40):
            if buf.produced >= 1:
                break
            time.sleep(0.05)
        app = create_app(cfg, buf, gen)
        assert app.state.crowd is not None
        with TestClient(app) as client:
            assert client.get("/health").status_code == 200
            for _ in range(40):
                if started:
                    break
                time.sleep(0.05)
            assert started, "crowd.run should start at startup with 0 viewers"
    finally:
        gen.stop()

