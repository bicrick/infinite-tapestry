"""Fair queue only when busy: quiet keeps today's FIFO/votes path and full holds."""
import asyncio
import os
import re
from pathlib import Path

from infinite_tapestry import crowd as crowd_mod
from infinite_tapestry.crowd import BUSY_HOLD, BUSY_PENDING, Crowd, direct_plan
from tests.test_crowd_features import FakeDirector, FakeInterpreter, FakeSupa

ROOT = Path(__file__).resolve().parents[1]


class RpcSupa(FakeSupa):
    def __init__(self, pending, picked):
        super().__init__(get_map={"ideas?status=eq.pending&order=created_at.asc&limit=40&select=id": pending,
                                  "ideas?status=eq.pending": pending})
        self.picked = picked

    def rest(self, method, path, body=None, prefer=None):
        if method == "POST" and path == "rpc/pick_ideas":
            self.calls.append((method, path, body))
            return self.picked
        return super().rest(method, path, body, prefer)


def _crowd(s, d):
    c = Crowd(s, d, FakeInterpreter(), None, lambda m: None, lambda: None, mock=True)
    c._limits_at = 1e18  # skip the knobs fetch; defaults apply
    return c


def test_quiet_queue_unchanged_fifo_and_full_hold():
    idea = {"id": 1, "handle": "ada", "body": "a misty dock", "votes": 0, "boost_cents": 0, "image_path": None}
    s, d = RpcSupa([{"id": 1}], []), FakeDirector()
    d.cur = None
    c = _crowd(s, d)
    s.get_map = {"ideas?status=eq.pending&order=created_at.asc&limit=40&select=id": [{"id": 1}], "ideas?status=eq.pending": [idea]}
    asyncio.run(c.pull_ideas())
    assert not c.busy
    assert not any(p == "rpc/pick_ideas" for _, p, _ in s.calls)
    assert d.added and d.added[0]["hold"] == 4


def test_busy_queue_uses_atomic_fair_pick_and_short_holds():
    pending = [{"id": i} for i in range(BUSY_PENDING + 5)]
    picked = [{"id": 3, "handle": "ada", "body": "pigskin macro", "votes": 2, "boost_cents": 0, "image_path": None, "user_id": "u1"},
              {"id": 9, "handle": "bob", "body": "glass reef", "votes": 0, "boost_cents": 0, "image_path": None, "user_id": "u2"}]
    s, d = RpcSupa(pending, picked), FakeDirector()
    d.cur = None
    c = _crowd(s, d)
    asyncio.run(c.pull_ideas())
    assert c.busy
    assert ("POST", "rpc/pick_ideas", {"p_n": 3}) in s.calls
    assert [sc["idea_ids"] for sc in d.added] == [[3, 9], [3, 9]]
    assert all(sc["hold"] == BUSY_HOLD for sc in d.added)
    assert 2 <= BUSY_HOLD <= 3


def test_direct_plan_hold_default_and_busy():
    assert direct_plan(["x"])["scenes"][0]["hold"] == 4
    assert direct_plan(["x"], hold=2)["scenes"][0]["hold"] == 2


def test_gpu_rate_default_is_real_runpod_rate():
    if "TAPESTRY_GPU_CENTS_PER_HOUR" not in os.environ:
        assert crowd_mod.GPU_CENTS_PER_HOUR == 89
    html = (ROOT / "static/index.html").read_text()
    assert "$0.17" not in html and "$0.90 an hour" in html


def test_migration_defines_fair_queue_without_llm():
    sql = (ROOT / "supabase/migrations/010_fair_queue.sql").read_text()
    for fn in ("fair_line", "pick_ideas", "queue_place", "queue_list", "submit_idea"):
        assert re.search(rf"function public\.{fn}\(", sql), fn
    assert "'expired'" in sql and "busy_pending int not null default 15" in sql
    assert "cooldown_minutes int not null default 30" in sql and "expire_minutes int not null default 90" in sql
    assert "pg_advisory_xact_lock" in sql
    code = "\n".join(l.split("--")[0] for l in sql.splitlines())
    assert not re.search(r"claude|haiku|anthropic|llm", code, re.I)


def test_woven_section_removed():
    for f in ("static/index.html", "static/social.js"):
        assert "woven-list" not in (ROOT / f).read_text()


def test_share_page_has_analytics_and_meta():
    js = (ROOT / "web/api/share.js").read_text()
    assert "/_vercel/insights/script.js" in js and "/_vercel/speed-insights/script.js" in js
    assert "og:image" in js and "twitter:card" in js
    assert "status=in.(pending,playing,played)" in js  # never rejected / expired


def test_fuel_never_stops_the_pod():
    src = (ROOT / "infinite_tapestry/crowd.py").read_text()
    assert "_stop_self" not in src and "podStop" not in src
    js = (ROOT / "web/lib/common.js").read_text()
    assert "RUNPOD_MIN_BALANCE" in js and "balance <= 0" not in js


def test_soft_title_word_boundary():
    from infinite_tapestry.prompts import soft_title
    assert soft_title("short") == "short"
    assert soft_title("Mayan temple with hidden technology inside") == "Mayan temple with hidden technology…"
    assert "…" in soft_title("abcdefghijklmnopqrstuvwxyz0123456789ABCDEF")


def test_low_fuel_banner_removed():
    for f in ("static/index.html", "static/social.js", "static/style.css"):
        assert "nudge-line" not in (ROOT / f).read_text() and "maybeNudge" not in (ROOT / f).read_text()


def test_strip_scenes_insert_in_order_for_replay():
    js = (ROOT / "static/client.js").read_text()
    assert "older strip: /timeline backfill covers it" not in js
    assert "tlScenes.splice(lo, 0," in js


def test_busy_pick_round_robins_by_submitter():
    c = _crowd(RpcSupa([], []), FakeDirector())
    rows = [{"id": 1, "guest_id": "A"}, {"id": 2, "guest_id": "A"}, {"id": 3, "guest_id": "A"},
            {"id": 4, "guest_id": "B"}, {"id": 5, "user_id": "u1"}, {"id": 6, "guest_id": "B"}]
    assert [r["id"] for r in c._pick(rows, 3, True, 2)] == [1, 4, 5]
    assert [r["id"] for r in c._pick(rows[:4], 3, True, 2)] == [1, 4, 2]
    # quiet: users can do whatever they want (plain order)
    assert [r["id"] for r in c._pick(rows, 3, False, 2)] == [1, 2, 3]
