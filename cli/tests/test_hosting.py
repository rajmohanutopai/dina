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
from dina_cli.hosting import HostingConfig, Provisioner, render_cell_caddyfile
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
        if getattr(self, "refuse_delete", False):
            return False
        self.deleted = getattr(self, "deleted", []) + [label]
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
    done = client.get(f"/link/done?req={req}", follow_redirects=False)
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
    out.write(json.dumps({"event": "bootstrap", "code": "BOOT", "expires_at": time.time() + 300}) + "\n")
    out.write(json.dumps({"event": "state", "state": "unlocked"}) + "\n")
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
    text = render_cell_caddyfile("abc.dina-owner.test", 19402, "/cells/abc/run/gate.sock", tmp_path)
    assert "admin off" in text and "disable_http_challenge" in text
    assert "reverse_proxy unix//cells/abc/run/gate.sock" in text
    assert "proxy_protocol" in text and "allow 127.0.0.1/32" in text
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


def test_sni_tells_a_cell_the_browsers_address_with_a_proxy_line():
    import asyncio

    from dina_cli.sni_router import make_handler

    async def run() -> bytes:
        got = asyncio.get_running_loop().create_future()

        async def cell(reader, writer):
            got.set_result(await reader.read(4096))
            writer.close()

        backend = await asyncio.start_server(cell, "127.0.0.1", 0)
        port = backend.sockets[0].getsockname()[1]
        router = await asyncio.start_server(
            make_handler(lambda name: ("127.0.0.1", port, True)), "127.0.0.1", 0
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
        lambda label: 19402 if label == "abcdefghijkm" else None,
    )
    assert route("chatgpt.example.com") == ("127.0.0.1", 9000)
    assert route("abcdefghijkm.dina-owner.example.com") == ("127.0.0.1", 19402, True)
    assert route("other.dina-owner.example.com") is None
    assert route("x.abcdefghijkm.dina-owner.example.com") is None
    assert route("evil.example.com") is None


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
