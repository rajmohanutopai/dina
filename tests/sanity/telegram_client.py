"""Telethon-based Telegram client for sanity tests.

Sends messages AS the user to bots and reads bot responses.
Session must be created first (one-time interactive login).
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

from telethon import TelegramClient


SESSION_PATH = str(Path(__file__).parent / "sanity_session")


class SanityTelegramClient:
    """Sends messages to Telegram bots and reads responses."""

    def __init__(self, api_id: int, api_hash: str):
        self._api_id = api_id
        self._api_hash = api_hash
        self._client: TelegramClient | None = None
        self._loop = asyncio.new_event_loop()

    def start(self) -> None:
        async def _start():
            client = TelegramClient(SESSION_PATH, self._api_id, self._api_hash)
            await client.connect()
            if not await client.is_user_authorized():
                raise RuntimeError(
                    "Telethon session not authorized. Run: python tests/sanity/create_session.py"
                )
            self._client = client
            me = await client.get_me()
            print(f"  Telegram: logged in as {me.first_name} (ID: {me.id})")

        self._loop.run_until_complete(_start())

    def stop(self) -> None:
        if self._client:
            coro = self._client.disconnect()
            if coro is not None:
                self._loop.run_until_complete(coro)

    def send_and_wait(
        self, bot_username: str, text: str, timeout: int = 30
    ) -> str | None:
        """Send a message to a bot and wait for the bot's response.

        Returns the bot's response text, or None on timeout.
        """
        return self._loop.run_until_complete(
            self._send_and_wait_async(bot_username, text, timeout)
        )

    async def _send_and_wait_async(
        self, bot_username: str, text: str, timeout: int
    ) -> str | None:
        entity = await self._client.get_entity(bot_username)

        # Send the message and record its ID
        sent = await self._client.send_message(entity, text)
        sent_id = sent.id

        # Wait for the bot's response. We want the latest bot message
        # (highest ID > sent_id). On each poll, if we find new messages
        # we do one extra poll to make sure we got the actual response
        # and not just a reminder notification that arrived first.
        deadline = time.time() + timeout
        last_best_id = 0
        while time.time() < deadline:
            await asyncio.sleep(3)
            messages = await self._client.get_messages(entity, limit=10)
            best = None
            for msg in messages:
                if msg.out:
                    continue
                if msg.id <= sent_id:
                    continue
                if msg.text and (best is None or msg.id > best.id):
                    best = msg
            if best is not None:
                if best.id == last_best_id:
                    # Same message as last poll — response has settled
                    return best.text
                # New message appeared — do one more poll to let
                # the actual command response arrive
                last_best_id = best.id

        # Return whatever we have (may be None)
        if last_best_id:
            messages = await self._client.get_messages(entity, limit=10)
            for msg in messages:
                if not msg.out and msg.id == last_best_id and msg.text:
                    return msg.text
        return None

    def send_and_click(
        self, bot_username: str, text: str, button_text: str, timeout: int = 30
    ) -> str | None:
        """Send a message, wait for inline buttons, click one, wait for result.

        Returns the bot's response after clicking the button.
        """
        return self._loop.run_until_complete(
            self._send_and_click_async(bot_username, text, button_text, timeout)
        )

    async def _send_and_click_async(
        self, bot_username: str, text: str, button_text: str, timeout: int
    ) -> str | None:
        entity = await self._client.get_entity(bot_username)
        sent = await self._client.send_message(entity, text)
        sent_id = sent.id

        # Phase 1: wait for bot message with inline buttons
        deadline = time.time() + timeout
        button_msg = None
        while time.time() < deadline:
            await asyncio.sleep(2)
            messages = await self._client.get_messages(entity, limit=5)
            for msg in messages:
                if msg.out or msg.id <= sent_id:
                    continue
                if msg.buttons:
                    button_msg = msg
                    break
            if button_msg:
                break

        if not button_msg:
            return None

        # Phase 2: click the button
        clicked = False
        for row in button_msg.buttons:
            for btn in row:
                if btn.text and button_text.lower() in btn.text.lower():
                    await button_msg.click(data=btn.data)
                    clicked = True
                    break
            if clicked:
                break

        if not clicked:
            return f"Button '{button_text}' not found"

        # Phase 3: wait for the edited/new message after click
        click_time = time.time()
        after_click_id = button_msg.id
        deadline = time.time() + timeout
        last_text = None
        while time.time() < deadline:
            await asyncio.sleep(2)
            # Check if the button message was edited (common pattern)
            messages = await self._client.get_messages(entity, limit=5)
            for msg in messages:
                if msg.out:
                    continue
                if msg.id == button_msg.id:
                    # Message was edited after click
                    if msg.text != button_msg.text:
                        return msg.text
                if msg.id > after_click_id and msg.text:
                    # New message after click
                    return msg.text
            # Also check if edit_date changed
            fresh = await self._client.get_messages(entity, ids=button_msg.id)
            if fresh and fresh.text != button_msg.text:
                return fresh.text

        return last_text

    def get_last_bot_message(self, bot_username: str) -> str | None:
        """Get the most recent message FROM the bot (not from us)."""
        return self._loop.run_until_complete(
            self._get_last_async(bot_username)
        )

    async def _get_last_async(self, bot_username: str) -> str | None:
        entity = await self._client.get_entity(bot_username)
        messages = await self._client.get_messages(entity, limit=5)
        for msg in messages:
            if not msg.out and msg.text:
                return msg.text
        return None
