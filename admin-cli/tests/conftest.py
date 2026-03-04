"""Shared fixtures for dina-admin-cli tests."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from dina_admin_cli.config import Config


@pytest.fixture()
def config(tmp_path) -> Config:
    """Minimal test config pointing to a dummy socket path."""
    # tmp_path won't have the socket file, but tests using this fixture
    # mock httpx.Client.request so the socket is never actually opened.
    return Config(
        socket_path=str(tmp_path / "admin.sock"),
        timeout=5.0,
    )


@pytest.fixture()
def mock_client() -> MagicMock:
    """A MagicMock standing in for AdminClient."""
    return MagicMock()
