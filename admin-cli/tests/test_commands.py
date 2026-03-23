"""Tests for admin CLI commands using click.testing.CliRunner."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import click
import pytest
from click.testing import CliRunner

from dina_admin_cli.client import AdminClientError
from dina_admin_cli.main import cli


def _test_config():
    """Return a Config suitable for tests."""
    from dina_admin_cli.config import Config

    return Config(
        socket_path="/data/run/admin.sock",
        timeout=5.0,
    )


def _invoke(args, mock_client=None):
    """Helper: invoke CLI with mocked client and config."""
    runner = CliRunner()
    with patch("dina_admin_cli.main.AdminClient") as MockCls, \
         patch("dina_admin_cli.main.load_config", return_value=_test_config()):
        if mock_client:
            MockCls.return_value = mock_client
        result = runner.invoke(cli, args)
    return result


# ── status ───────────────────────────────────────────────────────────────────


def test_status_json():
    mc = MagicMock()
    mc.healthz.return_value = {"status": "ok"}
    mc.readyz.return_value = {"status": "ok"}
    mc.get_did.return_value = {"id": "did:key:z6MkTest"}
    mc.list_personas.return_value = [{"id": "p-1"}]
    mc.list_devices.return_value = {"devices": [{"id": "d-1"}]}
    result = _invoke(["--json", "status"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["core"] == "healthy"
    assert data["ready"] is True
    assert data["did"] == "did:key:z6MkTest"
    assert data["personas"] == 1
    assert data["devices"] == 1


def test_status_degraded():
    """Status shows partial info when some endpoints fail."""
    mc = MagicMock()
    mc.healthz.return_value = {"status": "ok"}
    mc.readyz.side_effect = AdminClientError("not ready")
    mc.get_did.return_value = {"id": "did:key:z6MkTest"}
    mc.list_personas.side_effect = AdminClientError("locked")
    mc.list_devices.return_value = {"devices": []}
    result = _invoke(["--json", "status"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["core"] == "healthy"
    assert data["ready"] is False
    assert data["personas"] == "?"


def test_status_human():
    """Human-readable status output."""
    mc = MagicMock()
    mc.healthz.return_value = {"status": "ok"}
    mc.readyz.return_value = {"status": "ok"}
    mc.get_did.return_value = {"id": "did:key:z6MkTest"}
    mc.list_personas.return_value = [{"id": "p-1"}]
    mc.list_devices.return_value = {"devices": [{"id": "d-1"}]}
    result = _invoke(["status"], mock_client=mc)
    assert result.exit_code == 0
    assert "healthy" in result.output
    assert "did:key:z6MkTest" in result.output


# ── device list ──────────────────────────────────────────────────────────────


def test_device_list_json():
    mc = MagicMock()
    mc.list_devices.return_value = {"devices": [
        {"id": "d-1", "name": "laptop"},
        {"id": "d-2", "name": "phone", "revoked": True},
    ]}
    result = _invoke(["--json", "device", "list"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert len(data) == 2


def test_device_list_empty():
    mc = MagicMock()
    mc.list_devices.return_value = {"devices": []}
    result = _invoke(["device", "list"], mock_client=mc)
    assert result.exit_code == 0
    assert "No paired devices" in result.output


def test_device_list_human():
    mc = MagicMock()
    mc.list_devices.return_value = {"devices": [
        {"id": "d-1", "name": "laptop"},
    ]}
    result = _invoke(["device", "list"], mock_client=mc)
    assert result.exit_code == 0
    assert "laptop" in result.output


# ── device pair ──────────────────────────────────────────────────────────────


def test_device_pair_json():
    mc = MagicMock()
    mc.initiate_pairing.return_value = {"code": "123456", "expires_in": 300}
    result = _invoke(["--json", "device", "pair"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["code"] == "123456"


def test_device_pair_human():
    mc = MagicMock()
    mc.initiate_pairing.return_value = {"code": "987654", "expires_in": 300}
    result = _invoke(["device", "pair"], mock_client=mc)
    assert result.exit_code == 0
    assert "987654" in result.output
    assert "300" in result.output


# ── device revoke ────────────────────────────────────────────────────────────


def test_device_revoke_json():
    mc = MagicMock()
    mc.revoke_device.return_value = None
    result = _invoke(["--json", "device", "revoke", "d-1"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "revoked"
    assert data["device_id"] == "d-1"


def test_device_revoke_error():
    mc = MagicMock()
    mc.revoke_device.side_effect = AdminClientError("HTTP 404: device not found")
    result = _invoke(["--json", "device", "revoke", "d-bad"], mock_client=mc)
    assert result.exit_code != 0


# ── persona list ─────────────────────────────────────────────────────────────


def test_persona_list_json():
    mc = MagicMock()
    mc.list_personas.return_value = [
        {"id": "persona-personal", "name": "personal", "tier": "open"},
    ]
    result = _invoke(["--json", "persona", "list"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert len(data) == 1


def test_persona_list_empty():
    mc = MagicMock()
    mc.list_personas.return_value = []
    result = _invoke(["persona", "list"], mock_client=mc)
    assert result.exit_code == 0
    assert "No personas" in result.output


# ── persona create ───────────────────────────────────────────────────────────


def test_persona_create_json():
    mc = MagicMock()
    mc.create_persona.return_value = {"id": "persona-work", "status": "created"}
    runner = CliRunner()
    with patch("dina_admin_cli.main.AdminClient", return_value=mc), \
         patch("dina_admin_cli.main.load_config", return_value=_test_config()):
        result = runner.invoke(cli, [
            "--json", "persona", "create",
            "--name", "work", "--tier", "standard", "--passphrase", "secret123",
        ])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "created"


# ── persona unlock ───────────────────────────────────────────────────────────


def test_persona_unlock_json():
    mc = MagicMock()
    mc.unlock_persona.return_value = {"status": "unlocked"}
    runner = CliRunner()
    with patch("dina_admin_cli.main.AdminClient", return_value=mc), \
         patch("dina_admin_cli.main.load_config", return_value=_test_config()):
        result = runner.invoke(cli, [
            "--json", "persona", "unlock",
            "--name", "personal", "--passphrase", "secret123",
        ])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "unlocked"


# ── identity show ────────────────────────────────────────────────────────────


def test_identity_show_json():
    mc = MagicMock()
    mc.get_did.return_value = {"id": "did:key:z6MkTest", "verificationMethod": []}
    result = _invoke(["--json", "identity", "show"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["id"].startswith("did:")


# ── identity sign ────────────────────────────────────────────────────────────


def test_identity_sign_json():
    mc = MagicMock()
    mc.sign_data.return_value = {"signature": "aabb" * 32}
    result = _invoke(["--json", "identity", "sign", "hello world"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert "signature" in data


# ── config loading ──────────────────────────────────────────────────────────


def test_missing_config():
    """CLI exits with error when socket doesn't exist."""
    runner = CliRunner()
    result = runner.invoke(cli, ["--json", "status"])
    assert result.exit_code != 0


def test_fail_closed_socket_missing(monkeypatch, tmp_path):
    """When DINA_ADMIN_SOCKET points to nonexistent file, fail — don't silently proceed."""
    from dina_admin_cli.config import load_config

    monkeypatch.setenv("DINA_ADMIN_SOCKET", str(tmp_path / "nonexistent.sock"))

    with pytest.raises(click.UsageError, match="Admin socket not found"):
        load_config()


def test_socket_disabled_when_empty(monkeypatch):
    """When DINA_ADMIN_SOCKET is explicitly empty, fail with descriptive error."""
    from dina_admin_cli.config import load_config

    monkeypatch.setenv("DINA_ADMIN_SOCKET", "")

    with pytest.raises(click.UsageError, match="disabled"):
        load_config()


def test_config_uses_default_socket(monkeypatch, tmp_path):
    """When DINA_ADMIN_SOCKET is unset, load_config uses the default path."""
    from dina_admin_cli.config import DEFAULT_SOCKET_PATH, load_config

    monkeypatch.delenv("DINA_ADMIN_SOCKET", raising=False)

    # Default path won't exist on test machine, so expect the "not found" error
    with pytest.raises(click.UsageError, match="Admin socket not found"):
        load_config()


def test_config_loads_socket(monkeypatch, tmp_path):
    """When socket file exists, config loads successfully."""
    from dina_admin_cli.config import load_config

    sock_file = tmp_path / "admin.sock"
    sock_file.touch(mode=0o600)
    monkeypatch.setenv("DINA_ADMIN_SOCKET", str(sock_file))

    cfg = load_config()
    assert cfg.socket_path == str(sock_file)
    assert cfg.timeout == 30.0


def test_config_custom_timeout(monkeypatch, tmp_path):
    """DINA_TIMEOUT env var overrides default timeout."""
    from dina_admin_cli.config import load_config

    sock_file = tmp_path / "admin.sock"
    sock_file.touch(mode=0o600)
    monkeypatch.setenv("DINA_ADMIN_SOCKET", str(sock_file))
    monkeypatch.setenv("DINA_TIMEOUT", "10")

    cfg = load_config()
    assert cfg.timeout == 10.0


# ── approvals list ───────────────────────────────────────────────────────────


def test_approvals_list_json():
    mc = MagicMock()
    mc.list_approvals.return_value = [
        {
            "id": "apr-001",
            "client_did": "did:key:z6MkAgent1",
            "persona_id": "health",
            "action": "vault_read",
            "scope": "session",
            "status": "pending",
            "reason": "agent needs health data",
        },
    ]
    result = _invoke(["--json", "approvals", "list"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert len(data) == 1
    assert data[0]["id"] == "apr-001"


def test_approvals_list_empty():
    mc = MagicMock()
    mc.list_approvals.return_value = []
    result = _invoke(["approvals", "list"], mock_client=mc)
    assert result.exit_code == 0
    assert "No pending approvals" in result.output


def test_approvals_list_human():
    mc = MagicMock()
    mc.list_approvals.return_value = [
        {
            "id": "apr-123",
            "client_did": "did:key:z6MkAgentXYZ",
            "persona_id": "health",
            "action": "vault_read",
        },
    ]
    result = _invoke(["approvals", "list"], mock_client=mc)
    assert result.exit_code == 0
    assert "apr-123" in result.output
    assert "health" in result.output


def test_approvals_bare_invocation_lists():
    """Running 'dina-admin approvals' without subcommand lists pending."""
    mc = MagicMock()
    mc.list_approvals.return_value = []
    result = _invoke(["approvals"], mock_client=mc)
    assert result.exit_code == 0
    assert "No pending approvals" in result.output


# ── approvals approve ───────────────────────────────────────────────────────


def test_approvals_approve_json():
    mc = MagicMock()
    mc.approve.return_value = {"status": "approved", "id": "apr-001"}
    result = _invoke(["--json", "approvals", "approve", "apr-001"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "approved"
    mc.approve.assert_called_once_with("apr-001", "session")


def test_approvals_approve_human():
    mc = MagicMock()
    mc.approve.return_value = {"status": "approved"}
    result = _invoke(["approvals", "approve", "apr-001"], mock_client=mc)
    assert result.exit_code == 0
    assert "Approved: apr-001" in result.output


def test_approvals_approve_single_scope():
    mc = MagicMock()
    mc.approve.return_value = {"status": "approved"}
    result = _invoke(
        ["approvals", "approve", "apr-001", "--scope", "single"],
        mock_client=mc,
    )
    assert result.exit_code == 0
    mc.approve.assert_called_once_with("apr-001", "single")


def test_approvals_approve_error():
    mc = MagicMock()
    mc.approve.side_effect = AdminClientError("HTTP 404: approval not found")
    result = _invoke(["--json", "approvals", "approve", "apr-bad"], mock_client=mc)
    assert result.exit_code != 0


# ── approvals deny ──────────────────────────────────────────────────────────


def test_approvals_deny_json():
    mc = MagicMock()
    mc.deny.return_value = {"status": "denied", "id": "apr-001"}
    result = _invoke(["--json", "approvals", "deny", "apr-001"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "denied"


def test_approvals_deny_human():
    mc = MagicMock()
    mc.deny.return_value = {"status": "denied"}
    result = _invoke(["approvals", "deny", "apr-001"], mock_client=mc)
    assert result.exit_code == 0
    assert "Denied: apr-001" in result.output


def test_approvals_deny_error():
    mc = MagicMock()
    mc.deny.side_effect = AdminClientError("HTTP 404: approval not found")
    result = _invoke(["--json", "approvals", "deny", "apr-bad"], mock_client=mc)
    assert result.exit_code != 0


# ── help ─────────────────────────────────────────────────────────────────────


def test_help():
    runner = CliRunner()
    result = runner.invoke(cli, ["--help"])
    assert result.exit_code == 0
    assert "Dina Admin CLI" in result.output


def test_device_help():
    runner = CliRunner()
    result = runner.invoke(cli, ["device", "--help"])
    assert result.exit_code == 0
    assert "Manage paired devices" in result.output


def test_persona_help():
    runner = CliRunner()
    result = runner.invoke(cli, ["persona", "--help"])
    assert result.exit_code == 0
    assert "Manage personas" in result.output


def test_approvals_help():
    runner = CliRunner()
    result = runner.invoke(cli, ["approvals", "--help"])
    assert result.exit_code == 0
    assert "pending approval" in result.output.lower()


def test_identity_help():
    runner = CliRunner()
    result = runner.invoke(cli, ["identity", "--help"])
    assert result.exit_code == 0
    assert "Node identity" in result.output


# ── vault list ──────────────────────────────────────────────────────────────


def test_vault_list_json():
    mc = MagicMock()
    mc.vault_query.return_value = [
        {"id": "item-1", "type": "email", "summary": "Test email"},
        {"id": "item-2", "type": "note", "summary": "A note"},
    ]
    result = _invoke(["--json", "vault", "list", "--persona", "general"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert len(data) == 2
    mc.vault_query.assert_called_once_with("persona-general", query="", limit=20, offset=0)


def test_vault_list_empty():
    mc = MagicMock()
    mc.vault_query.return_value = []
    result = _invoke(["vault", "list", "--persona", "general"], mock_client=mc)
    assert result.exit_code == 0
    assert "No items found" in result.output


def test_vault_list_with_offset():
    """--offset is passed through to vault_query."""
    mc = MagicMock()
    mc.vault_query.return_value = [
        {"id": "item-3", "type": "note", "summary": "Page 2 item"},
    ]
    result = _invoke(
        ["--json", "vault", "list", "--persona", "health", "--offset", "20"],
        mock_client=mc,
    )
    assert result.exit_code == 0
    mc.vault_query.assert_called_once_with("persona-health", query="", limit=20, offset=20)


# ── vault search ────────────────────────────────────────────────────────────


def test_vault_search_json():
    mc = MagicMock()
    mc.vault_query.return_value = [
        {"id": "item-1", "type": "email", "summary": "Tea preferences"},
    ]
    result = _invoke(
        ["--json", "vault", "search", "tea", "--persona", "general"],
        mock_client=mc,
    )
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert len(data) == 1
    mc.vault_query.assert_called_once_with(
        "persona-general", query="tea", mode="fts5", limit=20, offset=0,
    )


def test_vault_search_empty_results():
    mc = MagicMock()
    mc.vault_query.return_value = []
    result = _invoke(
        ["vault", "search", "nonexistent", "--persona", "general"],
        mock_client=mc,
    )
    assert result.exit_code == 0
    assert "No items found" in result.output


# ── vault delete ────────────────────────────────────────────────────────────


def test_vault_delete_json():
    mc = MagicMock()
    mc.vault_delete.return_value = None
    result = _invoke(
        ["--json", "vault", "delete", "item-123", "--persona", "general", "--yes"],
        mock_client=mc,
    )
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "deleted"
    assert data["id"] == "item-123"
    mc.vault_delete.assert_called_once_with("persona-general", "item-123")


def test_vault_delete_human():
    mc = MagicMock()
    mc.vault_delete.return_value = None
    result = _invoke(
        ["vault", "delete", "item-456", "--persona", "health", "--yes"],
        mock_client=mc,
    )
    assert result.exit_code == 0
    assert "Deleted: item-456" in result.output


def test_vault_delete_error():
    mc = MagicMock()
    mc.vault_delete.side_effect = AdminClientError("HTTP 404: item not found")
    result = _invoke(
        ["--json", "vault", "delete", "item-bad", "--persona", "general", "--yes"],
        mock_client=mc,
    )
    assert result.exit_code != 0
