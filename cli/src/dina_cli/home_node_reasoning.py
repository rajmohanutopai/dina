"""Owner-authorized selection of a local coding agent as Dina's foreground Brain.

The native Home Node installer is an owner-authorized local process. It may use
Core's private owner capability to create the initial connected-host binding,
but it must never expose that capability or silently replace later owner
policy.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import Any

import httpx

from .home_node import HomeNodeError, HomeNodeManager
from .home_node_enrollment import HomeNodeEnrollment

CONNECTED_BRAIN_TASK_KINDS = (
    "answer.compose",
    "memory.structure",
    "intent.route",
    "service.respond",
    "review.summarize",
    "reminder.extract",
)
_DEVICE_ID_RE = re.compile(r"[A-Za-z0-9._:-]{1,220}\Z")


class HomeNodeReasoningError(HomeNodeError):
    """The installer could not safely select the enrolled reasoning backend."""


@dataclass(frozen=True)
class HomeNodeReasoningSelection:
    status: str
    backend_id: str | None
    principal_did: str
    policy_version: int | None
    selected: bool
    reason: str | None = None


class HomeNodeReasoningSelector:
    """Create only the initial binding for the exact enrolled coding agent."""

    def __init__(
        self,
        manager: HomeNodeManager,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 15.0,
    ) -> None:
        self.manager = manager
        self.transport = transport
        self.timeout = timeout

    def select(self, enrollment: HomeNodeEnrollment) -> HomeNodeReasoningSelection:
        if _DEVICE_ID_RE.fullmatch(enrollment.device_id) is None:
            raise HomeNodeReasoningError(
                "Core returned a coding-agent device ID that cannot form a stable "
                "reasoning backend ID."
            )
        status = self.manager.status()
        if not status.installed or not status.core_healthy:
            raise HomeNodeReasoningError(
                "Home Node Core must be installed and healthy before Brain selection."
            )

        backend_id = f"connected.{enrollment.device_id}"
        try:
            owner_capability = self.manager.read_owner_capability()
            with httpx.Client(
                base_url=status.core_url,
                timeout=self.timeout,
                transport=self.transport,
                headers={
                    "X-Dina-Owner-Capability": owner_capability,
                    "Cache-Control": "no-store",
                },
            ) as client:
                existing = self._list_backends(client)
                classified = self._classify_existing(
                    existing,
                    backend_id=backend_id,
                    principal_did=enrollment.agent_did,
                )
                if classified is not None:
                    return classified

                response = client.post(
                    "/v1/reasoning/backends/register",
                    json={
                        "backend_id": backend_id,
                        "kind": "connected_host",
                        "principal_did": enrollment.agent_did,
                        "allowed_task_kinds": list(CONNECTED_BRAIN_TASK_KINDS),
                        "max_sensitivity": "sensitive",
                        "availability": "foreground",
                        "model_class": "connected-host",
                        "expires_at": None,
                        "expected_version": None,
                    },
                )
                if response.status_code == 409:
                    raced = self._classify_existing(
                        self._list_backends(client),
                        backend_id=backend_id,
                        principal_did=enrollment.agent_did,
                    )
                    if raced is not None:
                        return raced
                if response.status_code != 201:
                    raise HomeNodeReasoningError(
                        "Core could not select the enrolled coding agent as the "
                        f"foreground Brain (HTTP {response.status_code})."
                    )
                body = _json_object(response, "reasoning backend registration")
                if not _matches_requested_binding(
                    body,
                    backend_id=backend_id,
                    principal_did=enrollment.agent_did,
                ):
                    raise HomeNodeReasoningError(
                        "Core returned an unexpected foreground Brain binding."
                    )
                return HomeNodeReasoningSelection(
                    status="selected",
                    backend_id=backend_id,
                    principal_did=enrollment.agent_did,
                    policy_version=_required_policy_version(body),
                    selected=True,
                )
        except HomeNodeError:
            raise
        except httpx.HTTPError as exc:
            raise HomeNodeReasoningError(
                "Could not reach the local Home Node owner reasoning API."
            ) from exc
        except (OSError, TypeError, ValueError) as exc:
            raise HomeNodeReasoningError(
                "Could not verify the local foreground Brain selection."
            ) from exc

    def _list_backends(self, client: httpx.Client) -> list[dict[str, Any]]:
        response = client.get("/v1/reasoning/backends")
        if response.status_code != 200:
            raise HomeNodeReasoningError(
                "Core could not list owner-selected reasoning backends "
                f"(HTTP {response.status_code})."
            )
        body = _json_object(response, "reasoning backend list")
        rows = body.get("backends")
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise HomeNodeReasoningError(
                "Core returned a malformed reasoning backend list."
            )
        return rows

    def _classify_existing(
        self,
        rows: list[dict[str, Any]],
        *,
        backend_id: str,
        principal_did: str,
    ) -> HomeNodeReasoningSelection | None:
        desired = next(
            (row for row in rows if row.get("backend_id") == backend_id),
            None,
        )
        if desired is not None:
            if _matches_requested_binding(
                desired,
                backend_id=backend_id,
                principal_did=principal_did,
            ):
                return HomeNodeReasoningSelection(
                    status="already_selected",
                    backend_id=backend_id,
                    principal_did=principal_did,
                    policy_version=_required_policy_version(desired),
                    selected=True,
                )
            return HomeNodeReasoningSelection(
                status="owner_policy_preserved",
                backend_id=backend_id,
                principal_did=principal_did,
                policy_version=_optional_policy_version(desired),
                selected=False,
                reason="the existing binding is disabled, revoked, expired, or changed",
            )

        active_connected = [
            row
            for row in rows
            if row.get("kind") == "connected_host"
            and row.get("enabled") is True
            and row.get("revoked_at") is None
            and _binding_not_expired(row, int(time.time() * 1000))
        ]
        if active_connected:
            return HomeNodeReasoningSelection(
                status="owner_policy_preserved",
                backend_id=None,
                principal_did=principal_did,
                policy_version=None,
                selected=False,
                reason="another connected agent is already selected as Brain",
            )
        return None


def _binding_not_expired(row: dict[str, Any], now_ms: int) -> bool:
    expires_at = row.get("expires_at")
    if expires_at is None:
        return True
    if (
        not isinstance(expires_at, int)
        or isinstance(expires_at, bool)
        or expires_at < 1
    ):
        # Malformed owner policy must not be silently displaced.
        return True
    return expires_at > now_ms


def _matches_requested_binding(
    row: dict[str, Any],
    *,
    backend_id: str,
    principal_did: str,
) -> bool:
    return (
        row.get("backend_id") == backend_id
        and row.get("kind") == "connected_host"
        and row.get("principal_did") == principal_did
        and set(row.get("allowed_task_kinds") or ()) == set(CONNECTED_BRAIN_TASK_KINDS)
        and row.get("max_sensitivity") == "sensitive"
        and row.get("availability") == "foreground"
        and row.get("model_class") == "connected-host"
        and row.get("enabled") is True
        and row.get("revoked_at") is None
        and row.get("expires_at") is None
    )


def _json_object(response: httpx.Response, label: str) -> dict[str, Any]:
    try:
        body = response.json()
    except json.JSONDecodeError as exc:
        raise HomeNodeReasoningError(
            f"Core returned invalid JSON for {label}."
        ) from exc
    if not isinstance(body, dict):
        raise HomeNodeReasoningError(f"Core returned an invalid body for {label}.")
    return body


def _optional_policy_version(row: dict[str, Any]) -> int | None:
    value = row.get("policy_version")
    return value if isinstance(value, int) and value >= 1 else None


def _required_policy_version(row: dict[str, Any]) -> int:
    value = _optional_policy_version(row)
    if value is None:
        raise HomeNodeReasoningError(
            "Core returned a reasoning backend without a valid policy version."
        )
    return value
