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
