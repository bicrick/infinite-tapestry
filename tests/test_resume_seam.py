"""Restart resumes from the right edge of the published strips (no seam)."""
import io
import json

from PIL import Image

from infinite_tapestry.buffer import Strip
from infinite_tapestry.generator import rebuild_canvas
from infinite_tapestry.store import HistoryStore


def _strip(i, color, w=320, ov=64):
    b = io.BytesIO(); Image.new("RGB", (w, 32), color).save(b, "PNG")
    return Strip(index=i, width=w, height=32, overlap=ov, jpeg=b.getvalue(), prompt="p")


def test_rebuild_canvas_ends_with_last_published_strip():
    c = rebuild_canvas([_strip(1, (255, 0, 0)), _strip(2, (0, 255, 0)), _strip(3, (0, 0, 255))], 64)
    assert c.width == 320 + 256 * 2
    assert c.getpixel((c.width - 1, 0)) == (0, 0, 255)
    assert c.getpixel((c.width - 320, 0)) == (0, 0, 255)   # overlap repainted by the newest strip
    assert c.getpixel((c.width - 321, 0)) == (0, 255, 0)


def test_local_cache_preferred_when_newer_than_mirror(tmp_path):
    class M:
        def load_state_row(self): return {"strip_index": 10}
        def get(self, p): return None
    s = HistoryStore(str(tmp_path), M())
    (tmp_path / "state.json").write_text(json.dumps({"strip_index": 14}))
    Image.new("RGB", (8, 8)).save(tmp_path / "canvas.png")
    state, canvas = s.load_state()
    assert state["strip_index"] == 14 and canvas is not None
