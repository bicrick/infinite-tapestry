import asyncio

from infinite_tapestry.autopilot import Autopilot
from infinite_tapestry.prompts import LiveDirector, make_scene


class FakeAuto:
    enabled = True
    tokens_used = 0

    def __init__(self, fail=False):
        self.fail, self.n, self.seen = fail, 0, []

    def autoplan(self, recent, vibe="", count=2):
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
    assert len(items) == 1 and items[0]["origin"] == "auto" and "glass forest" in items[0]["prompt"]
    assert ap.last_error and ap._next_allowed > 0


def test_autopilot_respects_disable_and_budget():
    d = LiveDirector("x", hold=0, blend=2)
    fi = FakeAuto()
    ap = Autopilot(d, fi, min_interval=0, token_budget=0)
    ap.enabled = False
    asyncio.run(ap.tick())
    assert fi.n == 0 and not d.state()["items"]
