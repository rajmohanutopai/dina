"""Structural and fail-closed checks for the installable Codex plugin."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MARKETPLACE_ROOT = REPO_ROOT / "cli" / "codex-plugin"
MARKETPLACE_MANIFEST = MARKETPLACE_ROOT / ".agents" / "plugins" / "marketplace.json"
ROOT_MARKETPLACE_MANIFEST = REPO_ROOT / ".agents" / "plugins" / "marketplace.json"
PLUGIN_ROOT = MARKETPLACE_ROOT / "plugins" / "dina"
SUPERVISOR = PLUGIN_ROOT / "bin" / "dina-gate"
SETUP = PLUGIN_ROOT / "bin" / "dina-setup"
BOOTSTRAP_AUTHORIZER = PLUGIN_ROOT / "bin" / "dina-bootstrap-authorize"
SETUP_SKILL = PLUGIN_ROOT / "skills" / "dina-setup" / "SKILL.md"


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _bootstrap_authorize(event: dict, **env_overrides: str) -> int:
    result = subprocess.run(
        [str(BOOTSTRAP_AUTHORIZER)],
        input=json.dumps(event),
        env={
            **os.environ,
            "DINA_PLUGIN_ROOT": str(PLUGIN_ROOT),
            **env_overrides,
        },
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    return result.returncode


def test_marketplace_points_at_the_self_contained_plugin() -> None:
    marketplace = _load_json(MARKETPLACE_MANIFEST)
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

    root_marketplace = _load_json(ROOT_MARKETPLACE_MANIFEST)
    assert root_marketplace["plugins"][0]["source"] == {
        "source": "local",
        "path": "./cli/codex-plugin/plugins/dina",
    }


def test_manifest_and_mcp_server_match_the_supported_cli_contract() -> None:
    manifest = _load_json(PLUGIN_ROOT / ".codex-plugin" / "plugin.json")
    mcp = _load_json(PLUGIN_ROOT / ".mcp.json")

    assert manifest["name"] == PLUGIN_ROOT.name
    assert manifest["version"] == "0.3.1"
    assert manifest["skills"] == "./skills/"
    assert manifest["mcpServers"] == "./.mcp.json"
    assert "hooks" not in manifest
    assert isinstance(manifest["interface"]["defaultPrompt"], list)
    assert 1 <= len(manifest["interface"]["defaultPrompt"]) <= 3
    assert mcp == {
        "mcpServers": {
            "dina": {
                "command": "./bin/dina-cli",
                "args": ["mcp-server", "--profile", "connected"],
                "cwd": ".",
                # Dina Core owns authorization and approval; a second Codex MCP
                # prompt would reject even read-only tools in noninteractive runs.
                "default_tools_approval_mode": "approve",
                "env": {"DINA_AGENT_HOST": "codex"},
                "env_vars": [
                    "DINA_AGENT_HOST_CONFIG_DIR",
                    "DINA_AGENT_HOST_CONFIG_ROOT",
                    "DINA_CLI_KEY_PASSPHRASE",
                    "DINA_CONFIG_DIR",
                    "DINA_HOME_NODE_DIR",
                    "DINA_PLUGIN_DEV_MODE",
                    "DINA_SETUP_RUNTIME_DIR",
                ],
            }
        }
    }


def test_codex_preview_uses_the_installer_owned_host_profile() -> None:
    preview = (
        REPO_ROOT / "scripts" / "dev" / "dina-codex-preview.sh"
    ).read_text(encoding="utf-8")

    assert 'export DINA_AGENT_HOST_CONFIG_DIR="$DINA_CONFIG_DIR"' in preview
    assert "DINA_AGENT_HOST_CONFIG_DIR=%q" in preview


def test_codex_hooks_use_the_codex_supervisor_and_supported_timeouts() -> None:
    hooks = _load_json(PLUGIN_ROOT / "hooks" / "hooks.json")["hooks"]

    assert hooks["SessionStart"] == [
        {
            "matcher": "startup|resume|clear|compact",
            "hooks": [
                {
                    "type": "command",
                    "command": (
                        'DINA_AGENT_HOST=codex "${PLUGIN_ROOT}/bin/dina-cli" '
                        "home-node ensure --if-installed --quiet"
                    ),
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
    assert hooks["SessionEnd"][0]["hooks"][0]["command"] == (
        'DINA_AGENT_HOST=codex "${PLUGIN_ROOT}/bin/dina-cli" session-end-hook'
    )


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
    assert "dina_memory_propose" in skill
    assert "configured always-on Dina Brain" in normalized_skill
    assert "dina_remember_status" in skill
    assert "Never call `dina_session_end` while a" in skill
    assert "approve in Dina, then retry the exact tool call" in normalized_skill
    assert "dina_talk" in skill
    assert "dina_delegate" in skill
    assert "only `completed` proves" in skill
    assert (PLUGIN_ROOT / "skills" / "dina-work" / "SKILL.md").is_file()
    setup_skill = (PLUGIN_ROOT / "skills" / "dina-setup" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    assert "foreground Brain" in setup_skill
    assert "Never request, receive, paste, or" in setup_skill
    assert "No source checkout, Docker, global Python package" in readme
    assert "codex plugin marketplace add rajmohanutopai/dina-plugins" in readme
    assert "--sparse" not in readme

    for skill_name in ("audit", "pair-phone"):
        maintenance_skill = (
            PLUGIN_ROOT / "skills" / skill_name / "SKILL.md"
        ).read_text(encoding="utf-8")
        assert '"${PLUGIN_ROOT}/bin/dina-cli"' in maintenance_skill
        assert "DINA_AGENT_HOST=codex" in maintenance_skill
    status_skill = (PLUGIN_ROOT / "skills" / "status" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    assert "`dina_status` MCP tool" in status_skill
    assert "false offline" in status_skill
    assert "home-node status" not in status_skill
    pair_phone = (
        PLUGIN_ROOT / "skills" / "pair-phone" / "SKILL.md"
    ).read_text(encoding="utf-8")
    assert "Never run a recovery-authority reveal command" in pair_phone
    assert "dina home-node show-recovery-phrase" not in pair_phone

    for name in (
        "dina-bootstrap-authorize",
        "dina-cli",
        "dina-gate",
        "dina-setup",
        "dina-setup-bootstrap",
    ):
        assert (PLUGIN_ROOT / "bin" / name).stat().st_mode & stat.S_IXUSR


def test_shared_runtime_copies_are_current() -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "dev" / "sync-agent-plugin-runtime.py"),
            "--check",
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def _fake_setup_cli(tmp_path: Path) -> tuple[Path, Path]:
    log = tmp_path / "setup-args.json"
    fake = tmp_path / "dina"
    fake.write_text(
        f"""#!{sys.executable}
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
if args == ["--version"]:
    print("dina-agent, version 0.20.2")
    raise SystemExit(0)
Path(os.environ["DINA_TEST_ARGS"]).write_text(json.dumps(args), encoding="utf-8")
print(json.dumps({{
    "kind": "setup_complete",
    "host": "codex",
    "ready": True,
    "installed_now": True,
    "connected_brain": {{
        "selected": True,
        "backend_id": "connected.codex-device",
    }},
    "next_steps": [],
}}))
""",
        encoding="utf-8",
    )
    fake.chmod(0o755)
    return fake, log


def test_codex_setup_bootstraps_shared_host_setup(tmp_path: Path) -> None:
    fake, log = _fake_setup_cli(tmp_path)
    result = subprocess.run(
        [str(SETUP), "--local-only", "--json"],
        env={
            **os.environ,
            "DINA_PLUGIN_DEV_MODE": "1",
            "DINA_CLI_BIN": str(fake),
            "DINA_TEST_ARGS": str(log),
            "DINA_SETUP_RUNTIME_DIR": str(tmp_path / "runtime"),
        },
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["connected_brain"]["selected"] is True
    assert json.loads(log.read_text(encoding="utf-8")) == [
        "--json",
        "agent-host",
        "setup",
        "--host",
        "codex",
        "--local-only",
    ]


def test_codex_preview_generates_a_valid_managed_test_pds_handle() -> None:
    preview = (
        REPO_ROOT / "scripts" / "dev" / "dina-codex-preview.sh"
    ).read_text(encoding="utf-8")

    assert "range(6)" in preview
    assert "string.ascii_lowercase+string.digits" in preview
    assert "token_hex(8)" not in preview


def test_setup_status_without_cli_does_not_guess_identity_state(
    tmp_path: Path,
) -> None:
    result = subprocess.run(
        [str(SETUP), "--status", "--json"],
        env={
            **os.environ,
            "DINA_PLUGIN_DEV_MODE": "1",
            "DINA_CLI_BIN": str(tmp_path / "missing-dina"),
            "DINA_SETUP_RUNTIME_DIR": str(tmp_path / "runtime"),
        },
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    value = json.loads(result.stdout)
    assert result.returncode == 0
    assert value["cli"]["available"] is False
    assert value["home_node"]["installed"] is None
    assert value["needs_identity_choice"] is None


def test_packaged_setup_ignores_ambient_cli_override(tmp_path: Path) -> None:
    marker = tmp_path / "executed"
    fake = tmp_path / "fake-dina"
    fake.write_text(
        f"#!/bin/sh\ntouch {marker}\nexit 0\n",
        encoding="utf-8",
    )
    fake.chmod(0o755)
    shadow_bin = tmp_path / "shadow-bin"
    shadow_bin.mkdir()
    shadow_python = shadow_bin / "python3"
    shadow_python.write_text(
        f"#!/bin/sh\necho shadowed > {marker}\nexit 91\n",
        encoding="utf-8",
    )
    shadow_python.chmod(0o755)

    result = subprocess.run(
        [str(SETUP), "--status", "--json"],
        env={
            **os.environ,
            "HOME": str(tmp_path / "home"),
            "DINA_PLUGIN_DEV_MODE": "0",
            "DINA_CLI_BIN": str(fake),
            "DINA_SETUP_RUNTIME_DIR": str(tmp_path / "attacker-runtime"),
            "PATH": str(shadow_bin),
        },
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0
    assert json.loads(result.stdout)["cli"]["available"] is False
    assert not marker.exists()


def test_setup_rejects_a_newer_incompatible_cli(tmp_path: Path) -> None:
    fake = tmp_path / "future-dina"
    fake.write_text(
        f"""#!{sys.executable}
import sys
if sys.argv[1:] == ["--version"]:
    print("dina-agent, version 0.21.0")
    raise SystemExit(0)
raise SystemExit(99)
""",
        encoding="utf-8",
    )
    fake.chmod(0o755)

    result = subprocess.run(
        [str(SETUP), "--local-only", "--json"],
        env={
            **os.environ,
            "DINA_PLUGIN_DEV_MODE": "1",
            "DINA_CLI_BIN": str(fake),
            "DINA_SETUP_RUNTIME_DIR": str(tmp_path / "runtime"),
        },
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    value = json.loads(result.stdout)
    assert result.returncode == 2
    assert value["code"] == "cli_override_incompatible"


def test_bootstrap_authorizer_accepts_codex_cmd_and_rejects_injection() -> None:
    exact = {
        "tool_name": "Bash",
        "tool_input": {
            "cmd": f"{SETUP} --local-only --json",
        },
    }
    injected = {
        "tool_name": "Bash",
        "tool_input": {
            "cmd": f"{SETUP} --local-only --json; echo bypass",
        },
    }

    assert _bootstrap_authorize(exact) == 0
    assert _bootstrap_authorize(injected) == 1


@pytest.mark.parametrize(
    "event",
    [
        {
            "tool_name": "Bash",
            "tool_input": {
                "cmd": f"sed -n '1,240p' {SETUP_SKILL}",
            },
        },
        {
            "tool_name": "Bash",
            "tool_input": {"cmd": f"cat {SETUP_SKILL}"},
        },
        {
            "tool_name": "Read",
            "tool_input": {"file_path": str(SETUP_SKILL)},
        },
    ],
)
def test_bootstrap_authorizer_allows_only_the_plugin_setup_skill(event: dict) -> None:
    assert _bootstrap_authorize(event) == 0


@pytest.mark.parametrize(
    "event",
    [
        {
            "tool_name": "Bash",
            "tool_input": {"cmd": f"sed -n '1,200p' {SETUP_SKILL}"},
        },
        {
            "tool_name": "Bash",
            "tool_input": {"cmd": f"sed -n '1,240p' {PLUGIN_ROOT / 'README.md'}"},
        },
        {
            "tool_name": "Bash",
            "tool_input": {"cmd": f"cat {SETUP_SKILL}; echo bypass"},
        },
        {
            "tool_name": "Bash",
            "tool_input": {"cmd": f"cat {SETUP_SKILL} > /tmp/setup-skill"},
        },
        {
            "tool_name": "Read",
            "tool_input": {"file_path": str(PLUGIN_ROOT / "README.md")},
        },
        {
            "tool_name": "Read",
            "tool_input": {"file_path": str(SETUP_SKILL), "limit": 240},
        },
        {
            "tool_name": "Read",
            "tool_input": {
                "file_path": str(SETUP_SKILL),
                "path": str(PLUGIN_ROOT / "README.md"),
            },
        },
    ],
)
def test_bootstrap_authorizer_rejects_setup_skill_read_expansion(event: dict) -> None:
    assert _bootstrap_authorize(event) == 1


def test_bootstrap_authorizer_rejects_a_path_shadowed_reader(tmp_path: Path) -> None:
    fake_sed = tmp_path / "sed"
    fake_sed.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    fake_sed.chmod(0o755)
    event = {
        "tool_name": "Bash",
        "tool_input": {"cmd": f"sed -n '1,240p' {SETUP_SKILL}"},
    }

    assert _bootstrap_authorize(event, PATH=f"{tmp_path}:{os.environ['PATH']}") == 1


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
    env = {
        **os.environ,
        "DINA_PLUGIN_DEV_MODE": "1",
        "DINA_BOOTSTRAP_PYTHON": sys.executable,
        "DINA_CLI_BIN": str(fake),
    }

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
    env = {
        **os.environ,
        "DINA_PLUGIN_DEV_MODE": "1",
        "DINA_BOOTSTRAP_PYTHON": sys.executable,
        "DINA_CLI_BIN": str(fake),
        "DINA_TEST_ARGS": str(args_file),
    }

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
def test_codex_supervisor_does_not_trust_shadowed_python_or_timeout(
    tmp_path: Path,
) -> None:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    marker = tmp_path / "shadow-executed"
    for name in ("python3", "timeout", "gtimeout"):
        executable = bindir / name
        executable.write_text(
            f"#!/bin/sh\ntouch {marker}\nexit 0\n",
            encoding="utf-8",
        )
        executable.chmod(0o755)
    fake_cli = tmp_path / "dina"
    fake_cli.write_text("#!/bin/sh\nexit 2\n", encoding="utf-8")
    fake_cli.chmod(0o755)

    result = subprocess.run(
        [str(SUPERVISOR)],
        input=b'{"session_id":"codex-1","tool_name":"Read","tool_input":{}}',
        env={
            **os.environ,
            "PATH": str(bindir),
            "DINA_PLUGIN_DEV_MODE": "1",
            "DINA_CLI_BIN": str(fake_cli),
        },
        capture_output=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 2
    assert not marker.exists()


@pytest.mark.skipif(os.name != "posix", reason="supervisor is a POSIX sh script")
def test_codex_supervisor_blocks_when_dina_is_missing(tmp_path: Path) -> None:
    empty_path = tmp_path / "empty-bin"
    empty_path.mkdir()
    env = {
        **os.environ,
        "HOME": str(tmp_path / "home"),
        "PATH": str(empty_path),
        "DINA_BOOTSTRAP_PYTHON": sys.executable,
    }

    result = subprocess.run(
        [str(SUPERVISOR)],
        input=b"{}",
        env=env,
        capture_output=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 2
    assert b"not set up" in result.stderr.lower()


@pytest.mark.skipif(os.name != "posix", reason="supervisor is a POSIX sh script")
def test_codex_supervisor_allows_only_exact_plugin_setup(tmp_path: Path) -> None:
    marker = tmp_path / "should-not-exist"
    exact = subprocess.run(
        [str(SUPERVISOR)],
        input=json.dumps(
            {
                "tool_name": "Bash",
                "tool_input": {"cmd": f"{SETUP} --local-only --json"},
            }
        ),
        env={**os.environ, "PLUGIN_ROOT": str(PLUGIN_ROOT)},
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    injected = subprocess.run(
        [str(SUPERVISOR)],
        input=json.dumps(
            {
                "tool_name": "Bash",
                "tool_input": {
                    "cmd": f"{SETUP} --local-only --json; touch {marker}",
                },
            }
        ),
        env={
            **os.environ,
            "PLUGIN_ROOT": str(PLUGIN_ROOT),
            "DINA_PLUGIN_DEV_MODE": "1",
            "DINA_BOOTSTRAP_PYTHON": sys.executable,
            "DINA_CLI_BIN": str(tmp_path / "missing-dina"),
        },
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert exact.returncode == 0
    assert injected.returncode == 2
    assert not marker.exists()
