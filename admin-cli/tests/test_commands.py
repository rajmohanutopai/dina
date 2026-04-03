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


# TRACE: {"suite": "ADMIN", "case": "0022", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "01", "title": "status_json"}
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


# TRACE: {"suite": "ADMIN", "case": "0023", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "02", "title": "status_degraded"}
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


# TRACE: {"suite": "ADMIN", "case": "0024", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "03", "title": "status_human"}
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


# TRACE: {"suite": "ADMIN", "case": "0025", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "04", "title": "device_list_json"}
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


# TRACE: {"suite": "ADMIN", "case": "0026", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "05", "title": "device_list_empty"}
def test_device_list_empty():
    mc = MagicMock()
    mc.list_devices.return_value = {"devices": []}
    result = _invoke(["device", "list"], mock_client=mc)
    assert result.exit_code == 0
    assert "No paired devices" in result.output


# TRACE: {"suite": "ADMIN", "case": "0027", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "06", "title": "device_list_human"}
def test_device_list_human():
    mc = MagicMock()
    mc.list_devices.return_value = {"devices": [
        {"id": "d-1", "name": "laptop"},
    ]}
    result = _invoke(["device", "list"], mock_client=mc)
    assert result.exit_code == 0
    assert "laptop" in result.output


# ── device pair ──────────────────────────────────────────────────────────────


# TRACE: {"suite": "ADMIN", "case": "0028", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "07", "title": "device_pair_json"}
def test_device_pair_json():
    mc = MagicMock()
    mc.initiate_pairing.return_value = {"code": "123456", "expires_in": 300}
    result = _invoke(["--json", "device", "pair"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["code"] == "123456"


# TRACE: {"suite": "ADMIN", "case": "0029", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "08", "title": "device_pair_human"}
def test_device_pair_human():
    mc = MagicMock()
    mc.initiate_pairing.return_value = {"code": "987654", "expires_in": 300}
    result = _invoke(["device", "pair"], mock_client=mc)
    assert result.exit_code == 0
    assert "987654" in result.output
    assert "300" in result.output


# ── device revoke ────────────────────────────────────────────────────────────


# TRACE: {"suite": "ADMIN", "case": "0030", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "09", "title": "device_revoke_json"}
def test_device_revoke_json():
    mc = MagicMock()
    mc.revoke_device.return_value = None
    result = _invoke(["--json", "device", "revoke", "d-1"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "revoked"
    assert data["device_id"] == "d-1"


# TRACE: {"suite": "ADMIN", "case": "0031", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "10", "title": "device_revoke_error"}
def test_device_revoke_error():
    mc = MagicMock()
    mc.revoke_device.side_effect = AdminClientError("HTTP 404: device not found")
    result = _invoke(["--json", "device", "revoke", "d-bad"], mock_client=mc)
    assert result.exit_code != 0


# ── persona list ─────────────────────────────────────────────────────────────


# TRACE: {"suite": "ADMIN", "case": "0032", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "11", "title": "persona_list_json"}
def test_persona_list_json():
    mc = MagicMock()
    mc.list_personas.return_value = [
        {"id": "persona-personal", "name": "personal", "tier": "open"},
    ]
    result = _invoke(["--json", "persona", "list"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert len(data) == 1


# TRACE: {"suite": "ADMIN", "case": "0033", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "12", "title": "persona_list_empty"}
def test_persona_list_empty():
    mc = MagicMock()
    mc.list_personas.return_value = []
    result = _invoke(["persona", "list"], mock_client=mc)
    assert result.exit_code == 0
    assert "No personas" in result.output


# ── persona create ───────────────────────────────────────────────────────────


# TRACE: {"suite": "ADMIN", "case": "0034", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "13", "title": "persona_create_json"}
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


# TRACE: {"suite": "ADMIN", "case": "0035", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "14", "title": "persona_unlock_json"}
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


# TRACE: {"suite": "ADMIN", "case": "0036", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "15", "title": "identity_show_json"}
def test_identity_show_json():
    mc = MagicMock()
    mc.get_did.return_value = {"id": "did:key:z6MkTest", "verificationMethod": []}
    result = _invoke(["--json", "identity", "show"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["id"].startswith("did:")


# ── identity sign ────────────────────────────────────────────────────────────


# TRACE: {"suite": "ADMIN", "case": "0037", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "16", "title": "identity_sign_json"}
def test_identity_sign_json():
    mc = MagicMock()
    mc.sign_data.return_value = {"signature": "aabb" * 32}
    result = _invoke(["--json", "identity", "sign", "hello world"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert "signature" in data


# ── config loading ──────────────────────────────────────────────────────────


# TRACE: {"suite": "ADMIN", "case": "0038", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "17", "title": "missing_config"}
def test_missing_config():
    """CLI exits with error when socket doesn't exist."""
    runner = CliRunner()
    result = runner.invoke(cli, ["--json", "status"])
    assert result.exit_code != 0


# TRACE: {"suite": "ADMIN", "case": "0039", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "18", "title": "fail_closed_socket_missing"}
def test_fail_closed_socket_missing(monkeypatch, tmp_path):
    """When DINA_ADMIN_SOCKET points to nonexistent file, fail — don't silently proceed."""
    from dina_admin_cli.config import load_config

    monkeypatch.setenv("DINA_ADMIN_SOCKET", str(tmp_path / "nonexistent.sock"))

    with pytest.raises(click.UsageError, match="Admin socket not found"):
        load_config()


# TRACE: {"suite": "ADMIN", "case": "0040", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "19", "title": "socket_disabled_when_empty"}
def test_socket_disabled_when_empty(monkeypatch):
    """When DINA_ADMIN_SOCKET is explicitly empty, fail with descriptive error."""
    from dina_admin_cli.config import load_config

    monkeypatch.setenv("DINA_ADMIN_SOCKET", "")

    with pytest.raises(click.UsageError, match="disabled"):
        load_config()


# TRACE: {"suite": "ADMIN", "case": "0041", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "20", "title": "config_uses_default_socket"}
def test_config_uses_default_socket(monkeypatch, tmp_path):
    """When DINA_ADMIN_SOCKET is unset, load_config uses the default path."""
    from dina_admin_cli.config import DEFAULT_SOCKET_PATH, load_config

    monkeypatch.delenv("DINA_ADMIN_SOCKET", raising=False)

    # Default path won't exist on test machine, so expect the "not found" error
    with pytest.raises(click.UsageError, match="Admin socket not found"):
        load_config()


# TRACE: {"suite": "ADMIN", "case": "0042", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "21", "title": "config_loads_socket"}
def test_config_loads_socket(monkeypatch, tmp_path):
    """When socket file exists, config loads successfully."""
    from dina_admin_cli.config import load_config

    sock_file = tmp_path / "admin.sock"
    sock_file.touch(mode=0o600)
    monkeypatch.setenv("DINA_ADMIN_SOCKET", str(sock_file))

    cfg = load_config()
    assert cfg.socket_path == str(sock_file)
    assert cfg.timeout == 30.0


# TRACE: {"suite": "ADMIN", "case": "0043", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "22", "title": "config_custom_timeout"}
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


# TRACE: {"suite": "ADMIN", "case": "0044", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "23", "title": "approvals_list_json"}
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


# TRACE: {"suite": "ADMIN", "case": "0045", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "24", "title": "approvals_list_empty"}
def test_approvals_list_empty():
    mc = MagicMock()
    mc.list_approvals.return_value = []
    result = _invoke(["approvals", "list"], mock_client=mc)
    assert result.exit_code == 0
    assert "No pending approvals" in result.output


# TRACE: {"suite": "ADMIN", "case": "0046", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "25", "title": "approvals_list_human"}
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


# TRACE: {"suite": "ADMIN", "case": "0047", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "26", "title": "approvals_bare_invocation_lists"}
def test_approvals_bare_invocation_lists():
    """Running 'dina-admin approvals' without subcommand lists pending."""
    mc = MagicMock()
    mc.list_approvals.return_value = []
    result = _invoke(["approvals"], mock_client=mc)
    assert result.exit_code == 0
    assert "No pending approvals" in result.output


# ── approvals approve ───────────────────────────────────────────────────────


# TRACE: {"suite": "ADMIN", "case": "0048", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "27", "title": "approvals_approve_json"}
def test_approvals_approve_json():
    mc = MagicMock()
    mc.approve.return_value = {"status": "approved", "id": "apr-001"}
    result = _invoke(["--json", "approvals", "approve", "apr-001"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "approved"
    mc.approve.assert_called_once_with("apr-001", "session")


# TRACE: {"suite": "ADMIN", "case": "0049", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "28", "title": "approvals_approve_human"}
def test_approvals_approve_human():
    mc = MagicMock()
    mc.approve.return_value = {"status": "approved"}
    result = _invoke(["approvals", "approve", "apr-001"], mock_client=mc)
    assert result.exit_code == 0
    assert "Approved: apr-001" in result.output


# TRACE: {"suite": "ADMIN", "case": "0050", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "29", "title": "approvals_approve_single_scope"}
def test_approvals_approve_single_scope():
    mc = MagicMock()
    mc.approve.return_value = {"status": "approved"}
    result = _invoke(
        ["approvals", "approve", "apr-001", "--scope", "single"],
        mock_client=mc,
    )
    assert result.exit_code == 0
    mc.approve.assert_called_once_with("apr-001", "single")


# TRACE: {"suite": "ADMIN", "case": "0051", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "30", "title": "approvals_approve_error"}
def test_approvals_approve_error():
    mc = MagicMock()
    mc.approve.side_effect = AdminClientError("HTTP 404: approval not found")
    result = _invoke(["--json", "approvals", "approve", "apr-bad"], mock_client=mc)
    assert result.exit_code != 0


# ── approvals deny ──────────────────────────────────────────────────────────


# TRACE: {"suite": "ADMIN", "case": "0052", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "31", "title": "approvals_deny_json"}
def test_approvals_deny_json():
    mc = MagicMock()
    mc.deny.return_value = {"status": "denied", "id": "apr-001"}
    result = _invoke(["--json", "approvals", "deny", "apr-001"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "denied"


# TRACE: {"suite": "ADMIN", "case": "0053", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "32", "title": "approvals_deny_human"}
def test_approvals_deny_human():
    mc = MagicMock()
    mc.deny.return_value = {"status": "denied"}
    result = _invoke(["approvals", "deny", "apr-001"], mock_client=mc)
    assert result.exit_code == 0
    assert "Denied: apr-001" in result.output


# TRACE: {"suite": "ADMIN", "case": "0054", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "33", "title": "approvals_deny_error"}
def test_approvals_deny_error():
    mc = MagicMock()
    mc.deny.side_effect = AdminClientError("HTTP 404: approval not found")
    result = _invoke(["--json", "approvals", "deny", "apr-bad"], mock_client=mc)
    assert result.exit_code != 0


# ── help ─────────────────────────────────────────────────────────────────────


# TRACE: {"suite": "ADMIN", "case": "0055", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "34", "title": "help"}
def test_help():
    runner = CliRunner()
    result = runner.invoke(cli, ["--help"])
    assert result.exit_code == 0
    assert "Dina Admin CLI" in result.output


# TRACE: {"suite": "ADMIN", "case": "0056", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "35", "title": "device_help"}
def test_device_help():
    runner = CliRunner()
    result = runner.invoke(cli, ["device", "--help"])
    assert result.exit_code == 0
    assert "Manage paired devices" in result.output


# TRACE: {"suite": "ADMIN", "case": "0057", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "36", "title": "persona_help"}
def test_persona_help():
    runner = CliRunner()
    result = runner.invoke(cli, ["persona", "--help"])
    assert result.exit_code == 0
    assert "Manage personas" in result.output


# TRACE: {"suite": "ADMIN", "case": "0058", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "37", "title": "approvals_help"}
def test_approvals_help():
    runner = CliRunner()
    result = runner.invoke(cli, ["approvals", "--help"])
    assert result.exit_code == 0
    assert "pending approval" in result.output.lower()


# TRACE: {"suite": "ADMIN", "case": "0059", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "38", "title": "identity_help"}
def test_identity_help():
    runner = CliRunner()
    result = runner.invoke(cli, ["identity", "--help"])
    assert result.exit_code == 0
    assert "Node identity" in result.output


# ── vault list ──────────────────────────────────────────────────────────────


# TRACE: {"suite": "ADMIN", "case": "0060", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "39", "title": "vault_list_json"}
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
    mc.vault_query.assert_called_once_with("general", query="", limit=20, offset=0)


# TRACE: {"suite": "ADMIN", "case": "0061", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "40", "title": "vault_list_empty"}
def test_vault_list_empty():
    mc = MagicMock()
    mc.vault_query.return_value = []
    result = _invoke(["vault", "list", "--persona", "general"], mock_client=mc)
    assert result.exit_code == 0
    assert "No items found" in result.output


# TRACE: {"suite": "ADMIN", "case": "0062", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "41", "title": "vault_list_with_offset"}
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
    mc.vault_query.assert_called_once_with("health", query="", limit=20, offset=20)


# ── vault search ────────────────────────────────────────────────────────────


# TRACE: {"suite": "ADMIN", "case": "0063", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "42", "title": "vault_search_json"}
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
        "general", query="tea", mode="fts5", limit=20, offset=0,
    )


# TRACE: {"suite": "ADMIN", "case": "0064", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "43", "title": "vault_search_empty_results"}
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


# TRACE: {"suite": "ADMIN", "case": "0065", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "44", "title": "vault_delete_json"}
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
    mc.vault_delete.assert_called_once_with("general", "item-123")


# TRACE: {"suite": "ADMIN", "case": "0066", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "45", "title": "vault_delete_human"}
def test_vault_delete_human():
    mc = MagicMock()
    mc.vault_delete.return_value = None
    result = _invoke(
        ["vault", "delete", "item-456", "--persona", "health", "--yes"],
        mock_client=mc,
    )
    assert result.exit_code == 0
    assert "Deleted: item-456" in result.output


# TRACE: {"suite": "ADMIN", "case": "0067", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "46", "title": "vault_delete_error"}
def test_vault_delete_error():
    mc = MagicMock()
    mc.vault_delete.side_effect = AdminClientError("HTTP 404: item not found")
    result = _invoke(
        ["--json", "vault", "delete", "item-bad", "--persona", "general", "--yes"],
        mock_client=mc,
    )
    assert result.exit_code != 0


# ── ask ──────────────────────────────────────────────────────────────────────


# TRACE: {"suite": "ADMIN", "case": "0068", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "47", "title": "ask_returns_content"}
def test_ask_returns_content():
    """dina-admin ask should display the LLM response."""
    mc = MagicMock()
    mc.ask.return_value = {"content": "You like cardamom tea with ginger."}
    result = _invoke(["ask", "What tea do I like"], mock_client=mc)
    assert result.exit_code == 0
    assert "cardamom tea" in result.output
    mc.ask.assert_called_once_with("What tea do I like")


# TRACE: {"suite": "ADMIN", "case": "0069", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "48", "title": "ask_json_mode"}
def test_ask_json_mode():
    """--json returns full response dict."""
    mc = MagicMock()
    mc.ask.return_value = {"content": "answer", "model": "gemini"}
    result = _invoke(["--json", "ask", "hello"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["content"] == "answer"


# TRACE: {"suite": "ADMIN", "case": "0070", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "49", "title": "ask_response_field_fallback"}
def test_ask_response_field_fallback():
    """Falls back to response field when content is empty."""
    mc = MagicMock()
    mc.ask.return_value = {"response": "fallback answer"}
    result = _invoke(["ask", "test query"], mock_client=mc)
    assert result.exit_code == 0
    assert "fallback answer" in result.output


# TRACE: {"suite": "ADMIN", "case": "0071", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "50", "title": "ask_dict_response"}
def test_ask_dict_response():
    """Extracts text from dict-typed response."""
    mc = MagicMock()
    mc.ask.return_value = {"response": {"text": "structured response"}}
    result = _invoke(["ask", "test"], mock_client=mc)
    assert result.exit_code == 0
    assert "structured response" in result.output


# TRACE: {"suite": "ADMIN", "case": "0072", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "51", "title": "ask_no_text_shows_error"}
def test_ask_no_text_shows_error():
    """Missing text argument should fail."""
    mc = MagicMock()
    result = _invoke(["ask"], mock_client=mc)
    assert result.exit_code != 0


# TRACE: {"suite": "ADMIN", "case": "0073", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "52", "title": "ask_error_shows_message"}
def test_ask_error_shows_message():
    """API error should display error message."""
    mc = MagicMock()
    mc.ask.side_effect = AdminClientError("Brain unreachable")
    result = _invoke(["ask", "hello"], mock_client=mc)
    assert result.exit_code != 0
    assert "Brain unreachable" in result.output


# TRACE: {"suite": "ADMIN", "case": "0074", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "53", "title": "ask_multi_word_query"}
def test_ask_multi_word_query():
    """Multiple arguments are joined into one query."""
    mc = MagicMock()
    mc.ask.return_value = {"content": "ok"}
    result = _invoke(["ask", "What", "is", "my", "FD", "status"], mock_client=mc)
    assert result.exit_code == 0
    mc.ask.assert_called_once_with("What is my FD status")


# ── remember ─────────────────────────────────────────────────────────────────


# TRACE: {"suite": "ADMIN", "case": "0075", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "54", "title": "remember_stored"}
def test_remember_stored():
    """dina-admin remember should display stored status."""
    mc = MagicMock()
    mc.remember.return_value = {"status": "stored", "message": "Memory stored successfully."}
    result = _invoke(["remember", "Team lunch Friday 1pm"], mock_client=mc)
    assert result.exit_code == 0
    assert "Stored" in result.output
    mc.remember.assert_called_once_with("Team lunch Friday 1pm")


# TRACE: {"suite": "ADMIN", "case": "0076", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "55", "title": "remember_needs_approval"}
def test_remember_needs_approval():
    """Sensitive data triggers approval prompt."""
    mc = MagicMock()
    mc.remember.return_value = {
        "status": "needs_approval",
        "message": "Classified into a sensitive persona.",
        "id": "stg-123",
    }
    result = _invoke(["remember", "My cholesterol is 220"], mock_client=mc)
    assert result.exit_code == 0
    assert "approval" in result.output.lower()


# TRACE: {"suite": "ADMIN", "case": "0077", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "56", "title": "remember_failed"}
def test_remember_failed():
    """Failed remember shows error."""
    mc = MagicMock()
    mc.remember.return_value = {"status": "failed", "message": "Classification error."}
    result = _invoke(["remember", "broken input"], mock_client=mc)
    assert result.exit_code == 0
    assert "Failed" in result.output


# TRACE: {"suite": "ADMIN", "case": "0078", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "57", "title": "remember_json_mode"}
def test_remember_json_mode():
    """--json returns full result dict."""
    mc = MagicMock()
    mc.remember.return_value = {"status": "stored", "id": "stg-abc", "message": "ok"}
    result = _invoke(["--json", "remember", "test memory"], mock_client=mc)
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["status"] == "stored"
    assert data["id"] == "stg-abc"


# TRACE: {"suite": "ADMIN", "case": "0079", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "58", "title": "remember_no_text_shows_error"}
def test_remember_no_text_shows_error():
    """Missing text argument should fail."""
    mc = MagicMock()
    result = _invoke(["remember"], mock_client=mc)
    assert result.exit_code != 0


# TRACE: {"suite": "ADMIN", "case": "0080", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "59", "title": "remember_error_shows_message"}
def test_remember_error_shows_message():
    """API error should display error message."""
    mc = MagicMock()
    mc.remember.side_effect = AdminClientError("staging failed")
    result = _invoke(["remember", "test"], mock_client=mc)
    assert result.exit_code != 0
    assert "staging failed" in result.output


# TRACE: {"suite": "ADMIN", "case": "0081", "section": "01", "sectionName": "Commands", "subsection": "01", "scenario": "60", "title": "remember_multi_word_text"}
def test_remember_multi_word_text():
    """Multiple arguments are joined into one text."""
    mc = MagicMock()
    mc.remember.return_value = {"status": "stored", "message": "ok"}
    result = _invoke(["remember", "FD", "rate", "is", "7.8%"], mock_client=mc)
    assert result.exit_code == 0
    mc.remember.assert_called_once_with("FD rate is 7.8%")
