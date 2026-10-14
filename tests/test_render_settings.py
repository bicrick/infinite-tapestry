"""Random scene widths + admin live render settings (auto_config.render)."""
from types import SimpleNamespace

from infinite_tapestry.config import Config
from infinite_tapestry.prompts import LiveDirector, make_scene
from infinite_tapestry.server import apply_render_settings


def test_widths_random_within_range_and_stable_per_scene():
    d = LiveDirector("seed")
    seen = set()
    for i in range(60):
        sc = make_scene(f"scene {i}", origin="auto")
        w = d._width(sc)
        assert 3 <= w <= 9 and d._width(sc) == w   # stable for the same scene
        seen.add(w)
    assert len(seen) >= 4                            # organic variation, not one fixed width
    for i in range(30):
        assert 5 <= d._width(make_scene(f"idea {i}", origin="user")) <= 7


def test_hold_is_width_minus_transition():
    d = LiveDirector("seed")
    sc = make_scene("x", origin="user", transition=1)
    assert d._hold_len(sc) == d._width(sc) - 1


def test_live_settings_apply_and_clamp():
    d = LiveDirector("seed")
    g = SimpleNamespace(director=d, config=Config())
    out = apply_render_settings({"auto_min": 12, "auto_max": 4, "user_min": 1, "user_max": 99,
                                 "seam_px": 999, "bridge_strength": 0.6}, g)
    assert d.widths["auto"] == (4, 12) and d.widths["user"] == (3, 30)
    assert out["seam_px"] == g.config.overlap and g.config.anchor_bridge_strength == 0.6
    sc = make_scene("y", origin="auto")
    assert 4 <= d._width(sc) <= 12
    apply_render_settings({"auto_min": 3, "auto_max": 3}, g)
    assert d._width(sc) == 3                          # range change re-rolls the scene's width


def test_bad_settings_ignored():
    d = LiveDirector("seed")
    g = SimpleNamespace(director=d, config=Config())
    before = dict(d.widths)
    apply_render_settings({"auto_min": "x", "seam_px": None}, g)
    assert d.widths == before
