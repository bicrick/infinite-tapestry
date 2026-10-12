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
