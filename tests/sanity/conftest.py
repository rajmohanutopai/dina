"""Telegram sanity test fixtures.

Provides Telethon-based client for sending messages AS the user to bots
and reading bot responses. Also provides Bot API helpers.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from .telegram_client import SanityTelegramClient

# Load .env.sanity
_ENV_FILE = Path(__file__).parent / ".env.sanity"


def _load_env() -> dict[str, str]:
    env = {}
    if _ENV_FILE.exists():
        for line in _ENV_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    return env


_ENV = _load_env()

API_ID = int(_ENV.get("SANITY_TELEGRAM_API_ID", "0"))
API_HASH = _ENV.get("SANITY_TELEGRAM_API_HASH", "")
ALONSO_TOKEN = _ENV.get("SANITY_ALONSO_TELEGRAM_TOKEN", "")
SANCHO_TOKEN = _ENV.get("SANITY_SANCHO_TELEGRAM_TOKEN", "")
ALONSO_BOT = "regression_test_dina_alonso_bot"
SANCHO_BOT = "regression_test_dina_sancho_bot"
OWNER_ID = int(_ENV.get("SANITY_OWNER_TELEGRAM_ID", "0"))


@pytest.fixture(scope="session", autouse=True)
def _cleanup_before_run(tg: SanityTelegramClient) -> None:
    """Clean stale state from prior runs before tests start."""
    import time

    # Delete stale contacts on both bots
    for bot in [ALONSO_BOT, SANCHO_BOT]:
        for contact in ["Sancho", "Alonso"]:
            r = tg.send_and_wait(bot, f"/contact delete {contact}", timeout=10)
            if r:
                print(f"  Cleanup: @{bot} /contact delete {contact} → {r[:60]}")
            time.sleep(1)

    # Small delay to let deletions settle
    time.sleep(2)


@pytest.fixture(scope="session")
def tg() -> SanityTelegramClient:
    """Telethon client logged in as the owner."""
    if not API_ID or not API_HASH:
        pytest.skip("SANITY_TELEGRAM_API_ID/HASH not set")
    client = SanityTelegramClient(API_ID, API_HASH)
    client.start()
    yield client
    client.stop()


@pytest.fixture(scope="session")
def owner_id() -> int:
    if not OWNER_ID:
        pytest.skip("SANITY_OWNER_TELEGRAM_ID not set")
    return OWNER_ID


@pytest.fixture(scope="session")
def alonso_bot_username() -> str:
    return ALONSO_BOT


@pytest.fixture(scope="session")
def sancho_bot_username() -> str:
    return SANCHO_BOT
