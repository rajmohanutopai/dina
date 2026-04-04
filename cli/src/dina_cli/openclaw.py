"""OpenClaw Gateway WebSocket RPC client.

Implements the current Gateway WS handshake:
- receive ``connect.challenge``
- send ``connect`` with role/scopes/auth/device identity
- persist ``hello-ok.auth.deviceToken`` when issued
- call ``agent`` then ``agent.wait`` until terminal result
"""

from __future__ import annotations

import base64
import json
import time
import uuid
from importlib.metadata import PackageNotFoundError, version as pkg_version
from typing import Any, Callable
from urllib.parse import urlparse

from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidURI
from websockets.sync.client import connect as ws_connect


class OpenClawError(Exception):
    """Raised when an OpenClaw Gateway call fails."""


class OpenClawRPCError(OpenClawError):
    """Raised when a Gateway RPC request returns an error payload."""

    def __init__(self, method: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(f"Gateway RPC error on '{method}': {message}")
        self.method = method
        self.details = details or {}


_PROTOCOL_VERSION = 3
_ROLE = "operator"
_SCOPES = ["operator.admin"]
_CLIENT_ID = "cli"
_CLIENT_MODE = "backend"
_DEVICE_FAMILY = "cli"
_PLATFORM = "python"


def _client_version() -> str:
    try:
        return pkg_version("dina-agent")
    except PackageNotFoundError:
        return "0.0.0"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _normalize_metadata(value: str) -> str:
    return value.strip().lower() if value else ""


def _build_device_auth_payload_v3(
    *,
    device_id: str,
    client_id: str,
    client_mode: str,
    role: str,
    scopes: list[str],
    signed_at_ms: int,
    token: str,
    nonce: str,
    platform: str,
    device_family: str,
) -> str:
    return "|".join(
        [
            "v3",
            device_id,
            client_id,
            client_mode,
            role,
            ",".join(scopes),
            str(signed_at_ms),
            token,
            nonce,
            _normalize_metadata(platform),
            _normalize_metadata(device_family),
        ]
    )


class OpenClawClient:
    """WebSocket RPC client for an OpenClaw Gateway.

    ``token`` is the shared gateway token. ``device_token`` is the cached
    per-device token returned by a prior successful handshake.
    """

    def __init__(
        self,
        base_url: str,
        token: str = "",
        device_id: str = "",
        device_public_key: str = "",
        device_name: str = "dina-cli",
        sign_fn: Callable[[bytes], bytes] | None = None,
        timeout: float = 300.0,
        device_token: str = "",
        save_device_token: Callable[[str], None] | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token.strip()
        self._device_id = device_id.strip()
        self._device_public_key = device_public_key.strip()
        self._device_name = device_name.strip() or "dina-cli"
        self._sign_fn = sign_fn
        self._timeout = timeout
        self._req_counter = 0
        self._device_token = device_token.strip()
        self._save_device_token = save_device_token
        self._client_version = _client_version()

    def _ws_url(self) -> str:
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
        req_id = self._next_id()
        frame: dict[str, Any] = {"type": "req", "id": req_id, "method": method}
        if params:
            frame["params"] = params
        ws.send(json.dumps(frame))

        while True:
            raw = ws.recv(timeout=self._timeout)
            msg = json.loads(raw)
            if msg.get("type") != "res" or msg.get("id") != req_id:
                continue
            if msg.get("ok", True):
                return msg.get("payload", {})

            error_obj = msg.get("error")
            payload = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}
            if isinstance(error_obj, dict):
                message = error_obj.get("message", "unknown")
                details = error_obj.get("details") if isinstance(error_obj.get("details"), dict) else {}
            else:
                message = payload.get("error", error_obj or "unknown")
                details = payload.get("details") if isinstance(payload.get("details"), dict) else {}
            raise OpenClawRPCError(method, str(message), details)

    def _recv_event(self, ws: Any, expected_event: str, timeout: float = 10) -> dict:
        raw = ws.recv(timeout=timeout)
        msg = json.loads(raw)
        if msg.get("type") != "event" or msg.get("event") != expected_event:
            raise OpenClawError(
                f"Expected event '{expected_event}', got: "
                f"type={msg.get('type')}, event={msg.get('event')}"
            )
        payload = msg.get("payload")
        return payload if isinstance(payload, dict) else {}

    def _trusted_retry_endpoint(self) -> bool:
        try:
            host = (urlparse(self._ws_url()).hostname or "").lower()
        except Exception:
            return False
        return host in {"127.0.0.1", "localhost", "::1"}

    def _connect_error_code(self, err: OpenClawRPCError) -> str:
        return str(err.details.get("code", "")).strip()

    def _should_retry_with_device_token(self, err: OpenClawRPCError) -> bool:
        if not (self._token and self._device_token and self._trusted_retry_endpoint()):
            return False
        code = self._connect_error_code(err)
        recommended = str(err.details.get("recommendedNextStep", "")).strip()
        return (
            code == "AUTH_TOKEN_MISMATCH"
            or err.details.get("canRetryWithDeviceToken") is True
            or recommended == "retry_with_device_token"
        )

    def _clear_cached_device_token(self) -> None:
        self._device_token = ""
        if self._save_device_token:
            self._save_device_token("")

    def _persist_device_token_from_hello(self, hello: dict) -> None:
        auth = hello.get("auth")
        if not isinstance(auth, dict):
            return
        token = str(auth.get("deviceToken", "")).strip()
        if not token:
            return
        self._device_token = token
        if self._save_device_token:
            self._save_device_token(token)

    def _connect_error_message(self, err: OpenClawRPCError) -> str:
        code = self._connect_error_code(err)
        if code == "PAIRING_REQUIRED":
            return (
                "OpenClaw device pairing required. Approve the pending device via "
                "`openclaw devices list` and `openclaw devices approve <requestId>`, "
                "or rely on local auto-approval on loopback."
            )
        if code == "DEVICE_AUTH_DEVICE_ID_MISMATCH":
            return "OpenClaw device ID does not match the supplied public-key fingerprint."
        if code == "DEVICE_AUTH_SIGNATURE_INVALID":
            return "OpenClaw rejected the device signature payload."
        if code == "AUTH_DEVICE_TOKEN_MISMATCH":
            return "Cached OpenClaw device token is stale or revoked."
        return str(err)

    def _device_block(self, signature_token: str, nonce: str) -> dict[str, Any] | None:
        if not (self._device_id and self._device_public_key and self._sign_fn):
            return None
        signed_at_ms = int(time.time() * 1000)
        payload = _build_device_auth_payload_v3(
            device_id=self._device_id,
            client_id=_CLIENT_ID,
            client_mode=_CLIENT_MODE,
            role=_ROLE,
            scopes=_SCOPES,
            signed_at_ms=signed_at_ms,
            token=signature_token,
            nonce=nonce,
            platform=_PLATFORM,
            device_family=_DEVICE_FAMILY,
        )
        signature = _b64url(self._sign_fn(payload.encode("utf-8")))
        return {
            "id": self._device_id,
            "publicKey": self._device_public_key,
            "signature": signature,
            "signedAt": signed_at_ms,
            "nonce": nonce,
        }

    def _connect_params(
        self,
        challenge_payload: dict,
        *,
        auth_token: str,
        auth_device_token: str = "",
    ) -> dict:
        nonce = str(challenge_payload.get("nonce", "")).strip()
        if not nonce:
            raise OpenClawError("Gateway connect challenge missing nonce")

        auth: dict[str, str] = {}
        if auth_token:
            auth["token"] = auth_token
        if auth_device_token:
            auth["deviceToken"] = auth_device_token
        if not auth and self._device_token:
            auth["token"] = self._device_token
            auth["deviceToken"] = self._device_token
        elif auth_device_token and "token" not in auth:
            auth["token"] = auth_device_token

        signature_token = auth.get("token") or auth.get("deviceToken") or ""
        params: dict[str, Any] = {
            "minProtocol": _PROTOCOL_VERSION,
            "maxProtocol": _PROTOCOL_VERSION,
            "client": {
                "id": _CLIENT_ID,
                "displayName": self._device_name,
                "version": self._client_version,
                "platform": _PLATFORM,
                "deviceFamily": _DEVICE_FAMILY,
                "mode": _CLIENT_MODE,
            },
            "role": _ROLE,
            "scopes": list(_SCOPES),
            "caps": [],
            "auth": auth,
        }
        device = self._device_block(signature_token, nonce)
        if device is not None:
            params["device"] = device
        return params

    def _connect_ws(self, ws: Any, *, auth_token: str, auth_device_token: str = "") -> dict:
        challenge = self._recv_event(ws, "connect.challenge", timeout=10)
        hello = self._send_req(
            ws,
            "connect",
            self._connect_params(
                challenge,
                auth_token=auth_token,
                auth_device_token=auth_device_token,
            ),
        )
        self._persist_device_token_from_hello(hello)
        return hello

    def _run_agent_flow(
        self,
        ws: Any,
        *,
        task: str,
        dina_session: str,
        dina_skill: str,
        idempotency_key: str,
    ) -> dict:
        # Gateway agent RPC requires message, idempotencyKey, sessionId.
        # Skills are loaded from gateway config. Dina session context is
        # passed through MCP tools, not the agent RPC.
        agent_params: dict[str, Any] = {
            "message": task,
            "idempotencyKey": idempotency_key,
            "sessionId": dina_session or idempotency_key,
        }

        agent_resp = self._send_req(ws, "agent", agent_params)
        run_id = agent_resp.get("runId", "")
        wait_id = self._next_id()
        ws.send(
            json.dumps(
                {
                    "type": "req",
                    "id": wait_id,
                    "method": "agent.wait",
                    "params": {"runId": run_id} if run_id else {},
                }
            )
        )

        terminal_statuses = {"completed", "failed", "cancelled"}
        while True:
            raw = ws.recv(timeout=self._timeout)
            msg = json.loads(raw)
            if msg.get("type") == "res" and msg.get("id") == wait_id:
                payload = msg.get("payload", {})
                if not msg.get("ok", True):
                    raise OpenClawError(f"agent.wait error: {payload.get('error', 'unknown')}")
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

    def health(self) -> bool:
        try:
            ws_url = self._ws_url()
            with ws_connect(ws_url, open_timeout=5) as ws:
                auth_token = self._token or self._device_token
                auth_device_token = "" if self._token else self._device_token
                self._connect_ws(ws, auth_token=auth_token, auth_device_token=auth_device_token)
                resp = self._send_req(ws, "health")
                return resp.get("ok", False) or resp.get("status") == "ok"
        except (ConnectionClosed, InvalidHandshake, InvalidURI, OSError, TimeoutError, OpenClawError):
            return False

    def run_task(
        self,
        task: str,
        dina_session: str = "",
        dina_skill: str = "dina",
        idempotency_key: str = "",
    ) -> dict:
        if not idempotency_key:
            idempotency_key = str(uuid.uuid4())
        if not self._token and not self._device_token:
            raise OpenClawError("No OpenClaw auth token configured")
        if not (self._device_id and self._device_public_key and self._sign_fn):
            raise OpenClawError("OpenClaw device identity is required for WebSocket device auth")

        ws_url = self._ws_url()
        attempts: list[tuple[str, str]] = []
        if self._token:
            attempts.append((self._token, ""))
        elif self._device_token:
            attempts.append((self._device_token, self._device_token))
        if self._token and self._device_token:
            attempts.append((self._token, self._device_token))

        tried_device_retry = False
        last_connect_error: OpenClawRPCError | None = None

        for auth_token, auth_device_token in attempts:
            if auth_device_token and not self._trusted_retry_endpoint() and self._token:
                continue
            if auth_device_token and self._token:
                if tried_device_retry:
                    continue
                tried_device_retry = True
            try:
                with ws_connect(ws_url, open_timeout=10, close_timeout=5) as ws:
                    self._connect_ws(ws, auth_token=auth_token, auth_device_token=auth_device_token)
                    return self._run_agent_flow(
                        ws,
                        task=task,
                        dina_session=dina_session,
                        dina_skill=dina_skill,
                        idempotency_key=idempotency_key,
                    )
            except OpenClawRPCError as exc:
                last_connect_error = exc
                code = self._connect_error_code(exc)
                if auth_device_token:
                    if code == "AUTH_DEVICE_TOKEN_MISMATCH" and not self._token:
                        self._clear_cached_device_token()
                    raise OpenClawError(self._connect_error_message(exc)) from exc
                if self._token and not auth_device_token and self._should_retry_with_device_token(exc):
                    continue
                raise OpenClawError(self._connect_error_message(exc)) from exc
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

        if last_connect_error is not None:
            raise OpenClawError(self._connect_error_message(last_connect_error)) from last_connect_error
        raise OpenClawError("OpenClaw Gateway connection failed")

    def close(self) -> None:
        """No persistent state to close for WS client."""

    def __enter__(self) -> OpenClawClient:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()
