import asyncio
import collections
import random

from infinite_tapestry import looks
from infinite_tapestry.autopilot import Autopilot
from infinite_tapestry.config import Config
from infinite_tapestry.prompts import LiveDirector
from infinite_tapestry.variety import LOOKS, spark


def test_family_classifier():
    cases = {"watercolor": "painting", "soft pastel oil painting": "painting", "film noir photograph": "film",
             "documentary photo, natur": "photo", "glossy 1920s magazine ph": "photo", "japanese woodblock print": "print",
             "cross-stitch embroidery": "craft", "lego brick diorama, medi": "craft", "pixel art": "digital",
             "chrome 3D render": "3d", "comic book ink": "illustration", "none": "", "": ""}
    for label, fam in cases.items():
        assert looks.family(label) == fam, label


def test_no_family_dominates_or_repeats():
    h, r = [], random.Random(7)
    for _ in range(400):
        h.append(looks.FAMILIES[looks.plan(h, 1, r)[0]][0])
    fams = [looks.family(x) for x in h]
    c = collections.Counter(fams)
    assert len(c) == len(looks.FAMILIES)
    assert max(c.values()) / len(fams) < 0.2          # 8 families, none dominates
    assert all(a != b for a, b in zip(fams, fams[1:]))  # never the same family back to back
    for i in range(len(fams) - 6):
        assert max(collections.Counter(fams[i:i + 6]).values()) <= 2


def test_story_look_capped_at_three_in_a_row():
    assert looks.story_may_continue(["watercolor", "watercolor"], "watercolor")
    assert not looks.story_may_continue(["watercolor"] * 3, "watercolor")


def test_enforce_swaps_blocked_family():
    recent = ["watercolor", "oil painting", "gouache"]
    sc = looks.enforce({"prompt": "watercolor, a heron in reeds", "style": "watercolor"}, "craft", recent, random.Random(1))
    assert looks.family(sc["style"]) == "craft" and "watercolor" not in sc["prompt"] and "heron" in sc["prompt"]
    ok = looks.enforce({"prompt": "linocut print, a heron", "style": "linocut print"}, "print", recent)
    assert ok["style"] == "linocut print"


def test_pool_balanced_and_neutral_seed():
    c = collections.Counter(looks.family(x) for x in LOOKS)
    assert set(c) == set(looks.FAMILIES) and max(c.values()) <= 2 * min(c.values())
    assert looks.family(spark(random.Random(3), family="craft")["look"]) == "craft"
    seed = Config().prompts[0][1]
    assert looks.family(seed) == "" or looks.family(seed) == "other"


class PaintAuto:
    enabled = True
    tokens_used = 0

    def __init__(self):
        self.briefs = []

    def autoplan(self, recent, vibe="", count=2, brief="", keep_style=""):
        self.briefs.append(brief)
        return {"scenes": [{"title": "Heron Reeds", "prompt": "watercolor, a heron in reeds", "style": "watercolor"},
                           {"title": "Wet Fjord", "prompt": "watercolor, a fjord in rain", "style": "watercolor"}]}


def test_autopilot_spreads_families_and_never_loads_lora():
    d = LiveDirector("seed", hold=0, blend=2)
    fi = PaintAuto()
    ap = Autopilot(d, fi, min_interval=0)
    asyncio.run(ap.tick())
    items = d.state()["items"]
    assert "LOOK PLAN" in fi.briefs[-1] and "no style is the default" in fi.briefs[-1]
    assert looks.family(items[0]["style"]) != looks.family(items[1]["style"])  # two watercolors can't both land
    assert all(i.get("lora") is None for i in items)  # 'watercolor' in an Auto prompt never loads the LoRA
