"""Fewer false positives; the hard lines (sexual/nudity, minors + sexual, slurs) still block."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from infinite_tapestry.config import Config
from infinite_tapestry.guard import hard_block_reason, is_disallowed

ROOT = Path(__file__).resolve().parents[1]

BENIGN = ["naked mole rat colony", "visible to the naked eye", "chicken breast factory", "turkey breasts on a grill",
          "breaststroke race", "blue tits on a branch", "a great tit singing", "comic strip city", "landing strip at dusk",
          "film strip cathedral", "stripes everywhere", "baby elephant parade", "baby dragons hatching",
          "kids toys everywhere", "children's drawings come alive", "explicit instructions for building a kite",
          "stripping paint off a barn", "sex pistols concert in sussex"]
HARD = ["nude statue", "naked crowd", "topless beach", "Boobs", "show me tits", "porn", "sexy teen",
        "naked children", "a naked mole rat and naked women", "stripper pole", "nigger", "f4ggots"]
TEXT_ONLY_OK = ["heil hitler satire", "nazis fleeing a giant duck", "kkk rally rained on by frogs"]


@pytest.mark.parametrize("t", BENIGN)
def test_benign_phrases_pass_guard(t):
    assert hard_block_reason(t) is None and not is_disallowed(t)


@pytest.mark.parametrize("t", [h for h in HARD if h not in ("nigger", "f4ggots")])
def test_hard_lines_still_block_guard(t):
    assert hard_block_reason(t) == "sexual" and is_disallowed(t)


def test_slurs_still_block_guard():
    assert hard_block_reason("nigger") == "slur" and hard_block_reason("f@ggots") == "slur"


def test_ref_image_threshold_raised_and_near_misses_logged():
    c = Config()
    assert c.nsfw_threshold == 0.8 and c.nsfw_log_min == 0.5
    assert "crowd.on_event = ops.event" in (ROOT / "infinite_tapestry/main.py").read_text()


def test_sql_allowlist_mirrors_code():
    sql = (ROOT / "supabase/migrations/019_mod_allowlist.sql").read_text()
    for p in ("naked mole", "breast ?strokes?", "tit ?mouse", "landing", "kid goats?"):
        assert p in sql


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_moderate_js_keyword_and_openai_scores():
    script = """
const m = require('./web/lib/moderate.js');
const out = {benign: %s.map(m.keyword), hard: %s.map(m.keyword), textok: %s.map(m.keyword),
  gore: m.openaiVerdict({categories: {'violence/graphic': true, sexual: true, 'self-harm/instructions': true},
                         category_scores: {'violence/graphic': 0.99, sexual: 0.4, 'self-harm/instructions': 0.5}}),
  sexHigh: m.openaiVerdict({categories: {}, category_scores: {sexual: 0.75}}),
  hateLow: m.openaiVerdict({categories: {hate: true}, category_scores: {hate: 0.5}}),
  hateHigh: m.openaiVerdict({categories: {}, category_scores: {hate: 0.9}}),
  minors: m.openaiVerdict({categories: {'sexual/minors': true}, category_scores: {}}),
  instr: m.openaiVerdict({categories: {}, category_scores: {'self-harm/instructions': 0.95}})};
console.log(JSON.stringify(out));
""" % (json.dumps([b for b in BENIGN if b not in ("explicit instructions for building a kite", "stripping paint off a barn", "stripes everywhere")]),
       json.dumps(HARD), json.dumps(TEXT_ONLY_OK))
    r = json.loads(subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True).stdout)
    assert all(v == "" for v in r["benign"]), r["benign"]
    assert all(v for v in r["hard"]), r["hard"]
    assert all(v == "" for v in r["textok"])
    assert r["gore"] == "" and r["sexHigh"] == "sexual" and r["hateLow"] == "" and r["hateHigh"] == ""
    assert r["minors"] == "minor_sexual" and r["instr"] == ""


def test_no_checks_on_live_canvas():
    gen = (ROOT / "infinite_tapestry/generator.py").read_text()
    for gone in ("self.nsfw(", "load_classifier", "drop_flagged", "obscure(", "on_flag("):
        assert gone not in gen, gone
    assert not hasattr(Config(), "nsfw_model")


def test_user_prompt_never_swapped_before_render():
    gen = (ROOT / "infinite_tapestry/generator.py").read_text()
    assert 'get("origin") != "user"' in gen
