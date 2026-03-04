"""Shared fixtures for dina-cli tests."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from dina_cli.config import Config


@pytest.fixture()
def config(tmp_path) -> Config:
    """Minimal test config with a real Ed25519 keypair."""
    from dina_cli.signing import CLIIdentity

    identity = CLIIdentity(identity_dir=tmp_path / "identity")
    identity.generate()
    return Config(
        core_url="http://localhost:8100",
        brain_url="http://localhost:8200",
        brain_token="test-brain-token",
        persona="personal",
        timeout=5.0,
        device_name="test-device",
    )


@pytest.fixture()
def sig_config(tmp_path) -> Config:
    """Alias for config — all configs use Ed25519 signature mode now."""
    from dina_cli.signing import CLIIdentity

    identity = CLIIdentity(identity_dir=tmp_path / "identity")
    identity.generate()
    return Config(
        core_url="http://localhost:8100",
        brain_url="http://localhost:8200",
        brain_token="test-brain-token",
        persona="personal",
        timeout=5.0,
        device_name="test-device",
    )


@pytest.fixture()
def mock_client() -> MagicMock:
    """A MagicMock standing in for DinaClient."""
    return MagicMock()
