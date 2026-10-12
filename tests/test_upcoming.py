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
