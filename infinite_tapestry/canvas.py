"""Rolling horizontal canvas: crop context, stitch, and feather seams."""

from __future__ import annotations

import numpy as np
from PIL import Image


def make_seed_image(height: int, width: int, seed: int = 0) -> Image.Image:
    """Neutral, subject-free starter canvas (soft colored noise, no horizon).

    On GPU it's fully repainted with the first prompt; in mock mode it just
    gives the first strips something to continue from."""
    rng = np.random.default_rng(seed)
    yy, xx = np.meshgrid(
        np.linspace(0, 1, height, dtype=np.float32),
        np.linspace(0, 1, width, dtype=np.float32),
        indexing="ij",
    )
    hue = rng.uniform(0, 1, 3).astype(np.float32)
    base = 0.35 + 0.15 * np.sin(2 * np.pi * (xx[..., None] * (1 + hue) + yy[..., None] * hue + hue * 6))
    noise = rng.normal(0.0, 0.03, size=base.shape).astype(np.float32)
    arr = (np.clip(base + noise, 0.0, 1.0) * 255).astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")


def feather_weights(overlap: int) -> np.ndarray:
    """Smoothstep ramp from 0 (old) to 1 (new) across `overlap` pixels."""
    if overlap <= 0:
        return np.zeros((0,), dtype=np.float32)
    t = np.linspace(0.0, 1.0, overlap, dtype=np.float32)
    return t * t * (3 - 2 * t)


def blend_strip(
    canvas: Image.Image,
    strip: Image.Image,
    paste_x: int,
    overlap: int,
) -> Image.Image:
    """Paste `strip` at `paste_x`, crossfading `overlap` px into existing pixels.

    The strip is expected to already contain the new content (and optionally
    regenerated overlap region). Only the horizontal seam is feathered.
    """
    if strip.height != canvas.height:
        raise ValueError(
            f"strip height {strip.height} != canvas height {canvas.height}"
        )
    if paste_x < 0:
        raise ValueError("paste_x must be >= 0")

    out = canvas.copy()
    # Ensure canvas is wide enough.
    needed = paste_x + strip.width
    if out.width < needed:
        widened = Image.new("RGB", (needed, out.height))
        widened.paste(out, (0, 0))
        out = widened

    if overlap <= 0 or paste_x == 0:
        out.paste(strip, (paste_x, 0))
        return out

    overlap = min(overlap, strip.width, paste_x)
    canvas_arr = np.asarray(out).astype(np.float32)
    strip_arr = np.asarray(strip).astype(np.float32)

    # Region on canvas that overlaps the left edge of the new strip.
    left = paste_x
    right = paste_x + overlap
    old = canvas_arr[:, left:right, :]
    new = strip_arr[:, :overlap, :]
    w = feather_weights(overlap)[None, :, None]
    blended = old * (1.0 - w) + new * w
    canvas_arr[:, left:right, :] = blended

    # Non-overlapping remainder of the strip.
    if strip.width > overlap:
        canvas_arr[:, paste_x + overlap : paste_x + strip.width, :] = strip_arr[
            :, overlap:, :
        ]

    return Image.fromarray(np.clip(canvas_arr, 0, 255).astype(np.uint8), mode="RGB")


def build_inpaint_inputs(
    canvas: Image.Image,
    window_width: int,
    strip_width: int,
    height: int,
) -> tuple[Image.Image, Image.Image, int]:
    """Crop the rightmost context window and build an inpaint mask.

    Returns (image, mask, context_x) where context_x is the canvas x of the
    window's left edge. Mask is white (= inpaint) on the right `strip_width`
    columns and black (= keep) on the context.
    """
    if canvas.height != height:
        raise ValueError("canvas height mismatch")
    context_width = window_width - strip_width
    if context_width <= 0:
        raise ValueError("invalid window/strip geometry")

    if canvas.width < context_width:
        # Pad on the left with seed-like extension.
        pad = Image.new("RGB", (context_width, height), (120, 150, 180))
        pad.paste(canvas, (context_width - canvas.width, 0))
        canvas = pad

    context_x = canvas.width - context_width
    window = Image.new("RGB", (window_width, height), (0, 0, 0))
    context = canvas.crop((context_x, 0, canvas.width, height))
    window.paste(context, (0, 0))

    mask = Image.new("L", (window_width, height), 0)
    mask_arr = np.zeros((height, window_width), dtype=np.uint8)
    mask_arr[:, context_width:] = 255
    mask = Image.fromarray(mask_arr, mode="L")

    return window, mask, context_x


def extract_new_strip(
    generated: Image.Image,
    context_width: int,
    strip_width: int,
    overlap: int,
) -> Image.Image:
    """Take the newly painted region plus `overlap` px of regenerated context."""
    if generated.width < context_width + strip_width:
        raise ValueError("generated window is too narrow")
    start = max(0, context_width - overlap)
    end = context_width + strip_width
    return generated.crop((start, 0, end, generated.height))


def stitch_generated_window(
    canvas: Image.Image,
    generated: Image.Image,
    window_width: int,
    strip_width: int,
    overlap: int,
    crossfade: int | None = None,
) -> tuple[Image.Image, Image.Image, int]:
    """Blend the generated window into the canvas.

    crossfade: px of alpha fade at the overlap's left edge (default = overlap). 0 = pixel-exact
    paste: the generated window already blends into the old pixels itself (klein feather), and a
    second cross-fade over repainted pixels shows up as a ghosted double exposure.

    Returns (new_canvas, emitted_strip, paste_x) where emitted_strip is the
    portion clients should append (overlap + new strip), and paste_x is where
    that strip should be blended on the prior canvas.
    """
    context_width = window_width - strip_width
    strip = extract_new_strip(generated, context_width, strip_width, overlap)
    paste_x = canvas.width - overlap if canvas.width >= overlap else 0
    # If canvas is shorter than overlap (startup), paste at end.
    if canvas.width < overlap:
        paste_x = canvas.width
        # On pure append with no overlap region, use only the new strip pixels.
        strip = generated.crop(
            (context_width, 0, context_width + strip_width, generated.height)
        )
        new_canvas = Image.new("RGB", (canvas.width + strip.width, canvas.height))
        new_canvas.paste(canvas, (0, 0))
        new_canvas.paste(strip, (canvas.width, 0))
        return new_canvas, strip, canvas.width

    cf = overlap if crossfade is None else max(0, min(overlap, crossfade))
    if cf < overlap:
        new_canvas = canvas.copy()
        if cf > 0:
            new_canvas = blend_strip(new_canvas, strip.crop((0, 0, cf, strip.height)), paste_x, cf)
            new_canvas = blend_strip(new_canvas, strip.crop((cf, 0, strip.width, strip.height)), paste_x + cf, 0)
        else:
            new_canvas = blend_strip(new_canvas, strip, paste_x, 0)
    else:
        new_canvas = blend_strip(canvas, strip, paste_x, overlap)
    # Emit the *blended* pixels so viewers (which draw strips opaquely over
    # the previous one) see the same feathered seam as the server canvas.
    emitted = new_canvas.crop((paste_x, 0, paste_x + strip.width, new_canvas.height))
    return new_canvas, emitted, paste_x


def histogram_match_strip(
    strip: Image.Image,
    reference: Image.Image,
) -> Image.Image:
    """Match strip color distribution to a reference (usually left context).

    Cheap consistency trick from the research notes; optional post-process.
    """
    s = np.asarray(strip).astype(np.float32)
    r = np.asarray(reference).astype(np.float32)
    out = s.copy()
    for c in range(3):
        s_mean, s_std = s[:, :, c].mean(), s[:, :, c].std() + 1e-6
        r_mean, r_std = r[:, :, c].mean(), r[:, :, c].std() + 1e-6
        out[:, :, c] = (s[:, :, c] - s_mean) * (r_std / s_std) + r_mean
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), mode="RGB")


def correct_drift(
    generated: Image.Image, window: Image.Image, context_width: int
) -> Image.Image:
    """Undo the color shift the model/VAE round-trip applied to the context.

    Per-channel affine transform fitted between the regenerated context
    (generated[:, :context_width]) and the original context, applied to the
    whole generated window. Prevents strip-over-strip drift.
    """
    g = np.asarray(generated.convert("RGB")).astype(np.float32)
    w = np.asarray(window.convert("RGB")).astype(np.float32)
    gc = g[:, :context_width]
    wc = w[:, :context_width]
    out = g.copy()
    for c in range(3):
        gs = gc[:, :, c].std() + 1e-6
        ws = wc[:, :, c].std()
        scale = float(np.clip(ws / gs, 0.7, 1.3))
        out[:, :, c] = (g[:, :, c] - gc[:, :, c].mean()) * scale + wc[:, :, c].mean()
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), mode="RGB")


def harmonize_seam(generated: Image.Image, x0: int, fade: int, probe: int = 6, sigma_rows: float = 24.0) -> Image.Image:
    """Remove colour *steps* at the mask edge x0 (the 'hard vertical colour-block' seam).

    Measures, per row, the colour jump between the columns just left and right of x0 (smoothed
    vertically so detail is untouched), and adds the opposite offset to the new region, fading
    to zero over `fade` px. Edges that exist in the content (texture) survive because only the
    low-frequency difference is corrected and the correction is capped.
    """
    g = np.asarray(generated.convert("RGB")).astype(np.float32)
    h, w, _ = g.shape
    if x0 - probe < 0 or x0 + probe >= w:
        return generated
    left = g[:, x0 - probe:x0].mean(axis=1)
    right = g[:, x0:x0 + probe].mean(axis=1)
    d = left - right                                   # (h, 3)
    k = int(sigma_rows * 3)
    ys = np.arange(-k, k + 1, dtype=np.float32)
    ker = np.exp(-0.5 * (ys / sigma_rows) ** 2); ker /= ker.sum()
    pad = np.pad(d, ((k, k), (0, 0)), mode="edge")
    d = np.stack([np.convolve(pad[:, c], ker, mode="valid") for c in range(3)], axis=1)
    d = np.clip(d, -90, 90)
    n = min(fade, w - x0)
    xs = np.arange(n, dtype=np.float32) / max(1, n)
    wgt = 0.5 * (1 + np.cos(np.pi * xs))              # 1 → 0, smooth
    out = g.copy()
    out[:, x0:x0 + n] += d[:, None, :] * wgt[None, :, None]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), mode="RGB")
