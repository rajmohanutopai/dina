"""Bluesky Bot adapter — polls for mentions and DMs, dispatches commands.

Connects to the Bluesky AT Protocol service (bsky.social by default),
polls for notifications (mentions) and DMs, parses them into
CommandRequests, and dispatches via CommandDispatcher.

Third-party imports: httpx (already a project dependency).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import httpx

from ..domain.request import Command, CommandRequest
from ..domain.response import BotResponse
from ..service.command_dispatcher import CommandDispatcher
from .bluesky_channel import BlueskyChannel

log = logging.getLogger(__name__)

# Polling intervals.
_MENTION_POLL_S = 30
_DM_POLL_S = 30


class BlueskyClient:
    """Low-level AT Protocol client for Bluesky API calls."""

    def __init__(self, service_url: str, handle: str, password: str) -> None:
        self._service = service_url.rstrip("/")
        self._handle = handle
        self._password = password
        self._access_jwt: str | None = None
        self._did: str | None = None
        self._session_expires: float = 0
        self._client = httpx.AsyncClient(timeout=15)
        # DM service uses a different host.
        self._dm_service = "https://api.bsky.chat"

    @property
    def did(self) -> str | None:
        return self._did

    @property
    def handle(self) -> str:
        return self._handle

    async def ensure_session(self) -> None:
        """Create or refresh auth session."""
        if self._access_jwt and time.time() < self._session_expires:
            return
        resp = await self._client.post(
            f"{self._service}/xrpc/com.atproto.server.createSession",
            json={"identifier": self._handle, "password": self._password},
        )
        resp.raise_for_status()
        data = resp.json()
        self._access_jwt = data["accessJwt"]
        self._did = data["did"]
        self._session_expires = time.time() + 3600
        log.info("bluesky.session_created", extra={"did": self._did})

    def _auth_headers(self) -> dict:
        return {"Authorization": f"Bearer {self._access_jwt}"}

    # ── Notifications (mentions) ───────────────────────────────────

    async def list_notifications(self, limit: int = 25, cursor: str = "") -> dict:
        """GET app.bsky.notification.listNotifications."""
        await self.ensure_session()
        params: dict[str, Any] = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        resp = await self._client.get(
            f"{self._service}/xrpc/app.bsky.notification.listNotifications",
            headers=self._auth_headers(),
            params=params,
        )
        resp.raise_for_status()
        return resp.json()

    async def update_seen(self, seen_at: str) -> None:
        """POST app.bsky.notification.updateSeen."""
        await self.ensure_session()
        await self._client.post(
            f"{self._service}/xrpc/app.bsky.notification.updateSeen",
            headers=self._auth_headers(),
            json={"seenAt": seen_at},
        )

    # ── Posts (replies) ────────────────────────────────────────────

    async def reply_post(self, text: str, reply_ref: dict) -> dict:
        """Create a reply post."""
        await self.ensure_session()
        record = {
            "$type": "app.bsky.feed.post",
            "text": text,
            "reply": reply_ref,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        resp = await self._client.post(
            f"{self._service}/xrpc/com.atproto.repo.createRecord",
            headers=self._auth_headers(),
            json={
                "repo": self._did,
                "collection": "app.bsky.feed.post",
                "record": record,
            },
        )
        resp.raise_for_status()
        return resp.json()

    async def get_post_thread(self, uri: str) -> dict | None:
        """GET app.bsky.feed.getPostThread — to get post details."""
        await self.ensure_session()
        try:
            resp = await self._client.get(
                f"{self._service}/xrpc/app.bsky.feed.getPostThread",
                headers=self._auth_headers(),
                params={"uri": uri, "depth": 0},
            )
            resp.raise_for_status()
            return resp.json()
        except Exception:
            return None

    # ── DMs ────────────────────────────────────────────────────────

    async def list_convos(self, limit: int = 25) -> dict:
        """GET chat.bsky.convo.listConvos."""
        await self.ensure_session()
        resp = await self._client.get(
            f"{self._dm_service}/xrpc/chat.bsky.convo.listConvos",
            headers={**self._auth_headers(), "Atproto-Proxy": f"did:web:api.bsky.chat#bsky_chat"},
            params={"limit": limit},
        )
        resp.raise_for_status()
        return resp.json()

    async def get_messages(self, convo_id: str, limit: int = 25, cursor: str = "") -> dict:
        """GET chat.bsky.convo.getMessages."""
        await self.ensure_session()
        params: dict[str, Any] = {"convoId": convo_id, "limit": limit}
        if cursor:
            params["cursor"] = cursor
        resp = await self._client.get(
            f"{self._dm_service}/xrpc/chat.bsky.convo.getMessages",
            headers={**self._auth_headers(), "Atproto-Proxy": f"did:web:api.bsky.chat#bsky_chat"},
            params=params,
        )
        resp.raise_for_status()
        return resp.json()

    async def send_dm(self, convo_id: str, text: str) -> dict:
        """POST chat.bsky.convo.sendMessage."""
        await self.ensure_session()
        resp = await self._client.post(
            f"{self._dm_service}/xrpc/chat.bsky.convo.sendMessage",
            headers={**self._auth_headers(), "Atproto-Proxy": f"did:web:api.bsky.chat#bsky_chat"},
            json={
                "convoId": convo_id,
                "message": {
                    "$type": "chat.bsky.convo.defs#messageInput",
                    "text": text,
                },
            },
        )
        resp.raise_for_status()
        return resp.json()


# ── Command Parsing ────────────────────────────────────────────────

# Command prefixes — Bluesky users type these in mentions or DMs.
_COMMAND_MAP: dict[str, Command] = {
    "/status": Command.STATUS,
    "/ask": Command.ASK,
    "/send": Command.SEND,
    "/contact": Command.CONTACT_LIST,  # default; subcommands parsed below
    "/review": Command.REVIEW,
    "/vouch": Command.VOUCH,
    "/flag": Command.FLAG,
    "/trust": Command.TRUST,
    "/remember": Command.REMEMBER,
    "/help": Command.HELP,
    "status": Command.STATUS,
    "ask": Command.ASK,
    "help": Command.HELP,
}


def parse_bluesky_command(text: str) -> CommandRequest | None:
    """Parse a mention or DM text into a CommandRequest.

    Supports both "/command args" and plain text (defaults to /ask).
    """
    text = text.strip()
    if not text:
        return None

    # Remove @mention prefix if present.
    if text.startswith("@"):
        parts = text.split(None, 1)
        text = parts[1] if len(parts) > 1 else ""
        if not text:
            return CommandRequest(command=Command.HELP, source="bluesky")

    lower = text.lower()

    # Check explicit commands.
    for prefix, cmd in _COMMAND_MAP.items():
        if lower.startswith(prefix):
            rest = text[len(prefix):].strip()
            return _parse_args(cmd, rest)

    # Contact subcommands.
    if lower.startswith("/contact ") or lower.startswith("contact "):
        rest = text.split(None, 1)[1] if " " in text else ""
        return _parse_contact_args(rest)

    # Default: treat as /ask.
    return CommandRequest(
        command=Command.ASK,
        args={"prompt": text},
        source="bluesky",
    )


def _parse_args(cmd: Command, rest: str) -> CommandRequest:
    """Parse command-specific arguments."""
    args: dict[str, str] = {}

    if cmd == Command.ASK:
        args["prompt"] = rest
    elif cmd == Command.REMEMBER:
        args["text"] = rest
    elif cmd == Command.SEND:
        if ":" in rest:
            contact, msg = rest.split(":", 1)
            args["contact"] = contact.strip()
            args["message"] = msg.strip()
    elif cmd in (Command.VOUCH, Command.FLAG):
        if ":" in rest:
            target, reason = rest.split(":", 1)
            args["name" if cmd == Command.VOUCH else "target"] = target.strip()
            args["reason"] = reason.strip()
    elif cmd == Command.REVIEW:
        if ":" in rest:
            product, review_text = rest.split(":", 1)
            args["product"] = product.strip()
            args["text"] = review_text.strip()
    elif cmd == Command.TRUST:
        args["target"] = rest
    elif cmd == Command.CONTACT_LIST:
        return _parse_contact_args(rest)

    return CommandRequest(command=cmd, args=args, source="bluesky", raw_text=rest)


def _parse_contact_args(rest: str) -> CommandRequest:
    """Parse /contact subcommands."""
    lower = rest.lower().strip()
    if lower.startswith("add "):
        parts = rest[4:].strip()
        if ":" in parts:
            name, did = parts.split(":", 1)
            return CommandRequest(
                command=Command.CONTACT_ADD,
                args={"name": name.strip(), "did": did.strip()},
                source="bluesky",
            )
    elif lower.startswith("delete ") or lower.startswith("remove "):
        name = rest.split(None, 1)[1] if " " in rest else ""
        return CommandRequest(
            command=Command.CONTACT_DELETE,
            args={"name": name.strip()},
            source="bluesky",
        )
    elif lower == "cleanup":
        return CommandRequest(command=Command.CONTACT_CLEANUP, source="bluesky")

    return CommandRequest(command=Command.CONTACT_LIST, source="bluesky")


# ── Bot Adapter ────────────────────────────────────────────────────

class BlueskyBotAdapter:
    """Polls Bluesky DMs from the owner, dispatches via CommandDispatcher.

    DM-only, owner-only. Public mentions are ignored — Dina is a
    private assistant, not a public bot. Same model as Telegram's
    allowed_user_ids.

    Parameters
    ----------
    client:
        Authenticated BlueskyClient.
    dispatcher:
        CommandDispatcher for routing commands.
    owner_did:
        DID of the owner. Only DMs from this DID are processed.
        If empty, DMs from any user are processed (not recommended).
    """

    def __init__(self, client: BlueskyClient, dispatcher: CommandDispatcher, owner_did: str = "") -> None:
        self._client = client
        self._dispatcher = dispatcher
        self._owner_did = owner_did
        self._last_seen_dm: dict[str, str] = {}  # convo_id → last message ID
        self._running = False
        self._tasks: list[asyncio.Task] = []

    async def start(self) -> None:
        """Start polling for DMs."""
        try:
            await self._client.ensure_session()
            log.info("bluesky.adapter.started", extra={
                "handle": self._client.handle,
                "did": self._client.did,
                "owner_did": self._owner_did or "(any)",
            })
            self._running = True
            self._tasks = [
                asyncio.create_task(self._poll_dms()),
            ]
        except Exception as exc:
            log.error("bluesky.adapter.start_failed", extra={"error": str(exc)})
            raise

    async def stop(self) -> None:
        """Stop polling."""
        self._running = False
        for task in self._tasks:
            task.cancel()
        log.info("bluesky.adapter.stopped")

    # ── Proactive DM to owner ────────────────────────────────────

    async def send_owner_dm(self, text: str) -> None:
        """Send a DM to the owner (for push notifications).

        Finds or creates the DM conversation with the owner DID.
        """
        if not self._owner_did:
            log.warning("bluesky.send_owner_dm.no_owner_did")
            return
        try:
            await self._client.ensure_session()
            # Find existing conversation with owner.
            convos = (await self._client.list_convos(limit=50)).get("convos", [])
            convo_id = None
            for c in convos:
                members = c.get("members", [])
                member_dids = [m.get("did", "") for m in members]
                if self._owner_did in member_dids:
                    convo_id = c.get("id")
                    break

            if not convo_id:
                # Create new conversation with owner.
                resp = await self._client._client.get(
                    f"{self._client._dm_service}/xrpc/chat.bsky.convo.getConvoForMembers",
                    headers={
                        **self._client._auth_headers(),
                        "Atproto-Proxy": "did:web:api.bsky.chat#bsky_chat",
                    },
                    params={"members": [self._owner_did]},
                )
                resp.raise_for_status()
                convo_id = resp.json().get("convo", {}).get("id")

            if convo_id:
                await self._client.send_dm(convo_id, text)
                log.info("bluesky.owner_dm_sent")
            else:
                log.warning("bluesky.send_owner_dm.no_convo")
        except Exception as exc:
            log.warning("bluesky.send_owner_dm.failed", extra={"error": str(exc)})

    # ── DM polling ─────────────────────────────────────────────────

    async def _poll_dms(self) -> None:
        """Poll for new DM messages."""
        while self._running:
            try:
                data = await self._client.list_convos(limit=25)
                convos = data.get("convos", [])

                for convo in convos:
                    convo_id = convo.get("id", "")
                    last_msg = convo.get("lastMessage", {})
                    last_msg_id = last_msg.get("id", "")

                    # Skip if we've already seen this message.
                    if last_msg_id == self._last_seen_dm.get(convo_id):
                        continue

                    # Skip our own messages.
                    sender_did = last_msg.get("sender", {}).get("did", "")
                    if sender_did == self._client.did:
                        self._last_seen_dm[convo_id] = last_msg_id
                        continue

                    # Owner filter — only process DMs from the owner.
                    if self._owner_did and sender_did != self._owner_did:
                        self._last_seen_dm[convo_id] = last_msg_id
                        log.debug("bluesky.dm_ignored", extra={"sender": sender_did[:30], "reason": "not owner"})
                        continue

                    # Skip non-text messages.
                    text = last_msg.get("text", "")
                    if not text:
                        self._last_seen_dm[convo_id] = last_msg_id
                        continue

                    await self._handle_dm(convo_id, text, sender_did, last_msg_id)
                    self._last_seen_dm[convo_id] = last_msg_id

            except Exception as exc:
                log.warning("bluesky.dm_poll_error", extra={"error": str(exc)})

            await asyncio.sleep(_DM_POLL_S)

    async def _handle_dm(self, convo_id: str, text: str, sender_did: str, msg_id: str) -> None:
        """Process a single DM message."""
        from ..infra.logging import bind_request_id
        rid = bind_request_id()

        log.info("bluesky.dm", extra={
            "sender": sender_did[:30], "text": text[:80], "req_id": rid,
        })

        # Parse command (DMs don't have @mention prefix).
        request = parse_bluesky_command(text)
        if not request:
            return
        request.user_id = sender_did
        request.args["req_id"] = rid

        # Handle confirmation replies (YES/NO for pending trust).
        lower = text.strip().lower()
        if lower == "publish" and self._dispatcher._pending_trust:
            response = await self._dispatcher.handle_trust_confirm(True)
        elif lower == "cancel" and self._dispatcher._pending_trust:
            response = await self._dispatcher.handle_trust_confirm(False)
        else:
            response = await self._dispatcher.dispatch(request)

        # Send response via BlueskyChannel DM.
        channel = BlueskyChannel(
            client=self._client,
            convo_id=convo_id,
            req_id=rid,
        )
        await channel.send(response)
