from infinite_tapestry.guard import is_blocked
from infinite_tapestry.interpreter import PromptInterpreter, is_refusal


def test_guard_blocks_minor_sexual_combos_only():
    assert is_blocked("nude teen on a beach")
    assert is_blocked("a 15 year old, erotic pose")
    assert not is_blocked("a blood-soaked gothic horror banquet")
    assert not is_blocked("nude adult figure study, renaissance oil painting")
    assert not is_blocked("children playing in a sunny park")


def test_refusal_falls_back_to_raw_text(monkeypatch):
    it = PromptInterpreter(api_key="k")
    monkeypatch.setattr(it, "_call", lambda *a, **k: "I can't help create that content.")
    p = it.plan("a blood-soaked gothic horror banquet")
    assert p["source"] == "raw" and p["scenes"][0]["prompt"] == "a blood-soaked gothic horror banquet"
    assert is_refusal("I won't do that") and not is_refusal('{"scenes":[]}')


def test_sexual_terms_rejected_but_gore_allowed():
    from infinite_tapestry.guard import is_disallowed, is_sexual
    from infinite_tapestry.interpreter import fallback_plan

    assert is_sexual("a nude figure in a hallway") and is_disallowed("erotic dance hall")
    assert not is_disallowed("a blood-soaked gothic horror banquet, gore, corpses")
    assert "nude" not in fallback_plan("nude beach at dawn")["scenes"][0]["prompt"]


def test_live_canvas_is_never_checked():
    """No canvas checks: even an injected classifier is never called on generated strips."""
    from infinite_tapestry.buffer import StripBuffer
    from infinite_tapestry.config import Config
    from infinite_tapestry.generator import StripGenerator
    from infinite_tapestry.mock_inpaint import MockInpainter

    cfg = Config(mock=True, height=32, window_width=64, strip_width=16, overlap=4, buffer_target=3, buffer_min=1)
    gen = StripGenerator(cfg, MockInpainter(cfg), StripBuffer(3, 1))
    calls, flagged = [], []
    gen.nsfw = lambda img: calls.append(1) or 0.99
    gen.on_flag = flagged.append
    gen.generate_one()
    assert calls == [] and flagged == [] and gen.nsfw_hits == 0
