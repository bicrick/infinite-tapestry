"""User ideas keep the user's text VERBATIM: the LLM only proposes a title + allowlisted suffix tokens.
Any LLM failure means the verbatim text. The LLM is mocked; nothing touches live."""
import asyncio
import json
import socket
import urllib.error

import pytest

from infinite_tapestry import interpreter as it
from infinite_tapestry.interpreter import PromptInterpreter, SYSTEM, clean_suffix, clean_title, raw_title, sanitize_raw


def _interp(monkeypatch, out=None, exc=None):
    p = PromptInterpreter(api_key="test")
    p.calls = []

    def fake(model, user, system=SYSTEM, max_tokens=6000, _think=True):
        p.calls.append((system, user))
        if exc:
            raise exc
        return out
    monkeypatch.setattr(p, "_call", fake)
    return p


def _r(title, suffix, **kw):
    return json.dumps({"title": title, "suffix": suffix, **kw})


# (idea, mocked LLM reply, expected prompt, expected title)
EXAMPLES = [
    ("a cat riding a skateboard through tokyo at night",
     _r("Cat Skateboard", ["highly detailed", "wide continuous scene", "neon lighting", "cinematic photo"]),
     "a cat riding a skateboard through tokyo at night, highly detailed, wide continuous scene", "Cat Skateboard"),
    ("oil painting of a lighthouse in a storm",
     _r("Lighthouse Storm", ["sharp focus", "a dragon in the sky", "extends left and right"]),
     "oil painting of a lighthouse in a storm, sharp focus, extends left and right", "Lighthouse Storm"),
    ("feces land",
     _r("Chocolate Wonderland", ["masterpiece", "photorealistic", "35mm"]),
     "feces land, masterpiece", "feces land"),
]


@pytest.mark.parametrize("idea,out,prompt,title", EXAMPLES)
def test_prompt_is_verbatim_text_plus_validated_suffix(monkeypatch, idea, out, prompt, title):
    plan = _interp(monkeypatch, out).plan(idea)
    assert plan["source"] == "haiku" and len(plan["scenes"]) == 1
    sc = plan["scenes"][0]
    assert sc["prompt"].startswith(idea) and idea in sc["prompt"]
    assert sc["prompt"] == prompt and sc["title"] == title
    assert sc["beats"] == [] and sc["style"] == ""


def test_llm_prompt_field_is_ignored_for_text_ideas(monkeypatch):
    out = _r("Red Balloon", [], prompt="a fantasy kingdom with dragons and a red balloon")
    plan = _interp(monkeypatch, out).plan("red balloon")
    assert plan["scenes"][0]["prompt"] == "red balloon"


def test_suffix_rejects_subjects_styles_and_caps():
    assert clean_suffix(["a dragon", "golden hour", "anime style", "photo", "highly detailed"]) == ["highly detailed"]
    assert clean_suffix("sharp focus, wide continuous scene, 8k") == ["sharp focus", "wide continuous scene", "8k"]
    assert len(clean_suffix(["highly detailed", "sharp focus", "8k", "4k", "masterpiece", "high quality", "seamless panorama"])) <= 5
    assert clean_suffix({"x": 1}) == [] and clean_suffix(None) == []
    assert clean_suffix(["<lora:x>", "(masterpiece:1.4)"]) == []


def test_title_only_from_users_words():
    assert clean_title("Glass Whales", "glass whales in a desert") == "Glass Whales"
    assert clean_title("Ocean Dreams", "glass whales in a desert") == "glass whales in a"
    assert clean_title("Whales", "glass whales in a desert") == "glass whales in a"  # 1 word: too short
    assert raw_title("") == ""


def test_system_keeps_hard_rules_and_never_rewrites():
    low = SYSTEM.lower()
    assert "verbatim" in low and "never rewrite" in low and "never photo" in low
    for rule in ("nudity or sexual content", "children/minors", "hateful slurs or symbols", "defamatory or degrading"):
        assert rule in low


@pytest.mark.parametrize("exc,out", [
    (None, "I can't help with that request."),        # refusal
    (None, "{not json"),                              # invalid JSON
    (None, "sure! here you go"),                      # no JSON
    (socket.timeout("timed out"), None),              # timeout
    (urllib.error.URLError("down"), None),            # network error
    (RuntimeError("boom"), None),                     # anything else
])
def test_any_failure_is_verbatim_text(monkeypatch, exc, out):
    idea = "  a   swamp full of\nscreaming (toasters)  "
    plan = _interp(monkeypatch, out, exc).plan(idea)
    assert plan["source"] == "raw"
    assert plan["scenes"][0]["prompt"] == "a swamp full of screaming (toasters)"
    assert plan["scenes"][0]["title"] == "a swamp full of"


def test_no_key_is_verbatim():
    plan = PromptInterpreter(api_key="").plan("pickle cathedral")
    assert plan["scenes"][0]["prompt"] == "pickle cathedral"


def test_sanitize_raw_trims_and_caps_only():
    assert sanitize_raw("  ((masterpiece)) cat ") == "((masterpiece)) cat"
    assert len(sanitize_raw("word " * 300)) <= 500


def test_safety_unchanged_in_fallback():
    assert "nude" not in it.fallback_plan("nude beach")["scenes"][0]["prompt"]


def test_image_only_uses_faithful_caption_with_moderation(monkeypatch):
    out = json.dumps({"title": "Red Barn", "suffix": ["highly detailed"], "prompt": "red barn in a wheat field, golden light",
                      "image_flags": []})
    p = _interp(monkeypatch, out)
    plan = p.plan("Inspired by this image", images=[(b"\x89PNG", "image/png")])
    assert plan["source"] == "haiku" and plan["scenes"][0]["prompt"] == "red barn in a wheat field, golden light, highly detailed"
    text = p.calls[0][1][-1]["text"].lower()
    assert "faithful" in text and "inventing nothing" in text and "image_flags" in text


def test_image_with_text_keeps_text_verbatim(monkeypatch):
    out = json.dumps({"title": "My Dog", "suffix": [], "image_flags": ["real_face"]})
    plan = _interp(monkeypatch, out).plan("my dog as a giant", images=[(b"x", "image/png")])
    assert plan["scenes"][0]["prompt"] == "my dog as a giant" and plan["image_flags"] == ["real_face"]


class Mocked:
    """Real PromptInterpreter with a mocked LLM reply, so crowd runs the true assembly path."""
    def __init__(self, monkeypatch):
        self.p = _interp(monkeypatch, _r("x", ["highly detailed"]))
        self.tokens_used = 0
        self.seen = []

    def plan(self, intent, current="", upcoming=None, images=None):
        self.seen.append(intent)
        return self.p.plan(intent, current, upcoming, images)


def test_crowd_one_verbatim_scene_per_idea_in_order(monkeypatch):
    from infinite_tapestry.crowd import Crowd
    from tests.test_crowd_features import FakeDirector, FakeSupa
    bodies = ["misty dock", "glass reef full of eels", "lava library"]
    rows = [{"id": i + 1, "handle": h, "body": b, "votes": 0, "boost_cents": 0, "image_path": None}
            for i, (h, b) in enumerate(zip(["ada", "bob", "cy"], bodies))]
    s = FakeSupa(get_map={"ideas?status=eq.pending&order=created_at.asc&limit=40&select=id": [{"id": i} for i in range(5)],
                          "ideas?status=eq.pending": rows})
    d = FakeDirector(); d.cur = None
    m = Mocked(monkeypatch)
    c = Crowd(s, d, m, None, lambda x: None, lambda: None, mock=True)
    c._limits_at = 1e18
    asyncio.run(c.pull_ideas())
    assert m.seen == bodies  # each idea planned alone, never a woven intent
    assert [sc["idea_ids"] for sc in d.added] == [[1], [2], [3]]
    assert [sc["by"] for sc in d.added] == ["@ada", "@bob", "@cy"]
    for sc, b in zip(d.added, bodies):
        assert sc["prompt"].startswith(b) and b in sc["prompt"]
        assert all(beat == sc["prompt"] for beat in (sc.get("beats") or []))
