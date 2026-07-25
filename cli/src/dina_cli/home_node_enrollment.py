"""Automatic enrollment of the local coding agent into Home Node Lite.

The installer is already an owner-authorized local process: it owns the private
native Home Node data directory and can read Core's owner capability directly.
This module uses that authority narrowly to mint one coding-scoped pairing code,
redeems it with the CLI's Ed25519 public key, and persists only the resulting
device metadata. Owner and pairing capabilities never reach stdout, logs, argv,
environment variables, or disk.
"""

from __future__ import annotations

import contextlib
import json
import os
import platform
import secrets
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from .config import load_saved_from, save_config_to, save_new_config_to
from .home_node import HomeNodeError, HomeNodeManager
from .setup_code import SetupCodeError, parse_setup_code
from .signing import CLIIdentity


class HomeNodeEnrollmentError(HomeNodeError):
    """Automatic enrollment could not complete safely."""


@dataclass(frozen=True)
class HomeNodeEnrollment:
    status: str
    device_id: str
    agent_did: str
    home_did: str
    config_dir: str


@dataclass(frozen=True)
class ManagedEnrollmentCleanup:
    """A purge-time cleanup plan captured before the install directory is removed."""

    install_dir: Path
    config_dir: Path
    device_id: str
    agent_did: str
    home_did: str

    def apply(self) -> bool:
        """Remove only credentials still proven to belong to this installation."""
        with _enrollment_lock_for(self.config_dir):
            config_file = self.config_dir / "config.json"
            identity_dir = self.config_dir / "identity"
            if (
                not config_file.is_file()
                or config_file.is_symlink()
                or not identity_dir.is_dir()
                or identity_dir.is_symlink()
            ):
                return False
            saved = load_saved_from(self.config_dir)
            if (
                saved.get("managed_by") != "dina-home-node-installer"
                or saved.get("managed_install_dir") != str(self.install_dir)
                or saved.get("device_id") != self.device_id
                or saved.get("homenode_did") != self.home_did
            ):
                return False
            identity = CLIIdentity(identity_dir=identity_dir)
            if not identity.exists:
                return False
            identity.ensure_loaded()
            if identity.did() != self.agent_did:
                return False

            # Remove config first. If key deletion then fails, the key is inert
            # and a later installer can safely reuse it instead of leaving a
            # live config pointing at a node whose vault was destroyed.
            config_file.unlink()
            shutil.rmtree(identity_dir)
            with contextlib.suppress(OSError):
                self.config_dir.rmdir()
            return True


def default_agent_config_dir() -> Path:
    override = os.environ.get("DINA_CONFIG_DIR", "").strip()
    return Path(override).expanduser() if override else Path.home() / ".dina" / "cli"


class HomeNodeAgentEnroller:
    """Enroll exactly one local coding agent without replacing other authority."""

    def __init__(
        self,
        manager: HomeNodeManager,
        *,
        config_dir: Path | None = None,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 15.0,
    ) -> None:
        self.manager = manager
        self.config_dir = (
            (config_dir or default_agent_config_dir()).expanduser().resolve()
        )
        self.identity_dir = self.config_dir / "identity"
        self.config_file = self.config_dir / "config.json"
        self.receipt_file = self.manager.install_dir / "agent-enrollment.json"
        self.transport = transport
        self.timeout = timeout

    def enroll(self) -> HomeNodeEnrollment:
        with self._enrollment_lock():
            return self._enroll_locked()

    def _enroll_locked(self) -> HomeNodeEnrollment:
        try:
            status = self.manager.status()
            if not status.installed or not status.core_healthy:
                raise HomeNodeEnrollmentError(
                    "Home Node Core must be installed and healthy before agent enrollment."
                )

            owner_capability = self.manager.read_owner_capability()
            with httpx.Client(
                base_url=status.core_url,
                timeout=self.timeout,
                transport=self.transport,
                headers={
                    "X-Dina-Owner-Capability": owner_capability,
                    "Cache-Control": "no-store",
                },
            ) as client:
                owner_status = self._owner_status(client)
                saved = load_saved_from(self.config_dir)
                identity = CLIIdentity(identity_dir=self.identity_dir)

                if self.config_file.exists():
                    return self._resolve_existing_config(
                        saved=saved,
                        identity=identity,
                        owner_status=owner_status,
                        core_url=status.core_url,
                    )

                if identity.exists:
                    identity.ensure_loaded()
                    existing_agent = _find_agent(owner_status, identity.did())
                    if existing_agent is not None:
                        return self._persist_recovered(
                            identity=identity,
                            agent=existing_agent,
                            owner_status=owner_status,
                            core_url=status.core_url,
                        )
                    return self._pair_and_persist(
                        client=client,
                        identity=identity,
                        identity_was_created=False,
                        owner_status=owner_status,
                        core_url=status.core_url,
                    )

                return self._enroll_new_identity(
                    client=client,
                    owner_status=owner_status,
                    core_url=status.core_url,
                )
        except HomeNodeError:
            raise
        except httpx.HTTPError as exc:
            raise HomeNodeEnrollmentError(
                "Could not reach the local Home Node owner setup API."
            ) from exc
        except (OSError, TypeError, ValueError) as exc:
            raise HomeNodeEnrollmentError(
                "Could not read or persist the local coding-agent identity."
            ) from exc

    def _resolve_existing_config(
        self,
        *,
        saved: dict[str, Any],
        identity: CLIIdentity,
        owner_status: dict[str, Any],
        core_url: str,
    ) -> HomeNodeEnrollment:
        if not identity.exists:
            raise HomeNodeEnrollmentError(
                f"Existing Dina config at {self.config_file} has no signing key. "
                "Refusing to replace or reinterpret it automatically."
            )
        identity.ensure_loaded()
        agent = _find_agent(owner_status, identity.did())
        configured_url = str(saved.get("core_url") or "").rstrip("/")
        configured_home_did = str(saved.get("homenode_did") or "")
        actual_home_did = _required_str(owner_status, "home_did")
        compatible = (
            configured_url == core_url.rstrip("/")
            and saved.get("role") == "agent"
            and configured_home_did == actual_home_did
            and agent is not None
        )
        if not compatible:
            raise HomeNodeEnrollmentError(
                f"Existing Dina configuration at {self.config_file} is not the "
                "coding agent for this Home Node. It was preserved unchanged. "
                "Choose a separate DINA_CONFIG_DIR or explicitly reconfigure it."
            )
        device_id = _required_str(agent, "device_id")
        if saved.get("device_id") != device_id:
            save_config_to(self.config_dir, {**saved, "device_id": device_id})
        self._record_if_managed(
            device_id=device_id,
            agent_did=identity.did(),
            home_did=actual_home_did,
        )
        return HomeNodeEnrollment(
            status="already_enrolled",
            device_id=device_id,
            agent_did=identity.did(),
            home_did=actual_home_did,
            config_dir=str(self.config_dir),
        )

    def _enroll_new_identity(
        self,
        *,
        client: httpx.Client,
        owner_status: dict[str, Any],
        core_url: str,
    ) -> HomeNodeEnrollment:
        # Persist the key at its final deterministic path before pairing. If the
        # process dies after Core accepts it but before config is written, the
        # next run can match this DID in the owner-visible coding-agent list and
        # repair config. A random staging path would strand untraceable authority.
        identity = CLIIdentity(identity_dir=self.identity_dir)
        identity.generate()
        return self._pair_and_persist(
            client=client,
            identity=identity,
            identity_was_created=True,
            owner_status=owner_status,
            core_url=core_url,
        )

    def _pair_and_persist(
        self,
        *,
        client: httpx.Client,
        identity: CLIIdentity,
        identity_was_created: bool,
        owner_status: dict[str, Any],
        core_url: str,
    ) -> HomeNodeEnrollment:
        setup_response = client.post("/v1/owner/setup/coding-agent")
        if setup_response.status_code != 201:
            raise HomeNodeEnrollmentError(
                "Core could not mint a coding-agent enrollment capability "
                f"(HTTP {setup_response.status_code})."
            )
        setup_body = _json_object(setup_response, "owner setup")
        try:
            setup = parse_setup_code(_required_str(setup_body, "setup_code"))
        except SetupCodeError as exc:
            raise HomeNodeEnrollmentError(
                f"Core returned an invalid coding-agent setup capability: {exc}"
            ) from exc
        expected_home_did = _required_str(owner_status, "home_did")
        expected_msgbox_url = _required_str(owner_status, "msgbox_url")
        if (
            setup.homenode_did != expected_home_did
            or setup.msgbox_url != expected_msgbox_url
        ):
            raise HomeNodeEnrollmentError(
                "Core owner setup returned connection metadata that does not "
                "match its authenticated status response."
            )

        pair_response = client.post(
            "/v1/pair/complete",
            json={
                "code": setup.code,
                "device_name": _device_name(),
                "public_key_multibase": identity.public_key_multibase(),
                # Core ignores this privilege hint. The owner-minted pairing
                # intent is authoritative for role=agent, scope=coding.
                "role": "agent",
            },
        )
        if pair_response.status_code != 201:
            raise HomeNodeEnrollmentError(
                "Core rejected automatic coding-agent enrollment "
                f"(HTTP {pair_response.status_code})."
            )
        pair_body = _json_object(pair_response, "pair completion")
        device_id = _required_str(pair_body, "device_id")
        home_did = _required_str(pair_body, "node_did")
        if home_did != expected_home_did:
            self._revoke(client, device_id)
            raise HomeNodeEnrollmentError(
                "Pair completion returned a different Home Node identity; the "
                "new device was revoked."
            )
        confirmed = self._owner_status(client)
        confirmed_agent = _find_agent(confirmed, identity.did())
        if (
            confirmed_agent is None
            or _required_str(confirmed_agent, "device_id") != device_id
        ):
            self._revoke(client, device_id)
            raise HomeNodeEnrollmentError(
                "Core did not confirm the new key as a coding-scoped agent; the "
                "new device was revoked."
            )

        try:
            self._save_connection(
                device_id=device_id,
                home_did=home_did,
                msgbox_url=setup.msgbox_url,
                core_url=core_url,
            )
            self._record_managed_enrollment(
                device_id=device_id,
                agent_did=identity.did(),
                home_did=home_did,
            )
        except Exception as exc:
            revoked = self._revoke(client, device_id)
            persisted = load_saved_from(self.config_dir)
            if (
                persisted.get("managed_by") == "dina-home-node-installer"
                and persisted.get("managed_install_dir")
                == str(self.manager.install_dir)
                and persisted.get("device_id") == device_id
            ):
                with contextlib.suppress(OSError):
                    self.config_file.unlink()
            if identity_was_created and not self.config_file.exists():
                shutil.rmtree(self.identity_dir, ignore_errors=True)
            suffix = (
                "The server-side device was revoked."
                if revoked
                else "Server-side revocation could not be confirmed; remove the "
                f"device {device_id} from the owner console."
            )
            raise HomeNodeEnrollmentError(
                f"Could not persist automatic enrollment locally. {suffix}"
            ) from exc

        return HomeNodeEnrollment(
            status="enrolled",
            device_id=device_id,
            agent_did=identity.did(),
            home_did=home_did,
            config_dir=str(self.config_dir),
        )

    def _persist_recovered(
        self,
        *,
        identity: CLIIdentity,
        agent: dict[str, Any],
        owner_status: dict[str, Any],
        core_url: str,
    ) -> HomeNodeEnrollment:
        device_id = _required_str(agent, "device_id")
        home_did = _required_str(owner_status, "home_did")
        self._save_connection(
            device_id=device_id,
            home_did=home_did,
            msgbox_url=_optional_str(owner_status, "msgbox_url"),
            core_url=core_url,
        )
        self._record_managed_enrollment(
            device_id=device_id,
            agent_did=identity.did(),
            home_did=home_did,
        )
        return HomeNodeEnrollment(
            status="recovered",
            device_id=device_id,
            agent_did=identity.did(),
            home_did=home_did,
            config_dir=str(self.config_dir),
        )

    def _save_connection(
        self,
        *,
        device_id: str,
        home_did: str,
        msgbox_url: str,
        core_url: str,
    ) -> None:
        save_new_config_to(
            self.config_dir,
            self._connection_values(
                device_id=device_id,
                home_did=home_did,
                msgbox_url=msgbox_url,
                core_url=core_url,
            ),
        )

    def _connection_values(
        self,
        *,
        device_id: str,
        home_did: str,
        msgbox_url: str,
        core_url: str,
    ) -> dict[str, Any]:
        return {
            "core_url": core_url.rstrip("/"),
            "device_name": _device_name(),
            "role": "agent",
            "agent_scope": "coding",
            "msgbox_url": msgbox_url,
            "homenode_did": home_did,
            "transport_mode": "direct",
            "device_id": device_id,
            "managed_by": "dina-home-node-installer",
            "managed_install_dir": str(self.manager.install_dir),
        }

    def _record_if_managed(
        self,
        *,
        device_id: str,
        agent_did: str,
        home_did: str,
    ) -> None:
        saved = load_saved_from(self.config_dir)
        if saved.get("managed_by") == "dina-home-node-installer" and saved.get(
            "managed_install_dir"
        ) == str(self.manager.install_dir):
            self._record_managed_enrollment(
                device_id=device_id,
                agent_did=agent_did,
                home_did=home_did,
            )

    def _record_managed_enrollment(
        self,
        *,
        device_id: str,
        agent_did: str,
        home_did: str,
    ) -> None:
        _write_private_json(
            self.receipt_file,
            {
                "schema": 1,
                "managed_by": "dina-home-node-installer",
                "managed_install_dir": str(self.manager.install_dir),
                "config_dir": str(self.config_dir),
                "device_id": device_id,
                "agent_did": agent_did,
                "home_did": home_did,
            },
        )

    @staticmethod
    def _owner_status(client: httpx.Client) -> dict[str, Any]:
        response = client.get("/v1/owner/setup/status")
        if response.status_code != 200:
            raise HomeNodeEnrollmentError(
                "Core owner setup is unavailable " f"(HTTP {response.status_code})."
            )
        return _json_object(response, "owner status")

    @contextlib.contextmanager
    def _enrollment_lock(self):
        with _enrollment_lock_for(self.config_dir):
            yield

    @staticmethod
    def _revoke(client: httpx.Client, device_id: str) -> bool:
        with contextlib.suppress(httpx.HTTPError):
            response = client.delete(f"/v1/owner/setup/coding-agent/{device_id}")
            return response.status_code in (204, 404)
        return False


def prepare_managed_enrollment_cleanup(
    manager: HomeNodeManager,
) -> ManagedEnrollmentCleanup | None:
    """Capture a verified cleanup plan before destructive Home Node removal."""
    receipt_file = manager.install_dir / "agent-enrollment.json"
    if not receipt_file.is_file() or receipt_file.is_symlink():
        return None
    try:
        value = json.loads(receipt_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    try:
        schema = value.get("schema")
        install_dir = Path(_required_str(value, "managed_install_dir")).resolve()
        config_dir = Path(_required_str(value, "config_dir")).resolve()
        device_id = _required_str(value, "device_id")
        agent_did = _required_str(value, "agent_did")
        home_did = _required_str(value, "home_did")
    except (OSError, HomeNodeEnrollmentError):
        return None
    if (
        schema != 1
        or value.get("managed_by") != "dina-home-node-installer"
        or install_dir != manager.install_dir
        or not agent_did.startswith("did:key:")
        or not home_did.startswith("did:")
    ):
        return None
    return ManagedEnrollmentCleanup(
        install_dir=install_dir,
        config_dir=config_dir,
        device_id=device_id,
        agent_did=agent_did,
        home_did=home_did,
    )


@contextlib.contextmanager
def _enrollment_lock_for(config_dir: Path):
    config_dir.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = config_dir.parent / f".{config_dir.name}.enrollment.lock"
    lock = lock_path.open("a+")
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


def _write_private_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    payload = json.dumps(value, indent=2, sort_keys=True).encode("utf-8")
    temp = path.parent / f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
    old_umask = os.umask(0o077)
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            view = memoryview(payload)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("short write while persisting enrollment receipt")
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temp, path)
        path.chmod(0o600)
    finally:
        os.umask(old_umask)
        with contextlib.suppress(FileNotFoundError):
            temp.unlink()


def _find_agent(owner_status: dict[str, Any], agent_did: str) -> dict[str, Any] | None:
    agents = owner_status.get("coding_agents")
    if not isinstance(agents, list):
        return None
    for value in agents:
        if isinstance(value, dict) and value.get("did") == agent_did:
            return value
    return None


def _json_object(response: httpx.Response, label: str) -> dict[str, Any]:
    try:
        value = response.json()
    except ValueError as exc:
        raise HomeNodeEnrollmentError(
            f"Core returned malformed JSON for {label}."
        ) from exc
    if not isinstance(value, dict):
        raise HomeNodeEnrollmentError(f"Core returned an invalid object for {label}.")
    return value


def _required_str(value: dict[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or result.strip() == "":
        raise HomeNodeEnrollmentError(
            f"Core response is missing required field {key!r}."
        )
    return result.strip()


def _optional_str(value: dict[str, Any], key: str) -> str:
    result = value.get(key)
    return result.strip() if isinstance(result, str) else ""


def _device_name() -> str:
    hostname = platform.node().strip()
    return f"{hostname}-coding-agent" if hostname else "coding-agent"
