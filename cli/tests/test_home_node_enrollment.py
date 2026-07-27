"""Automatic local coding-agent enrollment tests."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from click.testing import CliRunner

from dina_cli.config import load_saved_from, save_config_to
from dina_cli.home_node_enrollment import (
    HomeNodeAgentEnroller,
    HomeNodeEnrollmentError,
    ManagedEnrollmentCleanupFailure,
    ManagedEnrollmentCleanupReport,
    prepare_managed_enrollment_cleanup,
)
from dina_cli.seed_wrap import seed_to_mnemonic
from dina_cli.signing import CLIIdentity
from dina_cli.main import cli

HOME_DID = "did:plc:home-node-test"
MSGBOX_URL = "wss://msgbox.example/ws"
OWNER_CAPABILITY = "owner-capability-never-persist"


class FakeManager:
    def __init__(
        self,
        *,
        healthy: bool = True,
        install_dir: Path | None = None,
    ) -> None:
        self.healthy = healthy
        self.owner_reads = 0
        self.install_dir = install_dir or Path("/managed/home-node")

    def status(self):
        return SimpleNamespace(
            installed=True,
            core_healthy=self.healthy,
            core_url="http://127.0.0.1:8100",
        )

    def read_owner_capability(self) -> str:
        self.owner_reads += 1
        return OWNER_CAPABILITY


class EnrollmentServer:
    def __init__(self, agents: list[dict] | None = None) -> None:
        self.agents = list(agents or [])
        self.requests: list[tuple[str, str]] = []
        self.revoked: list[str] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((request.method, request.url.path))
        assert request.headers["x-dina-owner-capability"] == OWNER_CAPABILITY
        if request.method == "GET" and request.url.path == "/v1/owner/setup/status":
            return httpx.Response(
                200,
                json={
                    "coding_agent_pairing_available": True,
                    "home_did": HOME_DID,
                    "msgbox_url": MSGBOX_URL,
                    "coding_agents": self.agents,
                    "phone": {"configured": False, "state": "unpaired"},
                },
            )
        if (
            request.method == "POST"
            and request.url.path == "/v1/owner/setup/coding-agent"
        ):
            return httpx.Response(
                201,
                json={"setup_code": _setup_code(), "expires_at": 1234},
            )
        if request.method == "POST" and request.url.path == "/v1/pair/complete":
            body = json.loads(request.content)
            assert body["code"] == "PAIR-CODE"
            assert body["role"] == "agent"
            assert body["public_key_multibase"].startswith("z")
            agent_did = f"did:key:{body['public_key_multibase']}"
            self.agents = [
                {
                    "device_id": "coding-device-1",
                    "did": agent_did,
                    "name": body["device_name"],
                }
            ]
            return httpx.Response(
                201,
                json={
                    "device_id": "coding-device-1",
                    "node_did": HOME_DID,
                    "device_name": body["device_name"],
                    "role": "agent",
                },
            )
        prefix = "/v1/owner/setup/coding-agent/"
        if request.method == "DELETE" and request.url.path.startswith(prefix):
            self.revoked.append(request.url.path.removeprefix(prefix))
            return httpx.Response(204)
        return httpx.Response(404, json={"error": "not_found"})


def _setup_code() -> str:
    payload = {
        "v": 1,
        "msgbox_url": MSGBOX_URL,
        "homenode_did": HOME_DID,
        "transport": "msgbox",
        "device_name": "coding-agent",
        "code": "PAIR-CODE",
    }
    encoded = (
        base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8"))
        .decode("ascii")
        .rstrip("=")
    )
    return f"dina1:{encoded}"


def _enroller(
    tmp_path: Path,
    server: EnrollmentServer,
    manager: FakeManager | None = None,
) -> HomeNodeAgentEnroller:
    return HomeNodeAgentEnroller(
        manager or FakeManager(install_dir=tmp_path / "home-node"),  # type: ignore[arg-type]
        config_dir=tmp_path / "cli",
        transport=server.transport(),
    )


def test_enrolls_new_identity_without_persisting_capabilities(tmp_path: Path) -> None:
    server = EnrollmentServer()

    result = _enroller(tmp_path, server).enroll()

    assert result.status == "enrolled"
    assert result.device_id == "coding-device-1"
    assert result.home_did == HOME_DID
    config = load_saved_from(tmp_path / "cli")
    assert config == {
        "core_url": "http://127.0.0.1:8100",
        "device_name": config["device_name"],
        "role": "agent",
        "agent_scope": "coding",
        "msgbox_url": MSGBOX_URL,
        "homenode_did": HOME_DID,
        "transport_mode": "direct",
        "device_id": "coding-device-1",
        "managed_by": "dina-home-node-installer",
        "managed_install_dir": str(tmp_path / "home-node"),
    }
    serialized = json.dumps(config)
    assert OWNER_CAPABILITY not in serialized
    assert "PAIR-CODE" not in serialized
    identity = CLIIdentity(identity_dir=tmp_path / "cli" / "identity")
    assert identity.exists
    assert identity.did() == result.agent_did
    receipt = json.loads((tmp_path / "home-node" / "agent-enrollment.json").read_text())
    assert receipt == {
        "agent_did": result.agent_did,
        "config_dir": str(tmp_path / "cli"),
        "device_id": "coding-device-1",
        "home_did": HOME_DID,
        "managed_by": "dina-home-node-installer",
        "managed_install_dir": str(tmp_path / "home-node"),
        "schema": 1,
    }


def test_existing_compatible_enrollment_is_idempotent(tmp_path: Path) -> None:
    identity = CLIIdentity(identity_dir=tmp_path / "cli" / "identity")
    identity.generate()
    save_config_to(
        tmp_path / "cli",
        {
            "core_url": "http://127.0.0.1:8100",
            "role": "agent",
            "homenode_did": HOME_DID,
            "device_id": "existing-device",
        },
    )
    server = EnrollmentServer([{"device_id": "existing-device", "did": identity.did()}])

    result = _enroller(tmp_path, server).enroll()

    assert result.status == "already_enrolled"
    assert result.device_id == "existing-device"
    assert ("POST", "/v1/owner/setup/coding-agent") not in server.requests
    assert not (tmp_path / "home-node" / "agent-enrollment.json").exists()


def test_existing_managed_enrollment_repairs_cleanup_receipt(
    tmp_path: Path,
) -> None:
    identity = CLIIdentity(identity_dir=tmp_path / "cli" / "identity")
    identity.generate()
    save_config_to(
        tmp_path / "cli",
        {
            "core_url": "http://127.0.0.1:8100",
            "role": "agent",
            "homenode_did": HOME_DID,
            "device_id": "existing-device",
            "managed_by": "dina-home-node-installer",
            "managed_install_dir": str(tmp_path / "home-node"),
        },
    )
    server = EnrollmentServer([{"device_id": "existing-device", "did": identity.did()}])

    _enroller(tmp_path, server).enroll()

    assert (tmp_path / "home-node" / "agent-enrollment.json").is_file()


def test_existing_unrelated_config_is_preserved(tmp_path: Path) -> None:
    identity = CLIIdentity(identity_dir=tmp_path / "cli" / "identity")
    identity.generate()
    original = {
        "core_url": "https://other-node.example",
        "role": "agent",
        "homenode_did": "did:plc:other",
        "device_id": "other-device",
    }
    save_config_to(tmp_path / "cli", original)
    server = EnrollmentServer()

    with pytest.raises(HomeNodeEnrollmentError, match="preserved unchanged"):
        _enroller(tmp_path, server).enroll()

    assert load_saved_from(tmp_path / "cli") == original
    assert ("POST", "/v1/owner/setup/coding-agent") not in server.requests


def test_repairs_config_after_pair_succeeded_before_config_write(
    tmp_path: Path,
) -> None:
    identity = CLIIdentity(identity_dir=tmp_path / "cli" / "identity")
    identity.generate()
    server = EnrollmentServer(
        [{"device_id": "recovered-device", "did": identity.did()}]
    )

    result = _enroller(tmp_path, server).enroll()

    assert result.status == "recovered"
    assert load_saved_from(tmp_path / "cli")["device_id"] == "recovered-device"
    assert ("POST", "/v1/owner/setup/coding-agent") not in server.requests


def test_revokes_paired_device_when_local_persistence_fails(tmp_path: Path) -> None:
    server = EnrollmentServer()
    enroller = _enroller(tmp_path, server)

    with patch(
        "dina_cli.home_node_enrollment.save_new_config_to",
        side_effect=OSError("disk full"),
    ):
        with pytest.raises(HomeNodeEnrollmentError, match="was revoked"):
            enroller.enroll()

    assert server.revoked == ["coding-device-1"]
    assert not (tmp_path / "cli" / "identity").exists()
    assert not (tmp_path / "cli" / "config.json").exists()


def test_refuses_enrollment_until_core_is_healthy(tmp_path: Path) -> None:
    manager = FakeManager(healthy=False)
    server = EnrollmentServer()

    with pytest.raises(HomeNodeEnrollmentError, match="healthy"):
        _enroller(tmp_path, server, manager).enroll()

    assert manager.owner_reads == 0
    assert server.requests == []


def test_does_not_overwrite_config_created_while_pairing(tmp_path: Path) -> None:
    server = EnrollmentServer()
    conflicting = {
        "core_url": "https://other-node.example",
        "role": "agent",
        "homenode_did": "did:plc:other",
        "device_id": "other-device",
    }

    def race(request: httpx.Request) -> httpx.Response:
        response = server.handle(request)
        if request.method == "POST" and request.url.path == "/v1/pair/complete":
            save_config_to(tmp_path / "cli", conflicting)
        return response

    enroller = HomeNodeAgentEnroller(
        FakeManager(install_dir=tmp_path / "home-node"),  # type: ignore[arg-type]
        config_dir=tmp_path / "cli",
        transport=httpx.MockTransport(race),
    )

    with pytest.raises(HomeNodeEnrollmentError, match="was revoked"):
        enroller.enroll()

    assert server.revoked == ["coding-device-1"]
    assert load_saved_from(tmp_path / "cli") == conflicting


def test_wraps_owner_api_network_failures(tmp_path: Path) -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    enroller = HomeNodeAgentEnroller(
        FakeManager(install_dir=tmp_path / "home-node"),  # type: ignore[arg-type]
        config_dir=tmp_path / "cli",
        transport=httpx.MockTransport(fail),
    )

    with pytest.raises(HomeNodeEnrollmentError, match="Could not reach"):
        enroller.enroll()


def test_purge_cleanup_removes_only_exact_managed_credentials(
    tmp_path: Path,
) -> None:
    server = EnrollmentServer()
    result = _enroller(tmp_path, server).enroll()
    manager = FakeManager(install_dir=tmp_path / "home-node")

    cleanup = prepare_managed_enrollment_cleanup(manager)  # type: ignore[arg-type]

    assert cleanup is not None
    assert cleanup.agent_did == result.agent_did
    assert cleanup.apply() is True
    assert not (tmp_path / "cli" / "config.json").exists()
    assert not (tmp_path / "cli" / "identity").exists()


def test_host_receipts_preserve_cleanup_for_multiple_agents(tmp_path: Path) -> None:
    manager = FakeManager(install_dir=tmp_path / "home-node")
    first_server = EnrollmentServer()
    second_server = EnrollmentServer()
    HomeNodeAgentEnroller(
        manager,  # type: ignore[arg-type]
        config_dir=tmp_path / "claude",
        receipt_name="claude-code",
        transport=first_server.transport(),
    ).enroll()
    HomeNodeAgentEnroller(
        manager,  # type: ignore[arg-type]
        config_dir=tmp_path / "codex",
        receipt_name="codex",
        transport=second_server.transport(),
    ).enroll()

    cleanup = prepare_managed_enrollment_cleanup(manager)  # type: ignore[arg-type]

    assert cleanup is not None
    assert cleanup.apply() is True
    assert not (tmp_path / "claude" / "config.json").exists()
    assert not (tmp_path / "codex" / "config.json").exists()


def test_cleanup_batch_continues_after_one_host_cleanup_fails(tmp_path: Path) -> None:
    manager = FakeManager(install_dir=tmp_path / "home-node")
    for name in ("claude", "codex"):
        HomeNodeAgentEnroller(
            manager,  # type: ignore[arg-type]
            config_dir=tmp_path / name,
            receipt_name=name,
            transport=EnrollmentServer().transport(),
        ).enroll()
    cleanup = prepare_managed_enrollment_cleanup(manager)  # type: ignore[arg-type]
    assert cleanup is not None

    # Force the first cleanup to fail after the plans have been captured.
    (tmp_path / "claude" / "config.json").chmod(0o000)
    try:
        with patch(
            "dina_cli.home_node_enrollment.load_saved_from",
            side_effect=[OSError("disk failure"), load_saved_from(tmp_path / "codex")],
        ):
            report = cleanup.apply_report()
    finally:
        (tmp_path / "claude" / "config.json").chmod(0o600)

    assert report.removed_count == 1
    assert len(report.failures) == 1
    assert not (tmp_path / "codex" / "config.json").exists()
    assert (tmp_path / "claude" / "config.json").exists()


def test_purge_cleanup_preserves_credentials_changed_after_plan(
    tmp_path: Path,
) -> None:
    server = EnrollmentServer()
    _enroller(tmp_path, server).enroll()
    manager = FakeManager(install_dir=tmp_path / "home-node")
    cleanup = prepare_managed_enrollment_cleanup(manager)  # type: ignore[arg-type]
    assert cleanup is not None
    changed = load_saved_from(tmp_path / "cli")
    changed["device_id"] = "replacement-device"
    save_config_to(tmp_path / "cli", changed)

    assert cleanup.apply() is False
    assert (tmp_path / "cli" / "config.json").is_file()
    assert (tmp_path / "cli" / "identity").is_dir()


def test_malformed_or_foreign_cleanup_receipt_is_ignored(tmp_path: Path) -> None:
    manager = FakeManager(install_dir=tmp_path / "home-node")
    manager.install_dir.mkdir(parents=True)
    (manager.install_dir / "agent-enrollment.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "managed_by": "dina-home-node-installer",
                "managed_install_dir": str(tmp_path / "another-node"),
                "config_dir": str(tmp_path / "cli"),
                "device_id": "device",
                "agent_did": "did:key:zAgent",
                "home_did": HOME_DID,
            }
        )
    )

    assert prepare_managed_enrollment_cleanup(manager) is None  # type: ignore[arg-type]


def test_purge_command_applies_captured_managed_cleanup(tmp_path: Path) -> None:
    status = SimpleNamespace()
    manager = SimpleNamespace(
        install_dir=tmp_path / "home-node",
        uninstall=lambda **_kwargs: status,
    )
    cleanup = SimpleNamespace(
        apply_report=lambda: ManagedEnrollmentCleanupReport(removed_count=1)
    )

    with (
        patch("dina_cli.main._home_node_manager", return_value=manager),
        patch(
            "dina_cli.home_node_enrollment.prepare_managed_enrollment_cleanup",
            return_value=cleanup,
        ) as prepare,
    ):
        result = CliRunner().invoke(
            cli,
            ["--json", "home-node", "uninstall", "--purge-data", "--yes"],
        )

    assert result.exit_code == 0
    assert json.loads(result.output) == {
        "uninstalled": True,
        "data_purged": True,
        "managed_agent_credentials_removed": True,
        "managed_agent_cleanup_failures": [],
    }
    prepare.assert_called_once_with(manager)


def test_non_destructive_uninstall_never_removes_agent_credentials(
    tmp_path: Path,
) -> None:
    calls: list[dict] = []
    manager = SimpleNamespace(
        install_dir=tmp_path / "home-node",
        uninstall=lambda **kwargs: calls.append(kwargs),
    )

    with (
        patch("dina_cli.main._home_node_manager", return_value=manager),
        patch(
            "dina_cli.home_node_enrollment.prepare_managed_enrollment_cleanup"
        ) as prepare,
    ):
        result = CliRunner().invoke(
            cli,
            ["--json", "home-node", "uninstall"],
        )

    assert result.exit_code == 0
    assert calls == [{"purge_data": False}]
    assert json.loads(result.output)["managed_agent_credentials_removed"] is False
    prepare.assert_not_called()


def test_purge_reports_partial_managed_cleanup_failure(tmp_path: Path) -> None:
    manager = SimpleNamespace(
        install_dir=tmp_path / "home-node",
        uninstall=lambda **_kwargs: None,
    )
    cleanup = SimpleNamespace(
        apply_report=lambda: ManagedEnrollmentCleanupReport(
            failures=(
                ManagedEnrollmentCleanupFailure(
                    config_dir=str(tmp_path / "claude"),
                    code="cleanup_failed",
                ),
            )
        )
    )
    with (
        patch("dina_cli.main._home_node_manager", return_value=manager),
        patch(
            "dina_cli.home_node_enrollment.prepare_managed_enrollment_cleanup",
            return_value=cleanup,
        ),
    ):
        result = CliRunner().invoke(
            cli,
            ["--json", "home-node", "uninstall", "--purge-data", "--yes"],
        )

    assert result.exit_code == 2
    assert json.loads(result.output)["managed_agent_cleanup_failures"] == [
        {
            "config_dir": str(tmp_path / "claude"),
            "code": "cleanup_failed",
        }
    ]


def test_install_command_enrolls_by_default(tmp_path: Path) -> None:
    status = SimpleNamespace(
        installed=True,
        running=True,
        core_healthy=True,
        brain_healthy=True,
        core_url="http://127.0.0.1:8100",
        brain_url="http://127.0.0.1:8200",
        install_dir=str(tmp_path / "home-node"),
        release_version="0.20.0",
        autostart_enabled=True,
    )
    manager = SimpleNamespace(install=lambda **_kwargs: status)
    enrollment = SimpleNamespace(
        status="enrolled",
        device_id="device-1",
        agent_did="did:key:zAgent",
        home_did=HOME_DID,
        config_dir=str(tmp_path / "cli"),
    )

    with (
        patch("dina_cli.main._home_node_manager", return_value=manager),
        patch("dina_cli.home_node_enrollment.HomeNodeAgentEnroller") as enroller_type,
    ):
        enroller_type.return_value.enroll.return_value = enrollment
        result = CliRunner().invoke(
            cli,
            [
                "--json",
                "home-node",
                "install",
                "--release",
                "0.20.0",
                "--agent-config-dir",
                str(tmp_path / "cli"),
            ],
        )

    assert result.exit_code == 0
    body = json.loads(result.output)
    assert body["agent_enrollment"]["status"] == "enrolled"
    enroller_type.assert_called_once_with(
        manager,
        config_dir=tmp_path / "cli",
    )


def test_install_can_select_exact_enrolled_agent_as_foreground_brain(
    tmp_path: Path,
) -> None:
    status = SimpleNamespace(
        installed=True,
        running=True,
        core_healthy=True,
        brain_healthy=True,
        core_url="http://127.0.0.1:8100",
        brain_url="http://127.0.0.1:8200",
        install_dir=str(tmp_path / "home-node"),
        release_version="0.20.0",
        autostart_enabled=True,
    )
    manager = SimpleNamespace(install=lambda **_kwargs: status)
    enrollment = SimpleNamespace(
        status="enrolled",
        device_id="device-1",
        agent_did="did:key:zAgent",
        home_did=HOME_DID,
        config_dir=str(tmp_path / "cli"),
    )
    selection = SimpleNamespace(
        status="selected",
        backend_id="connected.device-1",
        principal_did="did:key:zAgent",
        policy_version=1,
        selected=True,
        reason=None,
    )

    with (
        patch("dina_cli.main._home_node_manager", return_value=manager),
        patch("dina_cli.home_node_enrollment.HomeNodeAgentEnroller") as enroller_type,
        patch(
            "dina_cli.home_node_reasoning.HomeNodeReasoningSelector"
        ) as selector_type,
    ):
        enroller_type.return_value.enroll.return_value = enrollment
        selector_type.return_value.select.return_value = selection
        result = CliRunner().invoke(
            cli,
            [
                "--json",
                "home-node",
                "install",
                "--release",
                "0.20.0",
                "--agent-config-dir",
                str(tmp_path / "cli"),
                "--use-enrolled-agent-as-brain",
            ],
        )

    assert result.exit_code == 0, result.output
    body = json.loads(result.output)
    assert body["reasoning_backend"] == {
        "status": "selected",
        "backend_id": "connected.device-1",
        "principal_did": "did:key:zAgent",
        "policy_version": 1,
        "selected": True,
        "reason": None,
    }
    selector_type.assert_called_once_with(manager)
    selector_type.return_value.select.assert_called_once_with(enrollment)


def test_install_rejects_brain_selection_without_started_enrollment() -> None:
    for incompatible in (["--no-enroll"], ["--no-start"]):
        result = CliRunner().invoke(
            cli,
            [
                "home-node",
                "install",
                "--use-enrolled-agent-as-brain",
                *incompatible,
            ],
        )
        assert result.exit_code == 2
        assert "requires a started, enrolled coding agent" in result.output


def test_install_command_allows_explicit_enrollment_opt_out(tmp_path: Path) -> None:
    status = SimpleNamespace(
        installed=True,
        running=True,
        core_healthy=True,
        brain_healthy=True,
        core_url="http://127.0.0.1:8100",
        brain_url="http://127.0.0.1:8200",
        install_dir=str(tmp_path / "home-node"),
        release_version="0.20.0",
        autostart_enabled=True,
    )
    manager = SimpleNamespace(install=lambda **_kwargs: status)

    with (
        patch("dina_cli.main._home_node_manager", return_value=manager),
        patch("dina_cli.home_node_enrollment.HomeNodeAgentEnroller") as enroller_type,
    ):
        result = CliRunner().invoke(
            cli,
            ["--json", "home-node", "install", "--no-enroll"],
        )

    assert result.exit_code == 0
    assert "agent_enrollment" not in json.loads(result.output)
    enroller_type.assert_not_called()


def test_install_restore_requires_public_handle() -> None:
    result = CliRunner().invoke(
        cli,
        ["home-node", "install", "--restore-identity"],
        input="unused\n",
    )

    assert result.exit_code == 2
    assert "requires the existing --pds-handle" in result.output


def test_install_restores_identity_from_private_file_before_start(
    tmp_path: Path,
) -> None:
    status = SimpleNamespace(
        installed=True,
        running=False,
        core_healthy=False,
        brain_healthy=False,
        core_url="http://127.0.0.1:8100",
        brain_url="http://127.0.0.1:8200",
        install_dir=str(tmp_path / "home-node"),
        release_version="0.20.0",
        autostart_enabled=True,
    )
    calls: list[tuple[str, object]] = []

    class RestoreManager:
        def install(self, **kwargs):
            calls.append(("install", kwargs))
            return status

        def restore_identity_seed(self, seed: bytes):
            calls.append(("restore", seed))

    phrase = " ".join(seed_to_mnemonic(b"\x23" * 32))
    recovery_file = tmp_path / "recovery.txt"
    recovery_file.write_text(f"# private\n{phrase}\n", encoding="utf-8")
    recovery_file.chmod(0o600)

    with patch(
        "dina_cli.main._home_node_manager",
        return_value=RestoreManager(),
    ):
        result = CliRunner().invoke(
            cli,
            [
                "--json",
                "home-node",
                "install",
                "--pds-handle",
                "restore.test-pds.dinakernel.com",
                "--recovery-file",
                str(recovery_file),
                "--no-start",
                "--no-enroll",
            ],
        )

    assert result.exit_code == 0, result.output
    assert calls[0][0] == "install"
    install_args = calls[0][1]
    assert isinstance(install_args, dict)
    assert install_args["start"] is False
    assert install_args["pds_handle"] == "restore.test-pds.dinakernel.com"
    assert calls[1] == ("restore", b"\x23" * 32)
    assert phrase not in result.output


def test_upgrade_command_reports_validated_release(tmp_path: Path) -> None:
    status = SimpleNamespace(
        installed=True,
        running=True,
        core_healthy=True,
        brain_healthy=True,
        core_url="http://127.0.0.1:8100",
        brain_url="http://127.0.0.1:8200",
        install_dir=str(tmp_path / "home-node"),
        release_version="0.21.0",
        autostart_enabled=True,
    )
    manager = SimpleNamespace(upgrade=lambda **_kwargs: status)

    with patch("dina_cli.main._home_node_manager", return_value=manager):
        result = CliRunner().invoke(
            cli,
            [
                "--json",
                "home-node",
                "upgrade",
                "--release",
                "0.21.0",
            ],
        )

    assert result.exit_code == 0
    assert json.loads(result.output)["release_version"] == "0.21.0"


def test_backup_command_uses_hidden_confirmed_passphrase(tmp_path: Path) -> None:
    destination = tmp_path / "node.dina"
    calls: list[tuple[Path, str, dict]] = []

    class BackupManager:
        def export_archive(self, path: Path, passphrase: str, **kwargs):
            calls.append((path, passphrase, kwargs))
            return path.resolve()

    with patch("dina_cli.main._home_node_manager", return_value=BackupManager()):
        result = CliRunner().invoke(
            cli,
            ["--json", "home-node", "backup", str(destination)],
            input="archive secret\narchive secret\n",
        )

    assert result.exit_code == 0, result.output
    assert calls == [
        (
            destination,
            "archive secret",
            {"overwrite": False, "wait_timeout": 120.0},
        )
    ]
    assert "archive secret" not in result.output
    assert json.loads(result.stdout)["backup_created"] is True


def test_force_restore_requires_yes_in_json_mode(tmp_path: Path) -> None:
    archive = tmp_path / "node.dina"
    archive.write_bytes(b"DINA\x01\x00")

    result = CliRunner().invoke(
        cli,
        [
            "--json",
            "home-node",
            "restore-backup",
            str(archive),
            "--force",
        ],
    )

    assert result.exit_code == 2
    assert "--force with --json requires --yes" in result.output


def test_force_restore_forwards_explicit_force(
    tmp_path: Path,
) -> None:
    archive = tmp_path / "node.dina"
    archive.write_bytes(b"DINA\x01\x00")
    calls: list[tuple[Path, str, dict]] = []

    class RestoreManager:
        def import_archive(self, path: Path, passphrase: str, **kwargs):
            calls.append((path, passphrase, kwargs))

    with patch("dina_cli.main._home_node_manager", return_value=RestoreManager()):
        result = CliRunner().invoke(
            cli,
            [
                "--json",
                "home-node",
                "restore-backup",
                str(archive),
                "--force",
                "--yes",
            ],
            input="archive secret\n",
        )

    assert result.exit_code == 0, result.output
    assert calls == [
        (
            archive,
            "archive secret",
            {"force": True, "wait_timeout": 120.0},
        )
    ]
    assert "archive secret" not in result.output
    assert json.loads(result.stdout)["restored"] is True
