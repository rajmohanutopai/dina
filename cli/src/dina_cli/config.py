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
    persona: str
    timeout: float
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


def load_config() -> Config:
    """Build Config from saved file + env overrides.

    Priority: env vars override saved file values.

    CLI always uses Ed25519 signature auth.  A keypair must exist
    (run ``dina configure`` to generate one).
    """
    saved = _load_saved()

    core_url = os.environ.get("DINA_CORE_URL") or saved.get("core_url") or "http://localhost:8100"
    persona = os.environ.get("DINA_PERSONA") or saved.get("persona") or "personal"
    timeout = float(os.environ.get("DINA_TIMEOUT") or saved.get("timeout") or 30.0)
    device_name = saved.get("device_name") or ""

    # Ed25519 keypair is required — nudge users to run configure.
    if not (IDENTITY_DIR / "ed25519_private.pem").exists():
        raise click.UsageError(
            "No Ed25519 keypair found. Run 'dina configure' to generate one."
        )

    return Config(
        core_url=core_url,
        persona=persona,
        timeout=timeout,
        device_name=device_name,
    )
