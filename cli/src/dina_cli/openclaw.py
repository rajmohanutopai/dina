"""OpenClaw Gateway WebSocket RPC client.

Implements the documented Gateway protocol for autonomous agent runs:
1. Connect to ws://{base_url}/ws
2. Receive connect challenge from Gateway
3. Respond with connect {token, clientId}
4. Call agent with task description
5. Wait with agent.wait — stream events until terminal

For Phase 1, this uses a simplified synchronous HTTP fallback since
the full WS RPC protocol requires the ``websockets`` async library
and the CLI is synchronous (Click framework).  The client is designed
to be upgraded to full WS when async support is added.

Sources: Gateway Protocol, Agent Loop, TypeBox docs.
"""

from __future__ import annotations

import json
import uuid

import httpx


class OpenClawError(Exception):
    """Raised when an OpenClaw Gateway call fails."""


class OpenClawClient:
    """Client for the local OpenClaw Gateway.

    Phase 1 uses HTTP POST /tools/invoke as a synchronous bridge.
    The ``run_task`` method submits a task and waits for the result.

    Parameters
    ----------
    base_url:
        Gateway base URL (e.g., ``http://localhost:3000``).
    token:
        Gateway auth token (generated during OpenClaw onboarding).
    timeout:
        Request timeout in seconds (default 300s for autonomous tasks).
    """

    def __init__(self, base_url: str, token: str = "", timeout: float = 300.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = httpx.Client(
            base_url=self._base_url,
            timeout=httpx.Timeout(timeout),
            headers=headers,
        )

    def health(self) -> bool:
        """Check if the Gateway is reachable."""
        try:
            resp = self._client.get("/healthz")
            return resp.status_code == 200
        except (httpx.ConnectError, httpx.TimeoutException):
            return False

    def run_task(
        self,
        task: str,
        dina_session: str = "",
        dina_skill: str = "dina",
    ) -> dict:
        """Submit a task to OpenClaw for autonomous execution.

        The agent uses the Dina skill manifest for callbacks
        (dina ask, dina validate, dina remember) at its own discretion.

        Parameters
        ----------
        task:
            Natural language task description.
        dina_session:
            Dina session name for scoped callbacks.
        dina_skill:
            Skill name for callback routing (default: "dina").

        Returns
        -------
        dict
            Agent's final result with at least ``status`` and ``data`` keys.
        """
        args: dict = {
            "task": task,
            "idempotency_key": str(uuid.uuid4()),
        }
        if dina_session:
            args["dina_session"] = dina_session
        if dina_skill:
            args["dina_skill"] = dina_skill

        try:
            resp = self._client.post("/tools/invoke", json={
                "tool": "agent_run",
                "args": args,
            })
            resp.raise_for_status()
            return resp.json()
        except httpx.ConnectError as exc:
            raise OpenClawError(
                f"OpenClaw Gateway unreachable at {self._base_url}: {exc}"
            ) from exc
        except httpx.TimeoutException as exc:
            raise OpenClawError(
                f"OpenClaw task timed out after {self._client.timeout.read}s"
            ) from exc
        except httpx.HTTPStatusError as exc:
            raise OpenClawError(
                f"OpenClaw returned HTTP {exc.response.status_code}: "
                f"{exc.response.text[:500]}"
            ) from exc

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self) -> OpenClawClient:
        return self

    def __exit__(self, *args) -> None:
        self.close()
