import io

from PIL import Image

from infinite_tapestry import lodx


def _img(w, h, color, fmt="JPEG"):
    b = io.BytesIO()
    Image.new("RGB", (w, h), color).save(b, fmt)
    return b.getvalue()


def _open(b):
    return Image.open(io.BytesIO(b)).convert("RGB")


def test_levels_and_keys():
    assert [lodx.STRIPS[k] for k in lodx.LEVELS] == [64, 256, 1024, 4096, 16384, 65536, 262144]
    assert lodx.key(4, 7) == "lodx/4/000007.webp"
    assert lodx.ov_key(114688) == "lodx/ov/00114688.webp"
    # the viewer's completeness rule: chunk c exists once (c+1)*N <= max_index
    assert lodx.complete_chunks(2, 127) == 1 and lodx.complete_chunks(2, 128) == 2
    assert lodx.complete_chunks(7, 115418) == 1 and lodx.complete_chunks(8, 115418) == 0


def test_combine_from_l1_and_macro_children():
    l1 = [_img(1024, 256, (200, 0, 0)), _img(1024, 256, (0, 200, 0)), None, _img(1024, 256, (0, 0, 200))]
    t = _open(lodx.combine(l1))
    assert t.size == (lodx.TILE_W, lodx.TILE_H)
    r, g, b = t.getpixel((128, 64)), t.getpixel((384, 64)), t.getpixel((900, 64))
    assert r[0] > 150 and g[1] > 150 and b[2] > 150
    assert max(t.getpixel((640, 64))) < 40   # the missing child stays dark fill, not garbage
    up = _open(lodx.combine([lodx.combine(l1)] * 4))
    assert up.size == (1024, 128)
    assert lodx.combine([None] * 4) is None


def test_overview_and_l1_from_strips():
    x5 = {0: lodx.encode(Image.new("RGB", (1024, 128), (250, 250, 0))), 1: None}
    ov = _open(lodx.overview(2 * lodx.OV_STEP, x5.get))
    assert ov.size == (lodx.OV_W, lodx.TILE_H)
    assert ov.getpixel((100, 60))[0] > 200 and max(ov.getpixel((1900, 60))) < 40
    strips = [_img(448, 1024, (i * 15, 100, 100)) for i in range(16)]
    t = _open(lodx.l1_from_strips(strips, 256, 1024))
    assert t.size == (1024, 256)


class _Mirror:
    def __init__(self, objs):
        self.objs, self.puts = dict(objs), []

    def get(self, path):
        return self.objs.get(path)

    def put(self, path, data, ctype, after=None):
        self.puts.append((path, ctype))
        self.objs[path] = data


class _Store:
    def __init__(self, d, objs):
        self.dir, self.mirror = str(d), _Mirror(objs)

    def load_meta(self):
        return {}

    def load_strip(self, i, meta=None):
        return None


def test_pod_builds_macro_tiles_when_their_chunk_completes(tmp_path):
    from infinite_tapestry.lod import LodBuilder
    l1 = {f"public:lod/1/{c:06d}.jpg": _img(1024, 256, (40 * c, 90, 160)) for c in range(4)}
    st = _Store(tmp_path, l1)
    b = LodBuilder(st, 256, 1024)
    b.on_strip(62)   # chunk 0 of X2 not complete yet
    b.on_strip(63)
    b._pool.shutdown(wait=True)
    assert ("public:lodx/2/000000.webp", "image/webp") in st.mirror.puts
    t = _open(st.mirror.objs["public:lodx/2/000000.webp"])
    assert t.size == (lodx.TILE_W, lodx.TILE_H)
    assert (tmp_path / "lodx/2/000000.webp").exists()


def test_pod_never_rebuilds_an_existing_macro_tile_and_builds_the_overview(tmp_path):
    from infinite_tapestry.lod import LodBuilder
    x5 = _img(1024, 128, (0, 120, 0), "WEBP")
    st = _Store(tmp_path, {"public:lodx/5/000000.webp": x5, "public:lodx/2/000000.webp": x5})
    b = LodBuilder(st, 256, 1024)
    assert b.get_x(2, 0, build=True) == x5 and not st.mirror.puts   # already on the CDN: cached, not re-uploaded
    ov = b.overview(lodx.OV_STEP)
    assert ov and st.mirror.puts == [("public:lodx/ov/00004096.webp", "image/webp")]
    assert _open(ov).size == (lodx.OV_W, lodx.TILE_H)
    assert b.overview(lodx.OV_STEP) == ov and len(st.mirror.puts) == 1


def test_blended_l1_paints_the_next_chunks_overlap():
    # 448 x 1024 strips: 192 px inpainted overlap + 256 px slot. The 17th strip covers the 16th slot's right 192 px,
    # exactly as the zoom-1 renderer overdraws it, so the tile edge carries the blend instead of a hard cut.
    strips = [_img(448, 1024, (200, 0, 0))] * 16 + [_img(448, 1024, (0, 0, 200))]
    raw = _open(lodx.l1_from_strips(strips[:16], 256, 1024, n=16))
    blend = _open(lodx.l1_from_strips(strips, 256, 1024, n=16))
    assert raw.size == blend.size == (1024, 256)
    assert raw.getpixel((1020, 128))[0] > 150                      # original: own strip to the edge
    r, g, b = blend.getpixel((1020, 128)); assert b > 150 and r < 60    # blended: next strip's overlap
    assert blend.getpixel((1024 - 44, 128))[0] < 60 and blend.getpixel((1024 - 54, 128))[0] > 150  # 192/4 = 48 px
    assert blend.getpixel((500, 128)) == raw.getpixel((500, 128))   # interior unchanged
    assert lodx.live_key(1, 7) == "lodb/1/000007.jpg" and lodx.key(5, 3, lodx.BLEND_X) == "lodxb/5/000003.webp"
    assert lodx.ov_key(4096, lodx.BLEND_X) == "lodxb/ov/00004096.webp"


def test_live_up_builds_l2_from_four_children():
    kids = [_img(1024, 256, c) for c in ((200, 0, 0), (0, 200, 0), (0, 0, 200))] + [None]
    t = _open(lodx.live_up(kids, 1024, 64))
    assert t.size == (1024, 64)
    assert t.getpixel((128, 32))[0] > 150 and t.getpixel((384, 32))[1] > 150 and t.getpixel((640, 32))[2] > 150
    assert max(t.getpixel((900, 32))) < 30   # missing child stays dark, as the pod builder does
    assert lodx.live_up([None] * 4, 1024, 64) is None
