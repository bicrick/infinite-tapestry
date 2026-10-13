from infinite_tapestry.interpreter import parse_plan
from infinite_tapestry.autopilot import director_brief


def test_director_parsed_and_sanitized():
    p = parse_plan('{"scenes":[{"title":"Skyline","prompt":"a city skyline at dusk"}],'
                   '"director":{"move":"journey","journey":"Lantern City","step":1,"total":6,"reason":"dusk feels right"}}')
    assert p["director"] == {"move": "journey", "journey": "Lantern City", "step": 1, "total": 6, "reason": "dusk feels right"}
    assert parse_plan('{"scenes":[{"prompt":"x y"}]}')["director"] == {}


def test_brief_has_context():
    b = director_brief([{"title": f"T{i}"} for i in range(25)], {"journey": "Deep", "step": 2, "total": 5, "reason": "r"},
                       "more autumn", "cozy", "cozy interiors")
    assert "T24" in b and "T4" not in b.split("Last scenes")[1].split("|")[0] and "scene 2 of 5" in b and "more autumn" in b
