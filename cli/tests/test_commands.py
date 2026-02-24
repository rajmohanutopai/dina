"""Tests for CLI commands using click.testing.CliRunner."""

from __future__ import annotations

import json
import os
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from dina_cli.client import DinaClientError
from dina_cli.main import cli


def _env(**overrides):
    """Minimal env vars for CLI to start."""
    base = {"DINA_CLIENT_TOKEN": "test-token"}
    base.update(overrides)
    return base


def _invoke(args, mock_client=None, env=None):
    """Helper: invoke CLI with mocked client."""
    runner = CliRunner()
    with patch("dina_cli.main.DinaClient") as MockCls:
        if mock_client:
            MockCls.return_value = mock_client
        result = runner.invoke(cli, args, env=env or _env())
    return result


# ── remember ──────────────────────────────────────────────────────────────


def test_remember_json():
    mc = MagicMock()
    mc.vault_store.return_value = {"item_id": "abc12345deadbeef"}
    result = _invoke(["--json", "remember", "Buy milk"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["stored"] is True
    assert data["id"].startswith("mem_")
    mc.vault_store.assert_called_once()


def test_remember_human():
    mc = MagicMock()
    mc.vault_store.return_value = {"item_id": "abc12345"}
    result = _invoke(["remember", "Buy milk"], mock_client=mc)
    assert result.exit_code == 0
    assert "stored: True" in result.output


def test_remember_with_category():
    mc = MagicMock()
    mc.vault_store.return_value = {"item_id": "x"}
    result = _invoke(["--json", "remember", "Alice bday March 15", "--category", "relationship"], mock_client=mc)
    assert result.exit_code == 0
    call_args = mc.vault_store.call_args
    item = call_args[0][1]  # second positional arg
    assert '"category": "relationship"' in item["metadata"]


# ── recall ────────────────────────────────────────────────────────────────


def test_recall_json():
    mc = MagicMock()
    mc.vault_query.return_value = [
        {"ID": "abc123", "Summary": "Buy milk", "IngestedAt": 1700000000},
    ]
    result = _invoke(["--json", "recall", "milk"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert len(data) == 1
    assert data[0]["content"] == "Buy milk"


def test_recall_empty():
    mc = MagicMock()
    mc.vault_query.return_value = []
    result = _invoke(["--json", "recall", "nonexistent"], mock_client=mc)
    assert result.exit_code == 0
    assert json.loads(result.output) == []


# ── validate ──────────────────────────────────────────────────────────────


def test_validate_approved():
    mc = MagicMock()
    mc.process_event.return_value = {"approved": True, "requires_approval": False, "risk": "SAFE"}
    mc.kv_set.return_value = None
    result = _invoke(["--json", "validate", "read_email", "Read inbox"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "approved"
    assert data["id"].startswith("val_")


def test_validate_pending():
    mc = MagicMock()
    mc.process_event.return_value = {"approved": False, "requires_approval": True, "risk": "HIGH"}
    mc.kv_set.return_value = None
    result = _invoke(["--json", "validate", "delete_emails", "Delete 247 emails", "--count", "247"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "pending_approval"
    assert "dashboard_url" in data


def test_validate_fallback_safe():
    """When Brain is unavailable, safe actions auto-approve."""
    mc = MagicMock()
    mc.process_event.side_effect = DinaClientError("Brain not configured. Set DINA_BRAIN_TOKEN.")
    result = _invoke(["--json", "validate", "search", "Search inbox"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "approved"


def test_validate_fallback_risky():
    """When Brain is unavailable, risky actions need approval."""
    mc = MagicMock()
    mc.process_event.side_effect = DinaClientError("Brain not configured. Set DINA_BRAIN_TOKEN.")
    result = _invoke(["--json", "validate", "send_email", "Send to 500 people"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "pending_approval"


# ── validate-status ───────────────────────────────────────────────────────


def test_validate_status_found():
    mc = MagicMock()
    mc.kv_get.return_value = json.dumps({"status": "approved", "action": "read_email"})
    result = _invoke(["--json", "validate-status", "val_abc12345"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "approved"
    assert data["id"] == "val_abc12345"


def test_validate_status_not_found():
    mc = MagicMock()
    mc.kv_get.return_value = None
    result = _invoke(["--json", "validate-status", "val_missing"], mock_client=mc)
    assert result.exit_code != 0


# ── scrub ─────────────────────────────────────────────────────────────────


def test_scrub_json(tmp_path):
    mc = MagicMock()
    mc.pii_scrub.return_value = {
        "scrubbed": "[EMAIL_1] sent a message",
        "entities": [{"Type": "EMAIL", "Value": "john@ex.com", "Start": 0, "End": 11}],
    }
    runner = CliRunner()
    with patch("dina_cli.main.DinaClient", return_value=mc), \
         patch("dina_cli.main.SessionStore") as MockSS:
        mock_store = MagicMock()
        mock_store.new_id.return_value = "sess_test1234"
        MockSS.return_value = mock_store
        result = runner.invoke(cli, ["--json", "scrub", "john@ex.com sent a message"], env=_env())
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["scrubbed"] == "[EMAIL_1] sent a message"
    assert data["session"] == "sess_test1234"


# ── rehydrate ─────────────────────────────────────────────────────────────


def test_rehydrate_json():
    runner = CliRunner()
    with patch("dina_cli.main.DinaClient"), \
         patch("dina_cli.main.SessionStore") as MockSS:
        mock_store = MagicMock()
        mock_store.rehydrate.return_value = "Dr. Sharma at Apollo Hospital"
        MockSS.return_value = mock_store
        result = runner.invoke(
            cli,
            ["--json", "rehydrate", "[PERSON_1] at [ORG_1]", "--session", "sess_abc"],
            env=_env(),
        )
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["restored"] == "Dr. Sharma at Apollo Hospital"


# ── draft ─────────────────────────────────────────────────────────────────


def test_draft_json():
    mc = MagicMock()
    mc.vault_store.return_value = {"item_id": "draftitem123"}
    result = _invoke(
        ["--json", "draft", "Hello!", "--to", "alice@ex.com", "--channel", "email", "--subject", "Hi"],
        mock_client=mc,
    )
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "pending_review"
    assert data["draft_id"].startswith("drf_")


# ── sign ──────────────────────────────────────────────────────────────────


def test_sign_json():
    mc = MagicMock()
    mc.did_get.return_value = {"id": "did:key:z6Mk123"}
    mc.did_sign.return_value = {"signature": "deadbeef"}
    result = _invoke(["--json", "sign", "I approve the budget"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["signed_by"] == "did:key:z6Mk123"
    assert data["signature"] == "deadbeef"
    assert "timestamp" in data


# ── audit ─────────────────────────────────────────────────────────────────


def test_audit_json():
    mc = MagicMock()
    mc.vault_query.return_value = [
        {"Type": "note", "Summary": "Bought milk", "Source": "dina-cli", "IngestedAt": 1700000000},
    ]
    result = _invoke(["--json", "audit", "--limit", "5"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert len(data) == 1
    assert data[0]["action"] == "note"


# ── missing token ─────────────────────────────────────────────────────────


def test_missing_token():
    runner = CliRunner()
    result = runner.invoke(cli, ["--json", "recall", "test"], env={})
    assert result.exit_code != 0


# ── configure ─────────────────────────────────────────────────────────────


def test_configure_signature_mode(tmp_path):
    """Configure in Ed25519 signing mode generates keypair and attempts pairing."""
    runner = CliRunner()
    identity_dir = tmp_path / "identity"

    with patch("dina_cli.main._configure_signature") as mock_sig, \
         patch("dina_cli.main.save_config") as mock_save:
        mock_save.return_value = tmp_path / "config.json"
        # Input: core_url (default), auth=1 (signature), device_name, brain_url, brain_token, persona, test=no
        user_input = "\n".join([
            "",           # core_url (default)
            "1",          # Ed25519 signing
            "my-laptop",  # device name
            "",           # brain_url (default)
            "",           # brain_token (skip)
            "",           # persona (default)
            "n",          # don't test connection
        ])
        result = runner.invoke(cli, ["configure"], input=user_input, env={})

    assert result.exit_code == 0
    assert "Ed25519 signing" in result.output
    mock_sig.assert_called_once()
    # Verify save_config was called with auth_mode="signature"
    saved = mock_save.call_args[0][0]
    assert saved["auth_mode"] == "signature"
    assert saved["device_name"] == "my-laptop"


def test_configure_token_mode(tmp_path):
    """Configure in legacy Bearer token mode saves client_token."""
    runner = CliRunner()

    with patch("dina_cli.main.save_config") as mock_save:
        mock_save.return_value = tmp_path / "config.json"
        user_input = "\n".join([
            "",               # core_url (default)
            "2",              # Bearer token
            "my-secret-tok",  # client token
            "",               # brain_url (default)
            "",               # brain_token (skip)
            "",               # persona (default)
            "n",              # don't test connection
        ])
        result = runner.invoke(cli, ["configure"], input=user_input, env={})

    assert result.exit_code == 0
    assert "Bearer token" in result.output
    saved = mock_save.call_args[0][0]
    assert saved["auth_mode"] == "token"
    assert saved["client_token"] == "my-secret-tok"


def test_configure_help():
    """Configure --help shows without requiring a token."""
    runner = CliRunner()
    result = runner.invoke(cli, ["configure", "--help"], env={})
    assert result.exit_code == 0
    assert "Set up connection" in result.output
