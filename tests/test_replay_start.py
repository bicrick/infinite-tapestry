"""Replay (GPU off) starts at a uniformly random spot across the whole history.

The distribution itself (uniform, runway, lost-span skip, small histories) is tested in
frontend/src/core/replay-start.test.ts (Vitest, run by `npm test`); these checks pin the wiring.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_replay_start_is_unit_tested():
    test = (ROOT / "frontend/src/core/replay-start.test.ts").read_text()
    assert "LOST" in test and "RUNWAY" in test and "decile" in test


def test_client_uses_random_start_for_boot_and_loop():
    app = (ROOT / "frontend/src/viewer/app.ts").read_text()
    assert app.count("window.TapestryReplayStart(") == 2
    assert "90 + Math.floor(Math.random() * 120)" not in app
    boot = (ROOT / "frontend/src/viewer/boot.ts").read_text()
    assert "window.TapestryReplayStart = replayStart;" in boot
    assert boot.index("window.TapestryReplayStart = replayStart;") < boot.index("startViewer();")
    main = (ROOT / "frontend/src/entries/main.ts").read_text()
    assert main.index('legacy/refl.js"') < main.index('viewer/boot"') < main.index('legacy/intro.js"') < main.index('chrome/offline-boot"')
