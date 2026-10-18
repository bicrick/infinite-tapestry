import asyncio

from infinite_tapestry.autopilot import Autopilot
from infinite_tapestry.prompts import LiveDirector, make_scene


class FakeAuto:
    enabled = True
    tokens_used = 0

    def __init__(self, fail=False):
        self.fail, self.n, self.seen = fail, 0, []

    def autoplan(self, recent, vibe="", count=2, brief="", keep_style=""):
        if self.fail:
            raise RuntimeError("down")
        self.seen.append([r["title"] for r in recent])
        self.n += 1
        return {"scenes": [{"title": f"auto{self.n}a", "prompt": f"p{self.n}a"},
                           {"title": f"auto{self.n}b", "prompt": f"p{self.n}b"}], "note": "n"}


def test_autopilot_fills_chains_and_user_preempts():
    d = LiveDirector("seed", hold=0, blend=2)
    fi = FakeAuto()
    ap = Autopilot(d, fi, min_interval=0)
    asyncio.run(ap.tick())
    items = d.state()["items"]
    assert [i["origin"] for i in items] == ["auto", "auto"]
    # User enqueue goes ahead and drops pending autos.
    dropped = d.add_user([make_scene("mine", origin="user")])
    assert dropped == 2 and [i["origin"] for i in d.state()["items"]] == ["user"]
    for i in range(10):
        d.frame_for(i)
    asyncio.run(ap.tick())
    assert "mine" in fi.seen[-1][-1] or "mine" in " ".join(fi.seen[-1])  # continues from user's scene
    assert not d.loop


def test_autopilot_failure_backs_off_with_variation():
    d = LiveDirector("a glass forest", hold=0, blend=2)
    ap = Autopilot(d, FakeAuto(fail=True), min_interval=0)
    asyncio.run(ap.tick())
    items = d.state()["items"]
    # fallback is a FRESH scene (new subject/place/look), never the last prompt replayed with a modifier
    assert len(items) == 1 and items[0]["origin"] == "auto" and "glass forest" not in items[0]["prompt"]
    assert items[0]["source"] == "variation" and items[0]["title"]
    assert ap.last_error and ap._next_allowed > 0


def test_autopilot_respects_disable_and_budget():
    d = LiveDirector("x", hold=0, blend=2)
    fi = FakeAuto()
    ap = Autopilot(d, fi, min_interval=0, token_budget=0)
    ap.enabled = False
    asyncio.run(ap.tick())
    assert fi.n == 0 and not d.state()["items"]


class SlowAuto(FakeAuto):
    def autoplan(self, *a, **k):
        import time
        time.sleep(1.0)
        return super().autoplan(*a, **k)


def test_hung_plan_is_abandoned_and_stage_kept_moving(monkeypatch):
    import infinite_tapestry.autopilot as A
    monkeypatch.setattr(A, "PLAN_TIMEOUT_S", 0.2)
    d = LiveDirector("a glass forest", hold=0, blend=2)
    ap = Autopilot(d, SlowAuto(), min_interval=0)
    asyncio.run(ap.tick())
    items = d.state()["items"]
    assert ap.last_error and not ap.busy and len(items) == 1 and items[0]["source"] == "variation"


def test_overdue_stage_gets_fallback_even_while_busy():
    d = LiveDirector("a glass forest", hold=0, blend=2)
    ap = Autopilot(d, FakeAuto(), min_interval=0)
    ap.busy = True                      # a plan is "in flight"
    for i in range(40):
        d.frame_for(i)                  # nothing queued: the seed scene runs long
    assert d.overdue() >= 3
    asyncio.run(ap.tick())
    assert [i["source"] for i in d.state()["items"]] == ["variation"]


def test_token_budget_is_hourly():
    import time
    d = LiveDirector("x", hold=0, blend=2)
    ap = Autopilot(d, FakeAuto(), min_interval=0, token_budget=1000)
    ap._spent = [(time.monotonic() - 3700, 5000)]   # spent over an hour ago: forgotten
    assert ap._can_call()
    ap._spent.append((time.monotonic(), 1500))
    assert not ap._can_call()
