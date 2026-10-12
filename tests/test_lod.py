import io

from PIL import Image

from infinite_tapestry.buffer import Strip
from infinite_tapestry.lod import LodBuilder
from infinite_tapestry.store import HistoryStore


def _jpeg(color, w=40, h=32):
    b = io.BytesIO(); Image.new("RGB", (w, h), color).save(b, "JPEG"); return b.getvalue()


def test_lod_levels_build_and_cache(tmp_path):
    st = HistoryStore(tmp_path)
    st.lod = LodBuilder(st, strip_width=32, height=32)
    for i in range(64):
        st.save_strip(Strip(index=i, width=40, height=32, overlap=8 if i else 0,
                            jpeg=_jpeg((i * 4, 100, 200)), prompt="p", created_at=1000.0 + i))
    st.lod._pool.shutdown(wait=True)
    l1 = Image.open(io.BytesIO(st.lod.get(1, 0)))
    assert l1.size == (16 * 32 // 4, 32 // 4)
    l2 = Image.open(io.BytesIO(st.lod.get(2, 0)))
    assert l2.size == (64 * 32 // 16, 2)
    assert st.lod.path(1, 3).exists() and st.lod.path(2, 0).exists()
