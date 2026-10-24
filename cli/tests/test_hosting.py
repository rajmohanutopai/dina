"""Hosted Dinas (HOSTED_DINA §3–§7): the front door's "Create my Dina", the
provisioner, and the SNI router.

The front door runs for real (Starlette app, OAuth, link pages) against a fake
provisioner; the provisioner runs a stand-in gate process speaking the gate's
event protocol on a real inherited pipe; the SNI router parses a real TLS
ClientHello made by Python's ssl module.
"""

from __future__ import annotations

import base64
import hashlib
import json
import ssl
import sys
import time
from unittest.mock import MagicMock
from urllib.parse import parse_qs, unquote, urlparse

import pytest
from starlette.testclient import TestClient

from dina_cli import mcp_server
from dina_cli.client import DinaClientError
from dina_cli.dot_bridge import BridgeState, DotBridge, build_bridge_server
from dina_cli.hosting import HostingConfig, KdfSlots, Provisioner, render_cell_caddyfile
from dina_cli.sni_router import cell_route, server_name
from dina_cli.transport import TransportResponse

REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect"
VERIFIER = "v" * 64
CHALLENGE = base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).decode().rstrip("=")


class FakeHosting:
    def __init__(self) -> None:
        self.created: list[str] = []
        self.states: dict[str, str] = {}
        self.boot: dict[str, str] = {}
        self.fail = False

    def create(self, name: str):
        if self.fail:
            raise RuntimeError("disk full")
        label = f"cell{len(self.created):08d}"
        self.created.append(name)
        self.states[label] = "new"
        return label, "TICKET-1"

    def owner_origin(self, label: str) -> str:
        return f"https://{label}.dina-owner.test"

    def state(self, label: str) -> str:
        return self.states.get(label, "stopped")

    def take_bootstrap(self, label: str):
        return self.boot.pop(label, None)

    def core_socket(self, label: str) -> str:
        return f"/tmp/{label}/core.sock"

    def delete_unclaimed(self, label: str) -> bool:
        # Like the provisioner: succeeds once, for a cell that is still there.
        if getattr(self, "refuse_delete", False) or label not in self.states:
            return False
        self.deleted = getattr(self, "deleted", []) + [label]
        del self.states[label]
        return True


class FakeCellTransport:
    def __init__(self, calls: list) -> None:
        self.calls = calls

    def request(self, method, path, headers=None, body=None):
        self.calls.append((method, path, json.loads(body) if body else None))
        return TransportResponse(status=200, headers={}, body=json.dumps({"device_id": "dev_cell", "scope": "dot"}))


@pytest.fixture
def hosted(tmp_path, monkeypatch):
    monkeypatch.setattr(mcp_server.mcp, "remove_tool", lambda name: None)
    monkeypatch.setattr(mcp_server.mcp, "auth", None)
    monkeypatch.setattr(mcp_server.mcp, "_additional_http_routes", [])
    monkeypatch.setattr(mcp_server, "_client_resolver", None)
    monkeypatch.setattr(mcp_server, "_owned_session_ids", set())
    hosting = FakeHosting()
    bridge = DotBridge(public_url="https://dot.test", state_dir=tmp_path / "bridge", hosting=hosting)
    calls: list = []
    monkeypatch.setattr(bridge, "_cell_transport", lambda label: FakeCellTransport(calls))
    bridge.cell_calls = calls
    # Whether the new cell's page answers yet (its certificate is in).
    bridge.origin_up = True
    monkeypatch.setattr(bridge, "_origin_ready", lambda origin: bridge.origin_up)
    bridge.fake_hosting = hosting
    server = build_bridge_server(bridge)
    app = server.http_app(path="/mcp", json_response=True, stateless_http=True)
    with TestClient(app, base_url="https://dot.test") as client:
        yield bridge, client


def _start(client) -> tuple[str, str]:
    client_id = client.post(
        "/register",
        json={"redirect_uris": [REDIRECT], "client_name": "ChatGPT", "token_endpoint_auth_method": "none"},
    ).json()["client_id"]
    resp = client.get(
        "/authorize",
        params={
            "response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT,
            "code_challenge": CHALLENGE, "code_challenge_method": "S256", "state": "s1",
            "scope": "dina.dot",
        },
        follow_redirects=False,
    )
    return client_id, parse_qs(urlparse(resp.headers["location"]).query)["req"][0]


def _create(client, req: str, invite: str, name: str = "Main Street Café"):
    return client.post(
        "/link",
        data={"req": req, "action": "create", "invite": invite, "display_name": name},
        follow_redirects=False,
    )


def test_link_page_offers_only_create_without_an_own_node(hosted):
    bridge, client = hosted
    _, req = _start(client)
    page = client.get(f"/link?req={req}").text
    assert "Create my Dina" in page and "Invite code" in page
    assert "I have a Dina" not in page
    own = client.post("/link", data={"req": req, "action": "own", "setup_code": "dina1:x"})
    assert "not offered here" in own.text


def test_create_needs_a_fresh_invite_then_hands_the_browser_to_the_cell(hosted):
    bridge, client = hosted
    [invite] = bridge.state.add_invites(1)
    _, req = _start(client)

    assert "not valid" in _create(client, req, "AAAA-BBBB-CCCC").text
    resp = _create(client, req, invite.lower())
    assert resp.status_code == 303
    assert resp.headers["location"] == f"https://dot.test/link/open?req={req}"
    resp = client.get(f"/link/open?req={req}", follow_redirects=False)
    assert resp.status_code == 303
    target = urlparse(resp.headers["location"])
    assert target.netloc == "cell00000000.dina-owner.test"
    assert target.query == ""  # the ticket travels in the fragment only
    frag = parse_qs(target.fragment)
    assert frag["ticket"] == ["TICKET-1"]
    assert unquote(frag["return"][0]) == f"https://dot.test/link/done?req={req}"
    assert bridge.fake_hosting.created == ["Main Street Café"]

    # The invite is spent; a second sign-up cannot reuse it.
    _, req2 = _start(client)
    assert "not valid" in _create(client, req2, invite).text


def test_the_person_waits_on_the_front_door_until_their_cells_page_answers(hosted, monkeypatch):
    # A new cell's Caddy needs a few seconds for its certificate; sent there at
    # once, the person's first sight of their Dina was a browser error.
    bridge, client = hosted
    [invite] = bridge.state.add_invites(1)
    _, req = _start(client)
    bridge.origin_up = False
    assert _create(client, req, invite).status_code == 303
    waiting = client.get(f"/link/open?req={req}", follow_redirects=False)
    assert waiting.status_code == 200 and "http-equiv=refresh" in waiting.text
    assert "TICKET-1" not in waiting.text  # the ticket never sits in a page
    bridge.origin_up = True
    ready = client.get(f"/link/open?req={req}", follow_redirects=False)
    assert ready.status_code == 303
    assert urlparse(ready.headers["location"]).netloc == "cell00000000.dina-owner.test"


def test_the_ticket_goes_only_to_the_browser_that_made_the_cell_and_only_once(hosted):
    # The request id sits in URLs and so in the front door's access log; it
    # alone must not hand anyone the ticket that claims the cell.
    bridge, client = hosted
    [invite] = bridge.state.add_invites(1)
    _, req = _start(client)
    bridge.origin_up = False
    _create(client, req, invite)
    cookie = client.cookies.get("dina_signup")
    assert cookie
    client.cookies.clear()
    bridge.origin_up = True
    stranger = client.get(f"/link/open?req={req}", follow_redirects=False)
    assert stranger.status_code == 403 and "TICKET-1" not in stranger.headers.get("location", "")
    client.cookies.set("dina_signup", cookie, domain="dot.test", path="/link")
    first = client.get(f"/link/open?req={req}", follow_redirects=False)
    assert first.status_code == 303 and "TICKET-1" in first.headers["location"]
    again = client.get(f"/link/open?req={req}", follow_redirects=False)
    assert again.status_code == 400 and "TICKET-1" not in again.text


def test_a_certificate_that_never_comes_does_not_hold_the_person_forever(hosted, monkeypatch):
    from dina_cli import dot_bridge

    bridge, client = hosted
    [invite] = bridge.state.add_invites(1)
    _, req = _start(client)
    bridge.origin_up = False
    _create(client, req, invite)
    monkeypatch.setattr(dot_bridge, "ORIGIN_WAIT_SECONDS", 0)
    assert client.get(f"/link/open?req={req}", follow_redirects=False).status_code == 303


def test_a_hosted_owner_links_again_with_a_code_from_their_dina_page(hosted):
    bridge, client = hosted
    client_id, req = _start(client)
    assert "I already have a Dina here" in client.get(f"/link?req={req}").text
    resp = client.post(
        "/link",
        data={"req": req, "action": "cell", "link_code": " dina-link:cell00000007:7KQ2M9XA "},
        follow_redirects=False,
    )
    assert resp.status_code == 303
    back = urlparse(resp.headers["location"])
    assert f"{back.scheme}://{back.netloc}{back.path}" == REDIRECT
    method, path, body = bridge.cell_calls[0]
    assert (method, path, body["code"], body["narrow_scope"]) == ("POST", "/v1/pair/complete", "7KQ2M9XA", "dot")
    (link,) = bridge.state.links().values()
    assert link["kind"] == "cell" and link["cell"] == "cell00000007"
    tokens = client.post(
        "/token",
        data={"client_id": client_id, "grant_type": "authorization_code",
              "code": parse_qs(back.query)["code"][0], "redirect_uri": REDIRECT, "code_verifier": VERIFIER},
    )
    assert tokens.status_code == 200


def test_a_bad_link_code_says_the_same_thing_whatever_went_wrong_and_tries_run_out(hosted, monkeypatch):
    bridge, client = hosted
    _, req = _start(client)

    def no_such_cell(label):
        raise RuntimeError("no such cell")

    monkeypatch.setattr(bridge, "_cell_transport", no_such_cell)
    said = set()
    for code in ("dina-link:cell00000000:7KQ2M9XA", "not a code"):
        page = client.post("/link", data={"req": req, "action": "cell", "link_code": code})
        assert page.status_code == 400
        said.add(page.text.split("class=err>")[1].split("<")[0])
    assert len(said) == 1  # a missing cell and a malformed code look alike
    last = client.post("/link", data={"req": req, "action": "cell", "link_code": "x"})
    assert "No tries left" in last.text
    assert bridge.state.links() == {}


def test_a_failed_create_gives_the_invite_back(hosted):
    bridge, client = hosted
    [invite] = bridge.state.add_invites(1)
    bridge.fake_hosting.fail = True
    _, req = _start(client)
    assert "Could not create your Dina" in _create(client, req, invite).text
    bridge.fake_hosting.fail = False
    assert _create(client, req, invite).status_code == 303


def test_done_waits_for_the_cell_then_pairs_a_dot_key_and_finishes_oauth(hosted):
    bridge, client = hosted
    [invite] = bridge.state.add_invites(1)
    client_id, req = _start(client)
    _create(client, req, invite)
    label = "cell00000000"

    waiting = client.get(f"/link/done?req={req}", follow_redirects=False)
    assert waiting.status_code == 200 and "http-equiv=refresh" in waiting.text
    assert bridge.cell_calls == []

    bridge.fake_hosting.states[label] = "unlocked"
    bridge.fake_hosting.boot[label] = "DOTCODE"
    # The front door pairs in the background as soon as the code arrives.
    for _ in range(40):
        done = client.get(f"/link/done?req={req}", follow_redirects=False)
        if done.status_code == 303:
            break
        time.sleep(0.1)
    assert done.status_code == 303
    back = urlparse(done.headers["location"])
    assert f"{back.scheme}://{back.netloc}{back.path}" == REDIRECT
    assert bridge.cell_calls[0][:2] == ("POST", "/v1/pair/complete")
    assert bridge.cell_calls[0][2]["code"] == "DOTCODE"
    (link,) = bridge.state.links().values()
    assert link["kind"] == "cell" and link["cell"] == label

    code = parse_qs(back.query)["code"][0]
    tokens = client.post(
        "/token",
        data={"client_id": client_id, "grant_type": "authorization_code", "code": code,
              "redirect_uri": REDIRECT, "code_verifier": VERIFIER},
    )
    assert tokens.status_code == 200


def test_a_locked_cell_answers_the_dot_in_words_it_can_pass_on(hosted):
    bridge, client = hosted
    bridge.state.put_link("lnk_x", {"did": "did:key:z", "kind": "cell", "cell": "cell00000000"})
    bridge.fake_hosting.states["cell00000000"] = "locked"
    with pytest.raises(DinaClientError, match="locked.*cell00000000.dina-owner.test"):
        bridge.client_for_link("lnk_x")


def test_a_failed_setup_ends_the_request(hosted):
    bridge, client = hosted
    [invite] = bridge.state.add_invites(1)
    _, req = _start(client)
    _create(client, req, invite)
    bridge.fake_hosting.states["cell00000000"] = "failed"
    assert "failed" in client.get(f"/link/done?req={req}").text
    assert "expired" in client.get(f"/link/done?req={req}").text
    # The dead cell is removed and the invite works again.
    assert bridge.fake_hosting.deleted == ["cell00000000"]
    assert bridge.state.take_invite(invite)


def test_a_failed_setup_is_cleaned_up_though_nobody_comes_back(hosted):
    bridge, client = hosted
    [invite] = bridge.state.add_invites(1)
    _, req = _start(client)
    _create(client, req, invite)
    bridge.fake_hosting.states["cell00000000"] = "failed"
    # The gate's page says "start again" and never returns to /link/done.
    for _ in range(40):
        if getattr(bridge.fake_hosting, "deleted", []):
            break
        time.sleep(0.1)
    assert bridge.fake_hosting.deleted == ["cell00000000"]
    assert bridge.state.take_invite(invite)


def test_an_invite_stays_spent_when_its_cell_cannot_be_removed(hosted):
    bridge, client = hosted
    [invite] = bridge.state.add_invites(1)
    _, req = _start(client)
    _create(client, req, invite)
    bridge.fake_hosting.states["cell00000000"] = "stopped"
    bridge.fake_hosting.refuse_delete = True  # someone's Dina whose gate crashed
    assert "did not finish" in client.get(f"/link/done?req={req}").text
    assert not bridge.state.take_invite(invite)


def test_the_front_door_and_the_cli_see_each_others_writes(tmp_path):
    server, cli = BridgeState(tmp_path), BridgeState(tmp_path)
    [code] = cli.add_invites(1)
    assert server.take_invite(code)
    server.put_link("lnk_a", {"did": "did:key:z"})
    server.put_tokens({"tok": {"kind": "access", "link_id": "lnk_a", "client_id": "c",
                               "family": "f", "expires_at": time.time() + 60}})
    assert cli.get_token("tok", "access") is not None
    cli.drop_link("lnk_a")  # `dina dot-bridge unlink` in another process
    assert server.get_link("lnk_a") is None
    assert server.get_token("tok", "access") is None
    # A later server write does not bring back what the CLI removed.
    server.put_client("c2", {"x": 1})
    assert cli.links() == {}


def test_invites_are_kept_as_hashes(tmp_path):
    state = BridgeState(tmp_path)
    codes = state.add_invites(3)
    text = (tmp_path / "state.json").read_text()
    assert all(code not in text for code in codes)
    assert state.take_invite(codes[0]) and not state.take_invite(codes[0])


# ── provisioner ──────────────────────────────────────────────────────────

FAKE_GATE = r"""
import json, os, subprocess, sys, time
# Like a real gate, start a child (the stand-in Core) and record its pid.
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
open(os.path.join(os.environ["DINA_CELL_VAULT_DIR"], "core.pid"), "w").write(str(child.pid))
fd = int(os.environ["DINA_CELL_EVENTS_FD"])
out = os.fdopen(fd, "w", buffering=1)
vault = os.environ["DINA_CELL_VAULT_DIR"]
if os.path.exists(os.path.join(vault, "wrapped_seed.bin")):
    out.write(json.dumps({"event": "state", "state": "locked"}) + "\n")
else:
    out.write(json.dumps({"event": "ticket", "ticket": "T-" + os.environ["DINA_PDS_HANDLE"], "expires_at": 1}) + "\n")
    if os.environ.get("FAKE_GATE_STAYS_NEW"):
        time.sleep(60)  # nobody ever signs up
    out.write(json.dumps({"event": "bootstrap", "code": "BOOT", "expires_at": time.time() + 300}) + "\n")
    out.write(json.dumps({"event": "state", "state": "unlocked"}) + "\n")
if os.environ.get("FAKE_GATE_TAKES_A_TURN"):
    import socket
    slots = socket.socket(fileno=int(os.environ["DINA_CELL_KDF_FD"]))
    slots.sendall(b"want\n")
    if slots.recv(16) == b"go\n":
        open(os.path.join(vault, "turn"), "w").write("held")
time.sleep(60)
"""


@pytest.fixture
def short_root():
    # Cell sockets must fit sun_path (104 bytes on macOS); pytest's tmp_path is too deep.
    import shutil
    import tempfile
    from pathlib import Path

    root = Path(tempfile.mkdtemp(prefix="dh", dir="/tmp"))
    yield root
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def provisioner(tmp_path, short_root):
    gate = tmp_path / "fake_gate.py"
    gate.write_text(FAKE_GATE)
    prov = Provisioner(
        HostingConfig(
            root=short_root / "hosting",
            core_command=["true"],
            gate_command=[sys.executable, str(gate)],
            core_cwd=tmp_path,
            core_env={"DINA_ENDPOINT_MODE": "test"},
            pds_handle_domain="test-pds.example",
            front_door_origin="https://dot.test",
        )
    )
    yield prov
    prov.stop_all()


def test_provisioner_creates_a_cell_reads_its_ticket_and_hands_out_the_code_once(provisioner):
    label, ticket = provisioner.create("  Main   Street Café ")
    assert len(label) == 12
    assert ticket == f"T-{label}.test-pds.example"
    assert provisioner.cells()[label]["display_name"] == "Main Street Café"
    assert provisioner.owner_origin(label).startswith("http://127.0.0.1:")
    for _ in range(50):
        if provisioner.state(label) == "unlocked":
            break
        time.sleep(0.05)
    assert provisioner.state(label) == "unlocked"
    assert provisioner.take_bootstrap(label) == "BOOT"
    assert provisioner.take_bootstrap(label) is None
    assert provisioner.core_socket(label).endswith(f"cells/{label}/run/core.sock")

    provisioner.delete(label)
    assert label not in provisioner.cells()
    assert not provisioner.cell_dir(label).exists()


def test_stopping_a_cell_stops_the_core_its_gate_started(provisioner):
    import os

    label, _ = provisioner.create("Bakery")
    pid_file = provisioner.cell_dir(label) / "vault" / "core.pid"
    for _ in range(50):
        if pid_file.exists() and pid_file.read_text():
            break
        time.sleep(0.05)
    core_pid = int(pid_file.read_text())
    provisioner.stop(label)
    for _ in range(50):
        try:
            os.kill(core_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    with pytest.raises(ProcessLookupError):
        os.kill(core_pid, 0)


def test_only_an_unfinished_sign_up_may_be_deleted(provisioner):
    label, _ = provisioner.create("Bakery")
    for _ in range(50):
        if provisioner.state(label) == "unlocked":
            break
        time.sleep(0.05)
    assert provisioner.delete_unclaimed(label) is False  # someone's Dina
    assert label in provisioner.cells()
    # Its gate crashes after sign-up: the mark on disk still protects it.
    (provisioner.cell_dir(label) / "vault" / "setup_complete").write_text("1")
    provisioner._live[label].process.kill()
    provisioner._live[label].process.wait()
    assert provisioner.state(label) == "stopped"
    assert provisioner.delete_unclaimed(label) is False
    assert (provisioner.cell_dir(label) / "vault").exists()
    other, _ = provisioner.create("Never finished")
    provisioner._live[other].state = "failed"
    assert provisioner.delete_unclaimed(other) is True
    assert other not in provisioner.cells()


def test_a_sign_up_that_finishes_during_a_delete_keeps_its_cell(provisioner, monkeypatch):
    label, _ = provisioner.create("Racing café")
    provisioner._live[label].state = "failed"
    mark = provisioner.cell_dir(label) / "vault" / "setup_complete"
    real_stop = provisioner.stop

    def stop_while_sign_up_finishes(lbl):
        # The gate finishes sign-up just as the provisioner stops it.
        mark.write_text("1")
        real_stop(lbl)

    monkeypatch.setattr(provisioner, "stop", stop_while_sign_up_finishes)
    assert provisioner.delete_unclaimed(label) is False
    assert (provisioner.cell_dir(label) / "vault").exists()
    assert label in provisioner.cells()


def test_the_front_door_reaches_the_provisioner_only_through_its_narrow_socket(short_root):
    import threading

    from dina_cli.hosting import HostingError, RemoteProvisioner, serve_provisioner

    class Stub:
        def create(self, name):
            return "abcdefghijkm", f"T-{name}"

        def cell_dir(self, label):
            if label != "abcdefghijkm":
                raise HostingError("not a cell label")

        def state(self, label):
            return "unlocked"

        def take_bootstrap(self, label):
            return None

        def delete(self, label):  # not on the list: must stay unreachable
            raise AssertionError("delete reached over the socket")

    sock = str(short_root / "prov.sock")
    server = serve_provisioner(Stub(), sock)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        remote = RemoteProvisioner(sock, timeout=5)
        assert remote.create("Café") == ("abcdefghijkm", "T-Café")
        assert remote.state("abcdefghijkm") == "unlocked"
        assert remote.take_bootstrap("abcdefghijkm") is None
        with pytest.raises(HostingError, match="not a cell label"):
            remote.state("../etc")
        with pytest.raises(HostingError, match="unknown operation"):
            remote._call("delete", label="abcdefghijkm")
    finally:
        server.shutdown()
        server.server_close()


def test_a_provisioner_fault_is_logged_though_the_front_door_hears_only_its_kind(short_root, caplog):
    # On the test box a missing `useradd` came back as "provisioner error" with
    # nothing in the journal.
    import logging
    import threading

    from dina_cli.hosting import HostingError, RemoteProvisioner, serve_provisioner

    class Broken:
        def create(self, name):
            raise FileNotFoundError("useradd")

    sock = str(short_root / "prov.sock")
    server = serve_provisioner(Broken(), sock)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with caplog.at_level(logging.ERROR, logger="dina_cli.hosting"):
            with pytest.raises(HostingError, match="^provisioner error$"):
                RemoteProvisioner(sock, timeout=5).create("Café")
        (record,) = [r for r in caplog.records if r.name == "dina_cli.hosting"]
        assert record.getMessage() == "provisioner create failed"
        assert "useradd" in caplog.text  # the reason, with its traceback
        assert "Café" not in caplog.text  # never the person's name
    finally:
        server.shutdown()
        server.server_close()


def test_provisioner_restarts_cells_locked(provisioner):
    label, _ = provisioner.create("Bakery")
    (provisioner.cell_dir(label) / "vault" / "wrapped_seed.bin").write_bytes(b"x")
    provisioner.stop(label)
    assert provisioner.state(label) == "stopped"
    provisioner.start_all()
    for _ in range(50):
        if provisioner.state(label) == "locked":
            break
        time.sleep(0.05)
    assert provisioner.state(label) == "locked"


def test_a_root_too_deep_for_sockets_is_refused_and_leaves_nothing(tmp_path):
    from dina_cli.hosting import HostingError

    prov = Provisioner(
        HostingConfig(
            root=tmp_path / ("deep" * 20),
            core_command=["true"],
            gate_command=["true"],
            core_cwd=tmp_path,
            core_env={},
            pds_handle_domain="x.example",
            front_door_origin="https://dot.test",
        )
    )
    with pytest.raises(HostingError, match="too deep"):
        prov.create("Café")
    assert prov.cells() == {}


def test_cell_caddyfile_keeps_tls_in_the_cell(tmp_path):
    text = render_cell_caddyfile(
        "abc.dina-owner.test", "/h/tls/abc/caddy.sock", "/cells/abc/run/gate.sock", tmp_path,
        alt_tlsalpn_port=19400,
    )
    assert "alt_tlsalpn_port 19400" in text
    assert "bind unix//h/tls/abc/caddy.sock|0660" in text
    assert "admin off" in text and "disable_http_challenge" in text
    assert "reverse_proxy unix//cells/abc/run/gate.sock" in text
    assert "proxy_protocol" in text
    assert f"storage file_system {tmp_path / 'data'}" in text


# ── SNI router ───────────────────────────────────────────────────────────


def _client_hello(host: str) -> bytes:
    ctx = ssl.create_default_context()
    incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
    obj = ctx.wrap_bio(incoming, outgoing, server_hostname=host)
    with pytest.raises(ssl.SSLWantReadError):
        obj.do_handshake()
    return outgoing.read()


def test_sni_reads_the_name_from_a_real_client_hello():
    assert server_name(_client_hello("abcd.dina-owner.example.com")) == "abcd.dina-owner.example.com"
    assert server_name(b"GET / HTTP/1.1\r\n\r\n") is None
    assert server_name(_client_hello("abcd.dina-owner.example.com")[:20]) is None


def test_sni_tells_a_cell_the_browsers_address_with_a_proxy_line(short_root):
    import asyncio

    from dina_cli.sni_router import make_handler

    async def run() -> bytes:
        got = asyncio.get_running_loop().create_future()

        async def cell(reader, writer):
            got.set_result(await reader.read(4096))
            writer.close()

        sock = str(short_root / "caddy.sock")
        backend = await asyncio.start_unix_server(cell, sock)
        router = await asyncio.start_server(
            make_handler(lambda name: (f"unix:{sock}", 0, True)), "127.0.0.1", 0
        )
        rport = router.sockets[0].getsockname()[1]
        reader, writer = await asyncio.open_connection("127.0.0.1", rport)
        hello = _client_hello("abcd.dina-owner.example.com")
        writer.write(hello)
        await writer.drain()
        data = await asyncio.wait_for(got, 5)
        local_port = writer.get_extra_info("sockname")[1]
        writer.close()
        router.close()
        backend.close()
        return data, hello, local_port

    data, hello, local_port = asyncio.run(run())
    line, _, rest = data.partition(b"\r\n")
    assert line.startswith(b"PROXY TCP4 127.0.0.1 127.0.0.1 ")
    assert line.split()[4] == str(local_port).encode()  # the browser's own port
    assert rest == hello


def test_sni_routes_the_front_door_and_cells_only():
    route = cell_route(
        "chatgpt.example.com",
        ("127.0.0.1", 9000),
        "dina-owner.example.com",
        lambda label: "/h/tls/abcdefghijkm/caddy.sock" if label == "abcdefghijkm" else None,
    )
    assert route("chatgpt.example.com") == ("127.0.0.1", 9000)
    assert route("abcdefghijkm.dina-owner.example.com") == (
        "unix:/h/tls/abcdefghijkm/caddy.sock",
        0,
        True,
    )
    assert route("other.dina-owner.example.com") is None
    assert route("x.abcdefghijkm.dina-owner.example.com") is None
    assert route("evil.example.com") is None


def test_sni_sends_other_names_to_an_existing_front_with_a_proxy_line():
    route = cell_route(
        "dot.example.com",
        ("127.0.0.1", 8443),
        "dina-owner.example.com",
        lambda label: None,
        other_target=("127.0.0.1", 8443),
        front_door_proxy=True,
    )
    assert route("dot.example.com") == ("127.0.0.1", 8443, True)
    assert route("test-pds.example.com") == ("127.0.0.1", 8443, True)
    # A name under the owner domain is a cell or nothing, never the other front.
    assert route("nosuchcell123.dina-owner.example.com") is None


def test_the_front_door_will_not_run_production_cells_in_its_own_process(tmp_path):
    import click

    from dina_cli.main import _make_bridge

    cfg = tmp_path / "hosting.json"
    cfg.write_text(json.dumps({
        "root": str(tmp_path / "h"), "core_command": ["x"], "gate_command": ["x"],
        "core_cwd": str(tmp_path), "pds_handle_domain": "x.example",
        "front_door_origin": "https://dot.test", "isolate": True,
    }))
    with pytest.raises(click.UsageError, match="separate provisioner"):
        _make_bridge("https://dot.test", "", "", "msgbox", "", tmp_path / "b", (), cfg)


def test_root_written_files_live_outside_the_cell_and_refuse_symlinks(provisioner, tmp_path):
    import os

    label, _ = provisioner.create("Café")
    admin = provisioner.admin_dir(label)
    assert (admin / "gate.log").exists()
    assert not (provisioner.cell_dir(label) / "logs" / "gate.log").exists()
    assert provisioner.cell_dir(label) not in admin.parents
    target = tmp_path / "victim"
    target.write_text("untouched")
    (admin / "caddy.log").symlink_to(target)
    with pytest.raises(OSError):
        os.close(provisioner._admin_file(label, "caddy.log", 0o600))
    assert target.read_text() == "untouched"
    provisioner.delete(label)
    assert not admin.exists()


def test_the_link_is_paired_as_soon_as_the_code_arrives_not_when_the_person_returns(hosted):
    bridge, client = hosted
    [invite] = bridge.state.add_invites(1)
    _, req = _start(client)
    _create(client, req, invite)
    bridge.fake_hosting.states["cell00000000"] = "unlocked"
    bridge.fake_hosting.boot["cell00000000"] = "DOTCODE"
    # Nobody visits /link/done (the person is still writing their words down),
    # yet the link is made.
    for _ in range(40):
        if bridge.state.links():
            break
        time.sleep(0.1)
    (link,) = bridge.state.links().values()
    assert link["cell"] == "cell00000000"


def test_open_registration_is_bounded_and_a_flood_cannot_shut_people_out(tmp_path):
    state = BridgeState(tmp_path)
    state.put_client("a", {}, max_clients=3, unused_ttl=3600)
    time.sleep(0.01)
    state.put_client("b", {}, max_clients=3, unused_ttl=3600)
    state.put_link("lnk", {"did": "x"})
    state.put_tokens({"t": {"kind": "access", "client_id": "a", "link_id": "lnk",
                            "family": "f", "expires_at": time.time() + 60}})
    time.sleep(0.01)
    state.put_client("c", {}, max_clients=3, unused_ttl=3600)
    # Full. A flood keeps coming; c is mid sign-up, a has tokens.
    for i in range(20):
        state.put_client(f"flood{i}", {}, max_clients=3, unused_ttl=3600, keep=frozenset({"c"}))
    for cid in ("a", "c", "flood19"):
        assert state.get_client(cid) is not None
    assert state.get_client("b") is None  # unused and oldest: dropped first
    names = ["a", "b", "c"] + [f"flood{i}" for i in range(20)]
    assert sum(state.get_client(n) is not None for n in names) == 3


def test_the_provisioner_enforces_its_own_limits(provisioner):
    from dina_cli.hosting import HostingError

    provisioner.config.max_cells = 1
    provisioner.create("First")
    with pytest.raises(HostingError, match="no room"):
        provisioner.create("Second")
    provisioner.config.max_cells = 100
    provisioner.config.max_creates_per_hour = 2
    provisioner.create("Second")
    with pytest.raises(HostingError, match="Too many new Dinas"):
        provisioner.create("Third")
    assert len(provisioner.cells()) == 2


def test_the_sni_router_command_routes_to_cell_sockets_that_exist(tmp_path, monkeypatch):
    from click.testing import CliRunner

    from dina_cli import sni_router
    from dina_cli.main import cli

    cfg = tmp_path / "hosting.json"
    cfg.write_text(json.dumps({
        "root": str(tmp_path / "h"), "core_command": ["x"], "gate_command": ["x"],
        "core_cwd": str(tmp_path), "pds_handle_domain": "x.example",
        "front_door_origin": "https://dot.test",
    }))
    sock = tmp_path / "h" / "tls" / "abcdefghijkm" / "caddy.sock"
    sock.parent.mkdir(parents=True)
    sock.write_text("")
    seen = {}

    async def fake_serve(route, host, port):
        seen.update(route=route, host=host, port=port)

    monkeypatch.setattr(sni_router, "serve", fake_serve)
    result = CliRunner().invoke(cli, [
        "dot-bridge", "sni-router", "--hosting-config", str(cfg),
        "--front-door-host", "Dot.Example.com", "--front-door-target", "127.0.0.1:8443",
        "--owner-domain", "dina-owner.example.com", "--port", "8444",
    ])
    assert result.exit_code == 0, result.output
    route = seen["route"]
    assert (seen["host"], seen["port"]) == (["0.0.0.0", "::"], 8444)
    assert route("dot.example.com") == ("127.0.0.1", 8443)
    assert route("abcdefghijkm.dina-owner.example.com") == (f"unix:{sock}", 0, True)
    assert route("zzzzzzzzzzzz.dina-owner.example.com") is None  # no such cell
    assert route("..%2f.dina-owner.example.com") is None  # not a label


def test_the_sni_router_command_wants_host_and_port_for_the_front_door(tmp_path):
    from click.testing import CliRunner

    from dina_cli.main import cli

    cfg = tmp_path / "hosting.json"
    cfg.write_text(json.dumps({
        "root": str(tmp_path / "h"), "core_command": ["x"], "gate_command": ["x"],
        "core_cwd": str(tmp_path), "pds_handle_domain": "x.example",
        "front_door_origin": "https://dot.test",
    }))
    result = CliRunner().invoke(cli, [
        "dot-bridge", "sni-router", "--hosting-config", str(cfg),
        "--front-door-host", "dot.example.com", "--front-door-target", "8443",
        "--owner-domain", "dina-owner.example.com",
    ])
    assert result.exit_code != 0
    assert "host:port" in result.output


# ── passphrase checks, all cells together ────────────────────────────────


def test_kdf_slots_cap_checks_and_go_in_the_order_asked():
    import threading

    slots = KdfSlots(2)
    a, b = slots.acquire(), slots.acquire()
    order: list[str] = []
    waiters = []
    for name in ("first", "second"):
        t = threading.Thread(target=lambda n=name: (slots.acquire(), order.append(n)))
        t.start()
        waiters.append(t)
        time.sleep(0.05)  # so they ask in this order
    time.sleep(0.1)
    assert order == [] and slots.holding() == 2
    slots.release(a)
    waiters[0].join(timeout=3)
    assert order == ["first"]
    slots.release(b)
    waiters[1].join(timeout=3)
    assert order == ["first", "second"]


def test_kdf_slots_take_back_a_turn_held_too_long():
    slots = KdfSlots(1, hold_seconds=0.2)
    slots.acquire()  # never given back
    start = time.monotonic()
    slots.acquire()
    assert time.monotonic() - start < 2.5


def test_a_gate_holds_one_turn_at_most_and_gives_it_back_when_its_socket_closes():
    import socket
    import threading

    slots = KdfSlots(1)
    ours, gate = socket.socketpair()
    threading.Thread(target=slots.serve, args=(ours,), daemon=True).start()
    gate.sendall(b"want\nwant\n")  # a second ask while holding is ignored
    assert gate.recv(16) == b"go\n"
    assert slots.holding() == 1
    gate.settimeout(0.3)
    with pytest.raises(socket.timeout):
        gate.recv(16)
    gate.close()  # the gate died holding its turn
    for _ in range(50):
        if slots.holding() == 0:
            break
        time.sleep(0.02)
    assert slots.holding() == 0


def test_the_provisioner_shares_its_turns_among_cells(tmp_path, short_root):
    gate = tmp_path / "fake_gate.py"
    gate.write_text(FAKE_GATE)
    prov = Provisioner(
        HostingConfig(
            root=short_root / "hosting",
            core_command=["true"],
            gate_command=[sys.executable, str(gate)],
            core_cwd=tmp_path,
            core_env={"FAKE_GATE_TAKES_A_TURN": "1"},
            pds_handle_domain="test-pds.example",
            front_door_origin="https://dot.test",
            max_kdf_checks=1,
        )
    )
    try:
        first, _ = prov.create("First")
        turn = lambda label: (prov.cell_dir(label) / "vault" / "turn").exists()  # noqa: E731
        for _ in range(100):
            if turn(first):
                break
            time.sleep(0.05)
        assert turn(first)
        second, _ = prov.create("Second")
        time.sleep(0.5)
        assert not turn(second)  # one check at a time on this machine
        prov.stop(first)  # its gate dies, and its turn comes back
        for _ in range(100):
            if turn(second):
                break
            time.sleep(0.05)
        assert turn(second)
    finally:
        prov.stop_all()


def test_sign_ups_people_walk_away_from_do_not_fill_the_machine(tmp_path, short_root):
    gate = tmp_path / "fake_gate.py"
    gate.write_text(FAKE_GATE)
    prov = Provisioner(
        HostingConfig(
            root=short_root / "hosting",
            core_command=["true"],
            gate_command=[sys.executable, str(gate)],
            core_cwd=tmp_path,
            core_env={"FAKE_GATE_STAYS_NEW": "1"},
            pds_handle_domain="test-pds.example",
            front_door_origin="https://dot.test",
            max_cells=1,
        )
    )
    try:
        abandoned, _ = prov.create("Walked away")  # its ticket expired long ago
        second, _ = prov.create("Second")
        assert abandoned not in prov.cells()
        assert second in prov.cells()
        assert not prov.cell_dir(abandoned).exists()
    finally:
        prov.stop_all()


def test_a_store_full_of_clients_in_use_refuses_rather_than_grows(tmp_path):
    state = BridgeState(tmp_path)
    assert state.put_client("a", {}, max_clients=2, unused_ttl=3600)
    assert state.put_client("b", {}, max_clients=2, unused_ttl=3600)
    assert not state.put_client("c", {}, max_clients=2, unused_ttl=3600, keep=frozenset({"a", "b"}))
    assert state.get_client("c") is None
    # A client whose only tokens expired is no longer in use.
    state.put_link("lnk", {"did": "x"})
    state.put_tokens({"t": {"kind": "access", "client_id": "a", "link_id": "lnk",
                            "family": "f", "expires_at": time.time() + 0.05}})
    time.sleep(0.1)
    assert state.put_client("d", {}, max_clients=2, unused_ttl=3600, keep=frozenset({"b"}))
    assert state.get_client("a") is None and state.get_client("d") is not None


def test_a_client_waiting_to_exchange_its_code_is_not_dropped(hosted, monkeypatch):
    from dina_cli import dot_bridge as db

    bridge, client = hosted
    [invite] = bridge.state.add_invites(1)
    client_id, req = _start(client)
    _create(client, req, invite)
    bridge.fake_hosting.boot["cell00000000"] = "DOTCODE"
    for _ in range(40):
        if bridge.state.links():
            break
        time.sleep(0.1)
    back = client.get(f"/link/done?req={req}", follow_redirects=False)
    assert back.status_code == 303  # a code is out; the client has no tokens yet
    monkeypatch.setattr(db, "MAX_CLIENTS", 1)
    flood = client.post(
        "/register",
        json={"redirect_uris": [REDIRECT], "client_name": "x", "token_endpoint_auth_method": "none"},
    )
    assert flood.status_code == 400  # full, and ChatGPT's client is kept
    code = parse_qs(urlparse(back.headers["location"]).query)["code"][0]
    tokens = client.post(
        "/token",
        data={"client_id": client_id, "grant_type": "authorization_code", "code": code,
              "redirect_uri": REDIRECT, "code_verifier": VERIFIER},
    )
    assert tokens.status_code == 200


def test_two_creates_at_once_cannot_both_take_the_last_place(provisioner):
    import threading

    from dina_cli.hosting import HostingError

    provisioner.config.max_cells = 1
    inner = provisioner._create

    def slow(name, reserved):
        time.sleep(0.3)  # both are past the check before either is in the registry
        return inner(name, reserved)

    provisioner._create = slow
    results: list[str] = []

    def make(name):
        try:
            provisioner.create(name)
            results.append("made")
        except HostingError:
            results.append("refused")

    threads = [threading.Thread(target=make, args=(n,)) for n in ("One", "Two")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert sorted(results) == ["made", "refused"]
    assert len(provisioner.cells()) == 1


def test_a_failed_sign_up_is_swept_once_its_ticket_is_long_gone(provisioner):
    label, _ = provisioner.create("Failed")
    for _ in range(50):
        if provisioner.state(label) == "unlocked":
            break
        time.sleep(0.05)
    provisioner._live[label].state = "failed"  # setup's Core died; no mark written
    assert provisioner.sweep_abandoned() == 1
    assert label not in provisioner.cells()


def test_two_submits_of_one_sign_up_make_one_cell(hosted):
    import threading

    bridge, client = hosted
    first, second = bridge.state.add_invites(2)
    _, req = _start(client)
    inner = bridge.fake_hosting.create

    def slow(name):
        time.sleep(0.3)  # both submits arrive while the first cell is made
        return inner(name)

    bridge.fake_hosting.create = slow
    codes: list[int] = []
    threads = [
        threading.Thread(target=lambda inv=inv: codes.append(_create(client, req, inv).status_code))
        for inv in (first, second)
    ]
    for t in threads:
        t.start()
        time.sleep(0.05)
    for t in threads:
        t.join(timeout=10)
    assert sorted(codes) == [303, 409]
    assert bridge.fake_hosting.created == ["Main Street Café"]
    # The refused submit spent no invite.
    assert bridge.state.take_invite(second)


def test_a_failed_sign_up_found_after_a_restart_is_swept_by_its_age(provisioner):
    from dina_cli.hosting import ABANDONED_GRACE_SECONDS, SIGNUP_TICKET_SECONDS

    label, _ = provisioner.create("Failed then restarted")
    live = provisioner._live[label]
    # A restarted gate reports `failed` and mints no ticket.
    live.state, live.ticket_expires_at = "failed", 0
    assert provisioner.sweep_abandoned() == 0  # young: its ticket could still be live
    provisioner._cells[label]["created_at"] = (
        time.time() - SIGNUP_TICKET_SECONDS - ABANDONED_GRACE_SECONDS - 5
    )
    assert provisioner.sweep_abandoned() == 1
    assert label not in provisioner.cells()


def test_the_provisioner_and_the_gate_agree_on_the_ticket_lifetime():
    import re
    from pathlib import Path

    from dina_cli.hosting import SIGNUP_TICKET_SECONDS

    gate = (Path(__file__).parents[2] / "apps/home-node-lite/core-server/src/cell/gate.ts").read_text()
    match = re.search(r"^const TICKET_TTL_MS = ([0-9 *]+);", gate, re.M)
    assert match is not None
    import math

    assert math.prod(int(n) for n in match.group(1).split("*")) == SIGNUP_TICKET_SECONDS * 1000


def test_fresh_turns_go_before_guessers_on_every_cell():
    import threading

    slots = KdfSlots(1)
    held = slots.acquire(fresh=False)
    order: list[str] = []
    threads = []
    for name, fresh in (("guess1", False), ("guess2", False), ("owner", True), ("guess3", False)):
        t = threading.Thread(target=lambda n=name, f=fresh: (slots.release(slots.acquire(fresh=f)), order.append(n)))
        t.start()
        threads.append(t)
        time.sleep(0.05)  # so they ask in this order
    slots.release(held)
    for t in threads:
        t.join(timeout=5)
    # The owner asked third, after two guessers on other cells, and went first.
    assert order == ["owner", "guess1", "guess2", "guess3"]


def test_a_waiting_ask_moves_queue_when_the_gate_relabels_it():
    import socket
    import threading

    slots = KdfSlots(1)
    held = slots.acquire(fresh=False)
    gates = {}
    for name in ("owner_cell", "guess_cell"):
        ours, gate = socket.socketpair()
        threading.Thread(target=slots.serve, args=(ours,), daemon=True).start()
        gates[name] = gate
    # A guesser's cell asks first; then the owner's cell asks for a guess
    # that has since timed out.
    gates["guess_cell"].sendall(b"want repeat\n")
    time.sleep(0.1)
    gates["owner_cell"].sendall(b"want repeat\n")
    time.sleep(0.1)
    # The owner's check takes over that waiting ask: it moves to the fresh
    # queue, ahead of every repeat ask.
    gates["guess_cell"].sendall(b"want repeat\n")  # same kind: no change
    gates["owner_cell"].sendall(b"want fresh\n")
    time.sleep(0.1)
    slots.release(held)
    gates["owner_cell"].settimeout(2)
    assert gates["owner_cell"].recv(16) == b"go\n"
    gates["guess_cell"].settimeout(0.3)
    with pytest.raises(socket.timeout):
        gates["guess_cell"].recv(16)
    gates["owner_cell"].sendall(b"done\n")
    gates["guess_cell"].settimeout(2)
    assert gates["guess_cell"].recv(16) == b"go\n"
    for g in gates.values():
        g.close()


def test_a_gate_that_dies_while_waiting_leaves_the_queue():
    import socket
    import threading

    slots = KdfSlots(1)
    held = slots.acquire(fresh=False)
    ours, gate = socket.socketpair()
    threading.Thread(target=slots.serve, args=(ours,), daemon=True).start()
    gate.sendall(b"want fresh\n")
    time.sleep(0.1)
    gate.close()  # died before its turn came
    time.sleep(0.1)
    slots.release(held)
    # Its turn was dropped: the next ask is served at once, nothing held.
    done = threading.Event()
    threading.Thread(target=lambda: (slots.release(slots.acquire(fresh=False)), done.set()), daemon=True).start()
    assert done.wait(2)
    assert slots.holding() == 0
