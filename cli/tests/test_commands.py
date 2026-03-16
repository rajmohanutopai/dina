"""Tests for CLI commands using click.testing.CliRunner."""

from __future__ import annotations

import json
import os
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from dina_cli.client import DinaClientError
from dina_cli.main import cli


def _test_config():
    """Return a Config suitable for tests (no real keypair needed)."""
    from dina_cli.config import Config
    return Config(
        core_url="http://localhost:8100",
        persona="personal",
        timeout=5.0,
        device_name="test-device",
    )


def _invoke(args, mock_client=None, env=None):
    """Helper: invoke CLI with mocked client and config."""
    runner = CliRunner()
    with patch("dina_cli.main.DinaClient") as MockCls, \
         patch("dina_cli.main.load_config", return_value=_test_config()):
        if mock_client:
            MockCls.return_value = mock_client
        result = runner.invoke(cli, args, env=env or {})
    return result


# ── remember ──────────────────────────────────────────────────────────────


# TST-CLI-028
def test_remember_json():
    mc = MagicMock()
    mc.vault_store.return_value = {"item_id": "abc12345deadbeef"}
    result = _invoke(["--json", "remember", "Buy milk"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["stored"] is True
    assert data["id"].startswith("mem_")
    mc.vault_store.assert_called_once()


# TST-CLI-029
def test_remember_human():
    mc = MagicMock()
    mc.vault_store.return_value = {"item_id": "abc12345"}
    result = _invoke(["remember", "Buy milk"], mock_client=mc)
    assert result.exit_code == 0
    assert "stored: True" in result.output


# TST-CLI-030
def test_remember_with_category():
    mc = MagicMock()
    mc.vault_store.return_value = {"item_id": "x"}
    result = _invoke(["--json", "remember", "Alice bday March 15", "--category", "relationship"], mock_client=mc)
    assert result.exit_code == 0
    call_args = mc.vault_store.call_args
    item = call_args[0][1]  # second positional arg
    assert '"category": "relationship"' in item["metadata"]


# ── recall ────────────────────────────────────────────────────────────────


# TST-CLI-031
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


# TST-CLI-032
def test_recall_empty():
    mc = MagicMock()
    mc.vault_query.return_value = []
    result = _invoke(["--json", "recall", "nonexistent"], mock_client=mc)
    assert result.exit_code == 0
    assert json.loads(result.output) == []


# ── validate ──────────────────────────────────────────────────────────────


# TST-CLI-033
def test_validate_approved():
    mc = MagicMock()
    mc.process_event.return_value = {"approved": True, "requires_approval": False, "risk": "SAFE"}
    mc.kv_set.return_value = None
    result = _invoke(["--json", "validate", "read_email", "Read inbox"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "approved"
    assert data["id"].startswith("val_")


# TST-CLI-034
def test_validate_pending():
    mc = MagicMock()
    mc.process_event.return_value = {"approved": False, "requires_approval": True, "risk": "HIGH"}
    mc.kv_set.return_value = None
    result = _invoke(["--json", "validate", "delete_emails", "Delete 247 emails", "--count", "247"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "pending_approval"
    assert "dashboard_url" in data


# TST-CLI-035
def test_validate_fallback_safe():
    """When Core is unavailable, safe actions auto-approve."""
    mc = MagicMock()
    mc.process_event.side_effect = DinaClientError("Cannot reach Dina at http://localhost:8100. Is it running?")
    result = _invoke(["--json", "validate", "search", "Search inbox"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "approved"


# TST-CLI-036
def test_validate_fallback_risky():
    """When Core is unavailable, risky actions need approval."""
    mc = MagicMock()
    mc.process_event.side_effect = DinaClientError("Cannot reach Dina at http://localhost:8100. Is it running?")
    result = _invoke(["--json", "validate", "send_email", "Send to 500 people"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "pending_approval"


# ── validate-status ───────────────────────────────────────────────────────


# TST-CLI-037
def test_validate_status_found():
    mc = MagicMock()
    mc.kv_get.return_value = json.dumps({"status": "approved", "action": "read_email"})
    result = _invoke(["--json", "validate-status", "val_abc12345"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "approved"
    assert data["id"] == "val_abc12345"


# TST-CLI-038
def test_validate_status_not_found():
    mc = MagicMock()
    mc.kv_get.return_value = None
    result = _invoke(["--json", "validate-status", "val_missing"], mock_client=mc)
    assert result.exit_code != 0


# ── scrub ─────────────────────────────────────────────────────────────────


# TST-CLI-039
def test_scrub_json(tmp_path):
    mc = MagicMock()
    mc.pii_scrub.return_value = {
        "scrubbed": "[EMAIL_1] sent a message",
        "entities": [{"Type": "EMAIL", "Value": "john@ex.com", "Start": 0, "End": 11}],
    }
    runner = CliRunner()
    with patch("dina_cli.main.DinaClient", return_value=mc), \
         patch("dina_cli.main.load_config", return_value=_test_config()), \
         patch("dina_cli.main.SessionStore") as MockSS:
        mock_store = MagicMock()
        mock_store.new_id.return_value = "sess_test1234"
        MockSS.return_value = mock_store
        result = runner.invoke(cli, ["--json", "scrub", "john@ex.com sent a message"], env={})
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["scrubbed"] == "[EMAIL_1] sent a message"
    assert data["session"] == "sess_test1234"


# ── rehydrate ─────────────────────────────────────────────────────────────


# TST-CLI-040
def test_rehydrate_json():
    runner = CliRunner()
    with patch("dina_cli.main.DinaClient"), \
         patch("dina_cli.main.load_config", return_value=_test_config()), \
         patch("dina_cli.main.SessionStore") as MockSS:
        mock_store = MagicMock()
        mock_store.rehydrate.return_value = "Dr. Sharma at Apollo Hospital"
        MockSS.return_value = mock_store
        result = runner.invoke(
            cli,
            ["--json", "rehydrate", "[PERSON_1] at [ORG_1]", "--session", "sess_abc"],
            env={},
        )
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["restored"] == "Dr. Sharma at Apollo Hospital"


# ── draft ─────────────────────────────────────────────────────────────────


# TST-CLI-041
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


# TST-CLI-042
def test_sign_json(tmp_path):
    """sign command signs locally — no server call needed."""
    from dina_cli.signing import CLIIdentity

    identity = CLIIdentity(identity_dir=tmp_path / "identity")
    identity.generate()

    runner = CliRunner()
    with patch("dina_cli.signing.CLIIdentity", return_value=identity):
        result = runner.invoke(cli, ["--json", "sign", "I approve the budget"], env={})
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["signed_by"].startswith("did:key:z")
    assert len(data["signature"]) == 128  # Ed25519 sig = 64 bytes = 128 hex
    assert "timestamp" in data


# ── audit ─────────────────────────────────────────────────────────────────


# TST-CLI-043
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


# ── missing keypair ───────────────────────────────────────────────────────


# TST-CLI-044
def test_missing_keypair():
    """CLI exits with error when no Ed25519 keypair exists."""
    runner = CliRunner()
    result = runner.invoke(cli, ["--json", "recall", "test"], env={})
    assert result.exit_code != 0


# ── configure ─────────────────────────────────────────────────────────────


# TST-CLI-045
def test_configure_signature_mode(tmp_path):
    """Configure generates Ed25519 keypair and attempts pairing."""
    runner = CliRunner()

    with patch("dina_cli.main._configure_signature") as mock_sig, \
         patch("dina_cli.main.save_config") as mock_save:
        mock_save.return_value = tmp_path / "config.json"
        # Input: core_url (default), device_name, persona, test=no
        user_input = "\n".join([
            "",           # core_url (default)
            "my-laptop",  # device name
            "",           # persona (default)
            "n",          # don't test connection
        ])
        result = runner.invoke(cli, ["configure"], input=user_input, env={})

    assert result.exit_code == 0
    mock_sig.assert_called_once()
    saved = mock_save.call_args[0][0]
    assert saved["device_name"] == "my-laptop"
    assert "client_token" not in saved
    assert "auth_mode" not in saved
    assert "brain_url" not in saved
    assert "brain_token" not in saved


# TST-CLI-046
def test_configure_help():
    """Configure --help shows without requiring a token."""
    runner = CliRunner()
    result = runner.invoke(cli, ["configure", "--help"], env={})
    assert result.exit_code == 0
    assert "Set up connection" in result.output


# ── session ──────────────────────────────────────────────────────────────


# TST-CLI-047
def test_session_start():
    """Session start creates a named session."""
    mc = MagicMock()
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"id": "ses-123", "name": "research", "status": "active"}
    mc._request.return_value = mock_resp
    mc._core = MagicMock()
    result = _invoke(["session", "start", "--name", "research"], mock_client=mc)
    assert result.exit_code == 0
    assert "research" in result.output
    assert "active" in result.output


# TST-CLI-048
def test_session_end():
    """Session end closes a session."""
    mc = MagicMock()
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"status": "ended"}
    mc._request.return_value = mock_resp
    mc._core = MagicMock()
    result = _invoke(["session", "end", "--name", "research"], mock_client=mc)
    assert result.exit_code == 0
    assert "ended" in result.output


# TST-CLI-049
def test_session_list_empty():
    """Session list shows no sessions when none active."""
    mc = MagicMock()
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"sessions": []}
    mc._request.return_value = mock_resp
    mc._core = MagicMock()
    result = _invoke(["session", "list"], mock_client=mc)
    assert result.exit_code == 0
    assert "No active sessions" in result.output


# TST-CLI-050
def test_session_list_with_sessions():
    """Session list shows active sessions with grants."""
    mc = MagicMock()
    mock_resp = MagicMock()
    mock_resp.json.return_value = {
        "sessions": [
            {
                "id": "ses-123",
                "name": "chair-research",
                "status": "active",
                "grants": [{"persona_id": "health"}],
            }
        ]
    }
    mc._request.return_value = mock_resp
    mc._core = MagicMock()
    result = _invoke(["session", "list"], mock_client=mc)
    assert result.exit_code == 0
    assert "chair-research" in result.output
    assert "health" in result.output


# TST-CLI-051
def test_session_start_json():
    """Session start with --json returns JSON."""
    mc = MagicMock()
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"id": "ses-456", "name": "tax", "status": "active"}
    mc._request.return_value = mock_resp
    mc._core = MagicMock()
    result = _invoke(["--json", "session", "start", "--name", "tax"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["name"] == "tax"


# ── recall with session ──────────────────────────────────────────────────


# TST-CLI-052
def test_recall_with_session_passes_header():
    """Recall with --session passes X-Session header."""
    mc = MagicMock()
    mc.vault_query.return_value = []
    result = _invoke(
        ["recall", "back pain", "--session", "chair-research", "--persona", "health"],
        mock_client=mc,
    )
    assert result.exit_code == 0
    # Verify vault_query was called with extra_headers containing X-Session
    mc.vault_query.assert_called_once()
    call_kwargs = mc.vault_query.call_args
    assert call_kwargs[1].get("extra_headers", {}).get("X-Session") == "chair-research"


# TST-CLI-053
def test_recall_persona_locked_shows_hint():
    """Recall shows helpful message when persona is locked."""
    mc = MagicMock()
    mc.vault_query.side_effect = DinaClientError("Access denied: persona locked")
    result = _invoke(["recall", "hello"], mock_client=mc)
    assert result.exit_code == 1
    assert "persona is locked" in result.output or "dina-admin" in result.output


# TST-CLI-054
def test_recall_with_verbose():
    """Recall --verbose flag is accepted."""
    mc = MagicMock()
    mc.vault_query.return_value = []
    result = _invoke(["-v", "recall", "hello"], mock_client=mc)
    assert result.exit_code == 0
