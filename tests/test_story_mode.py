import asyncio

from infinite_tapestry.autopilot import Autopilot
from infinite_tapestry.prompts import LiveDirector, make_scene
from tests.test_autopilot import FakeAuto


def row(pid=1, n=5, start=0):
    return {"id": pid, "status": "queued", "scene_index": start,
            "story": {"id": 9, "title": "Egypt", "theme": "nile", "scenes": [{"title": f"S{k}", "prompt": f"scene number {k} prompt"} for k in range(n)]}}


def play(d, n):
    for _ in range(n):
        d.frame_for(d._last_index + 1 if hasattr(d, "_last_index") else 0)


def titles(d):
    return [i["title"] for i in d.state()["items"]]


def drain(d, ap, steps=400):
    """Advance frames and tick Auto until the queue is consumed."""
    seen = []
    for i in range(steps):
        d.frame_for(i)
        asyncio.run(ap.tick())
        for r in d.recent(80):
            if r["title"] not in seen and str(r.get("source", "")).startswith("story:"):
                seen.append(r["title"])
    return seen


def test_story_plays_in_order_then_next_then_moods():
    d = LiveDirector("seed", hold=0, blend=2)
    fi = FakeAuto()
    done = []
    ap = Autopilot(d, fi, min_interval=0)
    queue = [row(1, 4), row(2, 3)]
    ap.config_fetch = lambda: {"story": (queue[0] if queue else None)}
    ap.story_done = lambda pid: (done.append(pid), queue.pop(0))
    ap.apply_config(ap.config_fetch())
    asyncio.run(ap.tick())
    assert titles(d)[:3] == ["S0", "S1", "S2"] and fi.n == 0  # no LLM in story mode
    seen = drain(d, ap)
    assert done == [1, 2]
    assert seen[:4] == ["S0", "S1", "S2", "S3"]
    assert ap.story is None and fi.n > 0  # playlist empty: back to mood rotation


def test_user_idea_interrupts_and_story_resumes():
    d = LiveDirector("seed", hold=0, blend=2)
    ap = Autopilot(d, FakeAuto(), min_interval=0)
    ap.apply_config({"story": row(1, 6)})
    asyncio.run(ap.tick())
    assert titles(d)[:3] == ["S0", "S1", "S2"]
    d.frame_for(0)  # S0 goes in flight
    d.add_user([make_scene("mine", origin="user")])
    asyncio.run(ap.tick())
    t = titles(d)
    assert "mine" in t and t.index("mine") < t.index("S1")  # user first, story resumes from where it was


def test_invalid_story_keeps_last_good_state():
    d = LiveDirector("seed", hold=0, blend=2)
    ap = Autopilot(d, FakeAuto(), min_interval=0)
    ap.apply_config({"story": row(1, 3)})
    for bad in [{"id": 2, "story": {"scenes": "nope"}}, {"id": "x"}, {"id": 3, "story": {"scenes": [{"prompt": ""}]}}, 7]:
        ap.apply_config({"story": bad})
        assert ap.story and ap.story["pid"] == 1
    ap.apply_config({})  # fetch failed for the playlist: unchanged
    assert ap.story["pid"] == 1
    ap.apply_config({"story": None})
    assert ap.story is None


def test_story_resumes_from_saved_index():
    d = LiveDirector("seed", hold=0, blend=2)
    ap = Autopilot(d, FakeAuto(), min_interval=0)
    ap.apply_config({"story": row(1, 6, start=3)})
    asyncio.run(ap.tick())
    assert titles(d)[0] == "S3"


def test_admin_story_and_chat_helpers_node():
    import subprocess, pathlib, shutil
    if not shutil.which("node"):
        return
    root = pathlib.Path(__file__).resolve().parents[1]
    js = r"""
    const s = require('./web/lib/stories.js'), c = require('./web/lib/autochat.js');
    const st = s.cleanStory({title:' T ', scenes:[{title:'a',prompt:'x'},{title:'b',prompt:'long enough'}]});
    if (st.scenes.length !== 1 || st.title !== 'T') throw 'clean';
    let ok = false; try { s.cleanStory({title:'', scenes:[]}); } catch (_) { ok = true; } if (!ok) throw 'reject';
    const msgs = [{role:'user',content:[{type:'text',text:'hi'}]},{role:'assistant',content:[{type:'text',text:'yo'},{type:'tool_use',id:'t1',name:'set_paused',input:{paused:true}}]}];
    const pr = c.pendingResults(msgs); if (pr.length !== 1 || pr[0].tool_use_id !== 't1') throw 'pending';
    const h = c.history([{role:'user',content:[{type:'tool_result',tool_use_id:'z'}]}, ...msgs]); if (h[0].content[0].type !== 'text') throw 'history';
    if (!c.TOOLS.map(t=>t.name).includes('propose_story')) throw 'tools';
    """
    r = subprocess.run(["node", "-e", js], cwd=root, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_admin_ui_has_chat_and_stories():
    import json, pathlib
    ui = json.loads((pathlib.Path(__file__).resolve().parents[1] / "web/api/_admin_ui.json").read_text())
    for w in ["Talk to Auto", "Play now", "Add to playlist", "Save to library", "New chat"]:
        assert w in ui["html"] + ui["js"], w
    assert "claude" not in (ui["html"] + ui["js"]).lower()
