"""Hosted cells: one person's Dina each, on the hosting machine (HOSTED_DINA §3).

The provisioner creates a cell (a folder, a random label, and in production its
own OS user), starts the cell's gate, and listens to what the gate reports on
an inherited pipe: the sign-up ticket, the dot's single-use bootstrap code
after the first boot, and whether the cell is locked or unlocked. It holds no
passphrase, seed, owner capability or TLS key: the gate and Core keep those
in the cell's folder, readable only by the cell's user.

Two ways to run:

- ``isolate=False`` (local test): every cell runs as the current user, and its
  gate listens on a loopback TCP port. The owner page is plain HTTP on that
  port; nothing here may face the internet.
- ``isolate=True`` (production, Linux, run as root): each cell gets its own OS
  user; Core's socket sits in a setgid folder of the front door's group, so the
  front door may connect and other cells may not; the gate listens on a socket
  only the cell's user can open, behind the cell's own Caddy, which holds the
  cell's TLS key and gets its certificate by TLS-ALPN-01 through the SNI router.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import signal
import socketserver
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

LABEL_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
# A Unix socket path must fit sun_path: 104 bytes on macOS, 108 on Linux.
MAX_SOCKET_PATH = 100
# Written by the gate before it shows the recovery words (`gate.ts`).
SETUP_COMPLETE = "setup_complete"
LABEL_LENGTH = 12
_LABEL_RE = re.compile(r"^[a-z0-9]{12}$")
DISPLAY_NAME_MAX = 60


class HostingError(Exception):
    """A hosting step failed; the message is safe to show the person."""


@dataclass
class HostingConfig:
    root: Path
    """Where cells live: ``<root>/cells/<label>`` and ``<root>/cells.json``."""
    core_command: list[str]
    """How to run Core, e.g. ``[tsx, .../core-server/src/bin.ts]``."""
    gate_command: list[str]
    """How to run the gate, e.g. ``[tsx, .../core-server/src/cell/gate_bin.ts]``."""
    core_cwd: Path
    core_env: dict[str, str]
    """Passed through to Core: endpoint mode, PDS, MsgBox, AppView, PLC."""
    pds_handle_domain: str
    """Each cell's handle is ``<label>.<pds_handle_domain>``."""
    front_door_origin: str
    owner_origin_template: str = "http://127.0.0.1:{port}"
    """The owner page's origin; ``{label}`` and ``{port}`` are filled in."""
    isolate: bool = False
    port_base: int = 19400
    front_door_group: str = "dina-frontdoor"
    caddy_command: list[str] = field(default_factory=lambda: ["caddy"])
    provisioner_socket: str = ""
    """Where `dina dot-bridge provisiond` listens; required with `isolate`."""


@dataclass
class _Live:
    process: subprocess.Popen[bytes]
    state: str = "new"
    ticket: str = ""
    ticket_expires_at: float = 0
    bootstrap: str = ""
    bootstrap_expires_at: float = 0
    ticket_seen: threading.Event = field(default_factory=threading.Event)
    caddy: subprocess.Popen[bytes] | None = None


class Provisioner:
    def __init__(self, config: HostingConfig) -> None:
        self.config = config
        # Re-entrant: delete_unclaimed holds it across stop, re-check and delete.
        self._lock = threading.RLock()
        self._live: dict[str, _Live] = {}
        self.config.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.config.isolate:
            # Cell users and the front door must pass through the root and
            # `cells` to reach their own folders, never list them.
            (self.config.root / "cells").mkdir(exist_ok=True, mode=0o711)
            os.chmod(self.config.root, 0o711)
            os.chmod(self.config.root / "cells", 0o711)
        self._registry = self.config.root / "cells.json"
        self._cells: dict[str, dict[str, Any]] = {}
        if self._registry.exists():
            self._cells = json.loads(self._registry.read_text(encoding="utf-8"))

    # ── registry ──────────────────────────────────────────────────────

    def _save(self) -> None:
        tmp = self._registry.with_name(f".cells.{os.getpid()}.{secrets.token_hex(4)}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(self._cells, handle, indent=2)
        os.replace(tmp, self._registry)

    def cells(self) -> dict[str, dict[str, Any]]:
        return dict(self._cells)

    def cell_dir(self, label: str) -> Path:
        if not _LABEL_RE.fullmatch(label):
            raise HostingError("not a cell label")
        return self.config.root / "cells" / label

    def admin_dir(self, label: str) -> Path:
        """Files the provisioner writes for a cell, in a folder ROOT owns.

        Never inside the cell's own folder: as root, writing or chowning a path
        the cell's user controls would follow a symlink it planted.
        """
        self.cell_dir(label)  # validates the label
        return self.config.root / "admin" / label

    def _admin_file(self, label: str, name: str, mode: int) -> int:
        """Open (append) a file in the cell's admin folder, refusing symlinks."""
        return os.open(
            self.admin_dir(label) / name,
            os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0),
            mode,
        )

    def core_socket(self, label: str) -> str:
        return str(self.cell_dir(label) / "run" / "core.sock")

    def gate_socket(self, label: str) -> str:
        return str(self.cell_dir(label) / "run" / "gate.sock")

    def owner_origin(self, label: str) -> str:
        cell = self._cells.get(label)
        if cell is None:
            raise HostingError("no such cell")
        return self.config.owner_origin_template.format(label=label, port=cell["port"])

    def state(self, label: str) -> str:
        live = self._live.get(label)
        if live is None or live.process.poll() is not None:
            return "stopped"
        return live.state

    # ── lifecycle ─────────────────────────────────────────────────────

    def create(self, display_name: str) -> tuple[str, str]:
        """Make a cell and start its gate. Returns (label, sign-up ticket)."""
        name = " ".join(display_name.split())[:DISPLAY_NAME_MAX]
        if name == "":
            raise HostingError("A display name is needed.")
        with self._lock:
            label = "".join(secrets.choice(LABEL_ALPHABET) for _ in range(LABEL_LENGTH))
            while label in self._cells:
                label = "".join(secrets.choice(LABEL_ALPHABET) for _ in range(LABEL_LENGTH))
            used = {c["port"] for c in self._cells.values()}
            port = self.config.port_base
            while port in used or port + 1 in used:
                port += 2
            self._cells[label] = {
                "display_name": name,
                "created_at": int(time.time()),
                "port": port,
                "user": f"dina-{label}" if self.config.isolate else "",
            }
            self._save()
        try:
            self._make_dirs(label)
            live = self._start_gate(label)
            if not live.ticket_seen.wait(timeout=30):
                raise HostingError("The new Dina did not start. Try again.")
        except Exception:
            self.delete(label)
            raise
        return label, live.ticket

    def start(self, label: str) -> None:
        """Start an existing cell's gate (it comes up locked)."""
        if label not in self._cells:
            raise HostingError("no such cell")
        if self.state(label) != "stopped":
            return
        self._start_gate(label)

    def start_all(self) -> None:
        for label in list(self._cells):
            try:
                self.start(label)
            except Exception:
                # One broken cell must not keep the others down.
                continue

    def stop(self, label: str) -> None:
        """Stop the cell: its gate, the Core the gate started, and its Caddy.

        Each runs in its own process group (`start_new_session`), and the whole
        group is signalled, so a Core is never left running after its gate,
        even one whose gate already died.
        """
        live = self._live.pop(label, None)
        if live is None:
            return
        for proc in (live.process, live.caddy):
            if proc is None:
                continue
            _kill_group(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                pass
            _kill_group(proc.pid, signal.SIGKILL)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass

    def stop_all(self) -> None:
        for label in list(self._live):
            self.stop(label)

    def delete(self, label: str) -> None:
        """Stop the cell and remove its folder and registry entry."""
        self.stop(label)
        with self._lock:
            cell = self._cells.pop(label, None)
            self._save()
        shutil.rmtree(self.cell_dir(label), ignore_errors=True)
        shutil.rmtree(self.admin_dir(label), ignore_errors=True)
        if cell is not None and cell.get("user") and self.config.isolate:
            subprocess.run(["userdel", cell["user"]], check=False, capture_output=True)

    def delete_unclaimed(self, label: str) -> bool:
        """Remove a cell whose sign-up never finished.

        The gate writes `vault/setup_complete` before it shows the recovery
        words, so a cell without it is one whose owner holds nothing. Any cell
        with the mark is someone's Dina and is never removed this way, whatever
        its gate is doing; nor is one whose gate is running a set-up Core.
        Decided under the provisioner's lock, from the files on disk.
        """
        mark = self.cell_dir(label) / "vault" / SETUP_COMPLETE
        with self._lock:
            if label not in self._cells or mark.exists():
                return False
            if self.state(label) in ("locked", "unlocked", "starting"):
                return False
            # Stop the gate first, so sign-up cannot finish behind this check,
            # then look again: if it finished in the meantime, the cell is
            # someone's, so it comes back up and stays.
            self.stop(label)
            if mark.exists():
                self.start(label)
                return False
            self.delete(label)
            return True

    def take_bootstrap(self, label: str) -> str | None:
        """The dot's bootstrap code, once: it is single-use and leaves here when taken."""
        live = self._live.get(label)
        # Core's pairing codes expire in Unix seconds (`pairing/ceremony.ts`).
        if live is None or live.bootstrap == "" or time.time() > live.bootstrap_expires_at:
            return None
        code, live.bootstrap = live.bootstrap, ""
        return code

    # ── internals ─────────────────────────────────────────────────────

    def _make_dirs(self, label: str) -> None:
        cell = self.cell_dir(label)
        if len(self.core_socket(label).encode()) > MAX_SOCKET_PATH:
            raise HostingError(
                f"hosting root {self.config.root} is too deep for Unix sockets; use a shorter path"
            )
        for sub in ("vault", "run", "logs", "caddy"):
            (cell / sub).mkdir(parents=True, exist_ok=True, mode=0o700)
        admin = self.admin_dir(label)
        admin.parent.mkdir(exist_ok=True, mode=0o711)
        admin.mkdir(exist_ok=True, mode=0o755)
        if not self.config.isolate:
            return
        user = self._cells[label]["user"]
        subprocess.run(
            ["useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", user],
            check=True,
            capture_output=True,
        )
        # The front door's group may pass through the cell folder to its
        # socket; the vault, logs and Caddy folders stay the cell's alone.
        shutil.chown(cell, user, self.config.front_door_group)
        os.chmod(cell, 0o710)
        for sub in ("vault", "logs", "caddy"):
            shutil.chown(cell / sub, user, user)
        # Core's socket inherits this folder's group: the front door may
        # connect to it, other cells may not.
        shutil.chown(cell / "run", user, self.config.front_door_group)
        os.chmod(cell / "run", 0o2750)

    def _start_gate(self, label: str) -> _Live:
        cell = self.cell_dir(label)
        info = self._cells[label]
        listen = (
            f"unix:{self.gate_socket(label)}"
            if self.config.isolate
            else f"tcp:127.0.0.1:{info['port']}"
        )
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(cell),
            **self.config.core_env,
            "DINA_PDS_PROVISION": "1",
            "DINA_PDS_HANDLE": f"{label}.{self.config.pds_handle_domain}",
            "DINA_CELL_VAULT_DIR": str(cell / "vault"),
            "DINA_CELL_CORE_SOCKET": self.core_socket(label),
            "DINA_CELL_LISTEN": listen,
            "DINA_CELL_CORE_COMMAND": json.dumps(self.config.core_command),
            "DINA_CELL_CORE_CWD": str(self.config.core_cwd),
            "DINA_CELL_CORE_LOG": str(cell / "logs" / "core.log"),
            "DINA_CELL_FRONT_DOOR": self.config.front_door_origin,
        }
        read_end, write_end = os.pipe()
        env["DINA_CELL_EVENTS_FD"] = str(write_end)
        command = list(self.config.gate_command)
        if self.config.isolate:
            command = ["runuser", "-u", info["user"], "--", *command]
        log = os.fdopen(self._admin_file(label, "gate.log", 0o600), "ab")
        try:
            proc = subprocess.Popen(
                command,
                cwd=str(self.config.core_cwd),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                pass_fds=(write_end,),
                # Its own process group, so stopping the cell reaches the Core
                # the gate starts as well.
                start_new_session=True,
            )
        finally:
            os.close(write_end)
            log.close()
        live = _Live(process=proc)
        self._live[label] = live
        threading.Thread(
            target=self._read_events, args=(label, live, read_end), daemon=True
        ).start()
        if self.config.isolate:
            live.caddy = self._start_caddy(label)
        return live

    def _read_events(self, label: str, live: _Live, fd: int) -> None:
        with os.fdopen(fd, "r", encoding="utf-8") as events:
            for line in events:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                kind = event.get("event")
                if kind == "ticket":
                    live.ticket = str(event.get("ticket", ""))
                    live.ticket_expires_at = float(event.get("expires_at", 0))
                    live.ticket_seen.set()
                elif kind == "bootstrap":
                    live.bootstrap = str(event.get("code", ""))
                    live.bootstrap_expires_at = float(event.get("expires_at", 0))
                elif kind == "state":
                    live.state = str(event.get("state", ""))
                    if live.state != "new":
                        # A cell that comes up locked reports no ticket.
                        live.ticket_seen.set()

    def _start_caddy(self, label: str) -> subprocess.Popen[bytes]:
        """The cell's own TLS front: its key and certificate stay in the cell."""
        cell = self.cell_dir(label)
        info = self._cells[label]
        host = self.owner_origin(label).split("://", 1)[-1]
        # Root writes the Caddyfile into the root-owned admin folder; the cell's
        # Caddy only reads it. Replaced whole, never opened through a link.
        caddyfile = self.admin_dir(label) / "Caddyfile"
        tmp = self.admin_dir(label) / f".Caddyfile.{secrets.token_hex(4)}"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(
                render_cell_caddyfile(host, info["port"], self.gate_socket(label), cell / "caddy")
            )
        os.replace(tmp, caddyfile)
        log = os.fdopen(self._admin_file(label, "caddy.log", 0o600), "ab")
        try:
            return subprocess.Popen(
                ["runuser", "-u", info["user"], "--", *self.config.caddy_command,
                 "run", "--config", str(caddyfile), "--adapter", "caddyfile"],
                env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(cell / "caddy"),
                     "XDG_DATA_HOME": str(cell / "caddy" / "data"),
                     "XDG_CONFIG_HOME": str(cell / "caddy" / "config")},
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
        finally:
            log.close()


def _kill_group(pid: int, sig: int) -> None:
    try:
        os.killpg(pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def render_cell_caddyfile(host: str, port: int, gate_socket: str, caddy_dir: Path) -> str:
    """A cell's Caddy: TLS on a loopback port the SNI router forwards to.

    Only TLS-ALPN-01 is used (the SNI router forwards port 443 here). No admin
    endpoint, no HTTP port, no access log: the owner page's requests are the
    owner's business. The PROXY line is accepted from the router on loopback
    only, so the address Caddy hands the gate is the browser's.
    """
    return (
        "{\n"
        "\tadmin off\n"
        "\tauto_https disable_redirects\n"
        "\thttp_port 0\n"
        f"\thttps_port {port}\n"
        f"\tstorage file_system {caddy_dir / 'data'}\n"
        "\tservers {\n"
        "\t\tlistener_wrappers {\n"
        "\t\t\tproxy_protocol {\n"
        "\t\t\t\tallow 127.0.0.1/32\n"
        "\t\t\t}\n"
        "\t\t\ttls\n"
        "\t\t}\n"
        "\t}\n"
        "}\n\n"
        f"{host}:{port} {{\n"
        "\ttls {\n"
        "\t\tissuer acme {\n"
        "\t\t\tdisable_http_challenge\n"
        "\t\t\talt_tlsalpn_port " + str(port) + "\n"
        "\t\t}\n"
        "\t}\n"
        f"\treverse_proxy unix/{gate_socket}\n"
        "}\n"
    )


# ── the provisioner as its own process ───────────────────────────────────
#
# HOSTED_DINA §3.1: in production the provisioner runs as root and the front
# door does not. They talk over a local socket only the front door's group
# may open, and the front door may ask for exactly these things: make a cell,
# read a cell's state and addresses, take its bootstrap code once, and remove
# a cell whose sign-up never finished. Nothing that reads or changes a set-up
# cell's data is on the list.

PROVISIONER_OPS = (
    "create",
    "state",
    "owner_origin",
    "core_socket",
    "take_bootstrap",
    "delete_unclaimed",
)


def serve_provisioner(provisioner: "Provisioner", socket_path: str, group: str = "") -> socketserver.BaseServer:
    """Serve the provisioner's narrow interface on a Unix socket (one JSON line each way)."""

    class Handler(socketserver.StreamRequestHandler):
        def handle(self) -> None:
            line = self.rfile.readline(64 * 1024)
            try:
                request = json.loads(line)
                op = request.get("op")
                if op not in PROVISIONER_OPS:
                    raise HostingError("unknown operation")
                if op == "create":
                    label, ticket = provisioner.create(str(request.get("display_name", "")))
                    answer: Any = {"label": label, "ticket": ticket}
                else:
                    label = str(request.get("label", ""))
                    provisioner.cell_dir(label)  # validates the label
                    answer = {"value": getattr(provisioner, op)(label)}
                reply = {"ok": True, **answer}
            except HostingError as exc:
                reply = {"ok": False, "error": str(exc)}
            except Exception:
                reply = {"ok": False, "error": "provisioner error"}
            self.wfile.write((json.dumps(reply) + "\n").encode())

    if os.path.exists(socket_path):
        os.unlink(socket_path)
    server = socketserver.ThreadingUnixStreamServer(socket_path, Handler)
    os.chmod(socket_path, 0o660)
    if group:
        shutil.chown(socket_path, group=group)
    return server


class RemoteProvisioner:
    """The front door's side of `serve_provisioner`: the same calls, over the socket."""

    def __init__(self, socket_path: str, timeout: float = 60.0) -> None:
        self.socket_path = socket_path
        self.timeout = timeout

    def _call(self, op: str, **fields: Any) -> dict[str, Any]:
        import socket

        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(self.timeout)
            sock.connect(self.socket_path)
            sock.sendall((json.dumps({"op": op, **fields}) + "\n").encode())
            data = b""
            while not data.endswith(b"\n"):
                chunk = sock.recv(65536)
                if not chunk:
                    break
                data += chunk
        reply = json.loads(data or b"{}")
        if not reply.get("ok"):
            raise HostingError(str(reply.get("error", "provisioner error")))
        return reply

    def create(self, display_name: str) -> tuple[str, str]:
        reply = self._call("create", display_name=display_name)
        return str(reply["label"]), str(reply["ticket"])

    def state(self, label: str) -> str:
        return str(self._call("state", label=label)["value"])

    def owner_origin(self, label: str) -> str:
        return str(self._call("owner_origin", label=label)["value"])

    def core_socket(self, label: str) -> str:
        return str(self._call("core_socket", label=label)["value"])

    def take_bootstrap(self, label: str) -> str | None:
        value = self._call("take_bootstrap", label=label)["value"]
        return None if value is None else str(value)

    def delete_unclaimed(self, label: str) -> bool:
        return bool(self._call("delete_unclaimed", label=label)["value"])


def load_hosting_config(path: Path) -> HostingConfig:
    """Read a hosting config (JSON). Paths may be relative to the file's folder."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    base = path.parent

    def p(value: str) -> Path:
        q = Path(value).expanduser()
        return q if q.is_absolute() else (base / q).resolve()

    def cmd(value: list[str]) -> list[str]:
        if not isinstance(value, list) or not value or not all(isinstance(v, str) for v in value):
            raise HostingError("commands must be lists of strings")
        return [str(p(v)) if v.startswith(("./", "../")) else v for v in value]

    env = raw.get("core_env", {})
    if not isinstance(env, dict) or not all(isinstance(v, str) for v in env.values()):
        raise HostingError("core_env must map names to strings")
    return HostingConfig(
        root=p(raw["root"]),
        core_command=cmd(raw["core_command"]),
        gate_command=cmd(raw["gate_command"]),
        core_cwd=p(raw["core_cwd"]),
        core_env=dict(env),
        pds_handle_domain=str(raw["pds_handle_domain"]),
        front_door_origin=str(raw["front_door_origin"]).rstrip("/"),
        owner_origin_template=str(raw.get("owner_origin_template", "http://127.0.0.1:{port}")),
        isolate=bool(raw.get("isolate", False)),
        port_base=int(raw.get("port_base", 19400)),
        front_door_group=str(raw.get("front_door_group", "dina-frontdoor")),
        caddy_command=cmd(raw.get("caddy_command", ["caddy"])),
        provisioner_socket=str(raw.get("provisioner_socket", "")),
    )
