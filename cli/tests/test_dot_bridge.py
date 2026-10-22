"""Dot bridge: the OAuth link ceremony and per-link signing (dot_bridge.py).

Drives the real Starlette app the bridge serves — dynamic registration,
/authorize, the setup-code page, /token, a tool call on /mcp, refresh,
unlink — with only the Home Node transport faked.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from unittest.mock import MagicMock
from urllib.parse import parse_qs, urlparse

import pytest
from starlette.testclient import TestClient

from dina_cli import mcp_server
from dina_cli.dot_bridge import DotBridge, build_bridge_server
from dina_cli.transport import TransportResponse

HOME = "did:plc:bridgehome"
REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect"
VERIFIER = "v" * 64
CHALLENGE = base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).decode().rstrip("=")


def _setup_code(did: str = HOME, code: str = "PAIRCODE") -> str:
    payload = {"v": 1, "msgbox_url": "wss://mb.test/ws", "homenode_did": did, "code": code}
    raw = json.dumps(payload, separators=(",", ":")).encode()
    return "dina1:" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


class FakeTransport:
    def __init__(self, calls: list, status: int = 200) -> None:
        self.calls = calls
        self.status = status

    def request(self, method, path, headers=None, body=None):
        self.calls.append((method, path, json.loads(body) if body else None))
        return TransportResponse(status=self.status, headers={}, body=json.dumps({"device_id": "dev_1", "scope": "dot"}))


@pytest.fixture
def bridge(tmp_path, monkeypatch):
    # The bridge wires the module-level server; keep each test's wiring local.
    monkeypatch.setattr(mcp_server.mcp, "remove_tool", lambda name: None)
    monkeypatch.setattr(mcp_server.mcp, "auth", None)
    monkeypatch.setattr(mcp_server.mcp, "_additional_http_routes", [])
    monkeypatch.setattr(mcp_server, "_client_resolver", None)
    monkeypatch.setattr(mcp_server, "_owned_session_ids", set())
    b = DotBridge(
        public_url="https://dot.test",
        homenode_did=HOME,
        msgbox_url="wss://mb.test/ws",
        state_dir=tmp_path / "bridge",
    )
    calls: list = []
    b.calls = calls
    monkeypatch.setattr(b, "_transport", lambda identity: FakeTransport(calls))
    clients: dict[str, MagicMock] = {}
    monkeypatch.setattr(b, "client_for_link", lambda link_id: clients.setdefault(link_id, MagicMock()))
    b.fake_clients = clients
    return b


@pytest.fixture
def http(bridge):
    server = build_bridge_server(bridge)
    app = server.http_app(path="/mcp", json_response=True, stateless_http=True)
    with TestClient(app, base_url="https://dot.test") as client:
        yield client


def _register(http, redirect=REDIRECT):
    return http.post("/register", json={"redirect_uris": [redirect], "client_name": "ChatGPT",
                                        "token_endpoint_auth_method": "none"})


def _authorize(http, client_id):
    resp = http.get("/authorize", params={
        "response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT,
        "code_challenge": CHALLENGE, "code_challenge_method": "S256",
        "state": "st8", "scope": "dina.dot",
    }, follow_redirects=False)
    assert resp.status_code == 302
    target = urlparse(resp.headers["location"])
    assert target.netloc == "dot.test" and target.path == "/link"
    return parse_qs(target.query)["req"][0]


def _link(http, req, code):
    return http.post("/link", data={"req": req, "setup_code": code}, follow_redirects=False)


def _token(http, client_id, **form):
    return http.post("/token", data={"client_id": client_id, **form})


def _linked(http):
    client_id = _register(http).json()["client_id"]
    req = _authorize(http, client_id)
    resp = _link(http, req, _setup_code())
    assert resp.status_code == 303
    back = urlparse(resp.headers["location"])
    assert f"{back.scheme}://{back.netloc}{back.path}" == REDIRECT
    query = parse_qs(back.query)
    assert query["state"] == ["st8"]
    tokens = _token(http, client_id, grant_type="authorization_code", code=query["code"][0],
                    redirect_uri=REDIRECT, code_verifier=VERIFIER)
    assert tokens.status_code == 200, tokens.text
    return client_id, tokens.json()


def _call_tool(http, access, name, arguments):
    headers = {"Authorization": f"Bearer {access}", "Accept": "application/json, text/event-stream"}
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
    assert http.post("/mcp", json=init, headers=headers).status_code == 200
    call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": name, "arguments": arguments}}
    return http.post("/mcp", json=call, headers=headers)


def _mcp_status(http, access):
    headers = {"Authorization": f"Bearer {access}", "Accept": "application/json, text/event-stream"}
    return http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                     headers=headers).status_code


def test_mcp_refuses_a_caller_without_a_token(http):
    resp = http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                     headers={"Accept": "application/json, text/event-stream"})
    assert resp.status_code == 401
    assert "resource_metadata" in resp.headers.get("www-authenticate", "")


def test_registration_refuses_a_redirect_off_the_allowed_hosts(http):
    assert _register(http, "https://evil.test/cb").status_code == 400
    assert _register(http, REDIRECT).status_code == 201


def test_link_pairs_a_fresh_agent_key_and_issues_tokens(http, bridge):
    _, tokens = _linked(http)

    assert [c[:2] for c in bridge.calls] == [("POST", "/v1/pair/complete")]
    body = bridge.calls[0][2]
    assert body["code"] == "PAIRCODE" and body["role"] == "agent"
    links = bridge.state.links()
    assert len(links) == 1
    (link_id, link), = links.items()
    assert link["did"].startswith("did:key:") and link["device_id"] == "dev_1"
    assert (bridge.state.link_dir(link_id) / "identity" / "ed25519_private.pem").exists()
    # The state file keeps hashes, never a usable token.
    state = (bridge.state.dir / "state.json").read_text()
    assert tokens["access_token"] not in state and tokens["refresh_token"] not in state


def test_tool_calls_sign_as_the_callers_link(http, bridge):
    _, tokens = _linked(http)
    (link_id,) = bridge.state.links()
    bridge.client_for_link(link_id).tender_draft_status.return_value = {"draft_state": "pending"}

    resp = _call_tool(http, tokens["access_token"], "dina_tender_status",
                      {"session": "s1", "draft_id": "tdr_1"})

    assert resp.status_code == 200, resp.text
    assert "pending" in resp.text
    bridge.fake_clients[link_id].tender_draft_status.assert_called_once_with(session="s1", draft_id="tdr_1")


def test_link_page_escapes_the_client_name(http):
    client_id = http.post("/register", json={"redirect_uris": [REDIRECT],
                                             "client_name": "<script>x</script>",
                                             "token_endpoint_auth_method": "none"}).json()["client_id"]
    req = _authorize(http, client_id)
    page = http.get(f"/link?req={req}")
    assert page.status_code == 200
    assert "<script>x" not in page.text and "&lt;script&gt;" in page.text
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]


def test_a_code_for_another_dina_is_refused_and_tries_run_out(http, bridge):
    client_id = _register(http).json()["client_id"]
    req = _authorize(http, client_id)

    first = _link(http, req, _setup_code(did="did:plc:someoneelse"))
    assert first.status_code == 400 and "different Dina" in first.text
    assert _link(http, req, "not a code").status_code == 400
    last = _link(http, req, _setup_code(did="did:plc:someoneelse"))
    assert "No tries left" in last.text
    # The request is spent: even a good code cannot use it now.
    assert "expired" in _link(http, req, _setup_code()).text
    assert bridge.calls == [] and bridge.state.links() == {}


def test_refused_pairing_leaves_no_key_behind(http, bridge, monkeypatch):
    monkeypatch.setattr(bridge, "_transport", lambda identity: FakeTransport(bridge.calls, status=403))
    client_id = _register(http).json()["client_id"]
    req = _authorize(http, client_id)

    resp = _link(http, req, _setup_code())

    assert resp.status_code == 400 and "refused" in resp.text
    assert bridge.state.links() == {}
    assert not any((bridge.state.dir / "links").glob("*/identity/*"))


def test_authorize_refuses_a_token_for_another_resource(http):
    client_id = _register(http).json()["client_id"]
    resp = http.get("/authorize", params={
        "response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT,
        "code_challenge": CHALLENGE, "code_challenge_method": "S256", "state": "st8",
        "scope": "dina.dot", "resource": "https://other.test/mcp",
    }, follow_redirects=False)
    assert resp.status_code == 302
    assert "error=invalid_request" in resp.headers["location"]
    assert urlparse(resp.headers["location"]).netloc == "chatgpt.com"

    ok = http.get("/authorize", params={
        "response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT,
        "code_challenge": CHALLENGE, "code_challenge_method": "S256", "state": "st8",
        "scope": "dina.dot", "resource": "https://dot.test/mcp",
    }, follow_redirects=False)
    assert urlparse(ok.headers["location"]).path == "/link"


def test_auth_code_is_single_use(http):
    client_id = _register(http).json()["client_id"]
    req = _authorize(http, client_id)
    code = parse_qs(urlparse(_link(http, req, _setup_code()).headers["location"]).query)["code"][0]
    form = dict(grant_type="authorization_code", code=code, redirect_uri=REDIRECT, code_verifier=VERIFIER)

    assert _token(http, client_id, **form).status_code == 200
    assert _token(http, client_id, **form).status_code == 400


def test_refresh_rotates_and_kills_the_old_pair(http):
    client_id, tokens = _linked(http)

    fresh = _token(http, client_id, grant_type="refresh_token", refresh_token=tokens["refresh_token"])

    assert fresh.status_code == 200
    assert _mcp_status(http, fresh.json()["access_token"]) == 200
    again = _token(http, client_id, grant_type="refresh_token", refresh_token=tokens["refresh_token"])
    assert again.status_code == 400
    assert _mcp_status(http, tokens["access_token"]) == 401


def test_unlink_revokes_the_device_and_its_tokens(http, bridge):
    _, tokens = _linked(http)
    (link_id,) = bridge.state.links()

    assert bridge.unlink(link_id) is True

    assert bridge.calls[-1][:2] == ("DELETE", "/v1/devices/self")
    assert bridge.state.links() == {}
    assert not bridge.state.link_dir(link_id).exists()
    assert _mcp_status(http, tokens["access_token"]) == 401


def test_public_url_must_be_https(tmp_path):
    with pytest.raises(ValueError, match="https"):
        DotBridge(public_url="http://dot.example.com", homenode_did=HOME,
                  msgbox_url="wss://mb.test/ws", state_dir=tmp_path)
    assert re.match(r"^https://", DotBridge(public_url="https://dot.example.com/", homenode_did=HOME,
                                           msgbox_url="wss://mb.test/ws", state_dir=tmp_path).public_url)


def test_a_link_that_does_not_come_back_dot_scoped_is_taken_back(http, bridge, monkeypatch):
    calls: list = []

    class OldCore:
        def request(self, method, path, headers=None, body=None):
            calls.append((method, path, json.loads(body) if body else None))
            return TransportResponse(status=201, headers={}, body=json.dumps({"device_id": "d"}))

    monkeypatch.setattr(bridge, "_transport", lambda identity: OldCore())
    client_id = _register(http).json()["client_id"]
    req = _authorize(http, client_id)
    resp = _link(http, req, _setup_code())
    assert "too old to link safely" in resp.text
    assert calls[0][2]["narrow_scope"] == "dot"
    assert calls[-1][:2] == ("DELETE", "/v1/devices/self")
    assert bridge.state.links() == {}
