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
