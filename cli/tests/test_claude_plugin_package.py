"""Structural checks for the installable Claude Code plugin bundle."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest
from click.testing import CliRunner

from dina_cli import __version__
from dina_cli.agent_host_setup import AgentHostSetupError, normalize_pds_handle
from dina_cli.main import cli


REPO_ROOT = Path(__file__).resolve().parents[2]
CLI_ROOT = REPO_ROOT / "cli"
MARKETPLACE_ROOT = REPO_ROOT
PLUGIN_ROOT = CLI_ROOT / "claude-plugin" / "dina"
SETUP = PLUGIN_ROOT / "bin" / "dina-setup"
AUTHORIZER = PLUGIN_ROOT / "bin" / "dina-bootstrap-authorize"
CLI_WRAPPER = PLUGIN_ROOT / "bin" / "dina-cli"


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_cli_runtime_version_matches_package_metadata() -> None:
    metadata = tomllib.loads((CLI_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert __version__ == metadata["project"]["version"]
    assert "fastmcp==2.14.5" in metadata["project"]["dependencies"]

    result = CliRunner().invoke(cli, ["--version"])
    assert result.exit_code == 0
    assert result.output.strip() == f"dina-agent, version {__version__}"


def test_home_node_status_is_available_before_pairing(tmp_path: Path) -> None:
    result = CliRunner().invoke(
        cli,
        ["--json", "home-node", "status"],
        env={"DINA_HOME_NODE_DIR": str(tmp_path / "home-node")},
    )

    assert result.exit_code == 0
    assert json.loads(result.output) == {
        "installed": False,
        "running": False,
        "core_healthy": False,
        "brain_healthy": False,
        "core_url": "http://127.0.0.1:8100",
        "brain_url": "http://127.0.0.1:8200",
        "install_dir": str(tmp_path / "home-node"),
        "release_version": None,
        "autostart_enabled": False,
    }


def test_authority_reveal_commands_require_a_human_tty() -> None:
    runner = CliRunner()

    for command in ("show-owner-capability", "show-recovery-phrase"):
        result = runner.invoke(cli, ["home-node", command])
        assert result.exit_code != 0
        assert "interactive human terminal" in result.output


def test_plugin_uses_only_the_automatic_standard_hooks_file() -> None:
    manifest = _load_json(PLUGIN_ROOT / ".claude-plugin" / "plugin.json")
    hooks = _load_json(PLUGIN_ROOT / "hooks" / "hooks.json")

    # Claude Code loads hooks/hooks.json automatically. Declaring it again in the
    # manifest causes duplicate hook registration in an installed plugin.
    assert "hooks" not in manifest
    session_start = hooks["hooks"]["SessionStart"]
    assert len(session_start) == 1
    assert "matcher" not in session_start[0]
    assert session_start[0]["hooks"] == [
        {
            "type": "command",
            "command": (
                '"${CLAUDE_PLUGIN_ROOT}/bin/dina-cli" '
                "home-node ensure --if-installed --quiet"
            ),
            "timeout": 120,
        }
    ]
    pre_tool_use = hooks["hooks"]["PreToolUse"]
    assert len(pre_tool_use) == 1
    assert pre_tool_use[0]["matcher"] == "*"
    assert pre_tool_use[0]["hooks"] == [
        {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/bin/dina-gate",
        }
    ]
    session_end = hooks["hooks"]["SessionEnd"]
    assert len(session_end) == 1
    assert "matcher" not in session_end[0]
    assert session_end[0]["hooks"] == [
        {
            "type": "command",
            "command": '"${CLAUDE_PLUGIN_ROOT}/bin/dina-cli" session-end-hook',
            "timeout": 10,
        }
    ]


def test_plugin_bundle_contains_its_runtime_and_recovery_docs() -> None:
    manifest = _load_json(PLUGIN_ROOT / ".claude-plugin" / "plugin.json")
    mcp_config = _load_json(PLUGIN_ROOT / ".mcp.json")
    readme = (PLUGIN_ROOT / "README.md").read_text(encoding="utf-8")
    normalized_readme = " ".join(readme.lower().split())
    gate = PLUGIN_ROOT / "bin" / "dina-gate"

    assert manifest["version"] == "0.3.0"
    assert "/dina:setup" in manifest["description"]
    assert mcp_config["mcpServers"]["dina"]["command"] == (
        "${CLAUDE_PLUGIN_ROOT}/bin/dina-cli"
    )
    assert mcp_config["mcpServers"]["dina"]["args"] == [
        "mcp-server",
        "--profile",
        "connected",
    ]
    assert "install the plugin first" in normalized_readme
    assert "/dina:setup" in normalized_readme
    assert "private managed python environment" in normalized_readme
    assert "no source checkout, docker, global python installation" in normalized_readme
    assert "never purges" in normalized_readme
    assert "private terminal" in normalized_readme
    assert "dina unpair" in readme
    for executable in (gate, SETUP, AUTHORIZER, CLI_WRAPPER):
        assert executable.stat().st_mode & stat.S_IXUSR
    assert (PLUGIN_ROOT / "commands" / "setup.md").is_file()


def test_plugin_bundles_mcp_native_usage_instructions() -> None:
    skill = (PLUGIN_ROOT / "skills" / "dina" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    assert "dina_session_start" in skill
    assert "dina_session_end" in skill
    assert "dina_validate" in skill
    assert "pending_approval" in skill
    assert "dina_scrub" in skill
    assert "dina_find_service" in skill
    assert "dina_talk" in skill
    assert "dina_delegate" in skill
    assert "only `completed` proves" in skill
    assert "PreToolUse" in skill
    assert (PLUGIN_ROOT / "skills" / "dina-work" / "SKILL.md").is_file()


def test_marketplace_points_at_the_self_contained_plugin() -> None:
    marketplace = _load_json(
        MARKETPLACE_ROOT / ".claude-plugin" / "marketplace.json"
    )
    plugins = marketplace["plugins"]

    assert len(plugins) == 1
    assert plugins[0]["name"] == "dina"
    assert plugins[0]["source"] == "./cli/claude-plugin/dina"
    assert "/dina:setup" in plugins[0]["description"]
    assert (PLUGIN_ROOT / "README.md").is_file()


def _authorize(event: dict) -> int:
    result = subprocess.run(
        [str(AUTHORIZER)],
        input=json.dumps(event),
        text=True,
        env={**os.environ, "CLAUDE_PLUGIN_ROOT": str(PLUGIN_ROOT)},
        capture_output=True,
        timeout=10,
        check=False,
    )
    return result.returncode


def _home_node_ready(value: object) -> int:
    result = subprocess.run(
        [str(AUTHORIZER), "--home-node-ready"],
        input=json.dumps(value),
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    return result.returncode


@pytest.mark.parametrize(
    ("event", "expected"),
    [
        (
            {
                "tool_name": "AskUserQuestion",
                "tool_input": {"questions": []},
            },
            10,
        ),
        (
            {
                "tool_name": "Bash",
                "tool_input": {
                    "command": (
                        '"${CLAUDE_PLUGIN_ROOT}/bin/dina-setup" --status --json'
                    )
                },
            },
            0,
        ),
        (
            {
                "tool_name": "Bash",
                "tool_input": {
                    "command": (
                        f'"{SETUP}" --pds-handle '
                        "Owner.PDS.DinaKernel.com --json"
                    )
                },
            },
            0,
        ),
        (
            {
                "tool_name": "Bash",
                "tool_input": {
                    "command": (
                        f'"{SETUP}" --pds-handle '
                        "owner.pds.dinakernel.com --pds-email owner@example.com --json"
                    )
                },
            },
            0,
        ),
        (
            {
                "tool_name": "Bash",
                "tool_input": {"command": f'"{SETUP}" --local-only; touch /tmp/x'},
            },
            1,
        ),
        (
            {
                "tool_name": "Bash",
                "tool_input": {
                    "command": f'"{SETUP}" --pds-handle "$(whoami).example.com"'
                },
            },
            1,
        ),
        (
            {
                "tool_name": "Bash",
                "tool_input": {"command": f'"{SETUP}" --bundle payload.tar.gz'},
            },
            1,
        ),
        (
            {"tool_name": "Read", "tool_input": {"file_path": "README.md"}},
            1,
        ),
    ],
)
def test_bootstrap_authorizer_has_a_narrow_surface(
    event: dict, expected: int
) -> None:
    assert _authorize(event) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (
            {
                "installed": True,
                "running": True,
                "core_healthy": True,
                "brain_healthy": True,
            },
            0,
        ),
        (
            {
                "installed": True,
                "running": True,
                "core_healthy": False,
                "brain_healthy": True,
            },
            1,
        ),
        ({}, 1),
        ([], 1),
    ],
)
def test_bootstrap_authorizer_only_recognizes_a_healthy_home_node(
    value: object, expected: int
) -> None:
    assert _home_node_ready(value) == expected


def test_managed_cli_wrapper_does_not_require_path_installation(tmp_path: Path) -> None:
    managed = tmp_path / "runtime" / "venv" / "bin" / "dina"
    managed.parent.mkdir(parents=True)
    managed.write_text("#!/bin/sh\nprintf 'managed:%s\\n' \"$*\"\n", encoding="utf-8")
    managed.chmod(0o755)

    result = subprocess.run(
        [str(CLI_WRAPPER), "status"],
        env={
            **os.environ,
            "DINA_SETUP_RUNTIME_DIR": str(tmp_path / "runtime"),
            "DINA_CLI_BIN": "",
        },
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0
    assert result.stdout.strip() == "managed:status"


def _fake_dina(tmp_path: Path) -> tuple[Path, Path, Path]:
    state = tmp_path / "installed"
    log = tmp_path / "commands.log"
    log.unlink(missing_ok=True)
    fake = tmp_path / "dina"
    fake.write_text(
        f"""#!{sys.executable}
import json
import os
import sys
from pathlib import Path

state = Path(os.environ["FAKE_DINA_STATE"])
log = Path(os.environ["FAKE_DINA_LOG"])
args = sys.argv[1:]
command_args = args[1:] if args[:1] == ["--json"] else args
with log.open("a", encoding="utf-8") as out:
    out.write(json.dumps(args) + "\\n")

if args == ["--version"]:
    print("dina-agent, version 0.20.0")
    raise SystemExit(0)

if command_args[:2] == ["agent-host", "setup"]:
    host = command_args[command_args.index("--host") + 1]
    installed = state.exists()
    if "--status" in command_args:
        print(json.dumps({{
            "kind": "setup_status",
            "host": host,
            "ready": installed,
            "cli": {{"available": True, "version": "0.20.0"}},
            "home_node": {{
                "installed": installed,
                "running": installed,
                "core_healthy": installed,
                "brain_healthy": installed,
            }},
            "needs_identity_choice": not installed,
        }}))
        raise SystemExit(0)
    if "--ensure" in command_args and not installed:
        print(json.dumps({{
            "kind": "setup_error",
            "host": host,
            "ready": False,
            "code": "identity_choice_required",
            "message": "Choose an identity.",
        }}))
        raise SystemExit(2)
    selecting_identity = (
        "--local-only" in command_args or "--pds-handle" in command_args
    )
    if installed and selecting_identity:
        print(json.dumps({{
            "kind": "setup_error",
            "host": host,
            "ready": False,
            "code": "identity_already_configured",
            "message": "Identity already configured.",
        }}))
        raise SystemExit(2)
    if not installed and not selecting_identity:
        print(json.dumps({{
            "kind": "setup_error",
            "host": host,
            "ready": False,
            "code": "identity_choice_required",
            "message": "Choose an identity.",
        }}))
        raise SystemExit(2)
    state.touch()
    print(json.dumps({{
        "kind": "setup_complete",
        "host": host,
        "ready": True,
        "installed_now": not installed,
        "home_node": {{
            "core_url": "http://127.0.0.1:8100",
            "brain_url": "http://127.0.0.1:8200",
            "owner_url": "http://127.0.0.1:8100/owner",
        }},
        "agent": {{
            "did": "did:key:zAgent",
            "home_did": "did:key:zHome",
            "transport": "direct",
        }},
        "connected_brain": {{
            "status": "selected" if not installed else "already_selected",
            "backend_id": "connected.coding-device-1",
            "principal_did": "did:key:zAgent",
            "policy_version": 1,
            "selected": True,
            "reason": None,
        }},
        "next_steps": [],
    }}))
    raise SystemExit(0)

print("unsupported fake command", args, file=sys.stderr)
raise SystemExit(9)
""",
        encoding="utf-8",
    )
    fake.chmod(0o755)
    return fake, state, log


def _run_setup(
    tmp_path: Path,
    *args: str,
) -> tuple[subprocess.CompletedProcess[str], list[list[str]]]:
    fake, state, log = _fake_dina(tmp_path)
    result = subprocess.run(
        [str(SETUP), *args, "--json"],
        env={
            **os.environ,
            "DINA_CLI_BIN": str(fake),
            "DINA_CONFIG_DIR": str(tmp_path / "config"),
            "DINA_HOME_NODE_DIR": str(tmp_path / "home-node"),
            "FAKE_DINA_STATE": str(state),
            "FAKE_DINA_LOG": str(log),
        },
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    commands = (
        [
            json.loads(line)
            for line in log.read_text(encoding="utf-8").splitlines()
            if line
        ]
        if log.is_file()
        else []
    )
    return result, commands


def _command_without_global_flags(command: list[str]) -> list[str]:
    return command[1:] if command[:1] == ["--json"] else command


def _find_command(commands: list[list[str]], prefix: list[str]) -> list[str]:
    return next(
        command
        for command in commands
        if _command_without_global_flags(command)[: len(prefix)] == prefix
    )


def _has_command(commands: list[list[str]], prefix: list[str]) -> bool:
    return any(
        _command_without_global_flags(command)[: len(prefix)] == prefix
        for command in commands
    )


def test_setup_installs_local_home_node_and_enrolls_agent(tmp_path: Path) -> None:
    result, commands = _run_setup(tmp_path, "--local-only")

    assert result.returncode == 0, result.stderr or result.stdout
    value = json.loads(result.stdout)
    assert value["ready"] is True
    assert value["installed_now"] is True
    assert value["connected_brain"]["selected"] is True
    setup = _find_command(commands, ["agent-host", "setup"])
    assert setup[setup.index("--host") + 1] == "claude-code"
    assert "--local-only" in setup
    assert "--pds-handle" not in setup


def test_setup_passes_public_identity_without_shell_interpolation(
    tmp_path: Path,
) -> None:
    result, commands = _run_setup(
        tmp_path,
        "--pds-handle",
        "owner.pds.dinakernel.com",
        "--pds-email",
        "owner@example.com",
    )

    assert result.returncode == 0, result.stderr or result.stdout
    setup = _find_command(commands, ["agent-host", "setup"])
    assert setup[setup.index("--pds-handle") + 1] == "owner.pds.dinakernel.com"
    assert setup[setup.index("--pds-email") + 1] == "owner@example.com"


def test_setup_normalizes_public_identity_before_install(tmp_path: Path) -> None:
    assert normalize_pds_handle("Owner.PDS.DinaKernel.com") == (
        "owner.pds.dinakernel.com"
    )


def test_setup_rejects_overlong_managed_pds_handle_before_cli_work(
    tmp_path: Path,
) -> None:
    with pytest.raises(AgentHostSetupError) as error:
        normalize_pds_handle("toolong.test-pds.dinakernel.com")
    assert error.value.code == "pds_handle_too_long"
    assert "prefix of at most 6 characters" in str(error.value)


def test_setup_repairs_existing_install_without_reprovisioning(tmp_path: Path) -> None:
    first, _ = _run_setup(tmp_path, "--local-only")
    assert first.returncode == 0
    second, commands = _run_setup(tmp_path, "--ensure")

    assert second.returncode == 0, second.stderr or second.stdout
    value = json.loads(second.stdout)
    assert value["installed_now"] is False
    assert value["connected_brain"]["selected"] is True
    setup = _find_command(commands, ["agent-host", "setup"])
    assert "--ensure" in setup
    assert "--local-only" not in setup


def test_setup_requires_identity_choice_and_preserves_existing_identity(
    tmp_path: Path,
) -> None:
    missing, _ = _run_setup(tmp_path)
    assert missing.returncode == 2
    assert json.loads(missing.stdout)["code"] == "identity_choice_required"

    installed, _ = _run_setup(tmp_path, "--local-only")
    assert installed.returncode == 0
    replacement, commands = _run_setup(
        tmp_path,
        "--pds-handle",
        "replacement.pds.dinakernel.com",
    )
    assert replacement.returncode == 2
    assert json.loads(replacement.stdout)["code"] == "identity_already_configured"
    setup = _find_command(commands, ["agent-host", "setup"])
    assert "--pds-handle" in setup
