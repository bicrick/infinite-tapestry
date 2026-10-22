"""Ownership labels: 'user' only means audience-submitted (not the viewer's); 'yours' comes from S.isMine alone."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = (ROOT / "frontend/src/styles/style.css").read_text()
SOCIAL = (ROOT / "frontend/src/legacy/social.js").read_text()


def test_no_css_badge_keyed_on_audience_origin():
    # .item.user marks every audience idea; a "you" badge on it labelled everyone's ideas as the viewer's.
    assert not re.search(r"\.item\.user[^{]*\{[^}]*content:\s*\"you\"", CSS)


def test_is_mine_needs_a_real_match():
    m = re.search(r"S\.isMine = \(row\) => (.*);", SOCIAL).group(1)
    assert "S.session && row.user_id && row.user_id === S.session.user.id" in m   # both ids present
    assert "mineIds().some((x) => x.id === row.id)" in m                          # ids this browser submitted
    assert "addMine = (id) => { if (!id || id < 0) return;" in SOCIAL               # never records an empty id
