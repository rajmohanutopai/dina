"""Scaffold-level tests for LiteDockerServices + RealLiteCore / RealLiteBrain
(tasks 8.2 + 8.3).

These validate the structure of the scaffold without requiring live
Lite containers. Endpoint-hitting tests land per the Phase 8a
migration tasks (8.5-8.11) alongside their test-file migrations.

The mutual-exclusion + mock-mode-default invariants are already
covered by `test_lite_mode_scaffold.py` (task 8.1).
"""

from __future__ import annotations

import pytest

from . import conftest
from .lite_clients import RealLiteBrain, RealLiteCore


class TestLiteDockerServicesShape:
    """The `LiteDockerServices` class carries the URL-exposure + health
    contract the `lite_services` fixture and the Real* clients rely on."""

    def test_default_ports_are_28100_28200(self) -> None:
        services = conftest.LiteDockerServices()
        assert services.core_url.endswith(":28100")
        assert services.brain_url.endswith(":28200")

    def test_default_host_is_localhost(self) -> None:
        services = conftest.LiteDockerServices()
        assert "127.0.0.1" in services.core_url

    def test_explicit_constructor_overrides(self) -> None:
        services = conftest.LiteDockerServices(
            host="dina-test-host", core_port=38100, brain_port=38200
        )
        assert services.core_url == "http://dina-test-host:38100"
        assert services.brain_url == "http://dina-test-host:38200"

    def test_env_override_takes_precedence_when_args_unset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DINA_LITE_HOST", "env-host")
        monkeypatch.setenv("DINA_LITE_CORE_PORT", "48100")
        monkeypatch.setenv("DINA_LITE_BRAIN_PORT", "48200")
        services = conftest.LiteDockerServices()
        assert services.core_url == "http://env-host:48100"
        assert services.brain_url == "http://env-host:48200"

    def test_is_running_returns_false_when_stack_is_down(self) -> None:
        # Point at a likely-unused port so the health-check fails the
        # connect-attempt cleanly. We assert the method returns False
        # (not that it raises) — catching the exception is part of the
        # contract.
        services = conftest.LiteDockerServices(
            host="127.0.0.1", core_port=65501, brain_port=65502
        )
        assert services.is_running() is False

    def test_assert_ready_raises_clear_message_when_down(self) -> None:
        services = conftest.LiteDockerServices(
            host="127.0.0.1", core_port=65501, brain_port=65502
        )
        with pytest.raises(RuntimeError, match="Lite stack not reachable"):
            services.assert_ready()

    def test_client_token_empty_by_default(self) -> None:
        services = conftest.LiteDockerServices()
        # Default is empty string (not None) — matches the existing
        # `_IntegrationServices.client_token` property shape.
        assert services.client_token == ""


@pytest.mark.skipif(
    conftest.LITE_MODE,
    reason="Only validates the mock-mode behaviour of lite_services. "
    "In LITE_MODE the fixture's `assert_ready()` fires at fixture-setup "
    "time before any test body runs, so a runtime skip inside the body "
    "can't cover this case.",
)
class TestLiteFixtureMockMode:
    """The `lite_services` fixture yields None outside LITE_MODE."""

    def test_fixture_yields_none(
        self, lite_services: conftest.LiteDockerServices | None
    ) -> None:
        assert lite_services is None


@pytest.mark.skipif(
    conftest.LITE_MODE or conftest.DOCKER_MODE,
    reason="Only validates `active_services` yielding None in mock mode — "
    "the real-stack branches are exercised by per-test migrations from "
    "Phase 8a (tasks 8.5-8.11).",
)
class TestActiveServicesFixtureMockMode:
    """The `active_services` abstraction (task 8.4) yields None when
    neither DINA_INTEGRATION=docker nor DINA_LITE=docker is set."""

    def test_active_services_is_none_in_mock_mode(
        self, active_services: object | None
    ) -> None:
        assert active_services is None

    def test_mock_vault_is_mock_class_in_mock_mode(
        self, mock_vault: object
    ) -> None:
        from .mocks import MockVault

        # In mock mode active_services is None → mock_vault fixture
        # should fall through to the `return MockVault()` branch.
        # (RealVault also extends MockVault — assert against the exact
        # class, not isinstance.)
        assert type(mock_vault).__name__ == "MockVault"

    def test_mock_dina_has_no_real_scrubber_in_mock_mode(
        self, mock_dina: object
    ) -> None:
        # In mock mode, mock_dina fixture SKIPS the RealPIIScrubber
        # attach step. Easiest assertion: the scrubber attribute is
        # whatever MockDinaCore's default is (which is not a
        # RealPIIScrubber instance).
        # Import lazily because RealPIIScrubber is defined in
        # real_clients.py and may have its own import side-effects.
        from .real_clients import RealPIIScrubber

        assert not isinstance(getattr(mock_dina, "scrubber", None), RealPIIScrubber)


class TestRealLiteCoreShape:
    """`RealLiteCore` mirrors MockGoCore's interface + adds HTTP backing."""

    def test_inherits_from_mock_go_core(self) -> None:
        from .mocks import MockGoCore

        client = RealLiteCore("http://127.0.0.1:65501")
        try:
            assert isinstance(client, MockGoCore)
        finally:
            client.close()

    def test_strips_trailing_slash_from_base_url(self) -> None:
        client = RealLiteCore("http://127.0.0.1:28100/")
        try:
            assert client.base_url == "http://127.0.0.1:28100"
        finally:
            client.close()

    def test_healthz_returns_false_on_unreachable(self) -> None:
        client = RealLiteCore("http://127.0.0.1:65501")
        try:
            assert client.healthz() is False
        finally:
            client.close()

    def test_client_token_optional_arg(self) -> None:
        client = RealLiteCore("http://127.0.0.1:28100", client_token="test-token")
        try:
            assert client.client_token == "test-token"
        finally:
            client.close()


class TestRealLiteBrainShape:
    """`RealLiteBrain` mirrors MockPythonBrain's interface + adds HTTP."""

    def test_inherits_from_mock_python_brain(self) -> None:
        from .mocks import MockPythonBrain

        client = RealLiteBrain("http://127.0.0.1:65502")
        try:
            assert isinstance(client, MockPythonBrain)
        finally:
            client.close()

    def test_healthz_returns_false_on_unreachable(self) -> None:
        client = RealLiteBrain("http://127.0.0.1:65502")
        try:
            assert client.healthz() is False
        finally:
            client.close()
