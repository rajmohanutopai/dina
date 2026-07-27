"""Shared setup workflow for coding-agent hosts.

Host plugins bootstrap a compatible ``dina-agent`` installation, then call
this module through ``dina agent-host setup``. Identity provisioning,
enrollment, health verification, and connected-Brain selection therefore have
one implementation across Claude Code, Codex, and future coding hosts.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Any

from . import __version__
from .client import DinaClient, DinaClientError
from .config import Config, load_saved_from
from .home_node import DEFAULT_RELEASE, HomeNodeError, HomeNodeManager
from .home_node_enrollment import HomeNodeAgentEnroller, HomeNodeEnrollment
from .home_node_reasoning import (
    HomeNodeReasoningSelection,
    HomeNodeReasoningSelector,
)
from .signing import CLIIdentity

SUPPORTED_HOSTS = ("claude-code", "codex")
HANDLE_LABEL_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
DINA_PDS_MAX_HANDLE_CHARS = 30
DINA_MANAGED_PDS_HOSTS = (
    "pds.dinakernel.com",
    "test-pds.dinakernel.com",
)


def _plugin_development_mode() -> bool:
    return os.environ.get("DINA_PLUGIN_DEV_MODE", "").strip() == "1"


class AgentHostSetupError(HomeNodeError):
    """A setup failure with a stable machine-readable code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def normalize_pds_handle(handle: str) -> str:
    """Normalize and validate a public PDS handle before provisioning."""
    normalized = handle.strip().lower()
    labels = normalized.split(".")
    if (
        len(normalized) > 253
        or normalized.startswith(".")
        or normalized.endswith(".")
        or len(labels) < 2
        or any(HANDLE_LABEL_RE.fullmatch(label) is None for label in labels)
    ):
        raise AgentHostSetupError(
            "pds_handle_invalid",
            "PDS handle must be a valid domain name.",
        )
    managed_host = next(
        (host for host in DINA_MANAGED_PDS_HOSTS if normalized.endswith(f".{host}")),
        None,
    )
    if managed_host is not None and len(normalized) > DINA_PDS_MAX_HANDLE_CHARS:
        max_prefix = DINA_PDS_MAX_HANDLE_CHARS - len(managed_host) - 1
        raise AgentHostSetupError(
            "pds_handle_too_long",
            "Dina PDS handles must be at most "
            f"{DINA_PDS_MAX_HANDLE_CHARS} characters. "
            f"Use a prefix of at most {max_prefix} characters for {managed_host}.",
        )
    return normalized


def default_host_config_dir(host: str) -> Path:
    """Resolve the installer-owned profile for one coding-agent host."""
    configured = (
        os.environ.get("DINA_CONFIG_DIR", "").strip()
        if _plugin_development_mode()
        else ""
    )
    if configured:
        return Path(configured).expanduser()
    configured_root = (
        os.environ.get("DINA_AGENT_HOST_CONFIG_ROOT", "").strip()
        if _plugin_development_mode()
        else ""
    )
    root = Path(
        configured_root or str(Path.home() / ".dina" / "agent-hosts")
    ).expanduser()
    return root / host / "cli"


def _host_label(host: str) -> str:
    return {
        "claude-code": "Claude Code",
        "codex": "Codex",
    }[host]


def _reasoning_result(selection: HomeNodeReasoningSelection) -> dict[str, Any]:
    return {
        "status": selection.status,
        "backend_id": selection.backend_id,
        "principal_did": selection.principal_did,
        "policy_version": selection.policy_version,
        "selected": selection.selected,
        "reason": selection.reason,
    }


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise AgentHostSetupError(
            "setup_environment_invalid",
            f"{name} must be an integer.",
        ) from exc
    if value < 1 or value > 65535:
        raise AgentHostSetupError(
            "setup_environment_invalid",
            f"{name} must be between 1 and 65535.",
        )
    return value


class AgentHostSetup:
    """Install or repair one host against the local native Home Node."""

    def __init__(
        self,
        host: str,
        *,
        manager: HomeNodeManager | None = None,
        config_dir: Path | None = None,
    ) -> None:
        if host not in SUPPORTED_HOSTS:
            raise AgentHostSetupError(
                "host_unsupported",
                f"Unsupported agent host {host!r}.",
            )
        self.host = host
        if manager is None:
            development_mode = _plugin_development_mode()
            manager = HomeNodeManager(
                install_dir=(
                    None if development_mode else Path.home() / ".dina" / "home-node"
                ),
                allow_release_overrides=development_mode,
            )
        self.manager = manager
        self.config_dir = (
            (config_dir or default_host_config_dir(host)).expanduser().resolve()
        )

    def status(self) -> dict[str, Any]:
        """Return setup readiness without creating or repairing authority."""
        home = self.manager.status()
        agent = self._probe_agent() if home.running and home.core_healthy else None
        ready = bool(
            home.installed
            and home.running
            and home.core_healthy
            and home.brain_healthy
            and agent
            and agent["paired"]
            and agent["authenticated"]
            and agent["core_reachable"]
        )
        return {
            "kind": "setup_status",
            "host": self.host,
            "ready": ready,
            "cli": self._cli_result(),
            "home_node": self._home_result(home),
            "agent": agent,
            "needs_identity_choice": not home.installed,
        }

    def ensure(self) -> dict[str, Any]:
        """Repair runtime health, enrollment, and compatible Brain selection."""
        if not self.manager.status().installed:
            raise AgentHostSetupError(
                "identity_choice_required",
                "No Home Node exists. Choose local-only setup or provide a public "
                "PDS handle.",
            )
        self.manager.ensure(if_installed=False, wait_timeout=120.0)
        enrollment, selection = self._enroll_and_select()
        return self._ready_result(
            enrollment=enrollment,
            selection=selection,
            installed_now=False,
        )

    def install(
        self,
        *,
        local_only: bool,
        pds_handle: str | None,
        pds_email: str | None,
    ) -> dict[str, Any]:
        """Install a native Home Node and enroll the coding host."""
        existing = self.manager.status()
        if existing.installed:
            if local_only or pds_handle:
                raise AgentHostSetupError(
                    "identity_already_configured",
                    "Home Node already exists; setup will not replace its identity "
                    "settings.",
                )
            return self.ensure()
        if pds_email and not pds_handle:
            raise AgentHostSetupError(
                "pds_email_without_handle",
                "--pds-email requires --pds-handle.",
            )
        if pds_handle:
            pds_handle = normalize_pds_handle(pds_handle)
        elif not local_only:
            raise AgentHostSetupError(
                "identity_choice_required",
                "Choose local-only setup or provide a public PDS handle.",
            )

        development_mode = _plugin_development_mode()
        release = (
            os.environ.get("DINA_SETUP_HOME_NODE_RELEASE", "").strip()
            if development_mode
            else ""
        )
        bundle = (
            os.environ.get("DINA_SETUP_HOME_NODE_BUNDLE", "").strip()
            if development_mode
            else ""
        )
        status = self.manager.install(
            release_version=release or DEFAULT_RELEASE,
            bundle_path=Path(bundle).expanduser() if bundle else None,
            endpoint_mode=(
                os.environ.get("DINA_SETUP_ENDPOINT_MODE", "release")
                if development_mode
                else "release"
            ),
            core_port=(
                _int_env("DINA_SETUP_CORE_PORT", 8100) if development_mode else 8100
            ),
            brain_port=(
                _int_env("DINA_SETUP_BRAIN_PORT", 8200) if development_mode else 8200
            ),
            pds_handle=pds_handle,
            pds_email=pds_email,
            start=True,
            wait_timeout=120.0,
        )
        if not status.core_healthy or not status.brain_healthy:
            raise AgentHostSetupError(
                "home_node_unhealthy",
                "Home Node started without healthy Core and Brain services.",
            )
        enrollment, selection = self._enroll_and_select()
        return self._ready_result(
            enrollment=enrollment,
            selection=selection,
            installed_now=True,
        )

    def _enroll_and_select(
        self,
    ) -> tuple[HomeNodeEnrollment, HomeNodeReasoningSelection]:
        enrollment = HomeNodeAgentEnroller(
            self.manager,
            config_dir=self.config_dir,
            device_name=f"{_host_label(self.host)} coding agent",
            receipt_name=self.host,
        ).enroll()
        selection = HomeNodeReasoningSelector(self.manager).select(enrollment)
        return enrollment, selection

    def _ready_result(
        self,
        *,
        enrollment: HomeNodeEnrollment,
        selection: HomeNodeReasoningSelection,
        installed_now: bool,
    ) -> dict[str, Any]:
        home = self.manager.status()
        agent = self._probe_agent()
        if not (
            home.installed
            and home.running
            and home.core_healthy
            and home.brain_healthy
            and agent
            and agent["paired"]
            and agent["authenticated"]
            and agent["core_reachable"]
            and agent["did"] == enrollment.agent_did
            and agent["home_did"] == enrollment.home_did
        ):
            raise AgentHostSetupError(
                "verification_failed",
                "Dina was installed but Core, Brain, or coding-agent "
                "authentication is not healthy.",
            )

        label = _host_label(self.host)
        next_steps: list[str] = []
        if self.host == "claude-code":
            next_steps.append(
                "Restart Claude Code so the Dina MCP server starts against the "
                "new installation."
            )
        else:
            next_steps.append(
                "Open /hooks, review and trust the Dina hook, then start a new "
                "Codex conversation so its MCP server and hooks reload."
            )
        if selection.selected:
            next_steps.append(
                f"{label} is selected as Dina's foreground Brain. It can reason "
                "for Dina while a host session is open; no separate AI API key "
                "is required."
            )
        else:
            next_steps.append(
                "Existing owner Brain policy was preserved. Use the Owner page "
                f"if you want this {label} agent to become Dina's foreground Brain."
            )
        next_steps.extend(
            [
                (
                    "To manage supervision or pair a phone, open the Owner URL "
                    "and privately run: dina home-node show-owner-capability"
                ),
                (
                    "Record the recovery phrase in a private terminal with: "
                    "dina home-node show-recovery-phrase"
                ),
            ]
        )
        return {
            "kind": "setup_complete",
            "host": self.host,
            "ready": True,
            "installed_now": installed_now,
            "cli": self._cli_result(),
            "home_node": {
                "core_url": home.core_url,
                "brain_url": home.brain_url,
                "owner_url": f"{home.core_url}/owner",
                "release_version": home.release_version,
            },
            "agent": agent,
            "connected_brain": _reasoning_result(selection),
            "next_steps": next_steps,
        }

    def _probe_agent(self) -> dict[str, Any] | None:
        saved = load_saved_from(self.config_dir)
        identity = CLIIdentity(identity_dir=self.config_dir / "identity")
        if (
            not (self.config_dir / "config.json").is_file()
            or not identity.exists
            or saved.get("role") != "agent"
            or saved.get("agent_scope") != "coding"
        ):
            return None
        try:
            identity.ensure_loaded()
            config = Config(
                core_url=str(saved.get("core_url") or ""),
                timeout=10.0,
                device_name=str(saved.get("device_name") or ""),
                role="agent",
                msgbox_url=str(saved.get("msgbox_url") or ""),
                homenode_did=str(saved.get("homenode_did") or ""),
                transport_mode=str(saved.get("transport_mode") or "direct"),
            )
            with DinaClient(config, identity=identity) as client:
                health = client._request(client._core, "GET", "/healthz")
                health.raise_for_status()
                client.session_list()
            return {
                "paired": True,
                "authenticated": True,
                "core_reachable": True,
                "did": identity.did(),
                "home_did": config.homenode_did,
                "transport": config.transport_mode,
                "config_dir": str(self.config_dir),
            }
        except (DinaClientError, HomeNodeError, OSError, TypeError, ValueError):
            return None

    @staticmethod
    def _home_result(home: Any) -> dict[str, Any]:
        return {
            "installed": home.installed,
            "running": home.running,
            "core_healthy": home.core_healthy,
            "brain_healthy": home.brain_healthy,
            "core_url": home.core_url,
            "brain_url": home.brain_url,
            "install_dir": home.install_dir,
            "release_version": home.release_version,
            "autostart_enabled": home.autostart_enabled,
        }

    @staticmethod
    def _cli_result() -> dict[str, Any]:
        active_cli = os.environ.get("DINA_SETUP_ACTIVE_CLI", "").strip()
        return {
            "available": True,
            "version": __version__,
            "path": active_cli or sys.argv[0],
            "managed": os.environ.get("DINA_SETUP_CLI_MANAGED") == "1",
        }
