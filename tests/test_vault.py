"""Unit tests for dina.vault — CeramicVault decentralized verdict storage."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

pytestmark = pytest.mark.legacy

from dina.identity import DinaIdentity
from dina.models import ProductVerdict


@pytest.fixture
def identity(tmp_path: Path) -> DinaIdentity:
    return DinaIdentity(identity_dir=tmp_path / "identity")


@pytest.fixture
def sample_verdict() -> ProductVerdict:
    return ProductVerdict(
        product_name="Pixel 9 Pro",
        verdict="BUY",
        confidence_score=88,
        pros=["amazing camera", "clean software", "7 years updates"],
        cons=["expensive", "no charger in box"],
        hidden_warnings=["gets warm under load"],
        expert_source="MKBHD",
        signature_hex="ab" * 64,
        signer_did="did:key:z6MkTest",
    )


class TestVaultDisabled:
    """Vault is disabled when no URL is configured."""

    def test_disabled_when_no_url(self, identity: DinaIdentity, tmp_path: Path):
        """Vault is disabled when no DINA_CERAMIC_URL is set."""
        with patch.dict("os.environ", {}, clear=False):
            # Ensure env var is absent
            import os
            os.environ.pop("DINA_CERAMIC_URL", None)

            from dina.vault import CeramicVault
            vault = CeramicVault(identity, ceramic_url="", vault_dir=tmp_path / "vault")
            assert vault.enabled is False

    def test_publish_returns_none_when_disabled(
        self, identity: DinaIdentity, sample_verdict: ProductVerdict, tmp_path: Path
    ):
        """publish() returns None when vault is disabled."""
        from dina.vault import CeramicVault
        vault = CeramicVault(identity, ceramic_url="", vault_dir=tmp_path / "vault")
        result = vault.publish(sample_verdict, "vid123", "https://youtu.be/vid123")
        assert result is None

    def test_synced_count_zero_when_disabled(
        self, identity: DinaIdentity, tmp_path: Path
    ):
        """synced_count is 0 when vault is disabled."""
        from dina.vault import CeramicVault
        vault = CeramicVault(identity, ceramic_url="", vault_dir=tmp_path / "vault")
        assert vault.synced_count == 0

    def test_connected_false_when_disabled(
        self, identity: DinaIdentity, tmp_path: Path
    ):
        """connected is False when vault is disabled."""
        from dina.vault import CeramicVault
        vault = CeramicVault(identity, ceramic_url="", vault_dir=tmp_path / "vault")
        assert vault.connected is False


class TestHealthCheck:
    """Tests for the health check against the Ceramic node."""

    def test_health_check_success(self, identity: DinaIdentity, tmp_path: Path):
        """Successful health check sets connected=True."""
        from dina.vault import CeramicVault

        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)

        with patch("dina.vault.urlopen", return_value=mock_response):
            vault = CeramicVault(
                identity, ceramic_url="http://localhost:7007", vault_dir=tmp_path / "vault"
            )
            assert vault.connected is True

    def test_health_check_failure(self, identity: DinaIdentity, tmp_path: Path):
        """Failed health check sets connected=False."""
        from urllib.error import URLError

        from dina.vault import CeramicVault

        with patch("dina.vault.urlopen", side_effect=URLError("refused")):
            vault = CeramicVault(
                identity, ceramic_url="http://localhost:7007", vault_dir=tmp_path / "vault"
            )
            assert vault.connected is False

    def test_health_check_returns_false_when_disabled(
        self, identity: DinaIdentity, tmp_path: Path
    ):
        """health_check() returns False when vault is disabled."""
        from dina.vault import CeramicVault
        vault = CeramicVault(identity, ceramic_url="", vault_dir=tmp_path / "vault")
        assert vault.health_check() is False


class TestPublish:
    """Tests for publishing verdicts to Ceramic."""

    def test_publish_returns_stream_id(
        self, identity: DinaIdentity, sample_verdict: ProductVerdict, tmp_path: Path
    ):
        """Successful publish returns a stream_id."""
        from dina.vault import CeramicVault

        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)

        mock_client = MagicMock()
        mock_client.create_document.return_value = {"stream_id": "kjzl6abc123"}

        with (
            patch("dina.vault.urlopen", return_value=mock_response),
            patch("dina.vault.CeramicVault._init_client", return_value=mock_client),
        ):
            vault = CeramicVault(
                identity, ceramic_url="http://localhost:7007", vault_dir=tmp_path / "vault"
            )
            stream_id = vault.publish(sample_verdict, "vid123", "https://youtu.be/vid123")

        assert stream_id == "kjzl6abc123"

    def test_publish_updates_index(
        self, identity: DinaIdentity, sample_verdict: ProductVerdict, tmp_path: Path
    ):
        """Successful publish updates the local stream index."""
        from dina.vault import CeramicVault

        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)

        mock_client = MagicMock()
        mock_client.create_document.return_value = {"stream_id": "kjzl6abc123"}

        with (
            patch("dina.vault.urlopen", return_value=mock_response),
            patch("dina.vault.CeramicVault._init_client", return_value=mock_client),
        ):
            vault = CeramicVault(
                identity, ceramic_url="http://localhost:7007", vault_dir=tmp_path / "vault"
            )
            vault.publish(sample_verdict, "vid123", "https://youtu.be/vid123")

        assert vault.get_stream_id("vid123") == "kjzl6abc123"
        assert vault.synced_count == 1

    def test_publish_persists_index_to_disk(
        self, identity: DinaIdentity, sample_verdict: ProductVerdict, tmp_path: Path
    ):
        """Stream index is persisted as JSON on disk."""
        from dina.vault import CeramicVault

        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)

        mock_client = MagicMock()
        mock_client.create_document.return_value = {"stream_id": "kjzl6abc123"}

        vault_dir = tmp_path / "vault"
        with (
            patch("dina.vault.urlopen", return_value=mock_response),
            patch("dina.vault.CeramicVault._init_client", return_value=mock_client),
        ):
            vault = CeramicVault(
                identity, ceramic_url="http://localhost:7007", vault_dir=vault_dir
            )
            vault.publish(sample_verdict, "vid123", "https://youtu.be/vid123")

        index_file = vault_dir / "stream_index.json"
        assert index_file.exists()
        data = json.loads(index_file.read_text())
        assert data["vid123"] == "kjzl6abc123"


class TestPublishFailure:
    """Publish failures don't crash the caller."""

    def test_publish_sdk_exception_returns_none(
        self, identity: DinaIdentity, sample_verdict: ProductVerdict, tmp_path: Path
    ):
        """SDK exception during publish returns None, no crash."""
        from dina.vault import CeramicVault

        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)

        mock_client = MagicMock()
        mock_client.create_document.side_effect = RuntimeError("SDK error")

        with (
            patch("dina.vault.urlopen", return_value=mock_response),
            patch("dina.vault.CeramicVault._init_client", return_value=mock_client),
        ):
            vault = CeramicVault(
                identity, ceramic_url="http://localhost:7007", vault_dir=tmp_path / "vault"
            )
            result = vault.publish(sample_verdict, "vid123", "https://youtu.be/vid123")

        assert result is None
        assert vault.synced_count == 0

    def test_publish_when_disconnected_returns_none(
        self, identity: DinaIdentity, sample_verdict: ProductVerdict, tmp_path: Path
    ):
        """Publish returns None when node is unreachable."""
        from urllib.error import URLError

        from dina.vault import CeramicVault

        with patch("dina.vault.urlopen", side_effect=URLError("refused")):
            vault = CeramicVault(
                identity, ceramic_url="http://localhost:7007", vault_dir=tmp_path / "vault"
            )
            result = vault.publish(sample_verdict, "vid123", "https://youtu.be/vid123")

        assert result is None


class TestStreamIndex:
    """Tests for the local stream index."""

    def test_empty_on_fresh_vault(self, identity: DinaIdentity, tmp_path: Path):
        """Fresh vault has empty stream index."""
        from dina.vault import CeramicVault
        vault = CeramicVault(identity, ceramic_url="", vault_dir=tmp_path / "vault")
        assert vault.synced_count == 0
        assert vault.get_stream_id("nonexistent") is None

    def test_index_survives_reload(
        self, identity: DinaIdentity, sample_verdict: ProductVerdict, tmp_path: Path
    ):
        """Stream index persists across vault instances."""
        from dina.vault import CeramicVault

        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)

        mock_client = MagicMock()
        mock_client.create_document.return_value = {"stream_id": "kjzl6persist"}

        vault_dir = tmp_path / "vault"
        with (
            patch("dina.vault.urlopen", return_value=mock_response),
            patch("dina.vault.CeramicVault._init_client", return_value=mock_client),
        ):
            vault = CeramicVault(
                identity, ceramic_url="http://localhost:7007", vault_dir=vault_dir
            )
            vault.publish(sample_verdict, "vid123", "https://youtu.be/vid123")

        # Create new vault instance pointing to the same dir (disabled this time)
        vault2 = CeramicVault(identity, ceramic_url="", vault_dir=vault_dir)
        assert vault2.get_stream_id("vid123") == "kjzl6persist"
        assert vault2.synced_count == 1


class TestStatusLines:
    """Tests for the status_lines property."""

    def test_disabled_status(self, identity: DinaIdentity, tmp_path: Path):
        """Disabled vault shows appropriate status."""
        from dina.vault import CeramicVault
        vault = CeramicVault(identity, ceramic_url="", vault_dir=tmp_path / "vault")
        lines = vault.status_lines
        assert len(lines) == 1
        assert "disabled" in lines[0]

    def test_enabled_connected_status(self, identity: DinaIdentity, tmp_path: Path):
        """Enabled + connected vault shows URL and synced count."""
        from dina.vault import CeramicVault

        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)

        with patch("dina.vault.urlopen", return_value=mock_response):
            vault = CeramicVault(
                identity, ceramic_url="http://localhost:7007", vault_dir=tmp_path / "vault"
            )

        lines = vault.status_lines
        assert len(lines) == 2
        assert "connected" in lines[0]
        assert "localhost:7007" in lines[0]

    def test_enabled_disconnected_status(self, identity: DinaIdentity, tmp_path: Path):
        """Enabled + disconnected vault shows disconnected status."""
        from urllib.error import URLError

        from dina.vault import CeramicVault

        with patch("dina.vault.urlopen", side_effect=URLError("refused")):
            vault = CeramicVault(
                identity, ceramic_url="http://localhost:7007", vault_dir=tmp_path / "vault"
            )

        lines = vault.status_lines
        assert len(lines) == 2
        assert "disconnected" in lines[0]
