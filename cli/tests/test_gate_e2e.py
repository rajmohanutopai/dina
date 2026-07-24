"""Live end-to-end test for the coding gate — opt-in (boots a Node core-server).

Skipped by default so the normal `pytest` unit run stays pure-Python. Enable it
in CI / locally with `DINA_GATE_E2E=1`. It shells out to the self-contained
harness, which boots a throwaway Core, drives real tool calls through
`dina gate-hook` + the supervisor, asserts every decision, and tears down.

    DINA_GATE_E2E=1 python -m pytest tests/test_gate_e2e.py -s
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parents[1] / "claude-plugin" / "e2e" / "gate_e2e.sh"


@pytest.mark.skipif(
    os.environ.get("DINA_GATE_E2E") != "1",
    reason="live E2E boots a Node core-server; set DINA_GATE_E2E=1 to run",
)
def test_gate_end_to_end():
    assert HARNESS.exists(), f"missing E2E harness: {HARNESS}"
    result = subprocess.run(
        ["bash", str(HARNESS)],
        capture_output=True,
        text=True,
        timeout=240,
    )
    # Surface the harness output so a failure is diagnosable in the pytest log.
    print(result.stdout)
    if result.stderr:
        print("STDERR:", result.stderr)
    assert result.returncode == 0, f"gate E2E failed (exit {result.returncode})"
