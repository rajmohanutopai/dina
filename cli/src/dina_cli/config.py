"""Configuration from saved file (~/.dina/cli/config.json) + env overrides."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

import click

CONFIG_DIR = Path.home() / ".dina" / "cli"
CONFIG_FILE = CONFIG_DIR / "config.json"
IDENTITY_DIR = CONFIG_DIR / "identity"


@dataclass(frozen=True)
class Config:
    """Immutable CLI configuration."""

    core_url: str
    brain_url: str
    client_token: str
    brain_token: str
    persona: str
    timeout: float
    auth_mode: str = "token"   # "token" or "signature"
    device_name: str = ""


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


def _has_keypair() -> bool:
    """Check whether an Ed25519 keypair exists on disk."""
    return (IDENTITY_DIR / "ed25519_private.pem").exists()


def load_config() -> Config:
    """Build Config from saved file + env overrides.

    Priority: env vars override saved file values.

    When ``auth_mode`` is ``"signature"`` (Ed25519 signing), a client_token
    is not required.  When ``auth_mode`` is ``"token"`` (legacy Bearer),
    a client_token must be present or ``click.UsageError`` is raised.
    """
    saved = _load_saved()

    core_url = os.environ.get("DINA_CORE_URL") or saved.get("core_url") or "http://localhost:8100"
    brain_url = os.environ.get("DINA_BRAIN_URL") or saved.get("brain_url") or "http://localhost:8200"
    client_token = os.environ.get("DINA_CLIENT_TOKEN") or saved.get("client_token") or ""
    brain_token = os.environ.get("DINA_BRAIN_TOKEN") or saved.get("brain_token") or ""
    persona = os.environ.get("DINA_PERSONA") or saved.get("persona") or "personal"
    timeout = float(os.environ.get("DINA_TIMEOUT") or saved.get("timeout") or 30.0)
    device_name = saved.get("device_name") or ""

    # Determine auth mode: saved config > auto-detect from keypair > "token".
    auth_mode = saved.get("auth_mode") or ""
    if not auth_mode:
        auth_mode = "signature" if _has_keypair() else "token"

    # In token mode a client_token is mandatory.
    if auth_mode == "token" and not client_token:
        hint = "Run 'dina configure' to set up, or set DINA_CLIENT_TOKEN"
        raise click.UsageError(f"No client token configured. {hint}")

    return Config(
        core_url=core_url,
        brain_url=brain_url,
        client_token=client_token,
        brain_token=brain_token,
        persona=persona,
        timeout=timeout,
        auth_mode=auth_mode,
        device_name=device_name,
    )
