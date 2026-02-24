"""Shared fixtures for dina-cli tests."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from dina_cli.config import Config


@pytest.fixture()
def config() -> Config:
    """Minimal test config."""
    return Config(
        core_url="http://localhost:8100",
        brain_url="http://localhost:8200",
        client_token="test-token",
        brain_token="test-brain-token",
        persona="personal",
        timeout=5.0,
    )


@pytest.fixture()
def sig_config(tmp_path) -> Config:
    """Config for Ed25519 signature mode with a real keypair."""
    from dina_cli.signing import CLIIdentity

    identity = CLIIdentity(identity_dir=tmp_path / "identity")
    identity.generate()
    return Config(
        core_url="http://localhost:8100",
        brain_url="http://localhost:8200",
        client_token="",
        brain_token="test-brain-token",
        persona="personal",
        timeout=5.0,
        auth_mode="signature",
        device_name="test-device",
    )


@pytest.fixture()
def mock_client() -> MagicMock:
    """A MagicMock standing in for DinaClient."""
    return MagicMock()
