"""The pod follows CI releases by itself; CI publishes only when the worker code changed."""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_scripts_parse():
    for p in ("scripts/pod/supervise.sh", "scripts/pod/selfboot.sh", "scripts/publish_worker.sh"):
        assert subprocess.run(["bash", "-n", str(ROOT / p)]).returncode == 0, p


def test_supervisor_follows_latest_and_rolls_back():
    src = (ROOT / "scripts/pod/supervise.sh").read_text()
    assert "deploy/worker/latest.txt" in src and "fetch_release.sh" in src
    assert "never became healthy" in src and 'BAD=$NEW' in src


def test_publish_skips_unchanged_worker():
    src = (ROOT / "scripts/publish_worker.sh").read_text()
    assert "latest.tree" in src and "--force" in src and "--retry" in src
