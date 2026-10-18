import asyncio
import random

from infinite_tapestry import looks
from infinite_tapestry.autopilot import Autopilot
from infinite_tapestry.config import Config
from infinite_tapestry.prompts import LiveDirector
from infinite_tapestry.variety import LOOKS, spark


def test_is_photo_labels():
    for s in ("cinematic photo", "film noir photograph", "documentary photo, natur", "glossy 1920s magazine ph"):
        assert looks.is_photo(s), s
    for s in ("watercolor", "soft pastel oil painting", "japanese woodblock print", "art deco poster", "fractal art", "none", ""):
        assert not looks.is_photo(s), s


def test_quota_pattern_is_two_photo_one_free():
    h = []
    for _ in range(30):
        h.append("photo" if looks.photo_needed(h) else "watercolor")
    share = sum(looks.is_photo(x) for x in h) / len(h)
    assert 0.6 <= share <= 0.7
    assert all(not (not looks.is_photo(a) and not looks.is_photo(b)) for a, b in zip(h, h[1:]))  # never 2 stylized in a row


def test_force_photo_rewrites_stylized_lead():
    sc = looks.finalize({"prompt": "watercolor, a heron in reeds", "style": "watercolor", "negative": ""}, True)
    assert looks.is_photo(sc["style"]) and "watercolor" not in sc["prompt"] and "heron" in sc["prompt"]
    assert "painting" in sc["negative"]
    free = looks.finalize({"prompt": "linocut print, a heron", "style": "linocut print", "negative": ""}, False)
    assert free["style"] == "linocut print" and free["negative"] == ""


def test_spark_looks_and_seed_prompt():
    assert all(not looks.is_photo(x) for x in LOOKS)
    assert looks.is_photo(spark(random.Random(3), photo=True)["look"])
    assert not looks.is_photo(spark(random.Random(3), photo=False)["look"])
    assert "painting" not in Config().prompts[0][1] and "photograph" in Config().prompts[0][1]


class StylizedAuto:
    enabled = True
    tokens_used = 0

    def __init__(self):
        self.briefs = []

    def autoplan(self, recent, vibe="", count=2, brief="", keep_style=""):
        self.briefs.append(brief)
        return {"scenes": [{"title": "Heron Reeds", "prompt": "watercolor, a heron in reeds", "style": "watercolor"},
                           {"title": "Wet Fjord", "prompt": "watercolor, a fjord in rain", "style": "watercolor"}]}


def test_autopilot_enforces_photo_slots_and_never_loads_lora():
    d = LiveDirector("seed", hold=0, blend=2)
    fi = StylizedAuto()
    ap = Autopilot(d, fi, min_interval=0)
    asyncio.run(ap.tick())
    items = d.state()["items"]
    assert "LOOK PLAN" in fi.briefs[-1]
    assert looks.is_photo(items[0]["style"])          # first slot required photo (no Auto history yet)
    assert all(i.get("lora") is None for i in items)  # 'watercolor' in an Auto prompt never loads the LoRA
