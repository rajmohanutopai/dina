"""Shared Claude Code/Codex setup-engine tests."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from click.testing import CliRunner

from dina_cli import agent_host_setup as agent_host_setup_module
from dina_cli.agent_host_setup import AgentHostSetup, AgentHostSetupError
from dina_cli.home_node import HomeNodeError, HomeNodeStatus
from dina_cli.home_node_enrollment import HomeNodeEnrollment
from dina_cli.home_node_reasoning import HomeNodeReasoningSelection
from dina_cli.main import cli


def _status(*, installed: bool, healthy: bool) -> HomeNodeStatus:
    return HomeNodeStatus(
        installed=installed,
        running=healthy,
        core_healthy=healthy,
        brain_healthy=healthy,
        core_url="http://127.0.0.1:18100",
        brain_url="http://127.0.0.1:18200",
        install_dir="/tmp/dina-home-node",
        release_version="test",
        autostart_enabled=True,
    )


class FakeManager:
    install_dir = Path("/tmp/dina-home-node")

    def __init__(self, *, installed: bool = False) -> None:
        self.installed = installed
        self.install_calls: list[dict] = []
        self.ensure_calls: list[tuple[bool, float]] = []

    def status(self) -> HomeNodeStatus:
        return _status(installed=self.installed, healthy=self.installed)

    def install(self, **kwargs) -> HomeNodeStatus:
        self.install_calls.append(kwargs)
        self.installed = True
        return self.status()

    def ensure(self, *, if_installed: bool, wait_timeout: float) -> None:
        self.ensure_calls.append((if_installed, wait_timeout))


def _enrollment() -> HomeNodeEnrollment:
    return HomeNodeEnrollment(
        status="enrolled",
        device_id="coding-device",
        agent_did="did:key:zAgent",
        home_did="did:plc:home",
        config_dir="/tmp/dina-cli",
    )


def _selection(*, selected: bool = True) -> HomeNodeReasoningSelection:
    return HomeNodeReasoningSelection(
        status="selected" if selected else "owner_policy_preserved",
        backend_id="connected.coding-device" if selected else None,
        principal_did="did:key:zAgent",
        policy_version=1 if selected else None,
        selected=selected,
        reason=None if selected else "another connected agent is selected",
    )


def test_default_host_profiles_are_isolated(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("DINA_CONFIG_DIR", raising=False)
    monkeypatch.setenv("DINA_PLUGIN_DEV_MODE", "1")
    monkeypatch.setenv("DINA_AGENT_HOST_CONFIG_ROOT", str(tmp_path))

    claude = AgentHostSetup("claude-code", manager=FakeManager())
    codex = AgentHostSetup("codex", manager=FakeManager())

    assert claude.config_dir == (tmp_path / "claude-code" / "cli").resolve()
    assert codex.config_dir == (tmp_path / "codex" / "cli").resolve()


def test_development_exact_host_config_dir_is_honored(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    exact = tmp_path / "isolated-claude-profile"
    monkeypatch.delenv("DINA_CONFIG_DIR", raising=False)
    monkeypatch.delenv("DINA_AGENT_HOST_CONFIG_ROOT", raising=False)
    monkeypatch.setenv("DINA_PLUGIN_DEV_MODE", "1")
    monkeypatch.setenv("DINA_AGENT_HOST_CONFIG_DIR", str(exact))

    setup = AgentHostSetup("claude-code", manager=FakeManager())

    assert setup.config_dir == exact.resolve()


def test_packaged_setup_ignores_exact_host_config_override(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("DINA_CONFIG_DIR", raising=False)
    monkeypatch.delenv("DINA_AGENT_HOST_CONFIG_ROOT", raising=False)
    monkeypatch.delenv("DINA_PLUGIN_DEV_MODE", raising=False)
    monkeypatch.setenv("DINA_AGENT_HOST_CONFIG_DIR", str(tmp_path / "attacker"))
    monkeypatch.setattr(Path, "home", classmethod(lambda _cls: tmp_path / "owner"))

    setup = AgentHostSetup("claude-code", manager=FakeManager())

    assert setup.config_dir == (
        tmp_path / "owner" / ".dina" / "agent-hosts" / "claude-code" / "cli"
    ).resolve()


def _wire_dependencies(
    monkeypatch: pytest.MonkeyPatch,
    *,
    selection: HomeNodeReasoningSelection | None = None,
) -> None:
    enrollment = _enrollment()
    chosen = selection or _selection()
    monkeypatch.setattr(
        agent_host_setup_module,
        "HomeNodeAgentEnroller",
        lambda manager, config_dir, **_kwargs: SimpleNamespace(
            enroll=lambda: enrollment
        ),
    )
    monkeypatch.setattr(
        agent_host_setup_module,
        "HomeNodeReasoningSelector",
        lambda manager: SimpleNamespace(select=lambda received: chosen),
    )
    monkeypatch.setattr(
        AgentHostSetup,
        "_probe_agent",
        lambda self: {
            "paired": True,
            "authenticated": True,
            "core_reachable": True,
            "did": enrollment.agent_did,
            "home_did": enrollment.home_did,
            "transport": "direct",
            "config_dir": str(self.config_dir),
        },
    )


@pytest.mark.parametrize("host", ["claude-code", "codex"])
def test_install_has_one_shared_flow_and_host_specific_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    host: str,
) -> None:
    manager = FakeManager()
    _wire_dependencies(monkeypatch)
    setup = AgentHostSetup(host, manager=manager, config_dir=tmp_path / "cli")

    result = setup.install(local_only=True, pds_handle=None, pds_email=None)

    assert result["ready"] is True
    assert result["host"] == host
    assert result["connected_brain"]["selected"] is True
    assert manager.install_calls[0]["pds_handle"] is None
    assert manager.install_calls[0]["start"] is True
    assert "Docker" not in " ".join(result["next_steps"])


def test_public_install_normalizes_identity_and_passes_test_overrides(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = FakeManager()
    _wire_dependencies(monkeypatch)
    monkeypatch.setenv("DINA_PLUGIN_DEV_MODE", "1")
    monkeypatch.setenv("DINA_SETUP_ENDPOINT_MODE", "test")
    monkeypatch.setenv("DINA_SETUP_CORE_PORT", "18100")
    monkeypatch.setenv("DINA_SETUP_BRAIN_PORT", "18200")
    setup = AgentHostSetup("codex", manager=manager, config_dir=tmp_path / "cli")

    setup.install(
        local_only=False,
        pds_handle="Owner.Test-PDS.DinaKernel.com",
        pds_email="owner@example.com",
    )

    install = manager.install_calls[0]
    assert install["pds_handle"] == "owner.test-pds.dinakernel.com"
    assert install["pds_email"] == "owner@example.com"
    assert install["endpoint_mode"] == "test"
    assert install["core_port"] == 18100
    assert install["brain_port"] == 18200


def test_packaged_setup_ignores_development_install_overrides(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = FakeManager()
    _wire_dependencies(monkeypatch)
    monkeypatch.delenv("DINA_PLUGIN_DEV_MODE", raising=False)
    monkeypatch.setenv("DINA_SETUP_HOME_NODE_RELEASE", "attacker-release")
    monkeypatch.setenv("DINA_SETUP_HOME_NODE_BUNDLE", str(tmp_path / "attacker.tgz"))
    monkeypatch.setenv("DINA_SETUP_ENDPOINT_MODE", "test")
    monkeypatch.setenv("DINA_SETUP_CORE_PORT", "18100")
    monkeypatch.setenv("DINA_SETUP_BRAIN_PORT", "18200")
    setup = AgentHostSetup("codex", manager=manager, config_dir=tmp_path / "cli")

    setup.install(local_only=True, pds_handle=None, pds_email=None)

    install = manager.install_calls[0]
    assert install["bundle_path"] is None
    assert install["endpoint_mode"] == "release"
    assert install["core_port"] == 8100
    assert install["brain_port"] == 8200
    assert install["release_version"] != "attacker-release"


def test_ensure_repairs_without_replacing_owner_brain_policy(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = FakeManager(installed=True)
    _wire_dependencies(monkeypatch, selection=_selection(selected=False))
    setup = AgentHostSetup("codex", manager=manager, config_dir=tmp_path / "cli")

    result = setup.ensure()

    assert manager.ensure_calls == [(False, 120.0)]
    assert result["connected_brain"]["status"] == "owner_policy_preserved"
    assert result["connected_brain"]["selected"] is False
    assert "preserved" in " ".join(result["next_steps"]).lower()


def test_setup_refuses_implicit_identity_and_existing_identity_replacement(
    tmp_path: Path,
) -> None:
    new_setup = AgentHostSetup(
        "codex",
        manager=FakeManager(),
        config_dir=tmp_path / "new",
    )
    with pytest.raises(AgentHostSetupError) as missing:
        new_setup.install(local_only=False, pds_handle=None, pds_email=None)
    assert missing.value.code == "identity_choice_required"

    existing_setup = AgentHostSetup(
        "codex",
        manager=FakeManager(installed=True),
        config_dir=tmp_path / "existing",
    )
    with pytest.raises(AgentHostSetupError) as replacement:
        existing_setup.install(
            local_only=False,
            pds_handle="replacement.pds.dinakernel.com",
            pds_email=None,
        )
    assert replacement.value.code == "identity_already_configured"


def test_cli_converts_home_node_failures_to_structured_setup_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_install(self, **_kwargs):
        raise HomeNodeError("native release asset was not found")

    monkeypatch.setattr(AgentHostSetup, "install", fail_install)

    result = CliRunner().invoke(
        cli,
        ["--json", "agent-host", "setup", "--host", "codex", "--local-only"],
    )

    assert result.exit_code == 2
    payload = json.loads(result.output)
    assert payload["code"] == "home_node_setup_failed"
    assert payload["message"] == "native release asset was not found"
    assert "Traceback" not in result.output
