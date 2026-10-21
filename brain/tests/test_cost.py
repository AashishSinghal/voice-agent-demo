from app.cost import CostGuard, tier_for

FRONTIER = tier_for("frontier", "groq", "openai/gpt-oss-120b")
MID = tier_for("mid", "groq", "openai/gpt-oss-20b")
LOCAL = tier_for("local", "ollama", "phi3")


def guard(cap=0.50, max_steps=6):
    return CostGuard([FRONTIER, MID, LOCAL], cap_usd=cap, max_steps=max_steps)


def sel(g, spent=0.0, steps=0, prompt=1000, out=500, **kw):
    return g.select(prompt_tokens=prompt, max_output_tokens=out, steps=steps, spent_usd=spent, **kw)


def test_prefers_frontier_when_affordable():
    d = sel(guard())
    assert d.action == "call" and d.tier.name == "frontier" and d.degraded_from is None


def test_steps_down_when_frontier_does_not_fit():
    # Remaining budget below frontier's projected cost but above mid's.
    f = FRONTIER.cost(1000, 500)
    m = MID.cost(1000, 500)
    assert m < f
    g = guard(cap=0.50)
    d = sel(g, spent=0.50 - (f + m) / 2)
    assert d.tier.name == "mid" and d.degraded_from == "frontier"


def test_falls_to_free_local_when_budget_is_gone():
    d = sel(guard(), spent=0.50)
    assert d.action == "call" and d.tier.name == "local" and d.projected_usd == 0.0


def test_cache_when_nothing_fits_and_local_unavailable():
    d = sel(guard(), spent=0.50, unavailable=frozenset({"local"}))
    assert d.action == "cache"


def test_halts_on_runaway_loop():
    d = sel(guard(max_steps=3), steps=3)
    assert d.action == "halt" and "step limit" in d.reason


def test_unavailable_provider_is_skipped():
    d = sel(guard(), unavailable=frozenset({"frontier"}))
    assert d.tier.name == "mid"


def test_projection_matches_price_table():
    assert abs(FRONTIER.cost(1_000_000, 0) - 0.15) < 1e-9
    assert abs(FRONTIER.cost(0, 1_000_000) - 0.60) < 1e-9
