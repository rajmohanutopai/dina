"""Structural and fail-closed checks for the installable Codex plugin."""

from __future__ import annotations

import json
import os
import stat
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MARKETPLACE_ROOT = REPO_ROOT / "cli" / "codex-plugin" / ".agents" / "plugins"
PLUGIN_ROOT = MARKETPLACE_ROOT / "plugins" / "dina"
SUPERVISOR = PLUGIN_ROOT / "bin" / "dina-gate"


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_marketplace_points_at_the_self_contained_plugin() -> None:
    marketplace = _load_json(MARKETPLACE_ROOT / "marketplace.json")
    entry = marketplace["plugins"][0]

    assert marketplace["name"] == "dina"
    assert entry["name"] == "dina"
    assert entry["source"] == {
        "source": "local",
        "path": "./plugins/dina",
    }
    assert entry["policy"] == {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL",
    }
    assert PLUGIN_ROOT.is_dir()


def test_manifest_and_mcp_server_match_the_supported_cli_contract() -> None:
    manifest = _load_json(PLUGIN_ROOT / ".codex-plugin" / "plugin.json")
    mcp = _load_json(PLUGIN_ROOT / ".mcp.json")

    assert manifest["name"] == PLUGIN_ROOT.name
    assert manifest["version"] == "0.2.0"
    assert manifest["skills"] == "./skills/"
    assert manifest["mcpServers"] == "./.mcp.json"
    assert "hooks" not in manifest
    assert isinstance(manifest["interface"]["defaultPrompt"], list)
    assert 1 <= len(manifest["interface"]["defaultPrompt"]) <= 3
    assert mcp == {
        "mcpServers": {
            "dina": {
                "command": "dina",
                "args": ["mcp-server", "--profile", "coding"],
            }
        }
    }


def test_codex_hooks_use_the_codex_supervisor_and_supported_timeouts() -> None:
    hooks = _load_json(PLUGIN_ROOT / "hooks" / "hooks.json")["hooks"]

    assert hooks["SessionStart"] == [
        {
            "matcher": "startup|resume|clear|compact",
            "hooks": [
                {
                    "type": "command",
                    "command": "dina home-node ensure --if-installed --quiet",
                    "timeout": 120,
                    "statusMessage": "Checking Dina Home Node",
                }
            ],
        }
    ]
    assert hooks["PreToolUse"] == [
        {
            "matcher": "*",
            "hooks": [
                {
                    "type": "command",
                    "command": "${PLUGIN_ROOT}/bin/dina-gate",
                    "timeout": 20,
                    "statusMessage": "Checking Dina policy",
                }
            ],
        }
    ]
    assert hooks["SessionEnd"][0]["hooks"][0]["timeout"] == 3


def test_plugin_documents_codex_specific_security_boundaries() -> None:
    readme = (PLUGIN_ROOT / "README.md").read_text(encoding="utf-8")
    skill = (PLUGIN_ROOT / "skills" / "dina" / "SKILL.md").read_text(encoding="utf-8")
    normalized_skill = " ".join(skill.split())
    supervisor = SUPERVISOR.read_text(encoding="utf-8")

    assert SUPERVISOR.stat().st_mode & stat.S_IXUSR
    assert "gate-hook --host codex" in supervisor
    assert "Codex currently cannot ask for local approval" in readme
    assert "Hosted tools such as web search are not hook-visible" in readme
    assert "pending_approval" in skill
    assert "approve in Dina, then retry the exact tool call" in normalized_skill
    assert "dina_talk" in skill
    assert "dina_delegate" in skill
    assert "only `completed` proves" in skill


@pytest.mark.skipif(os.name != "posix", reason="supervisor is a POSIX sh script")
@pytest.mark.parametrize(
    ("fake_body", "expected"),
    [
        ("exit 0", 0),
        ("exit 2", 2),
        ("exit 1", 2),
        ("kill -TERM $$", 2),
    ],
)
def test_codex_supervisor_normalizes_child_results(
    tmp_path: Path, fake_body: str, expected: int
) -> None:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    fake = bindir / "dina"
    fake.write_text(f"#!/bin/sh\n{fake_body}\n", encoding="utf-8")
    fake.chmod(0o755)
    env = dict(os.environ)
    env["PATH"] = str(bindir)

    result = subprocess.run(
        [str(SUPERVISOR)],
        input=b'{"session_id":"codex-1","tool_name":"Bash","tool_input":{}}',
        env=env,
        capture_output=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == expected
    if expected == 2 and fake_body != "exit 2":
        assert b"blocked" in result.stderr.lower()


@pytest.mark.skipif(os.name != "posix", reason="supervisor is a POSIX sh script")
def test_codex_supervisor_passes_the_host_mode(tmp_path: Path) -> None:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    args_file = tmp_path / "args"
    fake = bindir / "dina"
    fake.write_text(
        '#!/bin/sh\nprintf "%s\\n" "$*" > "$DINA_TEST_ARGS"\nexit 0\n',
        encoding="utf-8",
    )
    fake.chmod(0o755)
    env = dict(os.environ)
    env["PATH"] = str(bindir)
    env["DINA_TEST_ARGS"] = str(args_file)

    result = subprocess.run(
        [str(SUPERVISOR)],
        input=b'{"session_id":"codex-1","tool_name":"Bash","tool_input":{}}',
        env=env,
        capture_output=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0
    assert args_file.read_text(encoding="utf-8").strip() == "gate-hook --host codex"


@pytest.mark.skipif(os.name != "posix", reason="supervisor is a POSIX sh script")
def test_codex_supervisor_blocks_when_dina_is_missing(tmp_path: Path) -> None:
    empty_path = tmp_path / "empty-bin"
    empty_path.mkdir()
    env = dict(os.environ)
    env["PATH"] = str(empty_path)

    result = subprocess.run(
        [str(SUPERVISOR)],
        input=b"{}",
        env=env,
        capture_output=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 2
    assert b"not on path" in result.stderr.lower()
