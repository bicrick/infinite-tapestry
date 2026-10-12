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
