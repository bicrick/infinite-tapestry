from infinite_tapestry.prompts import LiveDirector, make_scene


def test_trim_auto_keeps_users_and_first_autos():
    d = LiveDirector("seed", hold=0, blend=2)
    d.add([make_scene(f"a{i}", origin="auto") for i in range(5)])
    d.add_user([make_scene("u", origin="user")])
    d.add([make_scene(f"b{i}", origin="auto") for i in range(4)])
    assert d.trim_auto(2)
    items = d.state()["items"]
    assert [i["origin"] for i in items] == ["user", "auto", "auto"]
    assert not d.trim_auto(2)


def test_ref_schedule_ramps_between_scenes():
    from infinite_tapestry import refs
    import io
    from PIL import Image
    buf = io.BytesIO(); Image.new("RGB", (64, 64), (200, 10, 10)).save(buf, "JPEG")
    refs.put(901, buf.getvalue())
    assert refs.schedule(None, None, 0.0) == (None, 0.0)
    rid, sc = refs.schedule(None, 901, 1.0)
    assert rid == 901 and abs(sc - refs.STYLE_SCALE) < 1e-6
    assert refs.schedule(901, None, 0.0)[0] == 901
    assert refs.blocked(["minor"]) and refs.blocked(["Sexual"]) and not refs.blocked(["real_face"])
    assert refs.face_mode_allowed("u", {}) is False


def test_hard_blocks_only():
    from infinite_tapestry.guard import hard_block_reason
    assert hard_block_reason("feces land") is None
    assert hard_block_reason("cartoon gore zombie buffet, vomit fountains") is None
    assert hard_block_reason("naked party") == "sexual"
    assert hard_block_reason("kids on a slide") == "minor"


def test_drop_flagged_resumes_auto():
    from infinite_tapestry.prompts import LiveDirector, make_scene
    d = LiveDirector("seed", hold=0, blend=4, loop=False)
    d.add_user([make_scene("bad idea", origin="user")])
    d.frame_for(0)
    assert d.state()["target"] == "bad idea"
    d.drop_flagged(1)
    assert d.state()["target"] is None


def test_momentum_brief_steps():
    from infinite_tapestry.autopilot import momentum_brief
    u = {"origin": "user", "title": "Feces Plains", "source": "feces land"}
    a = {"origin": "auto", "title": "x"}
    assert "SAME WORLD" in momentum_brief([a, u])
    assert "DRIFT" in momentum_brief([u, a, a])
    assert momentum_brief([u] + [a] * 5) == ""
    assert momentum_brief([a, a]) == ""
