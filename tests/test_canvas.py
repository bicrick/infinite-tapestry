"""Tests for panorama stitching and feather blending."""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from infinite_tapestry.canvas import (
    blend_strip,
    build_inpaint_inputs,
    extract_new_strip,
    feather_weights,
    histogram_match_strip,
    make_seed_image,
    stitch_generated_window,
)


def test_feather_weights_ramp():
    w = feather_weights(4)
    assert len(w) == 4
    assert w[0] == pytest.approx(0.0)
    assert w[-1] == pytest.approx(1.0)
    assert list(w) == sorted(w)


def test_feather_weights_empty():
    assert len(feather_weights(0)) == 0


def test_make_seed_image_shape():
    img = make_seed_image(64, 128, seed=1)
    assert img.size == (128, 64)
    assert img.mode == "RGB"


def test_blend_strip_extends_and_feathers():
    canvas = Image.new("RGB", (100, 40), (0, 0, 0))
    strip = Image.new("RGB", (50, 40), (255, 255, 255))
    out = blend_strip(canvas, strip, paste_x=80, overlap=20)
    assert out.width == 130
    arr = np.asarray(out)
    # Far left unchanged.
    assert arr[0, 0, 0] == 0
    # Far right of new strip is white.
    assert arr[0, -1, 0] == 255
    # Mid-overlap should be neither pure black nor pure white.
    mid = arr[20, 90, 0]
    assert 0 < mid < 255


def test_build_inpaint_inputs_mask():
    canvas = make_seed_image(32, 200, seed=0)
    window, mask, context_x = build_inpaint_inputs(
        canvas, window_width=64, strip_width=16, height=32
    )
    assert window.size == (64, 32)
    assert mask.size == (64, 32)
    assert context_x == 200 - 48
    m = np.asarray(mask)
    assert (m[:, :48] == 0).all()
    assert (m[:, 48:] == 255).all()


def test_extract_new_strip_includes_overlap():
    gen = Image.new("RGB", (64, 32), (10, 20, 30))
    strip = extract_new_strip(gen, context_width=48, strip_width=16, overlap=8)
    assert strip.size == (24, 32)  # 8 overlap + 16 new


def test_stitch_generated_window_grows_canvas():
    canvas = make_seed_image(32, 48, seed=2)
    # Fake a generated window: left context copy + bright new strip.
    window = Image.new("RGB", (64, 32), (0, 0, 0))
    window.paste(canvas, (0, 0))
    new_part = Image.new("RGB", (16, 32), (200, 50, 50))
    window.paste(new_part, (48, 0))

    new_canvas, emitted, paste_x = stitch_generated_window(
        canvas, window, window_width=64, strip_width=16, overlap=8
    )
    assert emitted.width == 24
    assert paste_x == 40  # 48 - 8
    assert new_canvas.width == 64  # 48 - 8 + 24


def test_histogram_match_changes_means():
    ref = Image.new("RGB", (20, 20), (50, 60, 70))
    strip = Image.new("RGB", (20, 20), (200, 10, 10))
    matched = histogram_match_strip(strip, ref)
    m = np.asarray(matched).mean(axis=(0, 1))
    r = np.asarray(ref).mean(axis=(0, 1))
    assert abs(m[0] - r[0]) < 5


def test_seam_score_flags_hard_vertical_cut():
    import numpy as np
    from PIL import Image
    from infinite_tapestry.generator import seam_score

    rng = np.random.default_rng(0)
    base = np.clip(rng.normal(120, 6, (64, 128, 3)), 0, 255).astype(np.uint8)
    smooth = Image.fromarray(base)
    cut = base.copy()
    cut[:, 70:] = np.clip(cut[:, 70:].astype(int) + 90, 0, 255).astype(np.uint8)
    assert seam_score(smooth, 0, 128) < 6 < seam_score(Image.fromarray(cut), 0, 128)


def test_seam_score_tolerates_interrupted_vertical_edges():
    import numpy as np
    from PIL import Image
    from infinite_tapestry.generator import seam_score

    rng = np.random.default_rng(1)
    img = np.clip(rng.normal(110, 6, (64, 128, 3)), 0, 255).astype(np.uint8)
    # A pillar: strong vertical edges, but crossed by a shelf/floor band.
    ramp = np.array([140, 180, 220], dtype=np.uint8)
    img[:, 57:60] = ramp[None, :, None]
    img[:, 60:70] = 220
    img[:, 70:73] = ramp[::-1][None, :, None]  # anti-aliased like a VAE decode
    assert seam_score(Image.fromarray(img), 0, 128) < 6
