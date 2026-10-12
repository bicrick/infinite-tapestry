"""New strips encode as WebP at ~half the JPEG q85 size."""

import io
import urllib.request

from PIL import Image

from infinite_tapestry.buffer import Strip, StripBuffer
from infinite_tapestry.config import Config
from infinite_tapestry.generator import StripGenerator
from infinite_tapestry.mock_inpaint import MockInpainter
from infinite_tapestry.store import HistoryStore, _strip_ext


def test_default_strip_format_is_webp():
    c = Config()
    assert c.strip_ext() == "webp" and c.strip_mime() == "image/webp"
    assert "strip_ext" in c.client_dict()


def _sample_strip() -> Image.Image:
    url = ("https://vforasrnktvqzukusejq.supabase.co/storage/v1/object/public/"
           "strips/live-sdxl/strips/00006500.jpg")
    try:
        data = urllib.request.urlopen(url, timeout=20).read()
        return Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        # Offline fallback: soft gradient (still favors WebP over JPEG).
        im = Image.new("RGB", (256, 512))
        px = im.load()
        for y in range(512):
            for x in range(256):
                px[x, y] = (x % 256, (y * 3) % 256, (x + y) % 256)
        return im


def test_webp_encode_about_half_of_jpeg():
    im = _sample_strip()
    c_jpg = Config(mock=True, height=im.height, window_width=512, strip_width=128, overlap=32,
                   buffer_target=2, buffer_min=1, strip_format="jpeg", jpeg_quality=85)
    c_web = Config(mock=True, height=im.height, window_width=512, strip_width=128, overlap=32,
                   buffer_target=2, buffer_min=1, strip_format="webp", webp_quality=65)
    jpg = StripGenerator(c_jpg, MockInpainter(c_jpg), StripBuffer(2, 1))._encode_jpeg(im)
    web = StripGenerator(c_web, MockInpainter(c_web), StripBuffer(2, 1))._encode_jpeg(im)
    assert _strip_ext(web) == "webp" and _strip_ext(jpg) == "jpg"
    # Live SDXL strips land near 50%; allow some headroom for offline gradient.
    assert len(web) < 0.70 * len(jpg)


def test_store_writes_webp_and_loads_legacy_jpg(tmp_path):
    import time
    store = HistoryStore(tmp_path)
    web = io.BytesIO()
    Image.new("RGB", (16, 32), (20, 40, 60)).save(web, "WEBP", quality=80)
    store.save_strip(Strip(index=0, width=16, height=32, overlap=4, jpeg=web.getvalue(),
                           prompt="x", created_at=time.time()))
    assert (tmp_path / "strips" / "00000000.webp").exists()
    assert store.load_strip(0) is not None
    jpg = io.BytesIO()
    Image.new("RGB", (16, 32), (1, 2, 3)).save(jpg, "JPEG", quality=85)
    (tmp_path / "strips" / "00000001.jpg").write_bytes(jpg.getvalue())
    assert store.load_strip(1) is not None
