"""Native Home Node Lite installation and lifecycle management.

The coding-agent plugins share this module through ``dina-agent``. A release
is a source-free, platform-specific tar archive containing bundled Core,
Brain, and archive-tool entry points plus the native SQLCipher binding. The
manager verifies every release file, owns private data and keys, and launches
a small native supervisor. No container runtime is involved.
"""

from __future__ import annotations

import base58
import contextlib
import hashlib
import io
import json
import os
import platform
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Callable, Iterator
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from . import __version__

DEFAULT_RELEASE = __version__
DEFAULT_RELEASE_REPOSITORY = "rajmohanutopai/dina"
INSTALL_SCHEMA = 2
RELEASE_SCHEMA = 2
MIN_NODE_MAJOR = 22
MAX_RELEASE_BYTES = 512 * 1024 * 1024
MAX_RELEASE_FILE_BYTES = 256 * 1024 * 1024
MAX_SIGSTORE_BUNDLE_BYTES = 4 * 1024 * 1024
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
SUPERVISOR_HEARTBEAT_MAX_AGE = 15.0
SUPERVISOR_TOKEN_ENV = "DINA_HOME_NODE_SUPERVISOR_TOKEN"
_ED25519_MULTICODEC = b"\xed\x01"
_RELEASE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}\Z")
_RELEASE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}-[0-9a-f]{12}\Z")
_REPOSITORY_RE = re.compile(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}\Z")
_HANDLE_LABEL_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
_SEMVER_RE = re.compile(
    r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)" r"(?:[-+][0-9A-Za-z.-]+)?\Z"
)
_DINA_PDS_MAX_HANDLE_CHARS = 30
_DINA_MANAGED_PDS_HOSTS = (
    "pds.dinakernel.com",
    "test-pds.dinakernel.com",
)


class HomeNodeError(RuntimeError):
    """A lifecycle failure safe to present to the operator."""


@dataclass(frozen=True)
class HomeNodeConfig:
    release_id: str
    release_version: str
    endpoint_mode: str
    core_port: int
    brain_port: int
    brain_did: str
    pds_handle: str | None = None
    pds_email: str | None = None
    autostart_enabled: bool = True


@dataclass(frozen=True)
class HomeNodeStatus:
    installed: bool
    running: bool
    core_healthy: bool
    brain_healthy: bool
    core_url: str
    brain_url: str
    install_dir: str
    release_version: str | None
    autostart_enabled: bool


@dataclass(frozen=True)
class ReleaseManifest:
    release: str
    minimum_cli_version: str
    maximum_cli_version_exclusive: str
    platform: str
    arch: str
    node_major: int
    node_entrypoint: str
    core_entrypoint: str
    brain_entrypoint: str
    archive_entrypoint: str
    files: dict[str, str]


RunCommand = Callable[..., subprocess.CompletedProcess[Any]]
OpenURL = Callable[..., Any]


def default_install_dir() -> Path:
    override = os.environ.get("DINA_HOME_NODE_DIR", "").strip()
    return (
        Path(override).expanduser() if override else Path.home() / ".dina" / "home-node"
    )


def _clean_python_subprocess_env() -> dict[str, str]:
    env = dict(os.environ)
    for name in ("PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP"):
        env.pop(name, None)
    return env


def _supervisor_process_marker(token: str) -> str:
    """Return a non-secret process marker derived from the private token."""
    return hashlib.sha256(token.encode("ascii")).hexdigest()[:32]


class HomeNodeManager:
    """Own one local, native Home Node Lite installation."""

    def __init__(
        self,
        install_dir: Path | None = None,
        *,
        run_command: RunCommand = subprocess.run,
        open_url: OpenURL = urlopen,
        sleep: Callable[[float], None] = time.sleep,
        allow_release_overrides: bool = True,
    ) -> None:
        self.install_dir = (install_dir or default_install_dir()).expanduser().resolve()
        self.state_file = self.install_dir / "state.json"
        self.current_file = self.install_dir / "current.json"
        self.release_dir = self.install_dir / "releases"
        self.data_dir = self.install_dir / "data"
        self.key_dir = self.install_dir / "brain-keys"
        self.brain_key_file = self.key_dir / "brain.ed25519"
        self.runtime_dir = self.install_dir / "runtime"
        self.log_dir = self.install_dir / "logs"
        self.lock_file = self.install_dir / "lifecycle.lock"
        self.upgrade_journal_file = self.install_dir / "upgrade.json"
        self.upgrade_backup_dir = self.install_dir / "upgrade-data-backup"
        self.archive_restore_journal_file = self.install_dir / "archive-restore.json"
        self.archive_restore_backup_dir = (
            self.install_dir / "archive-restore-data-backup"
        )
        self._run_command = run_command
        self._open_url = open_url
        self._sleep = sleep
        self._allow_release_overrides = allow_release_overrides

    @property
    def installed(self) -> bool:
        if not (
            self.state_file.is_file()
            and self.current_file.is_file()
            and self.brain_key_file.is_file()
        ):
            return False
        try:
            config = self._load_config()
            return self._release_path(config.release_id).is_dir()
        except HomeNodeError:
            return False

    def install(
        self,
        *,
        release_version: str = DEFAULT_RELEASE,
        bundle_path: Path | None = None,
        endpoint_mode: str = "release",
        core_port: int = 8100,
        brain_port: int = 8200,
        pds_handle: str | None = None,
        pds_email: str | None = None,
        start: bool = True,
        wait_timeout: float = 120.0,
    ) -> HomeNodeStatus:
        """Install a verified native release and optionally start it."""
        release_version = _normalize_release_version(release_version)
        pds_handle = _normalize_optional(pds_handle, lowercase=True)
        pds_email = _normalize_optional(pds_email)
        self._validate_inputs(
            release_version,
            endpoint_mode,
            core_port,
            brain_port,
            pds_handle,
            pds_email,
        )
        if bundle_path is not None:
            bundle_path = bundle_path.expanduser()

        with self._lifecycle_lock():
            self._ensure_private_dirs()
            self._recover_interrupted_operations(wait_timeout=wait_timeout)
            existing = self._load_config(missing_ok=True)
            if existing is not None:
                requested = (
                    release_version,
                    endpoint_mode,
                    core_port,
                    brain_port,
                    pds_handle,
                    pds_email,
                )
                current = (
                    existing.release_version,
                    existing.endpoint_mode,
                    existing.core_port,
                    existing.brain_port,
                    existing.pds_handle,
                    existing.pds_email,
                )
                release_matches = release_version == existing.release_version
                settings_match = requested[1:] == current[1:]
                if not release_matches or not settings_match:
                    raise HomeNodeError(
                        "Home Node is already recorded with different settings. "
                        "Use `dina home-node upgrade` for a release change; preserve "
                        "the existing ports, endpoint mode, and identity settings."
                    )
                if not self._release_path(existing.release_id).is_dir():
                    installed = self._install_release(
                        release_version=release_version,
                        bundle_path=bundle_path,
                    )
                    existing = replace(
                        existing,
                        release_id=installed[0],
                        release_version=installed[1].release,
                    )
                self._verify_release(existing.release_id)
                existing = replace(existing, autostart_enabled=start)
                self._write_state(existing, installed_at=self._load_installed_at())
                self._write_current(existing)
                if start:
                    self._start_locked(wait_timeout=wait_timeout, update_desired=False)
                else:
                    self._stop_runtime_locked(update_desired=False)
                return self.status()

            self._check_prerequisites()
            brain_did = self._ensure_brain_key()
            release_id, manifest = self._install_release(
                release_version=release_version,
                bundle_path=bundle_path,
            )
            config = HomeNodeConfig(
                release_id=release_id,
                release_version=manifest.release,
                endpoint_mode=endpoint_mode,
                core_port=core_port,
                brain_port=brain_port,
                brain_did=brain_did,
                pds_handle=pds_handle,
                pds_email=pds_email,
                autostart_enabled=start,
            )
            self._write_state(config, installed_at=self._now())
            self._write_current(config)
            if start:
                self._start_locked(wait_timeout=wait_timeout, update_desired=False)
            return self.status()

    def ensure(
        self,
        *,
        if_installed: bool = False,
        wait_timeout: float = 120.0,
    ) -> HomeNodeStatus | None:
        """Recover interrupted work and enforce the recorded desired state."""
        if not self.state_file.is_file():
            if if_installed:
                return None
            raise HomeNodeError(
                "Home Node is not installed. Run: dina home-node install"
            )
        with self._lifecycle_lock():
            self._recover_interrupted_operations(wait_timeout=wait_timeout)
            config = self._load_config()
            if not self._release_path(config.release_id).is_dir():
                raise HomeNodeError(
                    "The recorded native release is absent. Re-run "
                    "`dina home-node install` to restore it."
                )
            self._verify_release(config.release_id)
            if config.autostart_enabled:
                self._start_locked(wait_timeout=wait_timeout, update_desired=False)
            else:
                self._stop_runtime_locked(update_desired=False)
            return self.status()

    def start(self, *, wait_timeout: float = 120.0) -> HomeNodeStatus:
        self._require_installed()
        with self._lifecycle_lock():
            self._recover_interrupted_operations(wait_timeout=wait_timeout)
            self._start_locked(wait_timeout=wait_timeout, update_desired=True)
            return self.status()

    def stop(self) -> HomeNodeStatus:
        if not self.state_file.is_file():
            return self.status()
        with self._lifecycle_lock():
            self._stop_runtime_locked(update_desired=True)
            return self.status()

    def upgrade(
        self,
        *,
        release_version: str,
        bundle_path: Path | None = None,
        wait_timeout: float = 120.0,
    ) -> HomeNodeStatus:
        """Activate one release atomically, rolling code and data back on failure."""
        release_version = _normalize_release_version(release_version)
        if bundle_path is not None:
            bundle_path = bundle_path.expanduser()
        self._require_installed()

        with self._lifecycle_lock():
            self._recover_interrupted_operations(wait_timeout=wait_timeout)
            old = self._load_config()
            was_running = old.autostart_enabled
            release_id, manifest = self._install_release(
                release_version=release_version,
                bundle_path=bundle_path,
            )
            if release_id == old.release_id:
                if was_running:
                    self._start_locked(wait_timeout=wait_timeout, update_desired=False)
                return self.status()

            self._stop_runtime_locked(update_desired=False)
            self._snapshot_data(self.upgrade_backup_dir)
            candidate = replace(
                old,
                release_id=release_id,
                release_version=manifest.release,
                autostart_enabled=was_running,
            )
            self._write_private_json(
                self.upgrade_journal_file,
                {
                    "schema": 1,
                    "old_config": asdict(old),
                    "candidate_config": asdict(candidate),
                    "was_running": was_running,
                },
            )
            try:
                self._write_state(candidate, installed_at=self._load_installed_at())
                self._write_current(candidate)
                if was_running:
                    self._start_locked(
                        wait_timeout=wait_timeout,
                        update_desired=False,
                    )
            except Exception as upgrade_error:
                try:
                    self._rollback_upgrade(
                        old=old,
                        was_running=was_running,
                        wait_timeout=wait_timeout,
                    )
                except Exception as rollback_error:
                    raise HomeNodeError(
                        "Native Home Node upgrade failed and automatic rollback also "
                        f"failed: {rollback_error}"
                    ) from upgrade_error
                raise HomeNodeError(
                    "Native Home Node upgrade failed; the prior release and data "
                    "were restored."
                ) from upgrade_error
            self._clear_upgrade_artifacts()
            return self.status()

    def restore_identity_seed(self, seed: bytes) -> None:
        """Install canonical identity entropy into a never-booted data directory."""
        if len(seed) != 32:
            raise HomeNodeError(
                f"Recovered identity seed must be exactly 32 bytes, got {len(seed)}."
            )
        self._require_installed()
        with self._lifecycle_lock():
            self._recover_interrupted_operations(wait_timeout=120.0)
            config = self._load_config()
            if config.pds_handle is None:
                raise HomeNodeError(
                    "Restoring a network identity requires the existing PDS handle."
                )
            if self._supervisor_alive():
                raise HomeNodeError(
                    "Stop the Home Node before restoring identity material."
                )
            self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            entries = list(self.data_dir.iterdir())
            keyfile = self.data_dir / "keyfile"
            if entries:
                if (
                    len(entries) == 1
                    and entries[0] == keyfile
                    and keyfile.is_file()
                    and not keyfile.is_symlink()
                    and keyfile.read_bytes() == seed
                ):
                    return
                raise HomeNodeError(
                    "The Home Node data directory is not empty; refusing to replace "
                    "its identity. Purge it explicitly or restore a complete backup."
                )
            self._write_private_bytes(keyfile, seed)

    def export_archive(
        self,
        destination: Path,
        passphrase: str,
        *,
        overwrite: bool = False,
        wait_timeout: float = 120.0,
    ) -> Path:
        """Create a portable encrypted .dina backup with the offline native tool."""
        self._require_installed()
        destination = destination.expanduser().absolute()
        self._validate_archive_destination(destination, overwrite=overwrite)
        with self._lifecycle_lock():
            self._recover_interrupted_operations(wait_timeout=wait_timeout)
            config = self._load_config()
            was_running = config.autostart_enabled
            self._stop_runtime_locked(update_desired=False)
            try:
                archive = self._run_archive_tool(
                    config,
                    "export",
                    passphrase=passphrase,
                )
                if len(archive) < 6 or archive[:4] != b"DINA":
                    raise HomeNodeError(
                        "Core returned an invalid or empty .dina archive."
                    )
                self._atomic_write_archive(destination, archive)
            finally:
                if was_running:
                    self._start_locked(
                        wait_timeout=wait_timeout,
                        update_desired=False,
                    )
        return destination

    def verify_archive(self, archive_file: Path, passphrase: str) -> None:
        self._require_installed()
        archive = self._read_archive_file(archive_file)
        with self._lifecycle_lock():
            self._recover_interrupted_operations(wait_timeout=120.0)
            self._run_archive_tool(
                self._load_config(),
                "verify",
                passphrase=passphrase,
                archive=archive,
            )

    def import_archive(
        self,
        archive_file: Path,
        passphrase: str,
        *,
        force: bool = False,
        wait_timeout: float = 120.0,
    ) -> None:
        """Restore a .dina archive with a crash-recoverable data snapshot."""
        self._require_installed()
        archive = self._read_archive_file(archive_file)
        with self._lifecycle_lock():
            self._recover_interrupted_operations(wait_timeout=wait_timeout)
            config = self._load_config()
            self._run_archive_tool(
                config,
                "verify",
                passphrase=passphrase,
                archive=archive,
            )
            was_running = config.autostart_enabled
            self._stop_runtime_locked(update_desired=False)
            self._snapshot_data(self.archive_restore_backup_dir)
            self._write_private_json(
                self.archive_restore_journal_file,
                {
                    "schema": 1,
                    "config": asdict(config),
                    "was_running": was_running,
                },
            )
            try:
                self._run_archive_tool(
                    config,
                    "import",
                    passphrase=passphrase,
                    archive=archive,
                    force=force,
                )
                if was_running:
                    self._start_locked(
                        wait_timeout=wait_timeout,
                        update_desired=False,
                    )
            except Exception as import_error:
                try:
                    self._rollback_archive_restore(
                        config=config,
                        was_running=was_running,
                        wait_timeout=wait_timeout,
                    )
                except Exception as rollback_error:
                    raise HomeNodeError(
                        "Archive import failed and automatic rollback also failed: "
                        f"{rollback_error}"
                    ) from import_error
                raise
            self._clear_archive_restore_artifacts()

    def uninstall(self, *, purge_data: bool = False) -> None:
        """Remove native runtime code; preserve encrypted data unless requested."""
        if not self.install_dir.exists():
            return
        with self._lifecycle_lock():
            if self.state_file.is_file():
                self._stop_runtime_locked(update_desired=True)
            if purge_data:
                root = self.install_dir
                # Close the lock before its containing directory disappears.
            else:
                _remove_read_only_tree(self.release_dir)
                shutil.rmtree(self.runtime_dir, ignore_errors=True)
                shutil.rmtree(self.log_dir, ignore_errors=True)
                with contextlib.suppress(FileNotFoundError):
                    self.current_file.unlink()
                return
        if purge_data:
            _remove_read_only_tree(root)

    def logs(self, *, follow: bool = False, tail: int = 200) -> int:
        files = [
            ("supervisor", self.log_dir / "supervisor.log"),
            ("core", self.log_dir / "core.log"),
            ("brain", self.log_dir / "brain.log"),
        ]
        for label, path in files:
            if not path.is_file() or path.is_symlink():
                continue
            print(f"==> {label} <==")
            for line in _tail_lines(path, tail):
                print(line, end="")
        if not follow:
            return 0
        positions = {
            path: path.stat().st_size
            for _label, path in files
            if path.is_file() and not path.is_symlink()
        }
        try:
            while True:
                for label, path in files:
                    if not path.is_file() or path.is_symlink():
                        continue
                    offset = positions.get(path, 0)
                    size = path.stat().st_size
                    if size < offset:
                        offset = 0
                    if size > offset:
                        print(f"==> {label} <==")
                        with path.open(
                            "r", encoding="utf-8", errors="replace"
                        ) as stream:
                            stream.seek(offset)
                            content = stream.read()
                            positions[path] = stream.tell()
                        print(content, end="")
                self._sleep(0.5)
        except KeyboardInterrupt:
            return 130

    def read_owner_capability(self) -> str:
        return self._read_core_secret("owner_capability")

    def read_recovery_phrase(self) -> str | None:
        value = self._read_core_secret("recovery-phrase.txt", missing_ok=True)
        if value == "":
            return None
        return value

    def remove_recovery_phrase(self) -> None:
        path = self.data_dir / "recovery-phrase.txt"
        if path.is_symlink():
            raise HomeNodeError("Recovery phrase path must not be a symlink.")
        with contextlib.suppress(FileNotFoundError):
            path.unlink()

    def status(self) -> HomeNodeStatus:
        config = self._load_config(missing_ok=True)
        installed = (
            config is not None
            and self.current_file.is_file()
            and self.brain_key_file.is_file()
            and self._release_path(config.release_id).is_dir()
        )
        core_port = config.core_port if config else 8100
        brain_port = config.brain_port if config else 8200
        core_url = f"http://127.0.0.1:{core_port}"
        brain_url = f"http://127.0.0.1:{brain_port}"
        running = self._supervisor_alive()
        return HomeNodeStatus(
            installed=installed,
            running=running,
            core_healthy=installed and self._probe(f"{core_url}/healthz"),
            brain_healthy=installed and self._probe(f"{brain_url}/readyz"),
            core_url=core_url,
            brain_url=brain_url,
            install_dir=str(self.install_dir),
            release_version=config.release_version if config else None,
            autostart_enabled=config.autostart_enabled if config else False,
        )

    def _install_release(
        self,
        *,
        release_version: str,
        bundle_path: Path | None,
    ) -> tuple[str, ReleaseManifest]:
        self._check_prerequisites()
        bundle, source = self._read_release_bundle(
            release_version=release_version,
            bundle_path=bundle_path,
        )
        if len(bundle) > MAX_RELEASE_BYTES:
            raise HomeNodeError(
                f"Native release exceeds the {MAX_RELEASE_BYTES} byte safety limit."
            )
        bundle_sha = hashlib.sha256(bundle).hexdigest()
        with tempfile.TemporaryDirectory(
            prefix=".release-",
            dir=self.release_dir,
        ) as staging_name:
            staging = Path(staging_name)
            manifest = self._extract_and_verify_release(
                bundle,
                staging,
                requested_release=release_version,
            )
            release_id = (
                f"{_safe_release_component(manifest.release)}-{bundle_sha[:12]}"
            )
            if _RELEASE_ID_RE.fullmatch(release_id) is None:
                raise HomeNodeError("Native release produced an unsafe release id.")
            destination = self._release_path(release_id)
            if destination.exists():
                existing = self._read_release_manifest(destination)
                if existing != manifest:
                    raise HomeNodeError(
                        f"Release directory collision for {release_id}; refusing "
                        "to replace verified code."
                    )
                return release_id, existing
            metadata = {
                "schema": 1,
                "source": source,
                "bundle_sha256": bundle_sha,
                "installed_at": self._now(),
            }
            self._write_private_json(staging / ".install.json", metadata)
            # Seal only after the move: macOS rename() refuses to move a
            # directory the caller cannot write, so a pre-sealed staging tree
            # makes installation fail with EACCES there.
            os.replace(staging, destination)
            _make_release_read_only(destination)
        return release_id, manifest

    def _read_release_bundle(
        self,
        *,
        release_version: str,
        bundle_path: Path | None,
    ) -> tuple[bytes, str]:
        if bundle_path is not None:
            if bundle_path.is_symlink():
                raise HomeNodeError(
                    "Native release bundle must be a regular, non-symlink file."
                )
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            try:
                descriptor = os.open(bundle_path, flags)
            except OSError as exc:
                raise HomeNodeError(
                    "Native release bundle must be a regular, non-symlink file."
                ) from exc
            try:
                details = os.fstat(descriptor)
                if not stat.S_ISREG(details.st_mode):
                    raise HomeNodeError(
                        "Native release bundle must be a regular, non-symlink file."
                    )
                if details.st_size <= 0 or details.st_size > MAX_RELEASE_BYTES:
                    raise HomeNodeError("Native release bundle has an invalid size.")
                with os.fdopen(descriptor, "rb", closefd=False) as stream:
                    content = stream.read(MAX_RELEASE_BYTES + 1)
            except OSError as exc:
                raise HomeNodeError(
                    "Could not read the native release bundle."
                ) from exc
            finally:
                os.close(descriptor)
            if not content or len(content) > MAX_RELEASE_BYTES:
                raise HomeNodeError("Native release bundle has an invalid size.")
            return content, str(bundle_path.absolute())

        url = self._release_url(release_version)
        content = self._download_release_file(
            url,
            maximum_bytes=MAX_RELEASE_BYTES,
            label="native Home Node release",
        )
        signature_url = f"{url}.sigstore.json"
        signature = self._download_release_file(
            signature_url,
            maximum_bytes=MAX_SIGSTORE_BUNDLE_BYTES,
            label="native Home Node Sigstore bundle",
        )
        self._verify_downloaded_release_signature(
            content,
            signature,
            release_version=release_version,
        )
        return content, url

    def _download_release_file(
        self,
        url: str,
        *,
        maximum_bytes: int,
        label: str,
    ) -> bytes:
        request = Request(
            url,
            headers={
                "Accept": "application/octet-stream",
                "User-Agent": "dina-agent-native-installer",
            },
        )
        try:
            with self._open_url(request, timeout=60) as response:
                length = response.headers.get("Content-Length")
                if length is not None and int(length) > maximum_bytes:
                    raise HomeNodeError(f"Downloaded {label} exceeds the safety limit.")
                content = response.read(maximum_bytes + 1)
        except (HTTPError, URLError, OSError, ValueError) as exc:
            raise HomeNodeError(
                f"Could not download {label} from {url}: {exc}"
            ) from exc
        if not content or len(content) > maximum_bytes:
            raise HomeNodeError(f"Downloaded {label} is empty or too large.")
        return bytes(content)

    def _verify_downloaded_release_signature(
        self,
        archive: bytes,
        signature_bundle: bytes,
        *,
        release_version: str,
    ) -> None:
        repository = self._release_repository()
        tag = f"home-node-lite-v{release_version.removeprefix('v')}"
        identity = (
            f"https://github.com/{repository}/.github/workflows/"
            f"home-node-lite-release.yml@refs/tags/{tag}"
        )
        with tempfile.TemporaryDirectory(prefix="dina-release-signature-") as name:
            root = Path(name)
            archive_path = root / "release.tar.gz"
            bundle_path = root / "release.tar.gz.sigstore.json"
            _write_new_file(archive_path, archive, mode=0o600)
            _write_new_file(bundle_path, signature_bundle, mode=0o600)
            try:
                self._run_command(
                    [
                        sys.executable,
                        "-I",
                        "-m",
                        "sigstore",
                        "verify",
                        "identity",
                        "--offline",
                        "--bundle",
                        str(bundle_path),
                        "--cert-identity",
                        identity,
                        "--cert-oidc-issuer",
                        "https://token.actions.githubusercontent.com",
                        str(archive_path),
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=60,
                    cwd=root,
                    env=_clean_python_subprocess_env(),
                )
            except (
                subprocess.CalledProcessError,
                subprocess.TimeoutExpired,
                OSError,
            ) as exc:
                detail = _subprocess_error_detail(exc)
                raise HomeNodeError(
                    "Native Home Node release signature verification failed"
                    + (f": {detail}" if detail else ".")
                ) from exc

    def _release_url(self, release_version: str) -> str:
        exact = (
            os.environ.get("DINA_HOME_NODE_RELEASE_URL", "").strip()
            if self._allow_release_overrides
            else ""
        )
        if exact:
            return exact.format(
                release=release_version,
                platform=_runtime_platform(),
                arch=_runtime_arch(),
            )
        repository = self._release_repository()
        asset = f"dina-home-node-lite-{_runtime_platform()}-{_runtime_arch()}.tar.gz"
        tag = (
            release_version
            if release_version.startswith("home-node-lite-v")
            else f"home-node-lite-v{release_version.removeprefix('v')}"
        )
        return f"https://github.com/{repository}/releases/download/{tag}/{asset}"

    def _release_repository(self) -> str:
        repository = (
            os.environ.get("DINA_HOME_NODE_RELEASE_REPOSITORY", "").strip()
            if self._allow_release_overrides
            else ""
        ) or DEFAULT_RELEASE_REPOSITORY
        if _REPOSITORY_RE.fullmatch(repository) is None:
            raise HomeNodeError("DINA_HOME_NODE_RELEASE_REPOSITORY is malformed.")
        return repository

    def _extract_and_verify_release(
        self,
        bundle: bytes,
        destination: Path,
        *,
        requested_release: str,
    ) -> ReleaseManifest:
        try:
            archive = tarfile.open(fileobj=io.BytesIO(bundle), mode="r:*")
        except tarfile.TarError as exc:
            raise HomeNodeError("Native release is not a valid tar archive.") from exc
        with archive:
            members = archive.getmembers()
            if not members:
                raise HomeNodeError("Native release archive is empty.")
            names: set[str] = set()
            total = 0
            manifest_bytes: bytes | None = None
            for member in members:
                name = _safe_archive_name(member.name)
                if name in names:
                    raise HomeNodeError(
                        f"Native release contains duplicate path {name!r}."
                    )
                names.add(name)
                if (
                    member.issym()
                    or member.islnk()
                    or member.isdev()
                    or member.isfifo()
                ):
                    raise HomeNodeError(
                        f"Native release contains unsupported entry {name!r}."
                    )
                if not (member.isdir() or member.isfile()):
                    raise HomeNodeError(
                        f"Native release contains unsupported entry {name!r}."
                    )
                if member.size < 0 or member.size > MAX_RELEASE_FILE_BYTES:
                    raise HomeNodeError(
                        f"Native release file {name!r} exceeds the safety limit."
                    )
                total += member.size
                if total > MAX_RELEASE_BYTES:
                    raise HomeNodeError(
                        "Expanded native release exceeds the safety limit."
                    )
                if name == "manifest.json":
                    if not member.isfile():
                        raise HomeNodeError("manifest.json must be a regular file.")
                    manifest_bytes = _read_tar_member(archive, member)
            if manifest_bytes is None:
                raise HomeNodeError("Native release has no manifest.json.")
            manifest = _parse_release_manifest(manifest_bytes)
            if manifest.release not in {
                requested_release,
                requested_release.removeprefix("v"),
                f"v{requested_release.removeprefix('v')}",
            }:
                raise HomeNodeError(
                    "Native release manifest does not match the requested version "
                    f"({manifest.release!r} != {requested_release!r})."
                )
            self._validate_release_runtime(manifest)
            expected = set(manifest.files) | {"manifest.json"}
            unexpected = {
                name
                for name in names
                if name not in expected
                and not any(p.startswith(f"{name}/") for p in expected)
            }
            if unexpected:
                raise HomeNodeError(
                    "Native release contains unmanifested paths: "
                    + ", ".join(sorted(unexpected)[:5])
                )
            missing = set(manifest.files) - names
            if missing:
                raise HomeNodeError(
                    "Native release is missing manifest files: "
                    + ", ".join(sorted(missing)[:5])
                )

            for member in members:
                name = _safe_archive_name(member.name)
                target = destination.joinpath(*PurePosixPath(name).parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                payload = _read_tar_member(archive, member)
                if name != "manifest.json":
                    actual = hashlib.sha256(payload).hexdigest()
                    if actual != manifest.files[name]:
                        raise HomeNodeError(
                            f"Native release integrity check failed for {name!r}."
                        )
                _write_new_file(target, payload, mode=0o600)

        for entrypoint in (
            manifest.node_entrypoint,
            manifest.core_entrypoint,
            manifest.brain_entrypoint,
            manifest.archive_entrypoint,
        ):
            path = destination.joinpath(*PurePosixPath(entrypoint).parts)
            if not path.is_file() or path.is_symlink():
                raise HomeNodeError(
                    f"Native release entrypoint is absent: {entrypoint!r}."
                )
        return manifest

    def _validate_release_runtime(
        self,
        manifest: ReleaseManifest,
        *,
        root: Path | None = None,
    ) -> None:
        if manifest.platform != _runtime_platform() or manifest.arch != _runtime_arch():
            raise HomeNodeError(
                "Native release targets "
                f"{manifest.platform}/{manifest.arch}, but this host is "
                f"{_runtime_platform()}/{_runtime_arch()}."
            )
        if root is None:
            return
        node = root.joinpath(*PurePosixPath(manifest.node_entrypoint).parts)
        if not node.is_file() or node.is_symlink():
            raise HomeNodeError("Native release has no safe bundled Node runtime.")
        try:
            result = self._run_command(
                [str(node), "-p", "process.versions.node.split('.')[0]"],
                check=True,
                capture_output=True,
                text=True,
                timeout=10,
            )
            major = int(str(result.stdout).strip())
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            raise HomeNodeError(
                "Could not determine the installed Node.js version."
            ) from exc
        if major != manifest.node_major:
            raise HomeNodeError(
                "Native release runtime does not match its manifest "
                f"({major} != {manifest.node_major})."
            )

    def _verify_release(self, release_id: str) -> ReleaseManifest:
        root = self._release_path(release_id)
        manifest = self._read_release_manifest(root)
        self._validate_release_runtime(manifest, root=root)
        for relative, expected in manifest.files.items():
            path = root.joinpath(*PurePosixPath(relative).parts)
            if not path.is_file() or path.is_symlink():
                raise HomeNodeError(
                    f"Installed native release file is missing: {relative!r}."
                )
            actual = _sha256_file(path)
            if actual != expected:
                raise HomeNodeError(
                    f"Installed native release was modified: {relative!r}."
                )
        return manifest

    def _read_release_manifest(self, root: Path) -> ReleaseManifest:
        path = root / "manifest.json"
        if path.is_symlink() or not path.is_file():
            raise HomeNodeError("Installed native release has no safe manifest.")
        try:
            return _parse_release_manifest(path.read_bytes())
        except OSError as exc:
            raise HomeNodeError("Could not read the native release manifest.") from exc

    def _start_locked(
        self,
        *,
        wait_timeout: float,
        update_desired: bool,
    ) -> None:
        config = self._load_config()
        self._verify_release(config.release_id)
        if update_desired and not config.autostart_enabled:
            config = replace(config, autostart_enabled=True)
            self._write_state(config, installed_at=self._load_installed_at())
        if not self._supervisor_alive():
            self._cleanup_stale_runtime()
            self._ensure_runtime_ports_available(config)
            self._launch_supervisor()
        try:
            self._wait_for_health(config, timeout=wait_timeout)
        except Exception:
            self._request_supervisor_stop()
            raise

    def _stop_runtime_locked(self, *, update_desired: bool) -> None:
        config = self._load_config(missing_ok=True)
        if config is None:
            return
        if update_desired and config.autostart_enabled:
            config = replace(config, autostart_enabled=False)
            self._write_state(config, installed_at=self._load_installed_at())
        elif not update_desired and config.autostart_enabled:
            # The supervisor reads desired state. Temporarily stop it directly
            # while preserving the durable preference for backup/upgrade work.
            self._request_supervisor_stop()
            return
        self._wait_for_supervisor_exit(timeout=20.0)

    def _request_supervisor_stop(self) -> None:
        heartbeat = self._read_runtime_record("supervisor.json")
        if heartbeat is None:
            self._cleanup_stale_runtime()
            return
        pid = heartbeat.get("pid")
        token = heartbeat.get("token")
        if (
            isinstance(pid, int)
            and isinstance(token, str)
            and self._pid_matches(pid, token, "home_node_supervisor")
        ):
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGTERM)
        self._wait_for_supervisor_exit(timeout=20.0)

    def _wait_for_supervisor_exit(self, *, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while self._supervisor_alive(allow_stale=True) and time.monotonic() < deadline:
            self._sleep(0.1)
        if self._supervisor_alive(allow_stale=True):
            heartbeat = self._read_runtime_record("supervisor.json")
            if heartbeat is not None:
                pid = heartbeat.get("pid")
                token = heartbeat.get("token")
                if (
                    isinstance(pid, int)
                    and isinstance(token, str)
                    and self._pid_matches(pid, token, "home_node_supervisor")
                ):
                    with contextlib.suppress(ProcessLookupError, PermissionError):
                        os.kill(pid, signal.SIGKILL)
            deadline = time.monotonic() + 5.0
            while (
                self._supervisor_alive(allow_stale=True) and time.monotonic() < deadline
            ):
                self._sleep(0.1)
        self._cleanup_stale_runtime()

    def _launch_supervisor(self) -> None:
        token = secrets.token_hex(24)
        process_marker = _supervisor_process_marker(token)
        self.log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        log_path = self.log_dir / "supervisor.log"
        _rotate_log(log_path)
        command = [
            sys.executable,
            "-I",
            "-m",
            "dina_cli.home_node_supervisor",
            "--install-dir",
            str(self.install_dir),
            "--instance",
            process_marker,
        ]
        env = _clean_python_subprocess_env()
        env[SUPERVISOR_TOKEN_ENV] = token
        try:
            with log_path.open("ab", buffering=0) as log:
                process = subprocess.Popen(
                    command,
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    cwd=self.install_dir,
                    close_fds=True,
                    start_new_session=os.name != "nt",
                    creationflags=(
                        subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
                        if os.name == "nt"
                        else 0
                    ),
                    env=env,
                )
        except OSError as exc:
            raise HomeNodeError(
                f"Could not launch the native supervisor: {exc}"
            ) from exc
        self._write_private_json(
            self.runtime_dir / "launch.json",
            {
                "schema": 1,
                "pid": process.pid,
                "token": token,
                "launched_at": time.time(),
            },
        )
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            heartbeat = self._read_runtime_record("supervisor.json")
            if (
                heartbeat is not None
                and heartbeat.get("pid") == process.pid
                and heartbeat.get("token") == token
            ):
                return
            if process.poll() is not None:
                raise HomeNodeError(
                    "Native Home Node supervisor exited during startup. "
                    f"Inspect {log_path}."
                )
            self._sleep(0.1)
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(process.pid, signal.SIGTERM)
        raise HomeNodeError(
            "Native Home Node supervisor did not publish a startup heartbeat."
        )

    def _supervisor_alive(self, *, allow_stale: bool = False) -> bool:
        heartbeat = self._read_runtime_record("supervisor.json")
        if heartbeat is None:
            return False
        pid = heartbeat.get("pid")
        token = heartbeat.get("token")
        updated_at = heartbeat.get("updated_at")
        if (
            not isinstance(pid, int)
            or not isinstance(token, str)
            or not isinstance(updated_at, (int, float))
        ):
            return False
        if (
            not allow_stale
            and time.time() - float(updated_at) > SUPERVISOR_HEARTBEAT_MAX_AGE
        ):
            return False
        return self._pid_matches(pid, token, "home_node_supervisor")

    def _cleanup_stale_runtime(self) -> None:
        signaled: list[int] = []
        for name, marker in (
            ("core.json", "core.cjs"),
            ("brain.json", "brain.cjs"),
            ("supervisor.json", "home_node_supervisor"),
        ):
            record = self._read_runtime_record(name)
            if record is not None:
                pid = record.get("pid")
                token = record.get("token")
                if (
                    isinstance(pid, int)
                    and isinstance(token, str)
                    and self._pid_matches(pid, token, marker)
                ):
                    with contextlib.suppress(ProcessLookupError, PermissionError):
                        os.kill(pid, signal.SIGTERM)
                        signaled.append(pid)
            with contextlib.suppress(FileNotFoundError):
                (self.runtime_dir / name).unlink()
        with contextlib.suppress(FileNotFoundError):
            (self.runtime_dir / "launch.json").unlink()
        deadline = time.monotonic() + 5.0
        while signaled and time.monotonic() < deadline:
            signaled = [pid for pid in signaled if _pid_exists(pid)]
            if signaled:
                self._sleep(0.05)
        for pid in signaled:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGKILL)

    @staticmethod
    def _pid_matches(pid: int, token: str, marker: str) -> bool:
        if not _pid_exists(pid):
            return False
        command = _process_command(pid)
        if command is None:
            return False
        if marker not in command:
            return False
        # Processes started by CLI <= 0.20.1 carry the raw token in argv;
        # recognize them so upgrades can stop and supersede them cleanly.
        return _supervisor_process_marker(token) in command or token in command

    def _wait_for_health(self, config: HomeNodeConfig, *, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        core_url = f"http://127.0.0.1:{config.core_port}/healthz"
        brain_url = f"http://127.0.0.1:{config.brain_port}/readyz"
        while time.monotonic() < deadline:
            if not self._supervisor_alive():
                raise HomeNodeError(
                    "Native Home Node supervisor stopped before services became ready. "
                    f"Inspect {self.log_dir}."
                )
            if self._probe(core_url) and self._probe(brain_url):
                return
            self._sleep(0.25)
        raise HomeNodeError(
            f"Home Node did not become healthy within {timeout:g}s. "
            f"Inspect {self.log_dir}."
        )

    @staticmethod
    def _ensure_runtime_ports_available(config: HomeNodeConfig) -> None:
        for label, port in (("Core", config.core_port), ("Brain", config.brain_port)):
            if not _port_available(port):
                raise HomeNodeError(
                    f"{label} port {port} is already in use. Choose another port."
                )

    def _probe(self, url: str) -> bool:
        try:
            request = Request(url, headers={"Cache-Control": "no-store"})
            with self._open_url(request, timeout=1.5) as response:
                return 200 <= int(response.status) < 300
        except (HTTPError, URLError, OSError, ValueError):
            return False

    def _run_archive_tool(
        self,
        config: HomeNodeConfig,
        operation: str,
        *,
        passphrase: str,
        archive: bytes = b"",
        force: bool = False,
    ) -> bytes:
        if operation not in {"export", "import", "verify"}:
            raise HomeNodeError(f"Unsupported archive operation: {operation}")
        passphrase_bytes = passphrase.encode("utf-8")
        if not passphrase_bytes or len(passphrase_bytes) > 64 * 1024:
            raise HomeNodeError("Archive passphrase has an invalid encoded length.")
        request = (
            b"DARC"
            + len(passphrase_bytes).to_bytes(4, "big")
            + passphrase_bytes
            + archive
        )
        manifest = self._verify_release(config.release_id)
        release_root = self._release_path(config.release_id)
        entry = release_root.joinpath(*PurePosixPath(manifest.archive_entrypoint).parts)
        node = release_root.joinpath(*PurePosixPath(manifest.node_entrypoint).parts)
        command = [str(node), str(entry), operation]
        if force:
            command.append("--force")
        env = self._base_environment(config)
        try:
            result = self._run_command(
                command,
                input=request,
                check=True,
                capture_output=True,
                text=False,
                env=env,
                cwd=self.install_dir,
                timeout=600,
            )
        except subprocess.CalledProcessError as exc:
            detail = bytes(exc.stderr or b"").decode("utf-8", errors="replace").strip()
            raise HomeNodeError(
                f"Home Node archive {operation} failed"
                + (f": {detail}" if detail else ".")
            ) from exc
        except (OSError, subprocess.SubprocessError) as exc:
            raise HomeNodeError(f"Could not run archive {operation}: {exc}") from exc
        finally:
            mutable = bytearray(request)
            mutable[:] = b"\x00" * len(mutable)
            mutable_passphrase = bytearray(passphrase_bytes)
            mutable_passphrase[:] = b"\x00" * len(mutable_passphrase)
        return bytes(result.stdout or b"")

    def _base_environment(self, config: HomeNodeConfig) -> dict[str, str]:
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": os.environ.get("HOME", str(Path.home())),
            "NODE_ENV": "production",
            "DINA_ENDPOINT_MODE": config.endpoint_mode,
            "DINA_VAULT_DIR": str(self.data_dir),
            "DINA_CORE_HOST": "127.0.0.1",
            "DINA_CORE_PORT": str(config.core_port),
            "DINA_BRAIN_HOST": "127.0.0.1",
            "DINA_BRAIN_PORT": str(config.brain_port),
            "DINA_CORE_URL": f"http://127.0.0.1:{config.core_port}",
            "DINA_BRAIN_URL": f"http://127.0.0.1:{config.brain_port}",
            "DINA_SERVICE_KEY_DIR": str(self.key_dir),
            "DINA_BRAIN_SERVICE_KEY_FILE": self.brain_key_file.name,
            "DINA_BRAIN_DID": config.brain_did,
            "DINA_CORE_OWNER_CONSOLE": "1",
            "DINA_CORE_VERSION": config.release_version,
            "DINA_LOG_LEVEL": os.environ.get("DINA_LOG_LEVEL", "info"),
            "DINA_BRAIN_LOG_LEVEL": os.environ.get("DINA_BRAIN_LOG_LEVEL", "info"),
            "DINA_BRAIN_LLM_PROVIDER": os.environ.get(
                "DINA_BRAIN_LLM_PROVIDER", "none"
            ),
        }
        if config.pds_handle is not None:
            env["DINA_PDS_PROVISION"] = "1"
            env["DINA_PDS_HANDLE"] = config.pds_handle
        else:
            env["DINA_PDS_PROVISION"] = "0"
        if config.pds_email is not None:
            env["DINA_PDS_EMAIL"] = config.pds_email
        for key in (
            "DINA_GEMINI_API_KEY",
            "DINA_GEMINI_MODEL",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
        ):
            if os.environ.get(key):
                env[key] = os.environ[key]
        return env

    def runtime_spec(self) -> dict[str, Any]:
        """Return the verified process contract consumed by the supervisor."""
        config = self._load_config()
        manifest = self._verify_release(config.release_id)
        root = self._release_path(config.release_id)
        return {
            "config": asdict(config),
            "node": str(root.joinpath(*PurePosixPath(manifest.node_entrypoint).parts)),
            "core_entrypoint": str(
                root.joinpath(*PurePosixPath(manifest.core_entrypoint).parts)
            ),
            "brain_entrypoint": str(
                root.joinpath(*PurePosixPath(manifest.brain_entrypoint).parts)
            ),
            "environment": self._base_environment(config),
            "runtime_dir": str(self.runtime_dir),
            "log_dir": str(self.log_dir),
        }

    def _rollback_upgrade(
        self,
        *,
        old: HomeNodeConfig,
        was_running: bool,
        wait_timeout: float,
    ) -> None:
        self._stop_runtime_locked(update_desired=False)
        self._restore_data_snapshot(self.upgrade_backup_dir)
        self._write_state(old, installed_at=self._load_installed_at())
        self._write_current(old)
        if was_running:
            self._start_locked(wait_timeout=wait_timeout, update_desired=False)
        self._clear_upgrade_artifacts()

    def _rollback_archive_restore(
        self,
        *,
        config: HomeNodeConfig,
        was_running: bool,
        wait_timeout: float,
    ) -> None:
        self._stop_runtime_locked(update_desired=False)
        self._restore_data_snapshot(self.archive_restore_backup_dir)
        if was_running:
            self._start_locked(wait_timeout=wait_timeout, update_desired=False)
        self._clear_archive_restore_artifacts()

    def _recover_interrupted_operations(self, *, wait_timeout: float) -> None:
        if self.archive_restore_journal_file.exists():
            value = self._read_private_json(self.archive_restore_journal_file)
            config = _config_from_value(value.get("config"))
            was_running = value.get("was_running")
            if value.get("schema") != 1 or not isinstance(was_running, bool):
                raise HomeNodeError("Archive restore journal is malformed.")
            self._rollback_archive_restore(
                config=config,
                was_running=was_running,
                wait_timeout=wait_timeout,
            )
        if self.upgrade_journal_file.exists():
            value = self._read_private_json(self.upgrade_journal_file)
            old = _config_from_value(value.get("old_config"))
            was_running = value.get("was_running")
            if value.get("schema") != 1 or not isinstance(was_running, bool):
                raise HomeNodeError("Upgrade journal is malformed.")
            self._rollback_upgrade(
                old=old,
                was_running=was_running,
                wait_timeout=wait_timeout,
            )

    def _snapshot_data(self, destination: Path) -> None:
        shutil.rmtree(destination, ignore_errors=True)
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        _reject_symlinks(self.data_dir)
        shutil.copytree(self.data_dir, destination, copy_function=shutil.copy2)
        _chmod_private_tree(destination)

    def _restore_data_snapshot(self, source: Path) -> None:
        if not source.is_dir() or source.is_symlink():
            raise HomeNodeError("Home Node data rollback snapshot is missing.")
        _reject_symlinks(source)
        replacement = self.install_dir / f".data-restore-{secrets.token_hex(6)}"
        shutil.copytree(source, replacement, copy_function=shutil.copy2)
        _chmod_private_tree(replacement)
        old = self.install_dir / f".data-old-{secrets.token_hex(6)}"
        if self.data_dir.exists():
            os.replace(self.data_dir, old)
        os.replace(replacement, self.data_dir)
        shutil.rmtree(old, ignore_errors=True)

    def _clear_upgrade_artifacts(self) -> None:
        shutil.rmtree(self.upgrade_backup_dir, ignore_errors=True)
        with contextlib.suppress(FileNotFoundError):
            self.upgrade_journal_file.unlink()

    def _clear_archive_restore_artifacts(self) -> None:
        shutil.rmtree(self.archive_restore_backup_dir, ignore_errors=True)
        with contextlib.suppress(FileNotFoundError):
            self.archive_restore_journal_file.unlink()

    @staticmethod
    def _read_archive_file(archive_file: Path) -> bytes:
        path = archive_file.expanduser()
        if path.is_symlink() or not path.is_file():
            raise HomeNodeError("Archive must be a regular, non-symlink file.")
        size = path.stat().st_size
        if size <= 0 or size > MAX_ARCHIVE_BYTES:
            raise HomeNodeError("Archive is empty or exceeds the safety limit.")
        return path.read_bytes()

    @staticmethod
    def _validate_archive_destination(destination: Path, *, overwrite: bool) -> None:
        if destination.exists():
            if destination.is_symlink() or not destination.is_file():
                raise HomeNodeError(
                    "Archive destination must be a regular, non-symlink file."
                )
            if not overwrite:
                raise HomeNodeError(
                    f"Archive destination already exists: {destination}"
                )
        parent = destination.parent
        if parent.is_symlink() or not parent.is_dir():
            raise HomeNodeError(
                "Archive destination parent must be an existing, non-symlink directory."
            )

    @staticmethod
    def _atomic_write_archive(destination: Path, archive: bytes) -> None:
        temp = destination.parent / f".{destination.name}.{secrets.token_hex(6)}.tmp"
        _write_new_file(temp, archive, mode=0o600)
        os.replace(temp, destination)
        os.chmod(destination, 0o600)

    def _read_core_secret(self, name: str, *, missing_ok: bool = False) -> str:
        path = self.data_dir / name
        if not path.exists() and missing_ok:
            return ""
        if path.is_symlink() or not path.is_file():
            if missing_ok:
                return ""
            raise HomeNodeError(
                f"Home Node has not created the protected {name!r} file yet."
            )
        if os.name != "nt" and path.stat().st_mode & 0o077:
            raise HomeNodeError(
                f"Protected Home Node file {name!r} is accessible to other users."
            )
        try:
            return path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise HomeNodeError(
                f"Could not read protected Home Node file {name!r}."
            ) from exc

    def _check_prerequisites(self) -> None:
        if _runtime_platform() not in {"darwin", "linux", "win32"}:
            raise HomeNodeError("This host is not supported by native Home Node Lite.")

    def _ensure_private_dirs(self) -> None:
        for path in (
            self.install_dir,
            self.release_dir,
            self.data_dir,
            self.key_dir,
            self.runtime_dir,
            self.log_dir,
        ):
            if path.exists() and (path.is_symlink() or not path.is_dir()):
                raise HomeNodeError(f"Home Node path is not a safe directory: {path}")
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
            if os.name != "nt":
                os.chmod(path, 0o700)

    def _ensure_brain_key(self) -> str:
        if self.brain_key_file.exists():
            if self.brain_key_file.is_symlink() or not self.brain_key_file.is_file():
                raise HomeNodeError("Brain key path must be a regular file.")
            seed = self.brain_key_file.read_bytes()
            if len(seed) != 32:
                raise HomeNodeError("Brain service key must contain exactly 32 bytes.")
        else:
            seed = secrets.token_bytes(32)
            self._write_private_bytes(self.brain_key_file, seed)
        private = Ed25519PrivateKey.from_private_bytes(seed)
        public = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        return "did:key:z" + base58.b58encode(_ED25519_MULTICODEC + public).decode(
            "ascii"
        )

    def _write_current(self, config: HomeNodeConfig) -> None:
        self._write_private_json(
            self.current_file,
            {
                "schema": 1,
                "release_id": config.release_id,
                "release_version": config.release_version,
            },
        )

    def _write_state(self, config: HomeNodeConfig, *, installed_at: str) -> None:
        self._write_private_json(
            self.state_file,
            {
                "schema": INSTALL_SCHEMA,
                "installed_at": installed_at,
                "updated_at": self._now(),
                "config": asdict(config),
            },
        )

    def _load_installed_at(self) -> str:
        value = self._read_private_json(self.state_file)
        installed_at = value.get("installed_at")
        if not isinstance(installed_at, str) or not installed_at:
            raise HomeNodeError("Home Node state has no valid installed_at value.")
        return installed_at

    def _load_config(self, *, missing_ok: bool = False) -> HomeNodeConfig | None:
        if not self.state_file.exists() and missing_ok:
            return None
        value = self._read_private_json(self.state_file)
        if value.get("schema") != INSTALL_SCHEMA:
            raise HomeNodeError(
                "Home Node state uses an unsupported schema. Reinstall the "
                "greenfield native runtime while preserving data."
            )
        return _config_from_value(value.get("config"))

    def _read_private_json(self, path: Path) -> dict[str, Any]:
        if path.is_symlink() or not path.is_file():
            raise HomeNodeError(f"Home Node state file is missing or unsafe: {path}")
        if os.name != "nt" and path.stat().st_mode & 0o077:
            raise HomeNodeError(f"Home Node state file is not private: {path}")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise HomeNodeError(f"Home Node state file is malformed: {path}") from exc
        if not isinstance(value, dict):
            raise HomeNodeError(f"Home Node state file is malformed: {path}")
        return value

    def _read_runtime_record(self, name: str) -> dict[str, Any] | None:
        path = self.runtime_dir / name
        if not path.is_file() or path.is_symlink():
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    def _require_installed(self) -> None:
        if not self.installed:
            raise HomeNodeError(
                "Home Node native runtime is not installed. Run: "
                "dina home-node install"
            )

    def _release_path(self, release_id: str) -> Path:
        if _RELEASE_ID_RE.fullmatch(release_id) is None:
            raise HomeNodeError("Home Node state contains an unsafe release id.")
        path = (self.release_dir / release_id).resolve()
        if path.parent != self.release_dir.resolve():
            raise HomeNodeError("Home Node release path escaped its release directory.")
        return path

    @contextlib.contextmanager
    def _lifecycle_lock(self) -> Iterator[None]:
        self.install_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = self.lock_file.open("a+")
        try:
            if os.name == "nt":
                import msvcrt

                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl

                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            yield
        finally:
            if os.name == "nt":
                import msvcrt

                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
            lock.close()

    @staticmethod
    def _validate_inputs(
        release_version: str,
        endpoint_mode: str,
        core_port: int,
        brain_port: int,
        pds_handle: str | None,
        pds_email: str | None,
    ) -> None:
        if _RELEASE_RE.fullmatch(release_version) is None:
            raise HomeNodeError(f"Invalid Home Node release: {release_version!r}")
        if endpoint_mode not in {"test", "release"}:
            raise HomeNodeError("Endpoint mode must be 'test' or 'release'.")
        for label, port in (("Core", core_port), ("Brain", brain_port)):
            if (
                not isinstance(port, int)
                or isinstance(port, bool)
                or not (1 <= port <= 65535)
            ):
                raise HomeNodeError(f"{label} port must be between 1 and 65535.")
        if core_port == brain_port:
            raise HomeNodeError("Core and Brain must use different host ports.")
        if pds_email is not None and pds_handle is None:
            raise HomeNodeError("PDS email requires a PDS handle.")
        if pds_handle is not None:
            _validate_handle(pds_handle)
        if pds_email is not None and (
            len(pds_email) > 254
            or "@" not in pds_email
            or any(ch.isspace() or ord(ch) < 32 for ch in pds_email)
        ):
            raise HomeNodeError("PDS email is malformed.")

    @staticmethod
    def _write_private_json(path: Path, value: dict[str, Any]) -> None:
        payload = (
            json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode("utf-8")
        _atomic_private_write(path, payload)

    @staticmethod
    def _write_private_bytes(path: Path, content: bytes) -> None:
        _atomic_private_write(path, content)

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_release_manifest(content: bytes) -> ReleaseManifest:
    try:
        value = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HomeNodeError("Native release manifest is malformed.") from exc
    if not isinstance(value, dict) or value.get("schema") != RELEASE_SCHEMA:
        raise HomeNodeError("Native release manifest uses an unsupported schema.")
    required_strings = (
        "release",
        "minimum_cli_version",
        "maximum_cli_version_exclusive",
        "platform",
        "arch",
        "node_entrypoint",
        "core_entrypoint",
        "brain_entrypoint",
        "archive_entrypoint",
    )
    strings: dict[str, str] = {}
    for key in required_strings:
        item = value.get(key)
        if not isinstance(item, str) or not item:
            raise HomeNodeError(f"Native release manifest has invalid {key!r}.")
        strings[key] = item
    if _RELEASE_RE.fullmatch(strings["release"]) is None:
        raise HomeNodeError("Native release manifest has an invalid release value.")
    minimum_cli = _parse_semver_core(strings["minimum_cli_version"])
    maximum_cli = _parse_semver_core(strings["maximum_cli_version_exclusive"])
    current_cli = _parse_semver_core(__version__)
    if minimum_cli >= maximum_cli:
        raise HomeNodeError("Native release manifest has an invalid CLI version range.")
    if not (minimum_cli <= current_cli < maximum_cli):
        raise HomeNodeError(
            "Native Home Node release requires dina-agent "
            f">={strings['minimum_cli_version']} and "
            f"<{strings['maximum_cli_version_exclusive']}; this CLI is "
            f"{__version__}."
        )
    node_major = value.get("node_major")
    if (
        not isinstance(node_major, int)
        or isinstance(node_major, bool)
        or node_major < MIN_NODE_MAJOR
        or node_major > 100
    ):
        raise HomeNodeError("Native release manifest has invalid node_major.")
    files_value = value.get("files")
    if not isinstance(files_value, dict) or not files_value:
        raise HomeNodeError("Native release manifest has no file inventory.")
    files: dict[str, str] = {}
    for raw_path, raw_digest in files_value.items():
        if not isinstance(raw_path, str) or not isinstance(raw_digest, str):
            raise HomeNodeError("Native release manifest file inventory is malformed.")
        path = _safe_archive_name(raw_path)
        if path == "manifest.json" or _SHA256_RE.fullmatch(raw_digest) is None:
            raise HomeNodeError("Native release manifest file inventory is malformed.")
        files[path] = raw_digest
    for key in (
        "node_entrypoint",
        "core_entrypoint",
        "brain_entrypoint",
        "archive_entrypoint",
    ):
        entry = _safe_archive_name(strings[key])
        if entry not in files:
            raise HomeNodeError(
                f"Native release manifest entrypoint {entry!r} is not inventoried."
            )
        strings[key] = entry
    return ReleaseManifest(
        release=strings["release"],
        minimum_cli_version=strings["minimum_cli_version"],
        maximum_cli_version_exclusive=strings["maximum_cli_version_exclusive"],
        platform=strings["platform"],
        arch=strings["arch"],
        node_major=node_major,
        node_entrypoint=strings["node_entrypoint"],
        core_entrypoint=strings["core_entrypoint"],
        brain_entrypoint=strings["brain_entrypoint"],
        archive_entrypoint=strings["archive_entrypoint"],
        files=files,
    )


def _parse_semver_core(value: str) -> tuple[int, int, int]:
    match = _SEMVER_RE.fullmatch(value)
    if match is None:
        raise HomeNodeError(f"Invalid semantic version {value!r}.")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def _subprocess_error_detail(
    exc: subprocess.CalledProcessError | subprocess.TimeoutExpired | OSError,
) -> str:
    if isinstance(exc, subprocess.CalledProcessError):
        value = exc.stderr or exc.stdout
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace").strip()[-1000:]
        if isinstance(value, str):
            return value.strip()[-1000:]
    return str(exc).strip()[-1000:]


def _config_from_value(value: Any) -> HomeNodeConfig:
    if not isinstance(value, dict):
        raise HomeNodeError("Home Node state has no valid config object.")
    expected = {
        "release_id",
        "release_version",
        "endpoint_mode",
        "core_port",
        "brain_port",
        "brain_did",
        "pds_handle",
        "pds_email",
        "autostart_enabled",
    }
    if set(value) != expected:
        raise HomeNodeError("Home Node config has missing or unexpected fields.")
    release_id = value["release_id"]
    release_version = value["release_version"]
    endpoint_mode = value["endpoint_mode"]
    core_port = value["core_port"]
    brain_port = value["brain_port"]
    brain_did = value["brain_did"]
    pds_handle = value["pds_handle"]
    pds_email = value["pds_email"]
    autostart_enabled = value["autostart_enabled"]
    if (
        not isinstance(release_id, str)
        or _RELEASE_ID_RE.fullmatch(release_id) is None
        or not isinstance(release_version, str)
        or _RELEASE_RE.fullmatch(release_version) is None
        or endpoint_mode not in {"test", "release"}
        or not isinstance(core_port, int)
        or isinstance(core_port, bool)
        or not (1 <= core_port <= 65535)
        or not isinstance(brain_port, int)
        or isinstance(brain_port, bool)
        or not (1 <= brain_port <= 65535)
        or core_port == brain_port
        or not isinstance(brain_did, str)
        or not brain_did.startswith("did:key:z")
        or (pds_handle is not None and not isinstance(pds_handle, str))
        or (pds_email is not None and not isinstance(pds_email, str))
        or not isinstance(autostart_enabled, bool)
    ):
        raise HomeNodeError("Home Node config contains invalid values.")
    if pds_handle is not None:
        _validate_handle(pds_handle)
    return HomeNodeConfig(
        release_id=release_id,
        release_version=release_version,
        endpoint_mode=endpoint_mode,
        core_port=core_port,
        brain_port=brain_port,
        brain_did=brain_did,
        pds_handle=pds_handle,
        pds_email=pds_email,
        autostart_enabled=autostart_enabled,
    )


def _safe_archive_name(value: str) -> str:
    if (
        not value
        or "\x00" in value
        or "\\" in value
        or value.startswith("/")
        or value.endswith("/")
    ):
        # tar directory members may end in slash; normalize those before this
        # helper by tarfile's member.name behavior, which generally strips it.
        if value.endswith("/") and value[:-1]:
            value = value[:-1]
        else:
            raise HomeNodeError(f"Native release contains unsafe path {value!r}.")
    path = PurePosixPath(value)
    if any(part in {"", ".", ".."} for part in path.parts):
        raise HomeNodeError(f"Native release contains unsafe path {value!r}.")
    normalized = path.as_posix()
    if len(normalized) > 512:
        raise HomeNodeError("Native release contains an overlong path.")
    return normalized


def _read_tar_member(archive: tarfile.TarFile, member: tarfile.TarInfo) -> bytes:
    stream = archive.extractfile(member)
    if stream is None:
        raise HomeNodeError(f"Could not read release entry {member.name!r}.")
    content = stream.read(MAX_RELEASE_FILE_BYTES + 1)
    if len(content) != member.size or len(content) > MAX_RELEASE_FILE_BYTES:
        raise HomeNodeError(f"Release entry {member.name!r} has an invalid size.")
    return content


def _runtime_platform() -> str:
    value = sys.platform
    if value == "darwin":
        return "darwin"
    if value.startswith("linux"):
        return "linux"
    if value in {"win32", "cygwin"}:
        return "win32"
    raise HomeNodeError(f"Native Home Node does not support platform {value!r}.")


def _runtime_arch() -> str:
    value = platform.machine().lower()
    if value in {"x86_64", "amd64"}:
        return "x64"
    if value in {"arm64", "aarch64"}:
        return "arm64"
    raise HomeNodeError(f"Native Home Node does not support architecture {value!r}.")


def _normalize_release_version(value: str) -> str:
    result = value
    if result.startswith("home-node-lite-v"):
        result = result.removeprefix("home-node-lite-v")
    elif result.startswith("v") and _SEMVER_RE.fullmatch(result) is not None:
        result = result.removeprefix("v")
    if _RELEASE_RE.fullmatch(result) is None:
        raise HomeNodeError(f"Invalid Home Node release: {value!r}")
    return result


def _safe_release_component(value: str) -> str:
    result = value.removeprefix("v")
    if _RELEASE_RE.fullmatch(result) is None:
        raise HomeNodeError("Native release version cannot form a safe directory.")
    return result


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _write_new_file(path: Path, content: bytes, *, mode: int) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(fd)


def _atomic_private_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() and path.is_symlink():
        raise HomeNodeError(f"Refusing to replace symlink: {path}")
    temp = path.parent / f".{path.name}.{secrets.token_hex(6)}.tmp"
    try:
        _write_new_file(temp, content, mode=0o600)
        os.replace(temp, path)
        if os.name != "nt":
            os.chmod(path, 0o600)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temp.unlink()


def _make_release_read_only(root: Path) -> None:
    for path in sorted(root.rglob("*"), key=lambda item: len(item.parts), reverse=True):
        if path.is_symlink():
            raise HomeNodeError(
                "Native release staging unexpectedly contains a symlink."
            )
        if path.is_dir():
            if os.name != "nt":
                os.chmod(path, 0o500)
        elif os.name != "nt":
            mode = (
                0o500 if path.relative_to(root).as_posix() == "runtime/node" else 0o400
            )
            os.chmod(path, mode)
    if os.name != "nt":
        os.chmod(root, 0o500)


def _remove_read_only_tree(root: Path) -> None:
    """Remove a verified release tree without weakening it while installed."""
    if not root.exists():
        if root.is_symlink():
            raise HomeNodeError(f"Refusing to remove symlinked path: {root}")
        return
    if root.is_symlink():
        raise HomeNodeError(f"Refusing to remove symlinked path: {root}")
    _reject_symlinks(root)
    if os.name != "nt":
        os.chmod(root, 0o700)
        for path in root.rglob("*"):
            if path.is_dir():
                os.chmod(path, 0o700)
    shutil.rmtree(root)


def _reject_symlinks(root: Path) -> None:
    if root.is_symlink():
        raise HomeNodeError(f"Home Node data path is a symlink: {root}")
    for path in root.rglob("*"):
        if path.is_symlink():
            raise HomeNodeError(
                f"Home Node data contains an unsupported symlink: {path}"
            )


def _chmod_private_tree(root: Path) -> None:
    if os.name == "nt":
        return
    for path in root.rglob("*"):
        os.chmod(path, 0o700 if path.is_dir() else 0o600)
    os.chmod(root, 0o700)


def _rotate_log(path: Path, *, max_bytes: int = 10 * 1024 * 1024) -> None:
    if path.is_symlink():
        raise HomeNodeError(f"Log path must not be a symlink: {path}")
    if path.is_file() and path.stat().st_size > max_bytes:
        previous = path.with_suffix(path.suffix + ".1")
        with contextlib.suppress(FileNotFoundError):
            previous.unlink()
        os.replace(path, previous)


def _tail_lines(path: Path, count: int) -> list[str]:
    with path.open("r", encoding="utf-8", errors="replace") as stream:
        return stream.readlines()[-count:]


def _process_command(pid: int) -> str | None:
    if sys.platform.startswith("linux"):
        try:
            return (
                Path(f"/proc/{pid}/cmdline")
                .read_bytes()
                .replace(b"\x00", b" ")
                .decode("utf-8", errors="replace")
            )
        except OSError:
            return None
    if os.name == "nt":
        try:
            result = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "(Get-CimInstance Win32_Process -Filter "
                    f"'ProcessId={int(pid)}').CommandLine",
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=15,
            )
            command = result.stdout.strip()
            return command or None
        except (OSError, subprocess.SubprocessError, ValueError):
            return None
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
        return result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def _windows_pid_exists(pid: int) -> bool:
    """Probe liveness via OpenProcess: os.kill(pid, 0) is POSIX-only and
    raises WinError 87 on Windows."""
    import ctypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    ERROR_ACCESS_DENIED = 5
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if handle:
        kernel32.CloseHandle(handle)
        return True
    return kernel32.GetLastError() == ERROR_ACCESS_DENIED


def _pid_exists(pid: int) -> bool:
    if pid <= 1:
        return False
    if os.name == "nt":
        return _windows_pid_exists(pid)
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _normalize_optional(value: str | None, *, lowercase: bool = False) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    return normalized.lower() if lowercase else normalized


def _validate_handle(handle: str) -> None:
    if len(handle) > 253 or handle.startswith(".") or handle.endswith("."):
        raise HomeNodeError("PDS handle is malformed.")
    labels = handle.split(".")
    if len(labels) < 2 or any(
        _HANDLE_LABEL_RE.fullmatch(label) is None for label in labels
    ):
        raise HomeNodeError("PDS handle must be a valid lowercase domain name.")
    managed_host = next(
        (host for host in _DINA_MANAGED_PDS_HOSTS if handle.endswith(f".{host}")),
        None,
    )
    if managed_host is not None and len(handle) > _DINA_PDS_MAX_HANDLE_CHARS:
        max_prefix = _DINA_PDS_MAX_HANDLE_CHARS - len(managed_host) - 1
        raise HomeNodeError(
            "Dina PDS handles must be at most "
            f"{_DINA_PDS_MAX_HANDLE_CHARS} characters. "
            f"Use a prefix of at most {max_prefix} characters for {managed_host}."
        )
