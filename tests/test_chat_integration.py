"""Integration tests for dina.chat — REPL command handlers with identity and vault.

These tests exercise _handle_identity, _handle_verify, _handle_history,
the signing flow in _handle_url, vault dual-write, and the /vault command
by mocking external dependencies (LLM agents, YouTube transcript fetching,
ChromaDB embeddings, providers, Ceramic SDK).
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import chromadb
import pytest

from dina.identity import DinaIdentity
from dina.models import ProductVerdict
from dina.signing import canonicalize_verdict, sign_verdict


def _mock_providers():
    """Create a mock providers object with default embedding function."""
    mock = MagicMock()
    mock.make_embedding_function.return_value = (
        chromadb.utils.embedding_functions.DefaultEmbeddingFunction()
    )
    mock.embed_provider = "test"
    mock.can_analyze_video = False
    mock.verdict_model = MagicMock()
    mock.chat_model = MagicMock()
    mock.status_lines = ["Light: ollama/gemma3", "Heavy: gemini/gemini-2.5-flash (video-capable)"]
    return mock


@pytest.fixture
def mock_prov():
    """Shared mock providers instance."""
    return _mock_providers()


@pytest.fixture
def identity(tmp_path: Path) -> DinaIdentity:
    return DinaIdentity(identity_dir=tmp_path / "identity")


@pytest.fixture
def memory(tmp_path: Path, mock_prov):
    with patch("dina.memory.providers", mock_prov):
        from dina.memory import VerdictMemory

        return VerdictMemory(persist_dir=tmp_path / "chroma")


# ── /identity command ──────────────────────────────────────────────


class TestHandleIdentity:
    """Tests for the /identity command handler."""

    def test_prints_did_document(self, identity: DinaIdentity, capsys):
        """_handle_identity prints a valid W3C DID Document."""
        from dina.chat import _handle_identity

        _handle_identity(identity)
        output = capsys.readouterr().out
        doc = json.loads(output)
        assert "@context" in doc
        assert doc["id"].startswith("did:key:z6Mk")
        assert len(doc["verificationMethod"]) == 1

    def test_did_document_has_correct_did(self, identity: DinaIdentity, capsys):
        """The printed DID Document's id matches the identity's DID."""
        from dina.chat import _handle_identity
        from dina.did_key import derive_did_key

        _handle_identity(identity)
        output = capsys.readouterr().out
        doc = json.loads(output)
        assert doc["id"] == derive_did_key(identity)

    def test_verification_method_type(self, identity: DinaIdentity, capsys):
        """The verification method type is Ed25519VerificationKey2020."""
        from dina.chat import _handle_identity

        _handle_identity(identity)
        output = capsys.readouterr().out
        doc = json.loads(output)
        assert doc["verificationMethod"][0]["type"] == "Ed25519VerificationKey2020"


# ── /verify command ────────────────────────────────────────────────


class TestHandleVerify:
    """Tests for the /verify command handler."""

    def test_verify_signed_verdict(self, memory, identity, capsys):
        """Verifying a signed verdict prints VERIFIED."""
        from dina.chat import _handle_verify

        verdict = ProductVerdict(
            product_name="TestPhone",
            verdict="BUY",
            confidence_score=85,
            pros=["good"],
            cons=["bad"],
            expert_source="TestSource",
        )
        sig_hex, did = sign_verdict(verdict, identity)
        verdict.signature_hex = sig_hex
        verdict.signer_did = did
        memory.store(verdict, "https://youtu.be/test123", "test123")

        _handle_verify("test123", memory, identity)
        output = capsys.readouterr().out
        assert "VERIFIED" in output
        assert did in output

    def test_verify_nonexistent_video(self, memory, identity, capsys):
        """Verifying a non-existent video ID prints an error."""
        from dina.chat import _handle_verify

        _handle_verify("nonexistent", memory, identity)
        output = capsys.readouterr().out
        assert "No verdict found" in output

    def test_verify_unsigned_verdict(self, memory, identity, capsys):
        """Verifying an unsigned verdict prints 'no signature'."""
        from dina.chat import _handle_verify

        verdict = ProductVerdict(
            product_name="UnsignedPhone",
            verdict="WAIT",
            confidence_score=50,
            pros=["ok"],
            cons=["meh"],
            expert_source="Source",
        )
        memory.store(verdict, "https://youtu.be/nosig", "nosig")

        _handle_verify("nosig", memory, identity)
        output = capsys.readouterr().out
        assert "before signing was enabled" in output

    def test_verify_tampered_signature(self, memory, identity, capsys):
        """A verdict with a tampered signature prints INVALID."""
        from dina.chat import _handle_verify

        verdict = ProductVerdict(
            product_name="TamperedPhone",
            verdict="AVOID",
            confidence_score=10,
            pros=["none"],
            cons=["all"],
            expert_source="Source",
        )
        sig_hex, did = sign_verdict(verdict, identity)
        # Tamper with signature
        tampered_sig = "ff" * 64
        verdict.signature_hex = tampered_sig
        verdict.signer_did = did
        memory.store(verdict, "https://youtu.be/tamper1", "tamper1")

        _handle_verify("tamper1", memory, identity)
        output = capsys.readouterr().out
        assert "INVALID" in output

    def test_verify_with_wrong_identity(self, memory, identity, tmp_path, capsys):
        """Verifying with a different identity prints INVALID."""
        from dina.chat import _handle_verify

        verdict = ProductVerdict(
            product_name="CrossKeyPhone",
            verdict="BUY",
            confidence_score=80,
            pros=["nice"],
            cons=["pricey"],
            expert_source="Source",
        )
        sig_hex, did = sign_verdict(verdict, identity)
        verdict.signature_hex = sig_hex
        verdict.signer_did = did
        memory.store(verdict, "https://youtu.be/cross1", "cross1")

        # Verify with a different identity
        other_identity = DinaIdentity(identity_dir=tmp_path / "other_identity")
        _handle_verify("cross1", memory, other_identity)
        output = capsys.readouterr().out
        assert "INVALID" in output


# ── /history command ───────────────────────────────────────────────


class TestHandleHistory:
    """Tests for the /history command with [SIGNED] and [CERAMIC] indicators."""

    def test_history_empty(self, memory, capsys):
        """Empty history prints a helpful message."""
        from dina.chat import _handle_history

        _handle_history(memory)
        output = capsys.readouterr().out
        assert "No verdicts stored yet" in output

    def test_history_shows_signed_indicator(self, memory, capsys):
        """Signed verdicts show [SIGNED] in history output."""
        from dina.chat import _handle_history

        verdict = ProductVerdict(
            product_name="SignedPhone",
            verdict="BUY",
            confidence_score=90,
            pros=["great"],
            cons=["minor"],
            expert_source="Source",
            signature_hex="ab" * 64,
            signer_did="did:key:z6MkTest",
        )
        memory.store(verdict, "https://youtu.be/hist1", "hist1")

        _handle_history(memory)
        output = capsys.readouterr().out
        assert "[SIGNED]" in output
        assert "SignedPhone" in output

    def test_history_unsigned_no_indicator(self, memory, capsys):
        """Unsigned verdicts do NOT show [SIGNED] in history output."""
        from dina.chat import _handle_history

        verdict = ProductVerdict(
            product_name="UnsignedPhone",
            verdict="WAIT",
            confidence_score=50,
            pros=["ok"],
            cons=["meh"],
            expert_source="Source",
        )
        memory.store(verdict, "https://youtu.be/hist2", "hist2")

        _handle_history(memory)
        output = capsys.readouterr().out
        assert "[SIGNED]" not in output
        assert "UnsignedPhone" in output

    def test_history_shows_ceramic_indicator(self, memory, capsys):
        """Verdicts with stream_id show [CERAMIC] in history output."""
        from dina.chat import _handle_history

        verdict = ProductVerdict(
            product_name="CeramicPhone",
            verdict="BUY",
            confidence_score=92,
            pros=["synced"],
            cons=["none"],
            expert_source="Source",
            signature_hex="ab" * 64,
            signer_did="did:key:z6MkTest",
            stream_id="kjzl6abc123",
        )
        memory.store(verdict, "https://youtu.be/ceramic1", "ceramic1")

        _handle_history(memory)
        output = capsys.readouterr().out
        assert "[CERAMIC]" in output
        assert "[SIGNED]" in output
        assert "CeramicPhone" in output


# ── URL handling (signing flow) ────────────────────────────────────


class TestHandleUrl:
    """Tests for _handle_url signing integration (mocked LLM + transcript)."""

    def test_url_handler_signs_verdict_transcript_path(self, memory, identity, mock_prov, capsys):
        """_handle_url (transcript path) signs the verdict and stores the signature."""
        mock_verdict = ProductVerdict(
            product_name="MockPhone",
            verdict="BUY",
            confidence_score=88,
            pros=["fast", "great camera"],
            cons=["expensive"],
            expert_source="MockReviewer",
        )

        mock_result = MagicMock()
        mock_result.output = mock_verdict

        video_id = "mOcKvId1234"
        url = f"https://www.youtube.com/watch?v={video_id}"

        mock_prov.can_analyze_video = False

        with (
            patch("dina.chat.fetch_youtube_transcript", return_value="fake transcript"),
            patch("dina.chat.verdict_agent") as mock_agent,
            patch("dina.chat.providers", mock_prov),
        ):
            mock_agent.run_sync.return_value = mock_result
            from dina.chat import _handle_url

            _handle_url(url, memory, identity)

        output = capsys.readouterr().out
        assert "Signed by: did:key:z6Mk" in output
        assert "Stored in memory" in output

        # Verify the verdict was stored with signature
        item = memory.get_by_video_id(video_id)
        assert item is not None
        assert "signature_hex" in item["metadata"]
        assert "signer_did" in item["metadata"]
        assert "verdict_canonical" in item["metadata"]

    def test_url_handler_signature_verifies(self, memory, identity, mock_prov, capsys):
        """The signature stored by _handle_url is verifiable."""
        mock_verdict = ProductVerdict(
            product_name="VerifyPhone",
            verdict="WAIT",
            confidence_score=60,
            pros=["ok screen"],
            cons=["slow"],
            expert_source="Reviewer",
        )

        mock_result = MagicMock()
        mock_result.output = mock_verdict

        video_id = "vErIfYvId12"
        url = f"https://www.youtube.com/watch?v={video_id}"

        mock_prov.can_analyze_video = False

        with (
            patch("dina.chat.fetch_youtube_transcript", return_value="fake transcript"),
            patch("dina.chat.verdict_agent") as mock_agent,
            patch("dina.chat.providers", mock_prov),
        ):
            mock_agent.run_sync.return_value = mock_result
            from dina.chat import _handle_url

            _handle_url(url, memory, identity)

        capsys.readouterr()  # clear

        # Now verify
        from dina.chat import _handle_verify

        _handle_verify(video_id, memory, identity)
        output = capsys.readouterr().out
        assert "VERIFIED" in output

    def test_url_handler_video_path(self, memory, identity, mock_prov, capsys):
        """_handle_url uses VideoUrl when providers.can_analyze_video is True."""
        mock_verdict = ProductVerdict(
            product_name="VideoPhone",
            verdict="BUY",
            confidence_score=92,
            pros=["amazing screen"],
            cons=["heavy"],
            expert_source="VideoReviewer",
        )

        mock_result = MagicMock()
        mock_result.output = mock_verdict

        video_id = "vIdEoAnAlYz"
        url = f"https://www.youtube.com/watch?v={video_id}"

        mock_prov.can_analyze_video = True

        with (
            patch("dina.chat.verdict_agent") as mock_agent,
            patch("dina.chat.providers", mock_prov),
        ):
            mock_agent.run_sync.return_value = mock_result
            from dina.chat import _handle_url

            _handle_url(url, memory, identity)

        output = capsys.readouterr().out
        assert "Analysing video natively" in output
        assert "Signed by: did:key:z6Mk" in output

        # Verify the verdict was stored
        item = memory.get_by_video_id(video_id)
        assert item is not None
        assert item["metadata"]["product_name"] == "VideoPhone"


# ── URL handling with vault dual-write ─────────────────────────────


class TestHandleUrlWithVault:
    """Tests for _handle_url vault dual-write integration."""

    def test_dual_write_stores_stream_id(self, memory, identity, mock_prov, capsys):
        """When vault publishes successfully, stream_id is stored in ChromaDB."""
        mock_verdict = ProductVerdict(
            product_name="VaultPhone",
            verdict="BUY",
            confidence_score=95,
            pros=["decentralized"],
            cons=["none"],
            expert_source="VaultReviewer",
        )

        mock_result = MagicMock()
        mock_result.output = mock_verdict

        video_id = "vAuLtViD123"
        url = f"https://www.youtube.com/watch?v={video_id}"

        mock_vault = MagicMock()
        mock_vault.publish.return_value = "kjzl6dual123"
        mock_vault.enabled = True

        mock_prov.can_analyze_video = False

        with (
            patch("dina.chat.fetch_youtube_transcript", return_value="fake transcript"),
            patch("dina.chat.verdict_agent") as mock_agent,
            patch("dina.chat.providers", mock_prov),
        ):
            mock_agent.run_sync.return_value = mock_result
            from dina.chat import _handle_url

            _handle_url(url, memory, identity, vault=mock_vault)

        output = capsys.readouterr().out
        assert "Published to Ceramic: kjzl6dual123" in output

        # Verify stream_id was stored in ChromaDB
        item = memory.get_by_video_id(video_id)
        assert item is not None
        assert item["metadata"]["stream_id"] == "kjzl6dual123"

    def test_vault_publish_called_with_correct_args(self, memory, identity, mock_prov, capsys):
        """vault.publish is called with the signed verdict, video_id, and url."""
        mock_verdict = ProductVerdict(
            product_name="ArgPhone",
            verdict="WAIT",
            confidence_score=50,
            pros=["ok"],
            cons=["meh"],
            expert_source="Source",
        )

        mock_result = MagicMock()
        mock_result.output = mock_verdict

        video_id = "aRgViD12345"
        url = f"https://www.youtube.com/watch?v={video_id}"

        mock_vault = MagicMock()
        mock_vault.publish.return_value = "kjzl6args456"
        mock_vault.enabled = True

        mock_prov.can_analyze_video = False

        with (
            patch("dina.chat.fetch_youtube_transcript", return_value="fake transcript"),
            patch("dina.chat.verdict_agent") as mock_agent,
            patch("dina.chat.providers", mock_prov),
        ):
            mock_agent.run_sync.return_value = mock_result
            from dina.chat import _handle_url

            _handle_url(url, memory, identity, vault=mock_vault)

        # Verify vault.publish was called with the right args
        mock_vault.publish.assert_called_once()
        call_args = mock_vault.publish.call_args
        assert call_args[0][1] == video_id  # video_id
        assert call_args[0][2] == url  # url
        # First arg is the verdict (with signature set)
        published_verdict = call_args[0][0]
        assert published_verdict.signature_hex is not None
        assert published_verdict.signer_did is not None


class TestHandleUrlVaultFailure:
    """Tests for _handle_url when vault publish fails."""

    def test_chromadb_still_works_on_vault_failure(self, memory, identity, mock_prov, capsys):
        """ChromaDB storage works even when vault.publish returns None."""
        mock_verdict = ProductVerdict(
            product_name="FailVaultPhone",
            verdict="BUY",
            confidence_score=80,
            pros=["local"],
            cons=["no sync"],
            expert_source="Source",
        )

        mock_result = MagicMock()
        mock_result.output = mock_verdict

        video_id = "fAiLvAuLt12"
        url = f"https://www.youtube.com/watch?v={video_id}"

        mock_vault = MagicMock()
        mock_vault.publish.return_value = None
        mock_vault.enabled = True

        mock_prov.can_analyze_video = False

        with (
            patch("dina.chat.fetch_youtube_transcript", return_value="fake transcript"),
            patch("dina.chat.verdict_agent") as mock_agent,
            patch("dina.chat.providers", mock_prov),
        ):
            mock_agent.run_sync.return_value = mock_result
            from dina.chat import _handle_url

            _handle_url(url, memory, identity, vault=mock_vault)

        output = capsys.readouterr().out
        assert "Stored in memory" in output
        assert "Ceramic publish failed" in output

        # ChromaDB still has the verdict
        item = memory.get_by_video_id(video_id)
        assert item is not None
        assert item["metadata"]["product_name"] == "FailVaultPhone"
        assert "stream_id" not in item["metadata"]


# ── /vault command ─────────────────────────────────────────────────


class TestHandleVaultCommand:
    """Tests for the /vault command handler."""

    def test_vault_disabled_message(self, capsys):
        """_handle_vault prints disabled message when vault is None."""
        from dina.chat import _handle_vault

        _handle_vault(None)
        output = capsys.readouterr().out
        assert "disabled" in output

    def test_vault_disabled_when_not_enabled(self, capsys):
        """_handle_vault prints disabled when vault.enabled is False."""
        from dina.chat import _handle_vault

        mock_vault = MagicMock()
        mock_vault.enabled = False
        _handle_vault(mock_vault)
        output = capsys.readouterr().out
        assert "disabled" in output

    def test_vault_shows_status(self, capsys):
        """_handle_vault prints vault status lines when enabled."""
        from dina.chat import _handle_vault

        mock_vault = MagicMock()
        mock_vault.enabled = True
        mock_vault.status_lines = [
            "Vault: http://localhost:7007 (connected)",
            "Vault synced: 3 verdict(s)",
        ]
        _handle_vault(mock_vault)
        output = capsys.readouterr().out
        assert "connected" in output
        assert "3 verdict(s)" in output


# ── REPL banner and routing ────────────────────────────────────────


class TestReplBanner:
    """Tests for REPL banner content."""

    def test_banner_version(self, mock_prov):
        with patch("dina.chat.providers", mock_prov):
            from dina.chat import _make_banner

            banner = _make_banner()
            assert "v0.4" in banner

    def test_banner_mentions_identity_command(self, mock_prov):
        with patch("dina.chat.providers", mock_prov):
            from dina.chat import _make_banner

            banner = _make_banner()
            assert "/identity" in banner

    def test_banner_mentions_verify_command(self, mock_prov):
        with patch("dina.chat.providers", mock_prov):
            from dina.chat import _make_banner

            banner = _make_banner()
            assert "/verify" in banner

    def test_banner_mentions_vault_command(self, mock_prov):
        with patch("dina.chat.providers", mock_prov):
            from dina.chat import _make_banner

            banner = _make_banner()
            assert "/vault" in banner

    def test_banner_shows_provider_info(self, mock_prov):
        with patch("dina.chat.providers", mock_prov):
            from dina.chat import _make_banner

            banner = _make_banner()
            assert "Light:" in banner
            assert "Heavy:" in banner

    def test_banner_shows_vault_status(self, mock_prov):
        """Banner includes vault status lines when vault is passed."""
        mock_vault = MagicMock()
        mock_vault.status_lines = ["Vault: disabled (set DINA_CERAMIC_URL to enable)"]

        with patch("dina.chat.providers", mock_prov):
            from dina.chat import _make_banner

            banner = _make_banner(vault=mock_vault)
            assert "Vault:" in banner


class TestReplRouting:
    """Tests for REPL command routing (mocked input/output)."""

    def _mock_vault(self):
        """Create a disabled mock vault for REPL tests."""
        mock = MagicMock()
        mock.enabled = False
        mock.status_lines = ["Vault: disabled (set DINA_CERAMIC_URL to enable)"]
        return mock

    def test_identity_command_routes(self, identity, memory, mock_prov, capsys, tmp_path):
        """Typing /identity routes to _handle_identity."""
        from dina.did_key import derive_did_key

        inputs = iter(["/identity", "/quit"])

        with (
            patch("builtins.input", side_effect=inputs),
            patch("dina.chat.DinaIdentity", return_value=identity),
            patch("dina.chat.VerdictMemory", return_value=memory),
            patch("dina.chat.CeramicVault", return_value=self._mock_vault()),
            patch("dina.chat.providers", mock_prov),
        ):
            from dina.chat import repl

            repl()

        output = capsys.readouterr().out
        did = derive_did_key(identity)
        # Should print DID Document JSON and also the identity in the banner
        assert did in output
        assert "@context" in output

    def test_verify_command_without_arg(self, identity, memory, mock_prov, capsys):
        """Typing /verify without args prints usage."""
        inputs = iter(["/verify", "/quit"])

        with (
            patch("builtins.input", side_effect=inputs),
            patch("dina.chat.DinaIdentity", return_value=identity),
            patch("dina.chat.VerdictMemory", return_value=memory),
            patch("dina.chat.CeramicVault", return_value=self._mock_vault()),
            patch("dina.chat.providers", mock_prov),
        ):
            from dina.chat import repl

            repl()

        output = capsys.readouterr().out
        assert "Usage: /verify <video_id>" in output

    def test_vault_command_routes(self, identity, memory, mock_prov, capsys):
        """Typing /vault routes to _handle_vault."""
        inputs = iter(["/vault", "/quit"])

        with (
            patch("builtins.input", side_effect=inputs),
            patch("dina.chat.DinaIdentity", return_value=identity),
            patch("dina.chat.VerdictMemory", return_value=memory),
            patch("dina.chat.CeramicVault", return_value=self._mock_vault()),
            patch("dina.chat.providers", mock_prov),
        ):
            from dina.chat import repl

            repl()

        output = capsys.readouterr().out
        assert "disabled" in output

    def test_unknown_command_lists_all_commands(self, identity, memory, mock_prov, capsys):
        """Unknown commands show the full command list including new ones."""
        inputs = iter(["/unknown", "/quit"])

        with (
            patch("builtins.input", side_effect=inputs),
            patch("dina.chat.DinaIdentity", return_value=identity),
            patch("dina.chat.VerdictMemory", return_value=memory),
            patch("dina.chat.CeramicVault", return_value=self._mock_vault()),
            patch("dina.chat.providers", mock_prov),
        ):
            from dina.chat import repl

            repl()

        output = capsys.readouterr().out
        assert "/identity" in output
        assert "/verify" in output
        assert "/vault" in output

    def test_quit_command(self, identity, memory, mock_prov, capsys):
        """Typing /quit exits the REPL."""
        inputs = iter(["/quit"])

        with (
            patch("builtins.input", side_effect=inputs),
            patch("dina.chat.DinaIdentity", return_value=identity),
            patch("dina.chat.VerdictMemory", return_value=memory),
            patch("dina.chat.CeramicVault", return_value=self._mock_vault()),
            patch("dina.chat.providers", mock_prov),
        ):
            from dina.chat import repl

            repl()

        output = capsys.readouterr().out
        assert "Goodbye" in output

    def test_eof_exits(self, identity, memory, mock_prov, capsys):
        """EOFError (Ctrl+D) exits the REPL gracefully."""
        with (
            patch("builtins.input", side_effect=EOFError),
            patch("dina.chat.DinaIdentity", return_value=identity),
            patch("dina.chat.VerdictMemory", return_value=memory),
            patch("dina.chat.CeramicVault", return_value=self._mock_vault()),
            patch("dina.chat.providers", mock_prov),
        ):
            from dina.chat import repl

            repl()

        output = capsys.readouterr().out
        assert "Goodbye" in output

    def test_keyboard_interrupt_exits(self, identity, memory, mock_prov, capsys):
        """KeyboardInterrupt (Ctrl+C) exits the REPL gracefully."""
        with (
            patch("builtins.input", side_effect=KeyboardInterrupt),
            patch("dina.chat.DinaIdentity", return_value=identity),
            patch("dina.chat.VerdictMemory", return_value=memory),
            patch("dina.chat.CeramicVault", return_value=self._mock_vault()),
            patch("dina.chat.providers", mock_prov),
        ):
            from dina.chat import repl

            repl()

        output = capsys.readouterr().out
        assert "Goodbye" in output
