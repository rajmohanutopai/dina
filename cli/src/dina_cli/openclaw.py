"""OpenClaw Gateway WebSocket RPC client.

Implements the Gateway WS RPC protocol:

- Framing: ``{type: "req"|"res"|"event", ...}``
- Responses: ``{type: "res", id, ok: bool, payload: {...}}``
- Events: ``{type: "event", event: "name", payload: {...}}``
- Connect: auth{token}, client metadata, scopes, device identity
  with optional Ed25519 challenge signing
- Agent: ``{method: "agent", params: {task, skills, idempotencyKey}}``
- Wait: ``{method: "agent.wait", params: {runId}}``

NOTE: The exact connect handshake schema (protocol version, scope
names, device fields) is provisional and must be validated against
a live Gateway.  The framing and lifecycle (challenge → connect →
agent → agent.wait → terminal) follow the documented protocol.

Sources: Gateway Protocol (docs.openclaw.ai/gateway/protocol),
Gateway Runbook (docs.openclaw.ai/gateway/index).
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from typing import Any

from websockets.sync.client import connect as ws_connect
from websockets.exceptions import (
    ConnectionClosed,
    InvalidHandshake,
    InvalidURI,
)


class OpenClawError(Exception):
    """Raised when an OpenClaw Gateway call fails."""


# Gateway protocol constants.
# These are provisional — update when testing against a real Gateway.
# The official docs reference protocol version 3 and operator-style
# scopes, but the exact handshake schema may vary by Gateway release.
_MIN_PROTOCOL = 1
_MAX_PROTOCOL = 3


class OpenClawClient:
    """WebSocket RPC client for the local OpenClaw Gateway.

    Parameters
    ----------
    base_url:
        Gateway base URL.  HTTP URLs are converted to WS automatically.
    token:
        Gateway auth token (required even for loopback).
    device_id:
        Paired device DID (e.g., ``did:key:z6MkXyz...``).  Used as the
        device identity in the connect handshake.
    device_name:
        Human-readable device name.
    sign_fn:
        Optional signing function for challenge signing.  Receives
        ``(challenge_bytes: bytes) -> bytes`` and returns the Ed25519
        signature.  When provided, the connect handshake includes a
        signed device identity bound to the challenge nonce.
    timeout:
        WebSocket operation timeout in seconds (default 300s).
    """

    def __init__(
        self,
        base_url: str,
        token: str = "",
        device_id: str = "",
        device_name: str = "dina-cli",
        sign_fn: Any = None,
        timeout: float = 300.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._device_id = device_id
        self._device_name = device_name
        self._sign_fn = sign_fn
        self._timeout = timeout
        self._req_counter = 0

    def _ws_url(self) -> str:
        """Convert base URL to a WebSocket URL."""
        url = self._base_url
        if url.startswith("http://"):
            url = "ws://" + url[7:]
        elif url.startswith("https://"):
            url = "wss://" + url[8:]
        elif not url.startswith(("ws://", "wss://")):
            url = "ws://" + url
        if not url.endswith("/ws"):
            url = url.rstrip("/") + "/ws"
        return url

    def _next_id(self) -> str:
        self._req_counter += 1
        return str(self._req_counter)

    def _send_req(self, ws: Any, method: str, params: dict | None = None) -> dict:
        """Send a typed request and wait for the matching response.

        Response framing: ``{type: "res", id, ok: bool, payload: {...}}``
        """
        req_id = self._next_id()
        frame: dict[str, Any] = {"type": "req", "id": req_id, "method": method}
        if params:
            frame["params"] = params
        ws.send(json.dumps(frame))

        while True:
            raw = ws.recv(timeout=self._timeout)
            msg = json.loads(raw)
            if msg.get("type") == "res" and msg.get("id") == req_id:
                if not msg.get("ok", True):
                    error = msg.get("payload", {}).get("error", msg.get("error", "unknown"))
                    raise OpenClawError(f"Gateway RPC error on '{method}': {error}")
                return msg.get("payload", {})

    def _recv_event(self, ws: Any, expected_event: str, timeout: float = 10) -> dict:
        """Wait for a specific event frame.

        Event framing: ``{type: "event", event: "name", payload: {...}}``
        """
        raw = ws.recv(timeout=timeout)
        msg = json.loads(raw)
        if msg.get("type") != "event" or msg.get("event") != expected_event:
            raise OpenClawError(
                f"Expected event '{expected_event}', got: "
                f"type={msg.get('type')}, event={msg.get('event')}"
            )
        return msg.get("payload", {})

    def _connect_params(self, challenge_payload: dict) -> dict:
        """Build the connect request params per official Gateway protocol.

        Includes: auth, client metadata, scopes, protocol version range,
        and device identity with optional challenge signing.
        """
        nonce = challenge_payload.get("nonce", "")
        now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        # Device identity block.
        device: dict[str, Any] = {
            "id": self._device_id or self._device_name,
            "name": self._device_name,
            "type": "cli",
        }

        # Sign the challenge if a signing function is available.
        if self._sign_fn and nonce:
            sig_input = f"{nonce}:{self._device_id}:{now_iso}".encode()
            signature = self._sign_fn(sig_input)
            device["publicKey"] = self._device_id
            device["signature"] = signature.hex() if isinstance(signature, bytes) else signature
            device["signedAt"] = now_iso
            device["nonce"] = nonce

        return {
            "minProtocol": _MIN_PROTOCOL,
            "maxProtocol": _MAX_PROTOCOL,
            "auth": {
                "token": self._token,
            },
            "client": {
                "name": "dina-cli",
                "version": "0.4.0",
            },
            "scopes": ["agent", "tools"],
            "device": device,
        }

    def health(self) -> bool:
        """Check if the Gateway is reachable via WS connect handshake."""
        try:
            ws_url = self._ws_url()
            with ws_connect(ws_url, open_timeout=5) as ws:
                challenge = self._recv_event(ws, "connect.challenge", timeout=5)
                self._send_req(ws, "connect", self._connect_params(challenge))
                resp = self._send_req(ws, "health")
                return resp.get("status") == "ok"
        except (ConnectionClosed, InvalidHandshake, InvalidURI,
                OSError, TimeoutError, OpenClawError):
            return False

    def run_task(
        self,
        task: str,
        dina_session: str = "",
        dina_skill: str = "dina",
        idempotency_key: str = "",
    ) -> dict:
        """Start an autonomous agent run via the Gateway WS protocol.

        Returns the agent's final result from the terminal event.
        """
        if not idempotency_key:
            idempotency_key = str(uuid.uuid4())

        ws_url = self._ws_url()

        try:
            with ws_connect(ws_url, open_timeout=10, close_timeout=5) as ws:
                # 1. Receive connect.challenge event.
                challenge = self._recv_event(ws, "connect.challenge", timeout=10)

                # 2. Send connect request with full protocol fields.
                self._send_req(ws, "connect", self._connect_params(challenge))

                # 3. Call agent with task details.
                agent_params: dict[str, Any] = {
                    "task": task,
                    "idempotencyKey": idempotency_key,
                }
                if dina_skill:
                    agent_params["skills"] = [dina_skill]
                if dina_session:
                    agent_params["context"] = {"dina_session": dina_session}

                agent_resp = self._send_req(ws, "agent", agent_params)
                run_id = agent_resp.get("runId", "")

                # 4. Send agent.wait request.
                wait_id = self._next_id()
                ws.send(json.dumps({
                    "type": "req",
                    "id": wait_id,
                    "method": "agent.wait",
                    "params": {"runId": run_id} if run_id else {},
                }))

                # 5. Stream events until terminal.
                terminal_statuses = {"completed", "failed", "cancelled"}
                while True:
                    raw = ws.recv(timeout=self._timeout)
                    msg = json.loads(raw)

                    if msg.get("type") == "res" and msg.get("id") == wait_id:
                        payload = msg.get("payload", {})
                        if not msg.get("ok", True):
                            raise OpenClawError(
                                f"agent.wait error: {payload.get('error', 'unknown')}"
                            )
                        return payload

                    if msg.get("type") == "event":
                        payload = msg.get("payload", {})
                        status = payload.get("status", "")
                        if status in terminal_statuses:
                            if status == "completed":
                                return payload.get("result", payload)
                            raise OpenClawError(
                                f"Agent run {status}: "
                                f"{payload.get('error', payload.get('reason', 'unknown'))}"
                            )

        except (InvalidHandshake, InvalidURI) as exc:
            raise OpenClawError(
                f"OpenClaw Gateway connection failed at {ws_url}: {exc}"
            ) from exc
        except ConnectionClosed as exc:
            raise OpenClawError(
                f"OpenClaw Gateway connection closed unexpectedly: {exc}"
            ) from exc
        except TimeoutError as exc:
            raise OpenClawError(
                f"OpenClaw task timed out after {self._timeout}s"
            ) from exc
        except OSError as exc:
            raise OpenClawError(
                f"OpenClaw Gateway unreachable at {ws_url}: {exc}"
            ) from exc

    def close(self) -> None:
        """No persistent state to close for WS client."""

    def __enter__(self) -> OpenClawClient:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()
