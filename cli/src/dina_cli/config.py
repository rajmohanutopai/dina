"""Configuration from saved file (~/.dina/cli/config.json) + env overrides."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

import click

CONFIG_DIR = Path.home() / ".dina" / "cli"
CONFIG_FILE = CONFIG_DIR / "config.json"


@dataclass(frozen=True)
class Config:
    """Immutable CLI configuration."""

    core_url: str
    brain_url: str
    client_token: str
    brain_token: str
    persona: str
    timeout: float


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
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(values, indent=2))
    os.replace(tmp, CONFIG_FILE)
    return CONFIG_FILE


def load_config() -> Config:
    """Build Config from saved file + env overrides.

    Priority: env vars override saved file values.
    Raises ``click.UsageError`` if no client_token is available from
    either source.
    """
    saved = _load_saved()

    core_url = os.environ.get("DINA_CORE_URL") or saved.get("core_url") or "http://localhost:8100"
    brain_url = os.environ.get("DINA_BRAIN_URL") or saved.get("brain_url") or "http://localhost:8200"
    client_token = os.environ.get("DINA_CLIENT_TOKEN") or saved.get("client_token") or ""
    brain_token = os.environ.get("DINA_BRAIN_TOKEN") or saved.get("brain_token") or ""
    persona = os.environ.get("DINA_PERSONA") or saved.get("persona") or "personal"
    timeout = float(os.environ.get("DINA_TIMEOUT") or saved.get("timeout") or 30.0)

    if not client_token:
        hint = "Run 'dina configure' to set up, or set DINA_CLIENT_TOKEN"
        raise click.UsageError(f"No client token configured. {hint}")

    return Config(
        core_url=core_url,
        brain_url=brain_url,
        client_token=client_token,
        brain_token=brain_token,
        persona=persona,
        timeout=timeout,
    )
