"""Tests for brain configuration — env var parsing, defaults, validation.

Maps to Brain TEST_PLAN §9 (Configuration).
"""

from __future__ import annotations

import os

import pytest

from .factories import TEST_BRAIN_TOKEN, make_brain_config


# ---------------------------------------------------------------------------
# §9.1 CORE_URL from Environment (2 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-289
def test_config_9_1_1_core_url_from_env(monkeypatch, brain_config) -> None:
    """§9.1.1: CORE_URL is read from the DINA_CORE_URL environment variable."""
    pytest.skip("BrainConfig loader not yet implemented")
    # monkeypatch.setenv("DINA_CORE_URL", "http://core:9300")
    # cfg = load_brain_config()
    # assert cfg["CORE_URL"] == "http://core:9300"


# TST-BRAIN-376
def test_config_9_1_2_core_url_default(monkeypatch, brain_config) -> None:
    """§9.1.2: CORE_URL defaults to http://core:8300 when not set."""
    pytest.skip("BrainConfig loader not yet implemented")
    # monkeypatch.delenv("DINA_CORE_URL", raising=False)
    # cfg = load_brain_config()
    # assert cfg["CORE_URL"] == "http://core:8300"


# ---------------------------------------------------------------------------
# §9.2 BRAIN_TOKEN from Environment (2 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-377
def test_config_9_2_1_brain_token_from_env(monkeypatch, brain_config) -> None:
    """§9.2.1: BRAIN_TOKEN is read from the DINA_BRAIN_TOKEN environment variable."""
    pytest.skip("BrainConfig loader not yet implemented")
    # monkeypatch.setenv("DINA_BRAIN_TOKEN", TEST_BRAIN_TOKEN)
    # cfg = load_brain_config()
    # assert cfg["BRAIN_TOKEN"] == TEST_BRAIN_TOKEN


# TST-BRAIN-293
def test_config_9_2_2_brain_token_from_docker_secret(monkeypatch, tmp_path, brain_config) -> None:
    """§9.2.2: BRAIN_TOKEN loaded from /run/secrets/brain_token file."""
    pytest.skip("BrainConfig loader not yet implemented")
    # secret_file = tmp_path / "brain_token"
    # secret_file.write_text(TEST_BRAIN_TOKEN)
    # monkeypatch.setenv("DINA_BRAIN_TOKEN_FILE", str(secret_file))
    # cfg = load_brain_config()
    # assert cfg["BRAIN_TOKEN"] == TEST_BRAIN_TOKEN


# ---------------------------------------------------------------------------
# §9.3 Defaults (2 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-378
def test_config_9_3_1_listen_port_default(monkeypatch, brain_config) -> None:
    """§9.3.1: LISTEN_PORT defaults to 8200."""
    pytest.skip("BrainConfig loader not yet implemented")
    # monkeypatch.delenv("DINA_BRAIN_PORT", raising=False)
    # cfg = load_brain_config()
    # assert cfg["LISTEN_PORT"] == 8200


# TST-BRAIN-379
def test_config_9_3_2_log_level_default(monkeypatch, brain_config) -> None:
    """§9.3.2: LOG_LEVEL defaults to INFO."""
    pytest.skip("BrainConfig loader not yet implemented")
    # monkeypatch.delenv("DINA_LOG_LEVEL", raising=False)
    # cfg = load_brain_config()
    # assert cfg["LOG_LEVEL"] == "INFO"


# ---------------------------------------------------------------------------
# §9.4 Validation (2 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-380
def test_config_9_4_1_missing_brain_token_raises(monkeypatch) -> None:
    """§9.4.1: Startup fails if BRAIN_TOKEN is missing and no secret file exists."""
    pytest.skip("BrainConfig loader not yet implemented")
    # monkeypatch.delenv("DINA_BRAIN_TOKEN", raising=False)
    # monkeypatch.delenv("DINA_BRAIN_TOKEN_FILE", raising=False)
    # with pytest.raises(ValueError, match="BRAIN_TOKEN"):
    #     load_brain_config()


# TST-BRAIN-294
def test_config_9_4_2_invalid_core_url_raises(monkeypatch) -> None:
    """§9.4.2: Invalid CORE_URL (not a valid URL) fails validation."""
    pytest.skip("BrainConfig loader not yet implemented")
    # monkeypatch.setenv("DINA_BRAIN_TOKEN", TEST_BRAIN_TOKEN)
    # monkeypatch.setenv("DINA_CORE_URL", "not-a-url")
    # with pytest.raises(ValueError, match="CORE_URL"):
    #     load_brain_config()


# ---------------------------------------------------------------------------
# New tests for uncovered plan scenarios
# ---------------------------------------------------------------------------


# TST-BRAIN-290
def test_config_9_llm_url_from_env(monkeypatch) -> None:
    """§9 row 2: LLM_URL is read from the DINA_LLM_URL environment variable."""
    pytest.skip("BrainConfig loader not yet implemented")
    # monkeypatch.setenv("DINA_LLM_URL", "http://llm:8080")
    # cfg = load_brain_config()
    # assert cfg["LLM_URL"] == "http://llm:8080"


# TST-BRAIN-291
def test_config_9_missing_core_url_uses_default(monkeypatch) -> None:
    """§9 row 3: Missing CORE_URL uses default http://core:8300."""
    pytest.skip("BrainConfig loader not yet implemented")
    # monkeypatch.delenv("DINA_CORE_URL", raising=False)
    # cfg = load_brain_config()
    # assert cfg["CORE_URL"] == "http://core:8300"


# TST-BRAIN-292
def test_config_9_missing_llm_url_graceful(monkeypatch) -> None:
    """§9 row 4: Brain starts but LLM routing disabled when LLM_URL is not set."""
    pytest.skip("BrainConfig loader not yet implemented")
    # monkeypatch.delenv("DINA_LLM_URL", raising=False)
    # cfg = load_brain_config()
    # assert cfg.get("LLM_URL") is None
    # assert cfg["llm_routing_enabled"] is False
