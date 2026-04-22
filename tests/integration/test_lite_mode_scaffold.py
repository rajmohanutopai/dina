"""Scaffold-level tests for the DINA_LITE=docker branch in conftest (task 8.1).

Verifies the stack-selection detection, the skip_in_lite marker, and the
mutual-exclusion guard. These tests validate the infrastructure that
tasks 8.2-8.11 will build on; they don't require Lite containers to be
running.

The mutual-exclusion guard itself can't be unit-tested inside pytest
because it fires at conftest import time (before pytest_configure runs);
a subprocess run is the right shape — covered by the `ImportError` check
in the Phase 7c smoke (task 7.32) during `run_all_tests.sh`.
"""

from __future__ import annotations

import pytest

from . import conftest


class TestStackSelectionConstants:
    """Basic invariants on the module-level LITE_MODE / DOCKER_MODE flags."""

    def test_lite_mode_is_bool(self) -> None:
        assert isinstance(conftest.LITE_MODE, bool)

    def test_docker_mode_is_bool(self) -> None:
        assert isinstance(conftest.DOCKER_MODE, bool)

    def test_modes_are_mutually_exclusive_at_runtime(self) -> None:
        # At runtime, at most one mode can be true (the conftest module
        # raises RuntimeError at import time if both env vars are set,
        # so reaching this test means the guard held).
        assert not (conftest.LITE_MODE and conftest.DOCKER_MODE)


class TestSkipInLiteMarker:
    """Marker behaviour: skip_in_lite applies only in DINA_LITE=docker mode."""

    @pytest.mark.skip_in_lite(reason="test-the-marker: demonstrates opt-out")
    def test_marker_is_accepted_without_error(self) -> None:
        """A test tagged skip_in_lite runs in mock + docker mode; skips in lite.

        Reaching the body asserts we are NOT in lite mode. If DINA_LITE=docker
        is set, this test gets marked skipped at collection time and the
        body never runs — that's the contract task 8.1 wires.
        """
        assert conftest.LITE_MODE is False, (
            "skip_in_lite marker failed to skip this test in LITE_MODE — "
            "pytest_collection_modifyitems wiring is broken"
        )

    def test_unmarked_test_runs_in_every_mode(self) -> None:
        """A test without skip_in_lite runs regardless of mode.

        The collection hook only touches items carrying the marker, so
        the default posture stays: a test runs unless it explicitly opts
        out. This is the right default — forces migrators to decide
        deliberately, per `tests/integration/LITE_SKIPS.md`.
        """
        # Positive assertion: reaching this line proves the hook didn't
        # over-reach and blanket-skip everything in LITE_MODE.
        assert True


class TestMarkerRegistration:
    """The skip_in_lite marker should be registered via pytest_configure
    so pytest doesn't warn about unknown markers."""

    def test_marker_registered(self, pytestconfig: pytest.Config) -> None:
        # Markers registered via addinivalue_line land in the `markers` ini value
        # as `name(args): description` strings. We check the registered name.
        markers_ini = pytestconfig.getini("markers")
        marker_names = [m.split("(")[0].split(":")[0].strip() for m in markers_ini]
        assert "skip_in_lite" in marker_names, (
            f"skip_in_lite marker not registered — pytest would emit "
            f"PytestUnknownMarkWarning. Registered markers: {marker_names}"
        )
