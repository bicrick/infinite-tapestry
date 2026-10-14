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
    assert m.is_repeat("Salt Mine Chapel") and not m.is_repeat("Chapel Salt Mine")
    assert not m.is_repeat("Dust Storm Drive-In")
    b = brief("news", ["Nobel prize economics"], m)
    assert "Nobel" in b and "Salt Mine Chapel" in b and "welcome" in b and "BANNED" not in b
    assert pick_mode(have_news=False) != "news"


def test_titles_cleaned():
    from infinite_tapestry.themes import clean_title
    from infinite_tapestry.prompts import make_scene
    assert clean_title("Mandelbrot Spires 系") == "Mandelbrot Spires"
    assert clean_title("Café Révolution — Night") == "Café Révolution — Night"
    assert clean_title("「Kelp」 Cathedral") == "Kelp Cathedral"
    assert make_scene("silk dunes, wide", title="Silk Dunes 系")["title"] == "Silk Dunes"


def test_journeys_2_to_4():
    import random
    from infinite_tapestry.moods import MoodRotator
    r = MoodRotator(random.Random(1))
    first = r.next(2)
    assert r.fresh and "START" in r.brief(first)
    runs, cur, n = [], first, 2
    for _ in range(40):
        k = r.next(2)
        if k == cur:
            n += 2
            assert "CONTINUE" in r.brief(k)
        else:
            runs.append(n); cur, n = k, 2
    assert all(2 <= x <= 4 for x in runs)


def test_fractals_welcome_in_cosmic_and_abstract():
    from infinite_tapestry.moods import MOODS
    d = {m[0]: m[4] for m in MOODS}
    assert "fractal" in d["cosmic"].lower() and "fractal" in d["abstract"].lower() and "fractal" in d
