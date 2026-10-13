from infinite_tapestry.themes import ThemeMemory, brief, has_cliche, mentions_minor, pick_mode


def test_cliche_and_minor_filters():
    assert has_cliche("Neon Coral Reefs") and has_cliche("sunset beach glow")
    assert not has_cliche("Pigeon Parking Attendant")
    assert mentions_minor("Toddler Tornado Kitchen") and not mentions_minor("Telescope Mirror Workshop")


def test_memory_repeats_and_brief():
    m = ThemeMemory(40)
    for i in range(50):
        m.add(f"Theme {i}")
    assert len(m.titles) == 40
    m.add("Salt Mine Chapel")
    assert m.is_repeat("Salt Mine Chapel") and m.is_repeat("Chapel Salt Mine")
    assert not m.is_repeat("Dust Storm Drive-In")
    b = brief("news", ["Nobel prize economics"], m)
    assert "Nobel" in b and "Salt Mine Chapel" in b and "coral reef" in b
    assert pick_mode(have_news=False) != "news"


def test_cliche_budget_occasional():
    from infinite_tapestry.themes import ClicheBudget, clean_title, find_cliche
    b = ClicheBudget(every=6, distinct=20)
    assert find_cliche("Orion Nebula Overlook") == "nebula" and find_cliche("Salt Mine Chapel") is None
    assert b.allows("nebula")
    b.record("nebula")
    assert not b.allows("coral reef")  # never two in a row
    for _ in range(4):
        b.record(None)
    assert not b.allows("aurora")  # still within 1-in-6
    b.record(None)
    assert b.allows("aurora") and not b.allows("nebula")  # same one not within 20
    for _ in range(14):
        b.record(None)
    assert not b.allows("nebula")  # 19 scenes since nebula
    b.record(None)
    assert b.allows("nebula")
    assert "welcome OCCASIONALLY" in brief("cinematic", [], ThemeMemory(5), budget=ClicheBudget())
    assert clean_title("Mandelbrot Spires 系") == "Mandelbrot Spires"
    assert clean_title("Café Révolution — Night") == "Café Révolution — Night"
    assert clean_title("「Kelp」 Cathedral") == "Kelp Cathedral"


def test_fractals_welcome_in_cosmic_and_abstract():
    from infinite_tapestry.moods import MOODS
    d = {m[0]: m[4] for m in MOODS}
    assert "fractal" in d["cosmic"].lower() and "fractal" in d["abstract color field"].lower()
