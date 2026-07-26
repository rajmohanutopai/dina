"""Structural checks for the installable Claude Code plugin bundle."""

from __future__ import annotations

import json
import stat
import tomllib
from pathlib import Path

from click.testing import CliRunner

from dina_cli import __version__
from dina_cli.main import cli


REPO_ROOT = Path(__file__).resolve().parents[2]
CLI_ROOT = REPO_ROOT / "cli"
MARKETPLACE_ROOT = CLI_ROOT / "claude-plugin"
PLUGIN_ROOT = MARKETPLACE_ROOT / "dina"


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
            "command": "dina home-node ensure --if-installed --quiet",
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
            "command": "dina session-end-hook",
            "timeout": 10,
        }
    ]


def test_plugin_bundle_contains_its_runtime_and_recovery_docs() -> None:
    manifest = _load_json(PLUGIN_ROOT / ".claude-plugin" / "plugin.json")
    mcp_config = _load_json(PLUGIN_ROOT / ".mcp.json")
    readme = (PLUGIN_ROOT / "README.md").read_text(encoding="utf-8")
    normalized_readme = " ".join(readme.lower().split())
    gate = PLUGIN_ROOT / "bin" / "dina-gate"

    assert manifest["version"] == "0.2.0"
    assert "dina-agent>=0.20.0" in manifest["description"]
    assert mcp_config["mcpServers"]["dina"]["command"] == "dina"
    assert mcp_config["mcpServers"]["dina"]["args"] == [
        "mcp-server",
        "--profile",
        "connected",
    ]
    assert "before" in normalized_readme
    assert "automatically enrolls" in normalized_readme
    assert "home-node enroll-agent" in normalized_readme
    assert "home node installation and supervision are owned by" in normalized_readme
    assert "automatic local coding-agent enrollment is implemented" in normalized_readme
    assert "dina unpair" in readme
    assert gate.stat().st_mode & stat.S_IXUSR


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
    assert plugins[0]["source"] == "./dina"
    assert "dina-agent>=0.20.0" in plugins[0]["description"]
    assert (PLUGIN_ROOT / "README.md").is_file()
