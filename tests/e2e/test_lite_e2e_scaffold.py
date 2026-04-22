"""Scaffold-level tests for the DINA_LITE_E2E=docker branch in e2e/conftest
(task 9.2).

Mirrors tests/integration/test_lite_mode_scaffold.py (task 8.1) — no
container wiring yet; per-actor fixtures land per tasks 9.3 (Don Alonso
M1 smoke), 9.4 (Sancho M2), 9.5 (ChairMaker M3), 9.6 (Albert M2).

These tests run under EITHER DINA_E2E=docker OR DINA_LITE_E2E=docker —
they don't need Lite containers to be up; they validate the scaffold's
detection + marker-application wiring.
"""

from __future__ import annotations

import pytest

from . import conftest


class TestE2EStackSelection:
    """Basic invariants on LITE_E2E_MODE / DOCKER_MODE flags."""

    def test_lite_e2e_mode_is_bool(self) -> None:
        assert isinstance(conftest.LITE_E2E_MODE, bool)

    def test_docker_mode_is_bool(self) -> None:
        assert isinstance(conftest.DOCKER_MODE, bool)

    def test_exactly_one_mode_is_active(self) -> None:
        # Mutual-exclusion guard fires at conftest import; reaching
        # this test means exactly one of the two is True (both False
        # would have triggered the UsageError in pytest_configure).
        assert conftest.DOCKER_MODE ^ conftest.LITE_E2E_MODE


class TestSkipInLiteE2EMarker:
    """Marker behaviour: skip_in_lite_e2e applies only in DINA_LITE_E2E."""

    @pytest.mark.skip_in_lite_e2e(reason="test-the-marker: opt-out example")
    def test_marker_skips_in_lite_mode_only(self) -> None:
        # Reaching this body asserts we're NOT in LITE_E2E_MODE.
        assert conftest.LITE_E2E_MODE is False, (
            "skip_in_lite_e2e marker failed to skip this test in "
            "LITE_E2E_MODE — pytest_collection_modifyitems wiring is broken"
        )

    def test_unmarked_test_runs_in_every_e2e_mode(self) -> None:
        # Default posture: tests run unless they opt out. Reaching this
        # line proves the collection hook didn't over-reach and
        # blanket-skip everything under LITE_E2E_MODE.
        assert True


class TestMarkerRegistration:
    """The skip_in_lite_e2e marker should be registered so pytest
    doesn't emit PytestUnknownMarkWarning."""

    def test_marker_registered(self, pytestconfig: pytest.Config) -> None:
        markers_ini = pytestconfig.getini("markers")
        marker_names = [m.split("(")[0].split(":")[0].strip() for m in markers_ini]
        assert "skip_in_lite_e2e" in marker_names, (
            f"skip_in_lite_e2e marker not registered. "
            f"Registered markers: {marker_names}"
        )
