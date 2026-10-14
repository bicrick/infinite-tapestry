import json
import time

from fastapi.testclient import TestClient

from infinite_tapestry.buffer import StripBuffer
from infinite_tapestry.config import Config
from infinite_tapestry.generator import StripGenerator
from infinite_tapestry.mock_inpaint import MockInpainter
from infinite_tapestry.server import RateLimiter, create_app
from infinite_tapestry.timeline import Timeline


def test_auto_speed_tracks_capacity_smoothly():
    tl = Timeline(128)
    gen_px, cap = 128 * 6.0, 50.0
    speeds = []
    for _ in range(int(120 / 0.05)):
        if tl.pos is None or gen_px - tl.pos < 128 * 5: gen_px += cap * 0.05  # GPU paints at capacity until the buffer is full
        speeds.append(tl.step(0.05, gen_px, cap))
    assert abs(speeds[-1] - cap * tl.headroom) < 2  # holds ~15% below the GPU rate (slack to refill after stalls)
    jumps = max(abs(a - b) for a, b in zip(speeds, speeds[1:]))
    assert jumps < 1.0  # no jitter per 50ms tick
    assert 0 < gen_px - tl.pos < 128 * 6  # never runs off the edge


def test_brakes_when_gpu_stops():
    tl = Timeline(128)
    gen_px = 128 * 6.0
    for _ in range(400):
        tl.step(0.05, gen_px, 50.0)
    assert tl.pos <= gen_px and tl.speed < 5


def test_rate_limiter():
    rl = RateLimiter(10)
    assert rl.check("a") == 0 and rl.check("a") > 0 and rl.check("b") == 0


class FakeInterp:
    enabled = True

    def plan(self, intent, current="", upcoming=None):
        return {"scenes": [{"title": "X", "prompt": intent}], "note": "", "source": "haiku", "model": "f"}


def _recv_until(ws, pred, n=200):
    for _ in range(n):
        m = ws.receive()
        if m.get("text"):
            d = json.loads(m["text"])
            if pred(d):
                return d
    raise AssertionError("not received")


def test_shared_queue_and_clock_broadcast_and_cooldown():
    cfg = Config(mock=True, height=32, window_width=64, strip_width=16, overlap=4, buffer_target=3, buffer_min=1)
    buf = StripBuffer(target=3, minimum=1)
    gen = StripGenerator(cfg, MockInpainter(cfg), buf)
    gen.start()
    try:
        app = create_app(cfg, buf, gen, interpreter=FakeInterp(), intent_cooldown=60)
        c = TestClient(app)
        with c.websocket_connect("/ws") as a, c.websocket_connect("/ws") as b:
            a.send_json({"type": "intent", "text": "volcano"})
            got = _recv_until(b, lambda d: d.get("type") == "director" and "volcano" in d["director"]["queue"])
            assert got
            clk = _recv_until(b, lambda d: d.get("type") == "clock" and d["viewers"] == 2)
            assert clk["pos"] >= 0
            a.send_json({"type": "intent", "text": "again"})
            n = _recv_until(a, lambda d: d.get("type") == "notice")
            assert "s" in n["text"]
            time.sleep(0.5)
            assert buf.acknowledged >= 0
    finally:
        gen.stop()


def test_export_png():
    from PIL import Image
    import io
    cfg = Config(mock=True, height=32, window_width=64, strip_width=16, overlap=4, buffer_target=3, buffer_min=1)
    buf = StripBuffer(target=3, minimum=1)
    gen = StripGenerator(cfg, MockInpainter(cfg), buf)
    for _ in range(4):
        buf.put(gen.generate_one(), block=False)
    r = TestClient(create_app(cfg, buf, gen, interpreter=FakeInterp())).get("/export.png?scale=0.5")
    assert r.status_code == 200
    assert Image.open(io.BytesIO(r.content)).size == (32, 16)
