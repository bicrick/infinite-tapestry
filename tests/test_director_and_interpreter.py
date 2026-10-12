import time

from fastapi.testclient import TestClient

from infinite_tapestry.buffer import StripBuffer
from infinite_tapestry.config import Config
from infinite_tapestry.generator import StripGenerator
from infinite_tapestry.interpreter import PromptInterpreter, fallback_plan, parse_plan
from infinite_tapestry.mock_inpaint import MockInpainter
from infinite_tapestry.prompts import LiveDirector, make_scene
from infinite_tapestry.server import create_app


def test_queue_ops_reorder_remove_edit_play():
    d = LiveDirector("a", queue=["b", "c", "d"], hold=100, blend=2, loop=False)
    ids = [s["id"] for s in d.state()["items"]]
    assert d.move(ids[2], 0) and d.queue == ["d", "b", "c"]
    assert d.remove(ids[0]) and d.queue == ["d", "c"]
    assert d.edit(ids[1], prompt="c2", transition=5)
    assert d.state()["items"][1]["transition"] == 5 and d.queue == ["d", "c2"]
    assert d.play(ids[2], at=10) and d.target == "d" and d.queue == ["c2"]
    assert not d.remove(9999)


def test_scene_transition_and_hold_override_defaults():
    d = LiveDirector("a", hold=0, blend=8, loop=False)
    d.add([make_scene("b", negative="fog", transition=2, hold=50)])
    assert d.frame_for(0)[1] == "b"
    assert d.frame_for(1) == ("b", None, 0.0)
    assert "fog" in d.negative_for(0.0)
    d.add([make_scene("c")])
    assert d.frame_for(20) == ("b", None, 0.0)  # hold=50 respected


def test_skip_finishes_transition_and_advances():
    d = LiveDirector("a", queue=["b", "c"], hold=100, blend=10, loop=False)
    d.set_prompt("x", at=0)
    d.skip(1)
    a, b, _ = d.frame_for(2)
    assert a == "x" and b == "b"


def test_parse_plan_and_fallback():
    p = parse_plan('ok {"scenes":[{"title":"T","prompt":"neon city","transition":99,"hold":"x"}],"note":"n"}')
    assert p["scenes"][0]["transition"] == 32 and p["scenes"][0]["hold"] == 20
    f = fallback_plan("ocean")
    assert f["source"] == "raw" and "ocean" in f["scenes"][0]["prompt"]
    assert PromptInterpreter(api_key="").plan("ocean")["source"] == "raw"


def test_interpreter_falls_back_on_network_error(monkeypatch):
    it = PromptInterpreter(api_key="k")
    monkeypatch.setattr(it, "_call", lambda *a: (_ for _ in ()).throw(OSError("down")))
    assert it.plan("desert")["source"] == "raw"


class FakeInterp:
    enabled = True

    def plan(self, intent, current="", upcoming=None):
        return {"scenes": [{"title": "One", "prompt": "p1"}, {"title": "Two", "prompt": "p2"}],
                "note": "n", "source": "haiku", "model": "fake"}


def test_ws_intent_feeds_playlist():
    cfg = Config(mock=True, height=32, window_width=64, strip_width=16, overlap=4,
                 buffer_target=3, buffer_min=1)
    buf = StripBuffer(target=3, minimum=1)
    gen = StripGenerator(cfg, MockInpainter(cfg), buf)
    gen.start()
    try:
        app = create_app(cfg, buf, gen, interpreter=FakeInterp())
        with TestClient(app).websocket_connect("/ws") as ws:
            ws.send_json({"type": "intent", "text": "go somewhere", "when": "end", "req": 1})
            deadline = time.time() + 5
            while time.time() < deadline:
                m = ws.receive()
                if m.get("text") and '"plan"' in m["text"] and '"type": "plan"' in m["text"].replace('"type":"plan"', '"type": "plan"'):
                    break
            assert d_has(gen, ["p1", "p2"])
            time.sleep(0.5)
            assert (gen.stats()["strips_per_sec"] or 0) > 0
    finally:
        gen.stop()


def d_has(gen, prompts):
    q = gen.director.queue
    return all(p in q for p in prompts)
