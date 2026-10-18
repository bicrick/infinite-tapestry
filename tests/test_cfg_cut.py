"""CFG truncation: after round(cut*steps) steps the pipeline runs the cond branch only."""
import numpy as np
import pytest

from infinite_tapestry.inpaint import CFG_BATCHED, cfg_cut_callback, ip_embeds_match_batch
from infinite_tapestry.server import apply_render_settings


class T:
    """Minimal tensor stand-in (shape + chunk + slicing on dim 0)."""
    def __init__(self, a):
        self.a = np.asarray(a); self.shape = self.a.shape

    def chunk(self, n):
        return [T(x) for x in np.split(self.a, n)]

    def __getitem__(self, s):
        return T(self.a[s])


class Pipe:
    _num_timesteps = 10
    _guidance_scale = 6.5


def kw():
    return {k: T(np.stack([np.zeros(3), np.ones(3)])) for k in CFG_BATCHED}


def test_switches_off_at_the_cut_and_keeps_cond_half():
    p, cb = Pipe(), cfg_cut_callback(0.6)
    for i in range(5):
        assert cb(p, i, 0, kw()) == {} and p._guidance_scale == 6.5
    out = cb(p, 5, 0, kw())
    assert p._guidance_scale == 0.0 and set(out) == set(CFG_BATCHED)
    assert all(v.shape[0] == 1 and v.a.min() == 1 for v in out.values())   # the cond half
    assert cb(p, 6, 0, kw()) == {}                                          # only once


@pytest.mark.parametrize("cut", [1.0, 0.99])
def test_no_cut_when_it_rounds_to_the_end(cut):
    p = Pipe(); cb = cfg_cut_callback(cut)
    assert all(cb(p, i, 0, kw()) == {} for i in range(10)) and p._guidance_scale == 6.5


def test_ip_embeds_follow_the_batch():
    emb = [T(np.stack([np.zeros(4), np.ones(4)]))]
    args, kwargs = (T(np.zeros((1, 9))),), {"added_cond_kwargs": {"image_embeds": emb, "time_ids": 1}}
    a, k = ip_embeds_match_batch(None, args, kwargs)
    assert k["added_cond_kwargs"]["image_embeds"][0].shape[0] == 1 and k["added_cond_kwargs"]["image_embeds"][0].a.min() == 1
    assert ip_embeds_match_batch(None, (T(np.zeros((2, 9))),), {"added_cond_kwargs": {"image_embeds": emb}}) is None


def test_render_settings_take_cfg_cut():
    class D:
        widths = {}
        def set_widths(self, **k): pass

    class C:
        backend, overlap, anchor_seam_px, anchor_bridge_strength, steps, guidance_scale, cfg_cut = "sdxl", 192, 192, 0.85, 26, 6.5, 1.0

    class G:
        director, config = D(), C()
    g = G()
    assert apply_render_settings({"cfg_cut": 0.6, "steps": 22}, g)["cfg_cut"] == 0.6 and g.config.steps == 22
    apply_render_settings({"cfg_cut": 0.1}, g)
    assert g.config.cfg_cut == 0.3   # clamped
