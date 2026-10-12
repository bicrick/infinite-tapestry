import asyncio

from infinite_tapestry.crowd import Crowd
from infinite_tapestry.interpreter import PromptInterpreter


class FakeSupa:
    url = "http://x"
    def __init__(self):
        self.calls = []
    def rest(self, method, path, body=None, prefer=None):
        self.calls.append((method, path, body)); return []
    def audit(self, *a, **k):
        pass


class FakeDirector:
    def __init__(self):
        self._last_index = 10
        self.cur = {"title": "a", "idea_ids": [7]}
    def state(self):
        return {"current_scene": self.cur, "target_scene": None}


def test_track_landing_records_start_and_end():
    s, d = FakeSupa(), FakeDirector()
    c = Crowd(s, d, None, None, lambda m: None, lambda: None, mock=True)
    asyncio.run(c.track_landing())
    assert ("PATCH", "ideas?id=eq.7&start_strip=is.null", {"start_strip": 10}) in s.calls
    d.cur, d._last_index = {"title": "b"}, 25
    asyncio.run(c.track_landing())
    assert ("PATCH", "ideas?id=eq.7", {"end_strip": 25}) in s.calls


def test_plan_sends_images_as_content_blocks():
    it = PromptInterpreter(api_key="k")
    seen = {}
    def fake(model, user, *a, **k):
        seen["user"] = user
        return '{"scenes":[{"title":"t","prompt":"a quiet harbor"}]}'
    it._call = fake
    it.plan("go here", "now", None, [(b"\xff\xd8x", "image/jpeg")])
    assert isinstance(seen["user"], list) and seen["user"][0]["type"] == "image"
