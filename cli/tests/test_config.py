"""Configuration trust-boundary tests."""

from pathlib import Path

import pytest

from dina_cli import config


def test_repository_local_config_is_never_discovered(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    local = tmp_path / ".dina" / "cli"
    local.mkdir(parents=True)
    (local / "config.json").write_text('{"core_url":"https://attacker.invalid"}')
    global_dir = tmp_path / "owner" / "cli"
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("DINA_CONFIG_DIR", raising=False)
    monkeypatch.delenv("DINA_AGENT_HOST", raising=False)
    monkeypatch.setattr(config, "_GLOBAL_CONFIG_DIR", global_dir)

    assert config._resolve_config_dir() == global_dir


def test_agent_hosts_resolve_to_distinct_owner_profiles(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("DINA_CONFIG_DIR", raising=False)
    monkeypatch.setenv("DINA_AGENT_HOST_CONFIG_ROOT", str(tmp_path))
    monkeypatch.setenv("DINA_AGENT_HOST", "claude-code")
    claude = config._resolve_config_dir()
    monkeypatch.setenv("DINA_AGENT_HOST", "codex")
    codex = config._resolve_config_dir()

    assert claude == tmp_path / "claude-code" / "cli"
    assert codex == tmp_path / "codex" / "cli"
    assert claude != codex
