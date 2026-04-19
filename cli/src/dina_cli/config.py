"""Configuration from saved file (~/.dina/cli/config.json) + env overrides."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

import click

_GLOBAL_CONFIG_DIR = Path.home() / ".dina" / "cli"
_LOCAL_CONFIG_DIR = Path.cwd() / ".dina" / "cli"


def _resolve_config_dir() -> Path:
    """Find config directory: env override, then local, then global.

    Priority:
      1. DINA_CONFIG_DIR env var (for automation / multi-instance testing)
      2. Local .dina/cli/ in cwd (multi-instance: run from project folder)
      3. Global ~/.dina/cli/ (single-instance default)
    """
    env_dir = os.environ.get("DINA_CONFIG_DIR")
    if env_dir:
        return Path(env_dir)
    if (_LOCAL_CONFIG_DIR / "config.json").exists():
        return _LOCAL_CONFIG_DIR
    return _GLOBAL_CONFIG_DIR


CONFIG_DIR = _resolve_config_dir()
CONFIG_FILE = CONFIG_DIR / "config.json"
IDENTITY_DIR = CONFIG_DIR / "identity"


def set_config_dir(path: Path) -> None:
    """Change the config directory (called by dina configure)."""
    global CONFIG_DIR, CONFIG_FILE, IDENTITY_DIR
    CONFIG_DIR = path
    CONFIG_FILE = CONFIG_DIR / "config.json"
    IDENTITY_DIR = CONFIG_DIR / "identity"


@dataclass(frozen=True)
class Config:
    """Immutable CLI configuration."""

    core_url: str
    timeout: float
    device_name: str = ""
    role: str = "user"         # "user" or "agent" — set during configure
    # MsgBox transport — required for NAT'd/mobile deployments. `auto` falls
    # back from direct→msgbox when Core isn't reachable on core_url.
    msgbox_url: str = ""       # wss://mailbox.example.com/ws
    homenode_did: str = ""     # did:plc:... of the paired Home Node
    transport_mode: str = "auto"  # "direct" | "msgbox" | "auto"
    openclaw_url: str = ""     # ws://localhost:3000 — OpenClaw Gateway
    openclaw_token: str = ""   # Gateway auth token
    openclaw_device_token: str = ""  # Cached per-device Gateway token
    openclaw_hook_token: str = ""    # Token for /hooks/dina-task submission
    agent_runner: str = ""           # Default runner: "openclaw", "hermes", or "" (defaults to openclaw)


def _load_saved() -> dict:
    """Load saved config from ~/.dina/cli/config.json, or empty dict."""
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_config(values: dict) -> Path:
    """Write config values to ~/.dina/cli/config.json. Returns the path."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    old_umask = os.umask(0o077)
    try:
        tmp.write_text(json.dumps(values, indent=2))
        os.replace(tmp, CONFIG_FILE)
    finally:
        os.umask(old_umask)
    CONFIG_FILE.chmod(0o600)
    return CONFIG_FILE


def save_openclaw_device_token(token: str) -> Path:
    """Persist or clear the cached OpenClaw device token."""
    saved = _load_saved()
    if token:
        saved["openclaw_device_token"] = token
    else:
        saved.pop("openclaw_device_token", None)
    return save_config(saved)


def load_config() -> Config:
    """Build Config from saved file + env overrides.

    Priority: env vars override saved file values.

    CLI always uses Ed25519 signature auth.  A keypair must exist
    (run ``dina configure`` to generate one).
    """
    saved = _load_saved()

    core_url = os.environ.get("DINA_CORE_URL") or saved.get("core_url") or "http://localhost:8100"
    timeout = float(os.environ.get("DINA_TIMEOUT") or saved.get("timeout") or 30.0)
    device_name = saved.get("device_name") or ""
    msgbox_url = os.environ.get("DINA_MSGBOX_URL") or saved.get("msgbox_url") or ""
    homenode_did = os.environ.get("DINA_HOMENODE_DID") or saved.get("homenode_did") or ""
    transport_mode = (
        os.environ.get("DINA_TRANSPORT")
        or saved.get("transport_mode")
        or "auto"
    ).lower()
    if transport_mode not in ("direct", "msgbox", "auto"):
        raise click.UsageError(
            f"Invalid transport mode {transport_mode!r}. Must be direct, msgbox, or auto."
        )

    # Ed25519 keypair is required — nudge users to run configure.
    if not (IDENTITY_DIR / "ed25519_private.pem").exists():
        raise click.UsageError(
            "No Ed25519 keypair found. Run 'dina configure' to generate one."
        )

    role = saved.get("role") or "user"
    openclaw_url = os.environ.get("DINA_OPENCLAW_URL") or saved.get("openclaw_url") or ""
    openclaw_token = os.environ.get("DINA_OPENCLAW_TOKEN") or saved.get("openclaw_token") or ""
    openclaw_device_token = (
        os.environ.get("DINA_OPENCLAW_DEVICE_TOKEN")
        or saved.get("openclaw_device_token")
        or ""
    )
    openclaw_hook_token = (
        os.environ.get("DINA_OPENCLAW_HOOK_TOKEN")
        or saved.get("openclaw_hook_token")
        or ""
    )
    agent_runner = os.environ.get("DINA_AGENT_RUNNER") or saved.get("agent_runner") or ""

    return Config(
        core_url=core_url,
        timeout=timeout,
        device_name=device_name,
        role=role,
        msgbox_url=msgbox_url,
        homenode_did=homenode_did,
        transport_mode=transport_mode,
        openclaw_url=openclaw_url,
        openclaw_token=openclaw_token,
        openclaw_device_token=openclaw_device_token,
        openclaw_hook_token=openclaw_hook_token,
        agent_runner=agent_runner,
    )
