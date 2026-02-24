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
def mock_client() -> MagicMock:
    """A MagicMock standing in for DinaClient."""
    return MagicMock()
