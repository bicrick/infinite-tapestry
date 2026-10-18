import asyncio

from infinite_tapestry.crowd import Crowd, GPU_CENTS_PER_HOUR
from infinite_tapestry.interpreter import PromptInterpreter


class FakeSupa:
    url = "http://x"

    def __init__(self, get_map=None):
        self.calls = []
        self.get_map = get_map or {}

    def rest(self, method, path, body=None, prefer=None):
        self.calls.append((method, path, body))
        if method == "PATCH" and prefer == "return=representation" and "id=in.(" in path:
            # like PostgREST: the rows this request actually changed (all, unless a test says otherwise)
            ids = path.split("id=in.(")[1].split(")")[0].split(",")
            return [{"id": int(i)} for i in ids if int(i) not in getattr(self, "taken", ())]
        if method == "GET":
            for key, rows in self.get_map.items():
                if path.startswith(key) or key in path:
                    return rows
            return []
        return []

    def audit(self, *a, **k):
        self.calls.append(("AUDIT", a, k))


class FakeDirector:
    def __init__(self):
        self._last_index = 10
        self.cur = {"title": "a", "idea_ids": [7]}
        self.target = None
        self.items = []
        self.added = []

    def state(self):
        return {
            "current_scene": self.cur,
            "target_scene": self.target,
            "items": list(self.items),
            "target": None,
            "current": "sky",
        }

    def add_user(self, scenes, position="end"):
        self.added.extend(scenes)


class FakeInterpreter:
    def __init__(self, scenes=None):
        self.scenes = scenes or [{"title": "Harbor", "prompt": "a quiet harbor at dawn"}]
        self.tokens_used = 0

    def plan(self, *a, **k):
        return {"scenes": self.scenes, "source": "test"}


def test_track_landing_records_start_and_marks_played_on_end():
    s, d = FakeSupa(), FakeDirector()
    c = Crowd(s, d, None, None, lambda m: None, lambda: None, mock=True)
    asyncio.run(c.track_landing())
    assert ("PATCH", "ideas?id=eq.7&start_strip=is.null", {"start_strip": 10}) in s.calls
    d.cur, d._last_index = {"title": "b"}, 25
    asyncio.run(c.track_landing())
    end = [c for c in s.calls if c[0] == "PATCH" and c[1] == "ideas?id=eq.7" and "end_strip" in (c[2] or {})]
    assert end, s.calls
    body = end[-1][2]
    assert body["end_strip"] == 25
    assert body["status"] == "played"
    assert "played_at" in body


def test_pull_ideas_keeps_playing_and_stores_plan():
    idea = {"id": 8, "handle": "ada", "body": "a misty dock", "votes": 1, "boost_cents": 0, "image_path": None}
    s = FakeSupa(get_map={"ideas?status=eq.pending": [idea]})
    d = FakeDirector()
    d.cur = None
    msgs = []
    c = Crowd(s, d, FakeInterpreter(), None, msgs.append, lambda: None, mock=True)
    asyncio.run(c.pull_ideas())
    assert d.added and d.added[0]["idea_ids"] == [8]
    played = [c for c in s.calls if c[0] == "PATCH" and (c[2] or {}).get("status") == "played"]
    assert not played, played
    plan_patch = [c for c in s.calls if c[0] == "PATCH" and "plan" in (c[2] or {})]
    assert plan_patch
    assert "titles" in plan_patch[-1][2]["plan"]
    assert any(c[0] == "PATCH" and "status=eq.pending" in c[1] and (c[2] or {}).get("status") == "playing" for c in s.calls)


def test_pull_ideas_rejects_when_all_scenes_disallowed(monkeypatch):
    idea = {"id": 9, "handle": "bob", "body": "blocked", "votes": 0, "boost_cents": 0, "image_path": None}
    s = FakeSupa(get_map={"ideas?status=eq.pending": [idea]})
    d = FakeDirector()
    d.cur = None
    monkeypatch.setattr("infinite_tapestry.guard.is_disallowed", lambda *a, **k: True)
    monkeypatch.setattr("infinite_tapestry.interpreter.assemble_plan",
                        lambda core, title=None, hold=3: {"scenes": [{"title": "x", "prompt": "nope"}]})
    c = Crowd(s, d, FakeInterpreter([{"title": "x", "prompt": "nope"}]), None, lambda m: None, lambda: None, mock=True)
    asyncio.run(c.pull_ideas())
    assert not d.added
    assert any(c[0] == "PATCH" and (c[2] or {}).get("status") == "rejected" for c in s.calls)


def test_recover_interrupted_requeues_and_finalizes():
    s = FakeSupa(get_map={
        "ideas?status=eq.playing&start_strip=is.null": [{"id": 2}],
        "ideas?status=eq.playing&start_strip=not.is.null": [{"id": 3, "start_strip": 100}],
    })
    d = FakeDirector()
    d.cur = {"title": "unrelated"}  # no idea_ids overlapping 2/3
    c = Crowd(s, d, None, None, lambda m: None, lambda: None, mock=True)
    asyncio.run(c.recover_interrupted())
    assert ("PATCH", "ideas?id=eq.2", {"status": "pending"}) in s.calls
    fin = [call for call in s.calls if call[0] == "PATCH" and call[1] == "ideas?id=eq.3"]
    assert fin
    assert fin[-1][2]["status"] == "played"
    assert fin[-1][2]["end_strip"] == 112


def test_recover_interrupted_skips_ideas_still_in_director():
    """Director queue/current/target (with idea_ids) is restored from state.json — leave those alone."""
    s = FakeSupa(get_map={
        "ideas?status=eq.playing&start_strip=is.null": [{"id": 7}, {"id": 8}],
        "ideas?status=eq.playing&start_strip=not.is.null": [
            {"id": 9, "start_strip": 50},
            {"id": 10, "start_strip": 60},
        ],
    })
    d = FakeDirector()
    d.cur = {"title": "now", "idea_ids": [7]}
    d.target = {"title": "next", "idea_ids": [9]}
    d.items = [{"title": "queued", "idea_ids": [10], "origin": "user"}]
    c = Crowd(s, d, None, None, lambda m: None, lambda: None, mock=True)
    asyncio.run(c.recover_interrupted())
    patched = {(call[1], (call[2] or {}).get("status")) for call in s.calls if call[0] == "PATCH"}
    assert ("ideas?id=eq.8", "pending") in patched  # never landed, not in director
    assert ("ideas?id=eq.7", "pending") not in patched
    assert not any(p[0] == "ideas?id=eq.9" for p in patched)
    assert not any(p[0] == "ideas?id=eq.10" for p in patched)


def test_fuel_state_includes_gpu_cents_per_hour():
    c = Crowd(FakeSupa(), FakeDirector(), None, None, lambda m: None, lambda: None, mock=True)
    c.fuel_cents = 2234.0
    st = c.state()
    assert st["gpu_cents_per_hour"] == GPU_CENTS_PER_HOUR
    assert st["hours"] == round(2234.0 / GPU_CENTS_PER_HOUR, 2)
    assert st["cents"] == 2234.0


def test_plan_sends_images_as_content_blocks():
    it = PromptInterpreter(api_key="k")
    seen = {}

    def fake(model, user, *a, **k):
        seen["user"] = user
        return '{"scenes":[{"title":"t","prompt":"a quiet harbor"}]}'

    it._call = fake
    it.plan("go here", "now", None, [(b"\xff\xd8x", "image/jpeg")])
    assert isinstance(seen["user"], list) and seen["user"][0]["type"] == "image"


def test_queue_mode_threshold():
    from infinite_tapestry.crowd import queue_mode
    assert queue_mode(0) == "fifo" and queue_mode(3) == "fifo" and queue_mode(4) == "vote"


def test_pull_ideas_starts_text_idea_without_haiku_and_skips_rows_claimed_elsewhere():
    rows = [{"id": 11, "handle": "ada", "body": "a red kite", "image_path": None},
            {"id": 12, "handle": "bob", "body": "a blue boat", "image_path": None}]
    s = FakeSupa(get_map={"ideas?status=eq.pending": rows})
    s.taken = {12}                       # another pod claimed idea 12 first
    d = FakeDirector(); d.cur = None

    class NoCall(FakeInterpreter):
        enabled = False
        def plan(self, *a, **k):
            raise AssertionError("text ideas must not wait on Haiku")
    c = Crowd(s, d, NoCall(), None, lambda m: None, lambda: None, mock=True)
    c._limits_at = 1e18
    asyncio.run(c.pull_ideas())
    assert [sc["idea_ids"] for sc in d.added] == [[11]] and d.added[0]["prompt"] == "a red kite"


def test_duplicate_idea_on_stage_is_merged_not_replayed():
    rows = [{"id": 21, "handle": "ada", "body": "Marvel  superheros", "image_path": None}]
    s = FakeSupa(get_map={"ideas?status=eq.pending": rows})
    d = FakeDirector()
    d.cur = {"title": "m", "origin": "user", "source": "marvel superheros", "idea_ids": [20]}
    c = Crowd(s, d, FakeInterpreter(), None, lambda m: None, lambda: None, mock=True)
    c._limits_at = 1e18
    asyncio.run(c.pull_ideas())
    assert not d.added
    assert any(x[0] == "PATCH" and x[1] == "ideas?id=eq.21" and (x[2] or {}).get("status") == "played" for x in s.calls)
