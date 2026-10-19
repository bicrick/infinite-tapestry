"""Supabase free-plan log ingestion: every PostgREST call is one ~2 KB edge log line, so the pod's steady polling stays slow."""
from infinite_tapestry import autopilot, server, store
from infinite_tapestry.crowd import Crowd


def test_polling_intervals_stay_within_budget():
    assert Crowd.TICK_S >= 30 and Crowd.IDEA_POLL_S >= 45 and Crowd.METER_S >= 300
    assert autopilot.CFG_POLL_S >= 30
    assert server.DECISION_FLUSH_S >= 60
    assert store.SupabaseMirror.ROW_FLUSH_S >= 30
