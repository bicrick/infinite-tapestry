import os

# Tests never talk to the real Supabase/RunPod/Anthropic.
for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RUNPOD_API_KEY", "RUNPOD_POD_ID"):
    os.environ.pop(k, None)
import os

os.environ.setdefault("TAPESTRY_HEADLINES", "0")


import pytest as _pytest


@_pytest.fixture
def fixed_widths(monkeypatch):
    """Legacy timing tests: fixed v1.0 holds instead of random scene widths."""
    from infinite_tapestry.prompts import LiveDirector
    monkeypatch.setattr(LiveDirector, "random_widths", False)


@_pytest.fixture(autouse=True)
def _reset_supabase_breaker():
    """The Supabase breaker is process-wide; a test that simulates an outage must not trip it for the next test."""
    from infinite_tapestry import sbguard
    sbguard.BREAKER.ok()
    yield
    sbguard.BREAKER.ok()
