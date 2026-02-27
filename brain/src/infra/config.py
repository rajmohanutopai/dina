"""Brain configuration — environment variable parsing, defaults, validation.

Maps to Brain TEST_PLAN SS9 (Configuration) and the contract in
``brain/tests/contracts.py::BrainConfig``.

Supports Docker Secrets for ``BRAIN_TOKEN`` via
``DINA_BRAIN_TOKEN_FILE`` pointing to a file path (typically
``/run/secrets/brain_token``).
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

_DEFAULT_CORE_URL = "http://core:8100"
_DEFAULT_LISTEN_PORT = 8200
_DEFAULT_LOG_LEVEL = "INFO"

# Minimal URL pattern — must start with http:// or https://
_URL_PATTERN = re.compile(r"^https?://[^\s/$.?#].[^\s]*$", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Config dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class BrainConfig:
    """Immutable brain configuration loaded from environment variables.

    Attributes:
        core_url:            URL for dina-core (default ``http://core:8100``).
        brain_token:         BRAIN_TOKEN for authenticating with core.
        listen_port:         Port brain listens on (default ``8200``).
        log_level:           Logging level (default ``"INFO"``).
        llm_url:             URL for the LLM sidecar (optional).
        cloud_llm:           Preferred cloud LLM provider name (optional).
        llm_routing_enabled: ``True`` when ``llm_url`` is set and LLM
                             routing should be active.
    """

    core_url: str
    brain_token: str
    client_token: str | None
    listen_port: int
    log_level: str
    llm_url: str | None
    cloud_llm: str | None
    llm_routing_enabled: bool


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------


def _read_token_from_file(path: str) -> str:
    """Read the BRAIN_TOKEN from a Docker-secrets file.

    The file content is stripped of leading/trailing whitespace so that
    a trailing newline does not break constant-time comparison.
    """
    file_path = Path(path)
    if not file_path.is_file():
        raise ValueError(
            f"BRAIN_TOKEN file not found at {path} "
            "(set DINA_BRAIN_TOKEN_FILE to a valid path or provide DINA_BRAIN_TOKEN)"
        )
    return file_path.read_text().strip()


def load_brain_config() -> BrainConfig:
    """Load and validate brain configuration from environment variables.

    Environment variables:
        DINA_CORE_URL          — Core endpoint URL (default ``http://core:8100``).
        DINA_BRAIN_TOKEN       — Shared secret for core ↔ brain auth.
        DINA_BRAIN_TOKEN_FILE  — Path to a file containing the token
                                 (Docker Secrets pattern).
        DINA_BRAIN_PORT        — Brain listen port (default ``8200``).
        DINA_LOG_LEVEL         — Log level (default ``"INFO"``).
        DINA_LLM_URL           — LLM sidecar URL (optional).
        DINA_CLOUD_LLM         — Preferred cloud provider (optional).

    Raises:
        ValueError: If BRAIN_TOKEN is missing or CORE_URL is invalid.
    """
    # -- BRAIN_TOKEN (required) --
    brain_token = os.environ.get("DINA_BRAIN_TOKEN", "").strip()
    token_file = os.environ.get("DINA_BRAIN_TOKEN_FILE", "").strip()

    if not brain_token and token_file:
        brain_token = _read_token_from_file(token_file)

    if not brain_token:
        raise ValueError(
            "BRAIN_TOKEN must be set via DINA_BRAIN_TOKEN env var "
            "or DINA_BRAIN_TOKEN_FILE pointing to a Docker secret"
        )

    # -- CORE_URL (default with validation) --
    core_url = os.environ.get("DINA_CORE_URL", "").strip() or _DEFAULT_CORE_URL

    if not _URL_PATTERN.match(core_url):
        raise ValueError(
            f"CORE_URL '{core_url}' is not a valid URL "
            "(must start with http:// or https://)"
        )

    # -- LISTEN_PORT --
    port_str = os.environ.get("DINA_BRAIN_PORT", "").strip()
    listen_port = int(port_str) if port_str else _DEFAULT_LISTEN_PORT

    # -- LOG_LEVEL --
    log_level = os.environ.get("DINA_LOG_LEVEL", "").strip() or _DEFAULT_LOG_LEVEL

    # -- LLM_URL (optional) --
    llm_url = os.environ.get("DINA_LLM_URL", "").strip() or None

    # -- CLOUD_LLM (optional) --
    cloud_llm = os.environ.get("DINA_CLOUD_LLM", "").strip() or None

    # -- CLIENT_TOKEN (optional) --
    client_token = os.environ.get("DINA_CLIENT_TOKEN", "").strip() or None
    client_token_file = os.environ.get("DINA_CLIENT_TOKEN_FILE", "").strip()
    if not client_token and client_token_file:
        client_token = _read_token_from_file(client_token_file)

    # LLM routing is enabled only when a backend URL is configured
    llm_routing_enabled = llm_url is not None

    _env_mode = os.environ.get("DINA_ENV", "production").lower()
    if _env_mode == "production" and core_url.startswith("http://"):
        _is_docker = os.path.exists("/.dockerenv")
        if not _is_docker:
            log.warning(
                "config.core_url.insecure",
                extra={"detail": "Core URL uses plaintext HTTP in production outside Docker"},
            )

    return BrainConfig(
        core_url=core_url,
        brain_token=brain_token,
        client_token=client_token,
        listen_port=listen_port,
        log_level=log_level,
        llm_url=llm_url,
        cloud_llm=cloud_llm,
        llm_routing_enabled=llm_routing_enabled,
    )
