"""Replay (GPU offline): the composer is swapped for a non-interactive status pill, driven by the replay state."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "frontend/index.html").read_text()
JS = (ROOT / "frontend/src/viewer/app.ts").read_text()
CSS = (ROOT / "frontend/src/styles/style.css").read_text()


def test_pill_markup_is_a_status_not_a_control():
    m = re.search(r'<div id="offline-pill"[^>]*>.*?</div>', HTML)
    assert m, "offline pill missing"
    pill = m.group(0)
    assert 'role="status"' in pill and 'aria-live="polite"' in pill
    assert not re.search(r"<(input|textarea|button|a)\b", pill) and "tabindex" not in pill
    assert 'class="dot"' not in pill and "offline-dot" not in CSS   # text only, nothing animated
    assert HTML.index('id="cmd"') < HTML.index('id="offline-pill"')


def test_offline_follows_the_replay_state_and_blocks_submits():
    assert "setOffline(!connected && (replay || podDown));" in JS
    body = JS[JS.index("function setOffline(on: boolean)"):JS.index("function setAway(on: boolean)")]
    assert '$("cmd").inert = on' in body and ".drawer-foot input, .drawer-foot button" in body
    submit = JS[JS.index('$("cmd").addEventListener("submit"'):]
    assert submit.index("if (offline) return;") < submit.index("S.submitIdea(") < submit.index('send({ type: "intent"')


def test_css_swaps_composer_for_pill():
    assert re.search(r"body\.gpu-off \.dock \.cmd \{[^}]*visibility: hidden", CSS)
    assert re.search(r"body\.gpu-off \.dock \.offline-pill \{[^}]*opacity: 1", CSS)
    assert re.search(r"\.dock \.offline-pill \{[^}]*pointer-events: none", CSS)


def test_body_class_does_not_collide_with_existing_styles():
    # body.offline once matched the full-screen ".offline" splash rule and hid the whole page.
    assert 'classList.toggle("gpu-off", on)' in JS
    assert not re.search(r"(^|[\s,}])\.gpu-off\b", CSS), "a bare .gpu-off rule would style <body> itself"
