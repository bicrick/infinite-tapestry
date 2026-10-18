import json

from fastapi.testclient import TestClient

from infinite_tapestry.buffer import StripBuffer
from infinite_tapestry.config import Config
from infinite_tapestry.generator import StripGenerator
from infinite_tapestry.mock_inpaint import MockInpainter
from infinite_tapestry.server import Viewer, create_app


class _Mirror:
    def public_base(self):
        return "https://cdn.example/strips/live/strips/"


class _Store:
    mirror = _Mirror()

    def load_meta(self):
        return {}

    def save_strip(self, s):
        pass

    def save_state(self, *a, **k):
        pass


def test_v2_viewers_get_small_refs_not_binary():
    cfg = Config(mock=True, height=32, window_width=64, strip_width=16, overlap=4, buffer_target=3, buffer_min=1)
    buf = StripBuffer(target=3, minimum=1)
    gen = StripGenerator(cfg, MockInpainter(cfg), buf)
    gen.store = _Store()
    gen.start()
    try:
        with TestClient(create_app(cfg, buf, gen)) as c, c.websocket_connect("/ws?v=2") as ws:
            got_cfg = got_strip = None
            for _ in range(300):
                m = ws.receive()
                assert m.get("bytes") is None, "v2 must not receive binary strips"
                d = json.loads(m["text"])
                if d["type"] == "config":
                    got_cfg = d
                if d["type"] == "strip" and d["i"] >= 1:
                    got_strip = d
                    break
            assert got_cfg["strip_base"].startswith("https://cdn.example/")
            assert got_strip and len(json.dumps(got_strip)) < 1024 and "i" in got_strip
            ws.send_json({"type": "history", "start": 0, "end": 1})
            for _ in range(100):
                d = json.loads(ws.receive()["text"])
                if d["type"] == "strips":
                    assert [r["i"] for r in d["items"]] == [0, 1]
                    break
            else:
                raise AssertionError("no history refs")
    finally:
        gen.stop()


def test_slow_viewer_is_dropped_with_bounded_memory():
    import asyncio

    async def run():
        v = Viewer(True)
        v.task = asyncio.create_task(asyncio.sleep(10))
        for i in range(v.q.maxsize + 5):
            v.offer("x")
        await asyncio.sleep(0)
        assert v.kicked and v.task.cancelled() and v.q.qsize() == v.q.maxsize

    asyncio.run(run())


def _app():
    cfg = Config(mock=True, height=32, window_width=64, strip_width=16, overlap=4, buffer_target=3, buffer_min=1)
    buf = StripBuffer(target=3, minimum=1)
    gen = StripGenerator(cfg, MockInpainter(cfg), buf)
    gen.store = _Store()
    return cfg, buf, gen


def test_v2_bytes_viewers_get_live_pixels_right_after_the_ref():
    from infinite_tapestry.server import MAGIC

    cfg, buf, gen = _app()
    gen.start()
    try:
        with TestClient(create_app(cfg, buf, gen)) as c, c.websocket_connect("/ws?v=2&bytes=1") as ws:
            last_ref = None
            for _ in range(400):
                m = ws.receive()
                if m.get("text"):
                    d = json.loads(m["text"])
                    if d["type"] == "strip":
                        last_ref = d["i"]
                    continue
                b = m["bytes"]
                assert b[:4] == MAGIC.encode() if isinstance(MAGIC, str) else MAGIC
                idx = int.from_bytes(b[4:8], "big")
                assert idx == last_ref, "bytes follow their own ref"
                break
            else:
                raise AssertionError("no live strip bytes")
    finally:
        gen.stop()


def test_malformed_history_request_keeps_the_viewer_connected():
    cfg, buf, gen = _app()
    gen.start()
    try:
        with TestClient(create_app(cfg, buf, gen)) as c, c.websocket_connect("/ws?v=2") as ws:
            ws.send_json({"type": "history", "start": "abc", "end": None})
            ws.send_json({"type": "history", "start": 0, "end": 0})
            seen = 0
            for _ in range(3000):
                d = json.loads(ws.receive()["text"])
                if d["type"] == "strips":
                    seen += 1   # 1st: the connect snapshot; 2nd: the answer to the valid request
                    if seen == 2:
                        break
            else:
                raise AssertionError("socket stopped answering after a malformed request")
    finally:
        gen.stop()


def test_render_settings_tune_sdxl_sampler_live():
    from types import SimpleNamespace

    from infinite_tapestry.server import apply_render_settings

    cfg = Config(mock=True)
    cfg.backend, cfg.steps, cfg.guidance_scale = "sdxl", 18, 6.0
    gen = SimpleNamespace(config=cfg, director=SimpleNamespace())
    out = apply_render_settings({"steps": 26, "cfg": 6.5}, gen)
    assert (cfg.steps, cfg.guidance_scale) == (26, 6.5) and out["steps"] == 26
    apply_render_settings({"steps": 99}, gen)
    assert cfg.steps == 40                       # clamped
    apply_render_settings({}, gen)
    assert cfg.steps == 40                       # absent keys keep the current value
    cfg.backend = "klein"
    apply_render_settings({"steps": 20}, gen)
    assert cfg.steps == 40                       # distilled backends are not touched
