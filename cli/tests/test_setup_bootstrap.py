from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = REPO_ROOT / "cli" / "agent-plugin-runtime" / "dina-setup-bootstrap"


def _load_bootstrap():
    loader = importlib.machinery.SourceFileLoader("dina_setup_bootstrap_test", str(BOOTSTRAP))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def test_managed_install_is_pipless_and_atomic(tmp_path: Path, monkeypatch) -> None:
    bootstrap = _load_bootstrap()
    runtime = tmp_path / "runtime"
    old_environment = runtime / "venv"
    old_environment.mkdir(parents=True)
    (old_environment / "old-marker").write_text("old", encoding="utf-8")
    monkeypatch.setenv("DINA_PLUGIN_DEV_MODE", "1")
    monkeypatch.setenv("DINA_SETUP_RUNTIME_DIR", str(runtime))
    monkeypatch.setenv("DINA_SETUP_CLI_SPEC", "dina-agent==0.20.9")

    builder_options: list[dict] = []

    class FakeBuilder:
        def __init__(self, **kwargs):
            builder_options.append(kwargs)

        def create(self, environment: Path) -> None:
            python = bootstrap._environment_python(environment)
            python.parent.mkdir(parents=True)
            python.write_text("python", encoding="utf-8")

    def fake_download(_url: str, _sha: str, destination: Path) -> None:
        destination.write_bytes(b"wheel")

    def fake_run(argv, **_kwargs):
        if bootstrap.PIP_RUNNER in argv:
            environment = Path(argv[0]).parent.parent
            cli = bootstrap._environment_dina(environment)
            cli.write_text("dina", encoding="utf-8")
            cli.chmod(0o755)
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(bootstrap.venv, "EnvBuilder", FakeBuilder)
    monkeypatch.setattr(bootstrap, "_download_verified", fake_download)
    monkeypatch.setattr(bootstrap, "_run", fake_run)
    monkeypatch.setattr(
        bootstrap,
        "_cli_version",
        lambda path: bootstrap.REQUIRED_CLI if path.is_file() else None,
    )

    cli, version = bootstrap._install_managed_cli()

    assert version == (0, 20, 9)
    assert cli.is_file()
    assert not (old_environment / "old-marker").exists()
    assert builder_options == [
        {"with_pip": False, "clear": False, "symlinks": False}
    ]
    assert not list(runtime.glob(".venv.install-*"))
    assert not list(runtime.glob(".bootstrap-downloads-*"))


def test_atomic_replace_preserves_old_environment_on_failure(
    tmp_path: Path,
    monkeypatch,
) -> None:
    bootstrap = _load_bootstrap()
    destination = tmp_path / "venv"
    destination.mkdir()
    (destination / "old-marker").write_text("old", encoding="utf-8")
    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / "new-marker").write_text("new", encoding="utf-8")
    real_replace = os.replace
    calls = 0

    def fail_second_replace(source, target):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("injected swap failure")
        return real_replace(source, target)

    monkeypatch.setattr(bootstrap.os, "replace", fail_second_replace)

    with pytest.raises(OSError, match="injected swap failure"):
        bootstrap._replace_environment_atomically(staging, destination)

    assert (destination / "old-marker").read_text(encoding="utf-8") == "old"


def test_production_wheels_are_exactly_pinned() -> None:
    bootstrap = _load_bootstrap()

    assert bootstrap.REQUIRED_CLI == (0, 20, 9)
    assert bootstrap.DINA_WHEEL_URL.endswith("dina_agent-0.20.9-py3-none-any.whl")
    assert len(bootstrap.DINA_WHEEL_SHA256) == 64
    assert bootstrap.PIP_WHEEL_URL.endswith("pip-26.1.2-py3-none-any.whl")
    assert len(bootstrap.PIP_WHEEL_SHA256) == 64


def test_development_mode_rediscovers_a_newer_compatible_cli(
    tmp_path: Path,
    monkeypatch,
) -> None:
    bootstrap = _load_bootstrap()
    runtime = tmp_path / "runtime"
    managed = runtime / "venv" / "bin" / "dina"
    managed.parent.mkdir(parents=True)
    managed.write_text("dina", encoding="utf-8")
    managed.chmod(0o755)
    monkeypatch.setenv("DINA_PLUGIN_DEV_MODE", "1")
    monkeypatch.setenv("DINA_SETUP_RUNTIME_DIR", str(runtime))
    monkeypatch.setattr(bootstrap, "_cli_version", lambda _path: (0, 20, 10))

    assert bootstrap._find_compatible_cli() == (managed, (0, 20, 10))


def test_production_mode_requires_the_hash_pinned_cli_version(
    tmp_path: Path,
    monkeypatch,
) -> None:
    bootstrap = _load_bootstrap()
    monkeypatch.delenv("DINA_PLUGIN_DEV_MODE", raising=False)
    monkeypatch.delenv("DINA_SETUP_RUNTIME_DIR", raising=False)
    candidate = tmp_path / "dina"
    candidate.write_text("dina", encoding="utf-8")
    candidate.chmod(0o755)
    monkeypatch.setattr(bootstrap, "_candidate_clis", lambda: [candidate])
    monkeypatch.setattr(bootstrap, "_cli_version", lambda _path: (0, 20, 10))

    assert bootstrap._find_compatible_cli() is None


def test_claude_setup_clears_only_dinas_stale_mcp_failure(
    tmp_path: Path,
    monkeypatch,
) -> None:
    bootstrap = _load_bootstrap()
    monkeypatch.setenv("HOME", str(tmp_path))
    cache = tmp_path / ".claude" / "mcp-needs-auth-cache.json"
    cache.parent.mkdir()
    cache.write_text(
        json.dumps(
            {
                "plugin:dina:dina": {"timestamp": 1, "id": "dina"},
                "another-server": {"timestamp": 2, "id": "other"},
            }
        ),
        encoding="utf-8",
    )

    bootstrap._clear_claude_mcp_failure_cache("claude-code")

    assert json.loads(cache.read_text(encoding="utf-8")) == {
        "another-server": {"timestamp": 2, "id": "other"}
    }
    assert cache.stat().st_mode & 0o777 == 0o600


def test_claude_mcp_cache_cleanup_is_scoped_and_fail_safe(
    tmp_path: Path,
    monkeypatch,
) -> None:
    bootstrap = _load_bootstrap()
    monkeypatch.setenv("HOME", str(tmp_path))
    cache = tmp_path / ".claude" / "mcp-needs-auth-cache.json"
    cache.parent.mkdir()
    cache.write_text("not-json", encoding="utf-8")

    bootstrap._clear_claude_mcp_failure_cache("codex")
    assert cache.read_text(encoding="utf-8") == "not-json"

    bootstrap._clear_claude_mcp_failure_cache("claude-code")
    assert cache.read_text(encoding="utf-8") == "not-json"
