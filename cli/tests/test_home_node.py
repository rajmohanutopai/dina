"""Native plugin-owned Home Node installer and lifecycle tests."""

from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import tarfile
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import pytest

from dina_cli.home_node import (
    INSTALL_SCHEMA,
    HomeNodeError,
    HomeNodeManager,
    _runtime_arch,
    _runtime_platform,
)

NODE_MAJOR = 24


class FakeCommands:
    def __init__(
        self,
        *,
        fail_archive_import: bool = False,
        fail_signature: bool = False,
    ) -> None:
        self.calls: list[list[str]] = []
        self.binary_inputs: list[bytes] = []
        self.fail_archive_import = fail_archive_import
        self.fail_signature = fail_signature

    def __call__(self, command, **kwargs):
        self.calls.append([str(value) for value in command])
        if "sigstore" in command and self.fail_signature:
            raise subprocess.CalledProcessError(
                1,
                command,
                output="",
                stderr="invalid Sigstore identity",
            )
        if len(command) >= 2 and command[1] == "-p":
            return subprocess.CompletedProcess(
                command,
                0,
                stdout=f"{NODE_MAJOR}\n",
                stderr="",
            )
        if kwargs.get("text") is False:
            request = bytes(kwargs.get("input", b""))
            self.binary_inputs.append(request)
            operation = command[-2] if command[-1] == "--force" else command[-1]
            if operation == "import" and self.fail_archive_import:
                raise subprocess.CalledProcessError(
                    1,
                    command,
                    output=b"",
                    stderr=b"archive_tool: injected import failure",
                )
            stdout = b"DINA\x01\x00" if operation == "export" else b""
            return subprocess.CompletedProcess(
                command,
                0,
                stdout=stdout,
                stderr=b"",
            )
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")


class FakeResponse:
    def __init__(self, content: bytes) -> None:
        self.content = content
        self.headers = {"Content-Length": str(len(content))}

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None

    def read(self, maximum: int) -> bytes:
        return self.content[:maximum]


def _bundle(
    tmp_path: Path,
    *,
    version: str = "0.20.0",
    suffix: str = "",
    target_platform: str | None = None,
    target_arch: str | None = None,
    extra_files: dict[str, bytes] | None = None,
    corrupt_digest_for: str | None = None,
    minimum_cli_version: str = "0.20.0",
    maximum_cli_version_exclusive: str = "0.21.0",
) -> Path:
    payloads = {
        "runtime/node": b"fake bundled node",
        "core.cjs": f"core-{version}-{suffix}".encode(),
        "brain.cjs": f"brain-{version}-{suffix}".encode(),
        "archive.cjs": f"archive-{version}-{suffix}".encode(),
        "node_modules/better-sqlite3-multiple-ciphers/build/Release/"
        "better_sqlite3.node": b"native-sqlcipher",
    }
    payloads.update(extra_files or {})
    files = {
        name: hashlib.sha256(content).hexdigest() for name, content in payloads.items()
    }
    if corrupt_digest_for is not None:
        files[corrupt_digest_for] = "0" * 64
    manifest = {
        "schema": 2,
        "release": version,
        "minimum_cli_version": minimum_cli_version,
        "maximum_cli_version_exclusive": maximum_cli_version_exclusive,
        "platform": target_platform or _runtime_platform(),
        "arch": target_arch or _runtime_arch(),
        "node_major": NODE_MAJOR,
        "node_entrypoint": "runtime/node",
        "core_entrypoint": "core.cjs",
        "brain_entrypoint": "brain.cjs",
        "archive_entrypoint": "archive.cjs",
        "files": files,
    }
    path = tmp_path / f"release-{version}-{suffix or 'base'}.tar.gz"
    with tarfile.open(path, "w:gz") as archive:
        for name, content in {
            **payloads,
            "manifest.json": (
                json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n"
            ).encode(),
        }.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.mode = 0o500 if name == "runtime/node" else 0o400
            archive.addfile(info, io.BytesIO(content))
    return path


def _manager(
    tmp_path: Path,
    commands: FakeCommands | None = None,
) -> HomeNodeManager:
    manager = HomeNodeManager(
        tmp_path / "home-node",
        run_command=commands or FakeCommands(),
        sleep=lambda _seconds: None,
    )
    manager._probe = lambda _url: False  # type: ignore[method-assign]
    return manager


def _install(
    manager: HomeNodeManager,
    bundle: Path,
    *,
    version: str = "0.20.0",
    pds_handle: str | None = None,
) -> None:
    manager.install(
        release_version=version,
        bundle_path=bundle,
        endpoint_mode="test",
        pds_handle=pds_handle,
        start=False,
    )


def stat_mode(path: Path) -> int:
    return path.stat().st_mode & 0o777


def test_install_writes_verified_private_native_runtime(tmp_path: Path) -> None:
    commands = FakeCommands()
    manager = _manager(tmp_path, commands)
    bundle = _bundle(tmp_path)

    _install(manager, bundle)

    assert manager.installed
    config = manager._load_config()
    assert config is not None
    root = manager.release_dir / config.release_id
    assert (root / "core.cjs").is_file()
    assert (root / "brain.cjs").is_file()
    assert (root / "archive.cjs").is_file()
    assert (root / "runtime/node").is_file()
    assert manager.brain_key_file.stat().st_size == 32
    assert stat_mode(manager.install_dir) == 0o700
    assert stat_mode(manager.data_dir) == 0o700
    assert stat_mode(manager.key_dir) == 0o700
    assert stat_mode(manager.brain_key_file) == 0o600
    assert stat_mode(manager.state_file) == 0o600
    assert stat_mode(manager.current_file) == 0o600
    assert stat_mode(root) == 0o500

    state = json.loads(manager.state_file.read_text())
    assert state["schema"] == INSTALL_SCHEMA
    assert state["config"]["release_version"] == "0.20.0"
    assert state["config"]["endpoint_mode"] == "test"
    assert state["config"]["brain_did"].startswith("did:key:z")
    serialized = json.dumps(state)
    assert "docker" not in serialized.lower()
    assert "image" not in serialized.lower()
    assert commands.calls == []


@pytest.mark.parametrize(
    "requested_release",
    ["v0.20.0", "home-node-lite-v0.20.0"],
)
def test_install_normalizes_release_tag_forms(
    tmp_path: Path,
    requested_release: str,
) -> None:
    manager = _manager(tmp_path)
    bundle = _bundle(tmp_path, version="0.20.0")

    _install(manager, bundle, version=requested_release)

    status = manager.status()
    assert status.release_version == "0.20.0"
    config = manager._load_config()
    assert config is not None
    assert config.release_version == "0.20.0"


def test_install_wires_optional_pds_identity_without_seed_in_state(
    tmp_path: Path,
) -> None:
    manager = _manager(tmp_path)
    bundle = _bundle(tmp_path)

    manager.install(
        release_version="0.20.0",
        bundle_path=bundle,
        endpoint_mode="test",
        pds_handle="Alice.Test-PDS.DinaKernel.com",
        pds_email="Alice@example.com",
        start=False,
    )

    config = manager._load_config()
    assert config is not None
    env = manager._base_environment(config)
    assert config.pds_handle == "alice.test-pds.dinakernel.com"
    assert config.pds_email == "Alice@example.com"
    assert env["DINA_PDS_PROVISION"] == "1"
    assert env["DINA_PDS_HANDLE"] == "alice.test-pds.dinakernel.com"
    assert env["DINA_PDS_EMAIL"] == "Alice@example.com"
    assert env["DINA_CORE_VERSION"] == "0.20.0"
    assert "recovery" not in manager.state_file.read_text().lower()


def test_install_rejects_overlong_managed_dina_pds_handle(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    bundle = _bundle(tmp_path)

    with pytest.raises(
        HomeNodeError,
        match=r"prefix of at most 6 characters for test-pds\.dinakernel\.com",
    ):
        manager.install(
            release_version="0.20.0",
            bundle_path=bundle,
            endpoint_mode="test",
            pds_handle="toolong.test-pds.dinakernel.com",
            start=False,
        )


def test_install_allows_standard_length_handle_on_external_pds(
    tmp_path: Path,
) -> None:
    manager = _manager(tmp_path)
    bundle = _bundle(tmp_path)
    handle = f"{'a' * 40}.example.com"

    manager.install(
        release_version="0.20.0",
        bundle_path=bundle,
        endpoint_mode="test",
        pds_handle=handle,
        start=False,
    )

    config = manager._load_config()
    assert config is not None
    assert config.pds_handle == handle


def test_install_is_idempotent_for_identical_settings(tmp_path: Path) -> None:
    commands = FakeCommands()
    manager = _manager(tmp_path, commands)
    bundle = _bundle(tmp_path)
    _install(manager, bundle)
    first_key = manager.brain_key_file.read_bytes()
    release_dirs = list(manager.release_dir.iterdir())

    _install(manager, bundle)

    assert manager.brain_key_file.read_bytes() == first_key
    assert list(manager.release_dir.iterdir()) == release_dirs


def test_install_refuses_silent_runtime_change(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    bundle = _bundle(tmp_path)
    _install(manager, bundle)

    with pytest.raises(HomeNodeError, match="different settings"):
        manager.install(
            release_version="0.20.0",
            bundle_path=bundle,
            endpoint_mode="test",
            core_port=8110,
            start=False,
        )


def test_default_release_is_exact_and_idempotent(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    bundle = _bundle(tmp_path, version="0.20.0")
    manager.install(
        release_version="0.20.0",
        bundle_path=bundle,
        endpoint_mode="test",
        start=False,
    )

    manager.install(
        release_version="0.20.0",
        bundle_path=bundle,
        endpoint_mode="test",
        start=False,
    )

    assert manager._load_config().release_version == "0.20.0"  # type: ignore[union-attr]


def test_release_integrity_is_rechecked_before_start(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    bundle = _bundle(tmp_path)
    _install(manager, bundle)
    config = manager._load_config()
    assert config is not None
    core = manager.release_dir / config.release_id / "core.cjs"
    core.chmod(0o700)
    core.write_bytes(b"tampered")

    with pytest.raises(HomeNodeError, match="was modified"):
        manager.start(wait_timeout=0)


def test_bundle_rejects_digest_mismatch(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    bundle = _bundle(tmp_path, corrupt_digest_for="core.cjs")

    with pytest.raises(HomeNodeError, match="integrity check failed"):
        _install(manager, bundle)


def test_bundle_rejects_symlink_path(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    bundle = _bundle(tmp_path)
    symlink = tmp_path / "linked-release.tar.gz"
    try:
        symlink.symlink_to(bundle)
    except OSError as exc:
        pytest.skip(f"symlinks unavailable on this host: {exc}")

    with pytest.raises(HomeNodeError, match="regular, non-symlink"):
        _install(manager, symlink)


def test_bundle_rejects_path_traversal(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    bundle = _bundle(tmp_path)
    malicious = tmp_path / "malicious.tar.gz"
    with (
        tarfile.open(bundle, "r:gz") as source,
        tarfile.open(malicious, "w:gz") as target,
    ):
        for member in source.getmembers():
            target.addfile(
                member, source.extractfile(member) if member.isfile() else None
            )
        content = b"escape"
        info = tarfile.TarInfo("../escape")
        info.size = len(content)
        target.addfile(info, io.BytesIO(content))

    with pytest.raises(HomeNodeError, match="unsafe path"):
        _install(manager, malicious)
    assert not (tmp_path / "escape").exists()


def test_bundle_rejects_wrong_platform(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    other = "linux" if _runtime_platform() != "linux" else "darwin"
    bundle = _bundle(tmp_path, target_platform=other)

    with pytest.raises(HomeNodeError, match="targets"):
        _install(manager, bundle)


def test_bundle_rejects_requested_version_mismatch(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    bundle = _bundle(tmp_path, version="0.20.1")

    with pytest.raises(HomeNodeError, match="does not match"):
        _install(manager, bundle, version="0.20.0")


def test_bundle_rejects_incompatible_cli_range(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    bundle = _bundle(
        tmp_path,
        minimum_cli_version="0.21.0",
        maximum_cli_version_exclusive="0.22.0",
    )

    with pytest.raises(HomeNodeError, match="requires dina-agent"):
        _install(manager, bundle)


def test_downloaded_bundle_requires_expected_sigstore_identity(
    tmp_path: Path,
) -> None:
    bundle = _bundle(tmp_path).read_bytes()
    signature = b'{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}'
    commands = FakeCommands()

    def open_url(request, **_kwargs):
        return FakeResponse(
            signature if request.full_url.endswith(".sigstore.json") else bundle
        )

    manager = HomeNodeManager(
        tmp_path / "home-node",
        run_command=commands,
        open_url=open_url,
        sleep=lambda _seconds: None,
    )
    manager._probe = lambda _url: False  # type: ignore[method-assign]

    manager.install(
        release_version="home-node-lite-v0.20.0",
        endpoint_mode="test",
        start=False,
    )

    verification = next(call for call in commands.calls if "sigstore" in call)
    assert "--offline" in verification
    assert (
        "https://github.com/rajmohanutopai/dina/.github/workflows/"
        "home-node-lite-release.yml@refs/tags/home-node-lite-v0.20.0" in verification
    )


def test_downloaded_bundle_fails_closed_on_bad_signature(tmp_path: Path) -> None:
    bundle = _bundle(tmp_path).read_bytes()

    def open_url(request, **_kwargs):
        return FakeResponse(
            b"bad signature" if request.full_url.endswith(".sigstore.json") else bundle
        )

    manager = HomeNodeManager(
        tmp_path / "home-node",
        run_command=FakeCommands(fail_signature=True),
        open_url=open_url,
        sleep=lambda _seconds: None,
    )
    manager._probe = lambda _url: False  # type: ignore[method-assign]

    with pytest.raises(HomeNodeError, match="signature verification failed"):
        manager.install(
            release_version="0.20.0",
            endpoint_mode="test",
            start=False,
        )


def test_restore_identity_requires_pristine_data_and_pds_handle(
    tmp_path: Path,
) -> None:
    bundle = _bundle(tmp_path)
    manager = _manager(tmp_path)
    _install(manager, bundle)
    with pytest.raises(HomeNodeError, match="PDS handle"):
        manager.restore_identity_seed(b"a" * 32)

    manager2 = HomeNodeManager(
        tmp_path / "with-pds",
        run_command=FakeCommands(),
        sleep=lambda _seconds: None,
    )
    manager2._probe = lambda _url: False  # type: ignore[method-assign]
    _install(
        manager2,
        bundle,
        pds_handle="alice.test-pds.dinakernel.com",
    )
    manager2.restore_identity_seed(b"a" * 32)
    assert (manager2.data_dir / "keyfile").read_bytes() == b"a" * 32
    manager2.restore_identity_seed(b"a" * 32)
    with pytest.raises(HomeNodeError, match="not empty"):
        manager2.restore_identity_seed(b"b" * 32)


def test_archive_tool_receives_secret_only_on_stdin(tmp_path: Path) -> None:
    commands = FakeCommands()
    manager = _manager(tmp_path, commands)
    bundle = _bundle(tmp_path)
    _install(manager, bundle)
    destination = tmp_path / "backup.dina"

    result = manager.export_archive(
        destination,
        "correct horse battery staple",
        overwrite=False,
    )

    assert result == destination
    assert destination.read_bytes().startswith(b"DINA")
    assert stat_mode(destination) == 0o600
    request = commands.binary_inputs[-1]
    assert request.startswith(b"DARC")
    assert b"correct horse battery staple" in request
    flattened = " ".join(commands.calls[-1])
    assert "correct horse" not in flattened
    assert "DINA_ARCHIVE_PASSPHRASE" not in manager._base_environment(
        manager._load_config()  # type: ignore[arg-type]
    )


def test_archive_import_failure_restores_raw_data_snapshot(tmp_path: Path) -> None:
    commands = FakeCommands(fail_archive_import=True)
    manager = _manager(tmp_path, commands)
    bundle = _bundle(tmp_path)
    _install(manager, bundle)
    marker = manager.data_dir / "marker"
    marker.write_text("before", encoding="utf-8")
    archive = tmp_path / "input.dina"
    archive.write_bytes(b"DINA\x01\x00")

    with pytest.raises(HomeNodeError, match="injected import failure"):
        manager.import_archive(archive, "passphrase", force=True)

    assert marker.read_text() == "before"
    assert not manager.archive_restore_journal_file.exists()
    assert not manager.archive_restore_backup_dir.exists()


def test_upgrade_switches_release_and_cleans_snapshot(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    first = _bundle(tmp_path, version="0.20.0")
    second = _bundle(tmp_path, version="0.20.1")
    _install(manager, first)
    marker = manager.data_dir / "marker"
    marker.write_text("preserved", encoding="utf-8")

    status = manager.upgrade(
        release_version="home-node-lite-v0.20.1",
        bundle_path=second,
    )

    assert status.release_version == "0.20.1"
    assert marker.read_text() == "preserved"
    assert not manager.upgrade_journal_file.exists()
    assert not manager.upgrade_backup_dir.exists()
    assert len(list(manager.release_dir.iterdir())) == 2


def test_upgrade_failure_rolls_back_release_and_data(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    first = _bundle(tmp_path, version="0.20.0")
    second = _bundle(tmp_path, version="0.20.1")
    _install(manager, first)
    original = manager._load_config()
    assert original is not None
    marker = manager.data_dir / "marker"
    marker.write_text("before", encoding="utf-8")

    starts = 0

    def fail_candidate(*, wait_timeout: float, update_desired: bool) -> None:
        nonlocal starts
        starts += 1
        if starts == 1:
            marker.write_text("mutated", encoding="utf-8")
            raise HomeNodeError("injected health failure")

    with patch.object(manager, "_start_locked", side_effect=fail_candidate):
        # Force the node's desired state to running so upgrade exercises start.
        manager._write_state(
            replace(original, autostart_enabled=True),
            installed_at=manager._load_installed_at(),
        )
        with pytest.raises(HomeNodeError, match="prior release and data"):
            manager.upgrade(
                release_version="0.20.1",
                bundle_path=second,
            )

    restored = manager._load_config()
    assert restored is not None
    assert restored.release_id == original.release_id
    assert marker.read_text() == "before"


def test_interrupted_upgrade_is_recovered_before_ensure(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    bundle = _bundle(tmp_path)
    _install(manager, bundle)
    config = manager._load_config()
    assert config is not None
    marker = manager.data_dir / "marker"
    marker.write_text("old", encoding="utf-8")
    manager._snapshot_data(manager.upgrade_backup_dir)
    marker.write_text("new", encoding="utf-8")
    manager._write_private_json(
        manager.upgrade_journal_file,
        {
            "schema": 1,
            "old_config": config.__dict__,
            "candidate_config": config.__dict__,
            "was_running": False,
        },
    )

    manager.ensure(if_installed=False)

    assert marker.read_text() == "old"
    assert not manager.upgrade_journal_file.exists()


def test_status_uses_release_language_and_health(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    bundle = _bundle(tmp_path)
    _install(manager, bundle)
    manager._probe = lambda url: url.endswith("/healthz")  # type: ignore[method-assign]

    status = manager.status()

    assert status.installed is True
    assert status.running is False
    assert status.core_healthy is True
    assert status.brain_healthy is False
    assert status.release_version == "0.20.0"


def test_uninstall_preserves_data_by_default_and_purge_is_explicit(
    tmp_path: Path,
) -> None:
    bundle = _bundle(tmp_path)
    manager = _manager(tmp_path)
    _install(manager, bundle)
    marker = manager.data_dir / "marker"
    marker.write_text("keep", encoding="utf-8")

    manager.uninstall()

    assert manager.state_file.exists()
    assert manager.data_dir.exists()
    assert marker.read_text() == "keep"
    assert not manager.release_dir.exists()
    assert not manager.installed

    manager.install(
        release_version="0.20.0",
        bundle_path=bundle,
        endpoint_mode="test",
        start=False,
    )
    assert marker.read_text() == "keep"
    manager.uninstall(purge_data=True)
    assert not manager.install_dir.exists()


def test_logs_never_invoke_external_runtime(tmp_path: Path, capsys) -> None:
    commands = FakeCommands()
    manager = _manager(tmp_path, commands)
    manager.log_dir.mkdir(parents=True)
    (manager.log_dir / "core.log").write_text("one\ntwo\nthree\n")

    assert manager.logs(tail=2) == 0

    output = capsys.readouterr().out
    assert "two" in output
    assert "three" in output
    assert commands.calls == []


def test_release_urls_are_platform_specific_and_overridable(monkeypatch) -> None:
    monkeypatch.delenv("DINA_HOME_NODE_RELEASE_URL", raising=False)
    manager = HomeNodeManager()
    url = manager._release_url("1.2.3")
    assert "home-node-lite-v1.2.3" in url
    assert _runtime_platform() in url
    assert _runtime_arch() in url
    assert url.endswith(".tar.gz")

    monkeypatch.setenv(
        "DINA_HOME_NODE_RELEASE_URL",
        "https://example.test/{release}/{platform}/{arch}/bundle.tgz",
    )
    assert manager._release_url("1.2.3") == (
        f"https://example.test/1.2.3/{_runtime_platform()}/"
        f"{_runtime_arch()}/bundle.tgz"
    )


def test_release_overrides_can_be_disabled(monkeypatch) -> None:
    monkeypatch.setenv(
        "DINA_HOME_NODE_RELEASE_URL",
        "https://attacker.invalid/{release}/{platform}/{arch}/bundle.tgz",
    )
    monkeypatch.setenv(
        "DINA_HOME_NODE_RELEASE_REPOSITORY",
        "attacker/repository",
    )
    manager = HomeNodeManager(allow_release_overrides=False)

    assert "attacker.invalid" not in manager._release_url("1.2.3")
    assert manager._release_repository() == "rajmohanutopai/dina"


def test_pid_matches_recognizes_current_and_legacy_supervisors(monkeypatch) -> None:
    from dina_cli import home_node as home_node_module
    from dina_cli.home_node import _supervisor_process_marker

    token = "ab" * 24
    marker = "home_node_supervisor"
    commands = {
        101: f"python -m dina_cli.home_node_supervisor {marker} "
        f"--instance {_supervisor_process_marker(token)}",
        # A supervisor started by CLI <= 0.20.1 still carries the raw token.
        102: f"python -m dina_cli.home_node_supervisor {marker} --token {token}",
        103: f"python -m dina_cli.home_node_supervisor {marker} --token other",
        104: f"unrelated-process --instance {_supervisor_process_marker(token)}",
    }
    monkeypatch.setattr(home_node_module, "_process_command", commands.get)
    monkeypatch.setattr(home_node_module.os, "kill", lambda _pid, _sig: None)

    assert HomeNodeManager._pid_matches(101, token, marker) is True
    assert HomeNodeManager._pid_matches(102, token, marker) is True
    assert HomeNodeManager._pid_matches(103, token, marker) is False
    assert HomeNodeManager._pid_matches(104, token, marker) is False


def test_no_plugin_owned_source_mentions_docker() -> None:
    source_root = Path(__file__).parents[1] / "src/dina_cli"
    files = [
        source_root / "home_node.py",
        source_root / "home_node_supervisor.py",
        source_root / "home_node_enrollment.py",
    ]
    for path in files:
        assert "docker" not in path.read_text(encoding="utf-8").lower()
