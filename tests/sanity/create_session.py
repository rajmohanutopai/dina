#!/usr/bin/env python3
"""Create a Telethon session for sanity tests (one-time interactive login).

Run this when the session expires or doesn't exist:
    python tests/sanity/create_session.py

It will ask for your phone number and send a verification code via Telegram.
After that, the session file is saved and reused by the test suite.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from tests.sanity.telegram_client import SESSION_PATH


def _load_env() -> dict[str, str]:
    env_file = Path(__file__).parent / ".env.sanity"
    env = {}
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    return env


async def main():
    from telethon import TelegramClient

    env = _load_env()
    api_id = int(env.get("SANITY_TELEGRAM_API_ID", "0"))
    api_hash = env.get("SANITY_TELEGRAM_API_HASH", "")

    if not api_id or not api_hash:
        print("Error: Set SANITY_TELEGRAM_API_ID and SANITY_TELEGRAM_API_HASH in .env.sanity")
        sys.exit(1)

    print(f"Session path: {SESSION_PATH}.session")
    print(f"API ID: {api_id}")
    print()

    client = TelegramClient(SESSION_PATH, api_id, api_hash)
    await client.start()
    me = await client.get_me()
    print(f"\nLogged in as: {me.first_name} (ID: {me.id})")
    print("Session saved. You can now run the sanity tests.")
    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
