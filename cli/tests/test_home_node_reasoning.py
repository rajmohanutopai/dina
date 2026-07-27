"""Owner-safe foreground Brain selection tests."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from dina_cli.home_node_enrollment import HomeNodeEnrollment
from dina_cli.home_node_reasoning import (
    CONNECTED_BRAIN_TASK_KINDS,
    HomeNodeReasoningError,
    HomeNodeReasoningSelector,
)

OWNER_CAPABILITY = "owner-capability-never-persist"
AGENT_DID = "did:key:z6MkClaude"


class FakeManager:
    install_dir = Path("/managed/home-node")

    def __init__(self, *, healthy: bool = True) -> None:
        self.healthy = healthy
        self.owner_reads = 0

    def status(self):
        return SimpleNamespace(
            installed=True,
            core_healthy=self.healthy,
            core_url="http://127.0.0.1:8100",
        )

    def read_owner_capability(self) -> str:
        self.owner_reads += 1
        return OWNER_CAPABILITY


class ReasoningServer:
    def __init__(self, backends: list[dict] | None = None) -> None:
        self.backends = list(backends or [])
        self.requests: list[tuple[str, str]] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((request.method, request.url.path))
        assert request.headers["x-dina-owner-capability"] == OWNER_CAPABILITY
        if request.method == "GET" and request.url.path == "/v1/reasoning/backends":
            return httpx.Response(200, json={"backends": self.backends})
        if (
            request.method == "POST"
            and request.url.path == "/v1/reasoning/backends/register"
        ):
            body = json.loads(request.content)
            assert body == {
                "backend_id": "connected.coding-device-1",
                "kind": "connected_host",
                "principal_did": AGENT_DID,
                "allowed_task_kinds": list(CONNECTED_BRAIN_TASK_KINDS),
                "max_sensitivity": "sensitive",
                "availability": "foreground",
                "model_class": "connected-host",
                "expires_at": None,
                "expected_version": None,
            }
            created = {
                **body,
                "policy_version": 1,
                "enabled": True,
                "revoked_at": None,
            }
            self.backends = [created]
            return httpx.Response(201, json=created)
        return httpx.Response(404, json={"error": "not_found"})


def _enrollment(device_id: str = "coding-device-1") -> HomeNodeEnrollment:
    return HomeNodeEnrollment(
        status="enrolled",
        device_id=device_id,
        agent_did=AGENT_DID,
        home_did="did:plc:home",
        config_dir="/tmp/dina-cli",
    )


def _binding(
    *,
    backend_id: str = "connected.coding-device-1",
    principal_did: str = AGENT_DID,
    enabled: bool = True,
    revoked_at: int | None = None,
    expires_at: int | None = None,
) -> dict:
    return {
        "backend_id": backend_id,
        "kind": "connected_host",
        "principal_did": principal_did,
        "allowed_task_kinds": list(CONNECTED_BRAIN_TASK_KINDS),
        "max_sensitivity": "sensitive",
        "availability": "foreground",
        "model_class": "connected-host",
        "policy_version": 1,
        "enabled": enabled,
        "expires_at": expires_at,
        "revoked_at": revoked_at,
    }


def _selector(
    server: ReasoningServer,
    manager: FakeManager | None = None,
) -> HomeNodeReasoningSelector:
    return HomeNodeReasoningSelector(
        manager or FakeManager(),  # type: ignore[arg-type]
        transport=server.transport(),
    )


def test_selects_exact_enrolled_agent_without_exposing_owner_capability() -> None:
    server = ReasoningServer()

    result = _selector(server).select(_enrollment())

    assert result.status == "selected"
    assert result.selected is True
    assert result.backend_id == "connected.coding-device-1"
    assert result.policy_version == 1
    assert server.requests == [
        ("GET", "/v1/reasoning/backends"),
        ("POST", "/v1/reasoning/backends/register"),
    ]
    assert OWNER_CAPABILITY not in json.dumps(server.backends)


def test_matching_existing_selection_is_idempotent() -> None:
    server = ReasoningServer([_binding()])

    result = _selector(server).select(_enrollment())

    assert result.status == "already_selected"
    assert result.selected is True
    assert server.requests == [("GET", "/v1/reasoning/backends")]


def test_preserves_another_owner_selected_connected_brain() -> None:
    server = ReasoningServer(
        [_binding(backend_id="connected.other-device", principal_did="did:key:zOther")]
    )

    result = _selector(server).select(_enrollment())

    assert result.status == "owner_policy_preserved"
    assert result.selected is False
    assert result.backend_id is None
    assert "another connected agent" in (result.reason or "")
    assert ("POST", "/v1/reasoning/backends/register") not in server.requests


def test_ignores_an_expired_competing_connected_brain() -> None:
    server = ReasoningServer(
        [
            _binding(
                backend_id="connected.expired-device",
                principal_did="did:key:zExpired",
                expires_at=1,
            )
        ]
    )

    result = _selector(server).select(_enrollment())

    assert result.status == "selected"
    assert result.backend_id == "connected.coding-device-1"
    assert ("POST", "/v1/reasoning/backends/register") in server.requests


def test_does_not_revive_a_revoked_binding() -> None:
    server = ReasoningServer([_binding(enabled=False, revoked_at=123)])

    result = _selector(server).select(_enrollment())

    assert result.status == "owner_policy_preserved"
    assert result.selected is False
    assert result.backend_id == "connected.coding-device-1"
    assert ("POST", "/v1/reasoning/backends/register") not in server.requests


def test_rejects_device_id_that_cannot_form_backend_id() -> None:
    server = ReasoningServer()

    with pytest.raises(HomeNodeReasoningError, match="stable reasoning backend ID"):
        _selector(server).select(_enrollment("../owner"))

    assert server.requests == []


def test_refuses_selection_until_core_is_healthy() -> None:
    server = ReasoningServer()
    manager = FakeManager(healthy=False)

    with pytest.raises(HomeNodeReasoningError, match="healthy"):
        _selector(server, manager).select(_enrollment())

    assert manager.owner_reads == 0
    assert server.requests == []


def test_wraps_owner_api_network_failure() -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    selector = HomeNodeReasoningSelector(
        FakeManager(),  # type: ignore[arg-type]
        transport=httpx.MockTransport(fail),
    )

    with pytest.raises(HomeNodeReasoningError, match="Could not reach"):
        selector.select(_enrollment())
