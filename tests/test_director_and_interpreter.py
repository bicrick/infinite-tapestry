import time

import pytest
from fastapi.testclient import TestClient

from infinite_tapestry.buffer import StripBuffer
from infinite_tapestry.config import Config
from infinite_tapestry.generator import StripGenerator
from infinite_tapestry.interpreter import (
    AUTO_SYSTEM,
    SYSTEM,
    _STYLE_NOTE,
    PromptInterpreter,
    fallback_plan,
    parse_plan,
)
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


def test_scene_transition_and_hold_override_defaults(fixed_widths):
    d = LiveDirector("a", hold=0, blend=8, loop=False)
    sc = make_scene("b", negative="fog", hold=50)
    sc["transition"] = 2
    d.add([sc])
    assert d.frame_for(0)[1] == "b"
    assert d.frame_for(1) == ("b", None, 0.0)
    assert "fog" in d.negative_for(0.0)
    d.add([make_scene("c")])
    assert d.frame_for(3) == ("b", None, 0.0)  # user hold capped at 4
    assert d.frame_for(6)[1] == "c"


def test_skip_finishes_transition_and_advances():
    d = LiveDirector("a", queue=["b", "c"], hold=100, blend=10, loop=False)
    d.set_prompt("x", at=0)
    d.skip(1)
    a, b, _ = d.frame_for(2)
    assert a == "x" and b == "b"


def test_parse_plan_and_fallback():
    p = parse_plan('ok {"scenes":[{"title":"T","prompt":"neon city","transition":99,"hold":"x"}],"note":"n"}')
    assert p["scenes"][0]["transition"] == 3 and p["scenes"][0]["hold"] == 3
    f = fallback_plan("ocean")
    assert f["source"] == "raw" and "ocean" in f["scenes"][0]["prompt"]
    assert PromptInterpreter(api_key="").plan("ocean")["source"] == "raw"


def test_parse_plan_salvages_truncated_scenes_json():
    """Haiku 5.5 thinking can truncate mid-object; keep complete scenes already emitted."""
    truncated = (
        '{"scenes":[{"title":"Neon Drift","prompt":"neon city, wet streets, cyan glow",'
        '"negative":"","transition":20,"hold":16,"style":"pixel art"},'
        '{"title":"Half","prompt":"forest path under moonlight, mist rolling in from the'
    )
    p = parse_plan(truncated)
    assert len(p["scenes"]) == 1
    assert p["scenes"][0]["title"] == "Neon Drift"
    assert p["scenes"][0]["prompt"].startswith("neon city")
    assert p["scenes"][0]["style"] == "pixel art"


def test_parse_plan_valid_still_parses():
    raw = (
        '{"scenes":['
        '{"title":"One","prompt":"endless dunes at dusk","transition":18,"hold":20,"style":"none"},'
        '{"title":"Two","prompt":"crystal caves, blue light","transition":22,"hold":14,"style":"watercolor"}'
        '],"note":"drifting inland"}'
    )
    p = parse_plan(raw)
    assert len(p["scenes"]) == 2
    assert p["note"] == "drifting inland"
    assert p["scenes"][1]["style"] == "watercolor"


def test_parse_plan_refusal_and_empty_still_raise():
    with pytest.raises(ValueError, match="refusal"):
        parse_plan("I can't help create that content.")
    with pytest.raises(ValueError, match="empty plan"):
        parse_plan('{"scenes":[],"note":"nothing"}')
    with pytest.raises(ValueError, match="no JSON in reply"):
        # Truncated before any closing brace → nothing extractable.
        parse_plan('{"scenes":[{"title":"T","prompt":"trunc')


def test_style_note_defaults_photoreal():
    note = _STYLE_NOTE.lower()
    assert "photoreal" in note and "60%" in note and "40%" in note
    assert "more than 2 stylized" in note and "hyperreal" in note
    # Both system prompts carry the note and mention SDXL without dropping SD 1.5.
    # User ideas: faithful cleanup, no photoreal quota; Auto keeps its own look notes.
    assert _STYLE_NOTE not in SYSTEM and _STYLE_NOTE not in AUTO_SYSTEM
    low_a = AUTO_SYSTEM.lower()
    assert "photoreal" in low_a and "two of every three" in low_a and "5-20 words" in low_a and "look plan" in low_a
    assert "SDXL" in SYSTEM and "SD 1.5" in SYSTEM
    for sys in (AUTO_SYSTEM,):  # user ideas are verbatim text; composition notes only steer Auto
        assert "SDXL" in sys and "SD 1.5" in sys
        low = sys.lower()
        assert "full height" in low
        assert "horizons" in low or "strata" in low


def test_parse_plan_normalizes_style():
    p = parse_plan('{"scenes":[{"title":"T","prompt":"forest","style":"Pixel Art"}],"note":"n"}')
    assert p["scenes"][0]["style"] == "pixel art"


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


def test_user_idea_preempts_auto_hold_and_timings_halved(fixed_widths):
    from infinite_tapestry.prompts import LiveDirector, make_scene
    d = LiveDirector("seed", hold=12, blend=8)
    d.frame_for(0)
    d.add([make_scene("auto scene", hold=30, origin="auto")])
    d.frame_for(1)  # seed still holding
    assert d.state()["target"] is None
    d.add_user([make_scene("user idea", transition=8, origin="user")])
    a, b, t = d.frame_for(2)  # weaving starts immediately, auto scene dropped
    assert b == "user idea" and t > 0
    assert make_scene("x", transition=64, hold=200)["transition"] == 3
    assert make_scene("x", transition=1, hold=200)["hold"] == 4  # user cap
    assert make_scene("x", hold=200, origin="auto")["hold"] == 4


def test_scene_beats_unfold_across_hold(fixed_widths):
    d = LiveDirector("a", hold=0, blend=4, loop=False)
    d._current = make_scene("p0", hold=4, origin="user", beats=["b1", "b2", "b3"])  # user +2 → 6-strip hold
    d._active_since = 0
    assert [d.frame_for(i)[0] for i in range(4)] == ["b1", "b1", "b2", "b3"]


def test_variable_scene_length_by_weight(fixed_widths):
    d = LiveDirector("a", hold=6, blend=4, loop=False)
    assert d._hold_len(make_scene("x", hold=6, origin="auto")) == 3          # capped at 4, jitter -1
    assert d._hold_len(make_scene("x", hold=6, origin="user")) == 4          # short scenes
    s = make_scene("x", hold=6, origin="user"); s["prio"] = True
    assert d._hold_len(s) == 4                                              # no donor perk on stage time


def test_no_priority_queue():
    from infinite_tapestry.crowd import Crowd
    c = Crowd.__new__(Crowd); c._prio_run = 0
    pool = [{"id": i, "_prio": i in (3, 5, 6, 8), "boost_cents": 0} for i in range(1, 10)]
    order = []
    while pool:
        r = c._pick(pool, 1, True, 2)[0]; order.append(r["id"]); pool.remove(r)
    assert order[:6] == [1, 2, 3, 4, 5, 6]                                  # plain order, no priority
    assert c._pick([{"id": 1, "_prio": False}, {"id": 2, "_prio": True}], 1, False, 2)[0]["id"] == 1   # quiet: untouched


def test_reactions_stretch_the_scene_on_stage(fixed_widths):
    d = LiveDirector("a", hold=6, blend=4, loop=False)
    d._current = make_scene("x", hold=6, origin="auto"); d._active_since = 100
    assert d._hold_len(d._current) == 3
    d.heat = lambda since: 13 if since == 100 else 0
    assert d._hold_len(d._current) == 5          # +2 for ~13 reactions
    d.heat = lambda since: 500
    assert d._hold_len(d._current) == 5          # +2 max
    assert d._hold_len(make_scene("y", hold=6, origin="auto")) == 4   # only the scene on stage


def test_transitioner_inserts_bridge():
    from PIL import Image
    from infinite_tapestry.transitions import Transitioner
    d = LiveDirector("a", hold=3, blend=2, loop=False)
    nxt = make_scene("stadium", origin="auto", title="Stadium")
    d.add([nxt])
    g = type("G", (), {"canvas": Image.new("RGB", (1024, 1024))})()
    t = Transitioner(d, g, None)
    t._plan = lambda cur, n, jpeg: {"mode": "passthrough", "bridge": ["fog bank", "gate"]}
    t.step()
    assert [s["prompt"] for s in d._queue] == ["fog bank", "gate", "stadium"]
    assert d._queue[0]["bridge"] and nxt["transition"] == 1
    t.step()  # already handled
    assert len(d._queue) == 3
