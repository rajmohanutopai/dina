"""Tests for brain configuration — env var parsing, defaults, validation.

Maps to Brain TEST_PLAN §9 (Configuration).
"""

from __future__ import annotations

import pytest

from .factories import TEST_CLIENT_TOKEN
from src.infra.config import load_brain_config


# All env vars that load_brain_config reads.  Every test clears them first
# so the results are deterministic regardless of the host environment.
_ALL_CONFIG_ENVS = (
    "DINA_CORE_URL",
    "DINA_SERVICE_KEY_DIR",
    "DINA_CLIENT_TOKEN",
    "DINA_CLIENT_TOKEN_FILE",
    "DINA_BRAIN_PORT",
    "DINA_LOG_LEVEL",
    "DINA_LLM_URL",
    "DINA_CLOUD_LLM",
)


def _clear_config_env(monkeypatch):
    """Remove every config-related env var so tests start from a clean slate."""
    for var in _ALL_CONFIG_ENVS:
        monkeypatch.delenv(var, raising=False)


# ---------------------------------------------------------------------------
# §9.1 CORE_URL from Environment (2 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-289
def test_config_9_1_1_core_url_from_env(monkeypatch) -> None:
    """§9.1.1: CORE_URL is read from the DINA_CORE_URL environment variable."""
    _clear_config_env(monkeypatch)
    monkeypatch.setenv("DINA_CORE_URL", "http://core:9300")

    cfg = load_brain_config()

    assert cfg.core_url == "http://core:9300"


# TST-BRAIN-376
# TST-BRAIN-487 Default core URL is http://core:8100
def test_config_9_1_2_core_url_default(monkeypatch) -> None:
    """§9.1.2: CORE_URL defaults to http://core:8100 when not set."""
    _clear_config_env(monkeypatch)

    cfg = load_brain_config()

    assert cfg.core_url == "http://core:8100"


# ---------------------------------------------------------------------------
# §9.2 SERVICE_KEY_DIR from Environment (2 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-377
def test_config_9_2_1_service_key_dir_from_env(monkeypatch) -> None:
    """§9.2.1: SERVICE_KEY_DIR is read from DINA_SERVICE_KEY_DIR environment variable."""
    _clear_config_env(monkeypatch)
    monkeypatch.setenv("DINA_SERVICE_KEY_DIR", "/custom/service/keys")

    cfg = load_brain_config()

    assert cfg.service_key_dir == "/custom/service/keys"


# TST-BRAIN-293
def test_config_9_2_2_service_key_dir_default(monkeypatch) -> None:
    """§9.2.2: SERVICE_KEY_DIR defaults to /run/secrets/service_keys."""
    _clear_config_env(monkeypatch)

    cfg = load_brain_config()

    assert cfg.service_key_dir == "/run/secrets/service_keys"


# ---------------------------------------------------------------------------
# §9.3 Defaults (2 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-378
def test_config_9_3_1_listen_port_default(monkeypatch) -> None:
    """§9.3.1: LISTEN_PORT defaults to 8200."""
    _clear_config_env(monkeypatch)

    cfg = load_brain_config()

    assert cfg.listen_port == 8200


# TST-BRAIN-379
def test_config_9_3_2_log_level_default(monkeypatch) -> None:
    """§9.3.2: LOG_LEVEL defaults to INFO."""
    _clear_config_env(monkeypatch)

    cfg = load_brain_config()

    assert cfg.log_level == "INFO"


# ---------------------------------------------------------------------------
# §9.4 Validation (2 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-380
def test_config_9_4_1_client_token_from_env(monkeypatch) -> None:
    """§9.4.1: CLIENT_TOKEN is read from DINA_CLIENT_TOKEN env var."""
    _clear_config_env(monkeypatch)
    monkeypatch.setenv("DINA_CLIENT_TOKEN", TEST_CLIENT_TOKEN)

    cfg = load_brain_config()
    assert cfg.client_token == TEST_CLIENT_TOKEN


# TST-BRAIN-294
def test_config_9_4_2_invalid_core_url_raises(monkeypatch) -> None:
    """§9.4.2: Invalid CORE_URL (not a valid URL) fails validation."""
    _clear_config_env(monkeypatch)
    monkeypatch.setenv("DINA_CORE_URL", "not-a-url")

    with pytest.raises(ValueError, match="CORE_URL"):
        load_brain_config()


# ---------------------------------------------------------------------------
# New tests for uncovered plan scenarios
# ---------------------------------------------------------------------------


# TST-BRAIN-290
def test_config_9_llm_url_from_env(monkeypatch) -> None:
    """§9 row 2: LLM_URL is read from the DINA_LLM_URL environment variable."""
    _clear_config_env(monkeypatch)
    monkeypatch.setenv("DINA_LLM_URL", "http://llm:8080")

    cfg = load_brain_config()

    assert cfg.llm_url == "http://llm:8080"


# TST-BRAIN-291
def test_config_9_missing_core_url_uses_default(monkeypatch) -> None:
    """§9 row 3: Missing CORE_URL uses default http://core:8100."""
    _clear_config_env(monkeypatch)

    cfg = load_brain_config()

    assert cfg.core_url == "http://core:8100"


# TST-BRAIN-292
def test_config_9_missing_llm_url_graceful(monkeypatch) -> None:
    """§9 row 4: Brain starts but LLM routing disabled when LLM_URL is not set."""
    _clear_config_env(monkeypatch)

    cfg = load_brain_config()

    assert cfg.llm_url is None
    assert cfg.llm_routing_enabled is False
