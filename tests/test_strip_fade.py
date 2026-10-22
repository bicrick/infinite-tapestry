"""Load-in: strips crossfade over the LOD underlay only, never over the bare background (pale bands / gaps).

lodCovers itself is unit-tested in frontend/src/viewer/lod.test.ts (Vitest); these checks pin how the renderer
uses it.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "frontend/src/viewer/renderer.ts").read_text()
MOTION = (ROOT / "frontend/src/viewer/motion.ts").read_text()
APP = (ROOT / "frontend/src/viewer/app.ts").read_text()


def test_lod_covers_is_unit_tested():
    test = (ROOT / "frontend/src/viewer/lod.test.ts").read_text()
    assert "lodCovers(" in test and "hole" in test


def test_underlay_stays_on_while_fading_and_fade_is_gated_on_it():
    assert "this.coverage < 1 || this.fading > 0)" in JS
    assert "this.fading = fading;" in JS
    loop = JS[JS.index("if (!e.bitmap) continue;"):JS.index("this.coverage = want ? have / want : 0;")]
    assert loop.count("this.lodCovers(i * SW - e.overlap, (i + 1) * SW)") == 2
    assert loop.index("lodCovers") < loop.index("ctx.globalAlpha = fa")


def test_every_lod_draw_records_its_span():
    chunk = JS[JS.index("private drawLodChunk("):JS.index("private drawLod(")]
    assert chunk.count("ctx.drawImage(") == chunk.count("this.lodSpans.push(") == 2


def test_jumps_prefetch_the_underlay():
    # seek, flight + coast (prefetchLanding), replay start (load + loop)
    assert "this.d.lod.prefetch((target + vw / 2) / SW)" in MOTION
    assert MOTION.count("this.prefetchLanding(") == 2 and "this.d.lod.prefetch(land)" in MOTION
    assert APP.count("lod.prefetch(start)") == 2
