import io

from PIL import Image

from infinite_tapestry.buffer import Strip
from infinite_tapestry.prompts import LiveDirector as Director, make_scene
from infinite_tapestry.server import _title_from_prompt
from infinite_tapestry.store import HistoryStore


def _jpeg():
    b = io.BytesIO(); Image.new("RGB", (8, 8)).save(b, "JPEG"); return b.getvalue()


def test_scene_roundtrip_in_store(tmp_path):
    st = HistoryStore(tmp_path)
    st.save_strip(Strip(index=0, width=8, height=8, overlap=0, jpeg=_jpeg(), prompt="p",
                        scene={"title": "Glass Reef", "by": "@lumen", "style": "watercolor", "origin": "user"}))
    assert st.load_meta()[0]["scene"]["by"] == "@lumen"
    assert st.load_strip(0, st.load_meta()[0]).scene["title"] == "Glass Reef"


def test_director_caption_switches_halfway():
    d = Director("seed prompt")
    d.add_user([make_scene("a reef", title="Reef", transition=10, hold=1)])
    seen = []
    for i in range(30):
        d.frame_for(i)
        seen.append(d.caption().get("title"))
    assert "Reef" in seen and seen[0] != "Reef"


def test_title_from_prompt():
    assert _title_from_prompt("endless dunes of powdered glass, sky") == "Endless Dunes of Powdered Glass"
