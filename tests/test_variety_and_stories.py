import random

from infinite_tapestry.autopilot import director_brief, story_prompt
from infinite_tapestry.interpreter import parse_plan
from infinite_tapestry.variety import motif_run, spark, spark_line


def test_spark_and_motif_run():
    s = spark(random.Random(1))
    assert set(s) == {"era", "place", "subject", "look"} and "era" in spark_line(s)
    assert motif_run(["Lantern Tide", "Lantern Shore", "The Lantern Loft", "Glass Bay"]) == ["lantern"]


def test_brief_free_has_spark_and_new_territory_no_title_examples():
    b = director_brief([{"title": "Lantern Tide"}] * 4, None, "", "", "", spark(random.Random(2)))
    assert "Fresh spark" in b and "new territory" in b and "lantern" in b and '"Lantern Tide", "The Amber Hour"' not in b


def test_brief_story_mode_carries_premise_style_and_scenes():
    j = {"journey": "Robot Bakery", "step": 2, "total": 6, "premise": "a robot opens a bakery on Mars",
         "style": "claymation", "scenes": ["Red Dust Arrival", "First Oven"]}
    b = director_brief([], j, "", "", "", None)
    assert "a robot opens a bakery on Mars" in b and "claymation" in b and "Red Dust Arrival -> First Oven" in b


def test_director_story_fields_parsed():
    p = parse_plan('{"scenes":[{"title":"A","prompt":"a b"}],"director":{"move":"journey","journey":"J","total":5,'
                   '"step":1,"premise":"p","style":"linocut print"}}')
    assert p["director"]["style"] == "linocut print" and p["director"]["premise"] == "p"


def test_story_prompt_prepends_look_once():
    assert story_prompt("linocut print", "a fox in snow") == "linocut print, a fox in snow"
    assert story_prompt("linocut print", "linocut print of a fox") == "linocut print of a fox"
    assert story_prompt("", "x") == "x"
