"""Replay (GPU off) starts at a uniformly random spot across the whole history: static/replay.js."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _node(script: str):
    r = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_random_start_spans_history_with_runway_and_skips_lost_span():
    out = _node("""
      const { replayStart, RUNWAY, LOST } = require('./static/replay.js');
      const max = 115418, xs = [];
      for (let i = 0; i < 20000; i++) xs.push(replayStart(max));
      const ends = [0, 1 - 1e-12].map((u) => replayStart(max, () => u));
      console.log(JSON.stringify({ xs, ends, runway: RUNWAY, lost: LOST, small: [replayStart(10), replayStart(0)] }));
    """)
    xs, max_ = out["xs"], 115418
    hi = max_ - out["runway"]
    assert all(0 <= x <= hi for x in xs)
    for a, b in out["lost"]:
        assert not any(a - out["runway"] <= x <= b for x in xs)
    # Uniform over the whole range, not clustered near the end: every tenth of the history gets picked.
    deciles = {min(9, x * 10 // hi) for x in xs}
    assert deciles == set(range(10))
    assert min(xs) < hi * 0.02 and max(xs) > hi * 0.98
    assert out["ends"] == [0, hi]
    assert out["small"] == [5, 0]


def test_client_uses_random_start_for_boot_and_loop():
    client = (ROOT / "static/client.js").read_text()
    assert client.count("window.TapestryReplayStart(") == 2
    assert "90 + Math.floor(Math.random() * 120)" not in client
    html = (ROOT / "static/index.html").read_text()
    assert html.index('src="replay.js"') < html.index('src="client.js"')
