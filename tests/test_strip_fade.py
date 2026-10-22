"""Load-in: strips crossfade over the LOD underlay only, never over the bare background (pale bands / gaps)."""
import json
import re
import subprocess
from pathlib import Path

JS = (Path(__file__).resolve().parents[1] / "static/client.js").read_text()


def _lod_covers(spans, x0, x1):
    src = re.search(r"function lodCovers\(x0, x1\) \{.*?\n  \}", JS, re.S).group(0)
    prog = f"const lodSpans = {json.dumps(spans)};\n{src}\nprocess.stdout.write(String(lodCovers({x0}, {x1})));"
    return subprocess.run(["node", "-e", prog], capture_output=True, text=True, check=True).stdout == "true"


def test_lod_covers_needs_contiguous_spans():
    assert _lod_covers([[0, 100], [100, 200]], 10, 190)
    assert not _lod_covers([[0, 100], [120, 200]], 10, 190)    # hole
    assert not _lod_covers([[50, 200]], 10, 190)               # starts too late
    assert not _lod_covers([], 0, 10)


def test_underlay_stays_on_while_fading_and_fade_is_gated_on_it():
    assert "coverage < 1 || draw.fading > 0)" in JS
    assert "draw.fading = fading;" in JS
    loop = JS[JS.index("if (!e.bitmap) continue;"):JS.index("coverage = want ? have / want : 0;")]
    assert loop.count("lodCovers(i * SW() - e.overlap, (i + 1) * SW())") == 2
    assert loop.index("lodCovers") < loop.index("ctx.globalAlpha = fa")


def test_every_lod_draw_records_its_span():
    chunk = JS[JS.index("function drawLodChunk("):JS.index("let thumbCv")]
    assert chunk.count("ctx.drawImage(") == chunk.count("lodSpans.push(") == 2


def test_jumps_prefetch_the_underlay():
    assert JS.count("prefetchLod(") >= 6   # definition + seek, flight, coast, replay start (load + loop)
