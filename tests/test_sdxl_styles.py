import argparse

import numpy as np
from PIL import Image

from infinite_tapestry.canvas import harmonize_seam
from infinite_tapestry.config import config_from_args
from infinite_tapestry.main import build_parser
from infinite_tapestry.prompts import LiveDirector, make_scene
from infinite_tapestry.styles import normalize, ramp, with_trigger


def test_ramp_crossfades_lora_weights():
    assert ramp("pixel art", None, 0) == {"pixel art": 0.9}
    mid = ramp("pixel art", "watercolor", 0.5)
    assert 0.4 < mid["pixel art"] < 0.5 and 0.4 < mid["watercolor"] < 0.45
    assert ramp("pixel art", "watercolor", 1.0) == {"watercolor": 0.85}
    assert ramp("none", "ink", 0.7) == {}  # prompt-only styles carry no LoRA
    assert normalize("Pixel Art") == "pixel art" and normalize("bogus") == "none"
    assert with_trigger("a city", "watercolor").startswith("watercolor painting")


def test_harmonize_seam_removes_colour_step():
    a = np.zeros((64, 128, 3), np.uint8)
    a[:, :64] = (160, 90, 140)
    a[:, 64:] = (90, 150, 120)
    out = np.asarray(harmonize_seam(Image.fromarray(a), 64, 48)).astype(int)
    step_before = np.abs(a[:, 63].astype(int) - a[:, 64].astype(int)).sum()
    step_after = np.abs(out[:, 63] - out[:, 64]).sum()
    assert step_after < step_before * 0.1
    assert (out[:, 120] == a[:, 120]).all()  # far side untouched


def test_sdxl_preset_and_style_on_scenes():
    args = build_parser().parse_args(["--backend", "sdxl"])
    cfg = config_from_args(args)
    assert (cfg.height, cfg.strip_width, cfg.overlap, cfg.backend) == (1024, 256, 192, "sdxl")
    assert config_from_args(build_parser().parse_args(["--backend", "sdxl", "--steps", "12"])).steps == 12
    d = LiveDirector("a", queue=[])
    d.add([make_scene("b", style="pixel art", transition=12)])
    for i in range(30):
        d.frame_for(i)
    assert d.styles_for(1.0)[0] in ("pixel art", "none")


def test_default_negatives_discourage_vertical_strata():
    """Live failure mode is stacked horizons / strata, not vertical colour seams."""
    from infinite_tapestry.config import Config

    neg = Config().negative_prompt.lower()
    for term in (
        "multiple horizons",
        "stacked landscapes",
        "layered strata",
        "split levels",
        "horizontal bands",
        "panorama panels",
        "diptych",
    ):
        assert term in neg


def test_prefill_masked_is_not_black():
    from infinite_tapestry.inpaint import prefill_masked
    img = Image.new("RGB", (64, 32), (120, 60, 200))
    img.paste((0, 0, 0), (40, 0, 64, 32))
    mask = Image.new("L", (64, 32), 0)
    mask.paste(255, (40, 0, 64, 32))
    out = np.asarray(prefill_masked(img, mask)).astype(float)
    assert out[:, 40:].mean() > 90 and (out[:, :40] == np.asarray(img)[:, :40]).all()


def test_loras_only_on_explicit_user_request():
    from infinite_tapestry.styles import explicit_lora, ramp
    from infinite_tapestry.prompts import LiveDirector, make_scene
    assert explicit_lora("a pixel art castle") == "pixel art"
    assert explicit_lora("hyperrealistic pixel art castle") is None
    assert explicit_lora("misty forest") is None
    d = LiveDirector("seed")
    d.play_now(make_scene("x", origin="auto", style="watercolor"))
    d.frame_for(0)
    a, b = d.styles_for(0.5)
    assert ramp(a, b, 0.5) == {}
    d2 = LiveDirector("seed")
    d2.play_now(make_scene("x", origin="user", style="pixel", lora="pixel art"))
    d2.frame_for(0)
    assert "pixel art" in ramp(*d2.styles_for(0.5), 0.5)
    assert ramp("pixel art", "none", 1.0) == {}


def test_prefill_has_no_row_structure():
    """Regression for the overnight banding bug: beyond the short seam ramp, the masked fill must not copy
    per-row colours (stripes) across the strip."""
    from infinite_tapestry.inpaint import prefill_masked
    a = np.zeros((64, 300, 3), np.uint8)
    a[::2, :40] = 255                      # strongly striped context
    img = Image.fromarray(a)
    mask = Image.new("L", (300, 64), 0)
    mask.paste(255, (40, 0, 300, 64))
    for mode in ("ramp", "meannoise", "gray"):
        out = np.asarray(prefill_masked(img, mask, mode=mode, ramp_px=96)).astype(float)[:, 40 + 96:].mean(axis=(1, 2))
        assert np.abs(out[::2] - out[1::2]).mean() < 10, mode
    old = np.asarray(prefill_masked(img, mask, mode="rowmean")).astype(float)[:, 40 + 96:].mean(axis=(1, 2))
    assert np.abs(old[::2] - old[1::2]).mean() > 100   # the old fill really was striped
