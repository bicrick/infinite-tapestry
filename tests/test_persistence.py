import time

from fastapi.testclient import TestClient

from infinite_tapestry.buffer import StripBuffer
from infinite_tapestry.config import Config
from infinite_tapestry.generator import StripGenerator
from infinite_tapestry.mock_inpaint import MockInpainter
from infinite_tapestry.prompts import make_scene
from infinite_tapestry.server import create_app
from infinite_tapestry.store import HistoryStore


def cfg():
    return Config(mock=True, height=32, window_width=64, strip_width=16, overlap=4, buffer_target=3, buffer_min=1)


def run(gen, n):
    for _ in range(n):
        st = gen.generate_one()
        gen.buffer.put(st, block=False) or gen.buffer.acknowledge(st.index)
        gen.buffer.acknowledge(st.index)
        gen._persist(st)


def test_restart_restores_strips_queue_and_index(tmp_path):
    c = cfg()
    g1 = StripGenerator(c, MockInpainter(c), StripBuffer(3, 1, history_limit=5))
    g1.attach_store(HistoryStore(tmp_path))
    g1.director.add([make_scene("a whale cathedral", origin="user")])
    run(g1, 12)
    g1.store.save_state(g1.snapshot_state(), g1.canvas, force=True)

    g2 = StripGenerator(c, MockInpainter(c), StripBuffer(3, 1, history_limit=5))
    g2.attach_store(HistoryStore(tmp_path))
    assert g2.strip_index == 12
    assert g2.buffer.produced == 12 and len(g2.buffer.snapshot()) == 5
    assert "a whale cathedral" in g2.director.queue or g2.director.target == "a whale cathedral" or "a whale cathedral" in g2.director.current
    st = g2.generate_one()
    assert st.index == 12

    app = create_app(c, g2.buffer, g2, interpreter=type("I", (), {"enabled": False})())
    client = TestClient(app)
    r = client.get("/export.png")  # full history from disk, not just the 5 in memory
    from PIL import Image
    import io
    assert r.status_code == 200 and Image.open(io.BytesIO(r.content)).width == 12 * 16
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "history", "start": 0, "end": 3})
        got = set()
        t0 = time.time()
        while not {0, 1, 2, 3} <= got and time.time() - t0 < 5:
            m = ws.receive()
            if m.get("bytes"):
                import struct
                got.add(struct.unpack("!4sIHHHH", m["bytes"][:16])[1])
        assert {0, 1, 2, 3} <= got
