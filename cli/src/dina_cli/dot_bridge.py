"""Dot bridge — the `dot` MCP profile served over HTTP for ChatGPT.

Run: dina dot-bridge serve --public-url https://dina-dot.example.com \\
         --homenode-did did:plc:... --msgbox-url wss://.../ws

OPENAI_DOTS_INTEGRATION §6. ChatGPT reaches a plugin over HTTPS and signs in
with OAuth. This bridge is its own OAuth server, and the one credential it
accepts is a `dina1:` setup code from the Dina app (Settings → Agents). Each
link pairs a fresh Ed25519 key as its own agent device, so the owner sees the
link in the app and can revoke it there; every tool call is then signed with
that link's key, and Core applies the same gates as for any other agent.

The bridge holds no owner key and no vault. Its state is the OAuth clients,
the links, and SHA-256 hashes of the tokens it issued (never the tokens).
Serve it behind a TLS front; it binds loopback by default.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import html
import json
import os
import secrets
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlparse

from mcp.server.auth.provider import (
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse, Response

from fastmcp.server.auth.auth import (
    AccessToken,
    ClientRegistrationOptions,
    OAuthProvider,
    RevocationOptions,
)
from fastmcp.server.dependencies import get_access_token

from .client import DinaClient, DinaClientError
from .config import Config
from .setup_code import SetupCodeError, parse_setup_code
from .signing import CLIIdentity

if TYPE_CHECKING:
    from .hosting import Provisioner

DOT_SCOPE = "dina.dot"
DEFAULT_STATE_DIR = Path.home() / ".dina" / "dot-bridge"
DEFAULT_REDIRECT_HOSTS = ("chatgpt.com",)
LINK_DEVICE_NAME = "ChatGPT dot"

PENDING_TTL_SECONDS = 10 * 60
AUTH_CODE_TTL_SECONDS = 5 * 60
ACCESS_TOKEN_TTL_SECONDS = 60 * 60
REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
# Core burns a pairing code after three failures; stop asking at the same point.
MAX_LINK_ATTEMPTS = 3
INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class BridgeError(Exception):
    """A link step failed; the message is safe to show the owner."""


@dataclass
class _Pending:
    client_id: str
    client_name: str
    params: AuthorizationParams
    expires_at: float
    attempts: int = 0
    # HOSTED_DINA §4: the cell this request created, waiting for its first boot,
    # and the invite it spent (given back if the sign-up fails).
    cell: str = ""
    invite: str = ""


class BridgeState:
    """The bridge's file state: clients, links, token hashes, invite-code hashes.

    One JSON file, 0600. Tokens and invite codes are kept only as SHA-256.
    The running front door and the `dina dot-bridge` commands are separate
    processes, so every read loads the file afresh and every write holds an
    exclusive lock across load, change and save: an invite made or a link
    dropped from the command line is seen by the server at once.
    """

    _KEYS = ("clients", "links", "tokens", "invites")

    def __init__(self, state_dir: Path) -> None:
        self.dir = state_dir
        self._file = state_dir / "state.json"
        self._lock_file = state_dir / "state.lock"
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.dir, 0o700)
        self._data: dict[str, dict[str, Any]] = {k: {} for k in self._KEYS}

    @contextlib.contextmanager
    def _locked(self, write: bool):
        fd = os.open(self._lock_file, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX if write else fcntl.LOCK_SH)
            self._load()
            yield self._data
            if write:
                self._save()
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def _load(self) -> None:
        data: dict[str, dict[str, Any]] = {k: {} for k in self._KEYS}
        if self._file.exists():
            loaded = json.loads(self._file.read_text(encoding="utf-8"))
            for key in self._KEYS:
                if isinstance(loaded.get(key), dict):
                    data[key] = loaded[key]
        self._data = data

    def _save(self) -> None:
        tmp = self._file.with_name(f".state.{os.getpid()}.{secrets.token_hex(4)}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(self._data, handle, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self._file)
        finally:
            tmp.unlink(missing_ok=True)

    def link_dir(self, link_id: str) -> Path:
        return self.dir / "links" / link_id

    # clients
    def get_client(self, client_id: str) -> dict | None:
        with self._locked(write=False) as data:
            return data["clients"].get(client_id)

    def put_client(self, client_id: str, info: dict) -> None:
        with self._locked(write=True) as data:
            data["clients"][client_id] = info

    # links
    def get_link(self, link_id: str) -> dict | None:
        with self._locked(write=False) as data:
            return data["links"].get(link_id)

    def links(self) -> dict[str, dict]:
        with self._locked(write=False) as data:
            return dict(data["links"])

    def put_link(self, link_id: str, link: dict) -> None:
        with self._locked(write=True) as data:
            data["links"][link_id] = link

    def drop_link(self, link_id: str) -> None:
        with self._locked(write=True) as data:
            data["links"].pop(link_id, None)
            data["tokens"] = {h: t for h, t in data["tokens"].items() if t.get("link_id") != link_id}

    # tokens (stored by hash)
    def get_token(self, token: str, kind: str) -> dict | None:
        key = _hash(token)
        with self._locked(write=False) as data:
            record = data["tokens"].get(key)
            live = (
                record is not None
                and record.get("kind") == kind
                and record["expires_at"] >= time.time()
                and record["link_id"] in data["links"]
            )
        if record is not None and not live and record.get("kind") == kind:
            with self._locked(write=True) as data:
                data["tokens"].pop(key, None)
        return record if live else None

    def put_tokens(self, records: dict[str, dict]) -> None:
        with self._locked(write=True) as data:
            now = time.time()
            data["tokens"] = {h: t for h, t in data["tokens"].items() if t["expires_at"] >= now}
            for token, record in records.items():
                data["tokens"][_hash(token)] = record

    def drop_tokens(self, *, family: str) -> None:
        with self._locked(write=True) as data:
            data["tokens"] = {h: t for h, t in data["tokens"].items() if t.get("family") != family}

    # invites (HOSTED_DINA §1: sign-up is invite only; each code works once)
    def add_invites(self, count: int) -> list[str]:
        codes = [
            "-".join("".join(secrets.choice(INVITE_ALPHABET) for _ in range(4)) for _ in range(3))
            for _ in range(count)
        ]
        with self._locked(write=True) as data:
            for code in codes:
                data["invites"][_hash(code)] = {"created_at": int(time.time()), "used_at": 0}
        return codes

    def invites(self) -> list[dict]:
        with self._locked(write=False) as data:
            return list(data["invites"].values())

    def take_invite(self, code: str) -> bool:
        key = _hash(code.strip().upper())
        with self._locked(write=True) as data:
            invite = data["invites"].get(key)
            if invite is None or invite.get("used_at"):
                return False
            invite["used_at"] = int(time.time())
            return True

    def release_invite(self, code: str) -> None:
        """Give an invite back when the sign-up it started could not make a Dina."""
        key = _hash(code.strip().upper())
        with self._locked(write=True) as data:
            invite = data["invites"].get(key)
            if invite is not None:
                invite["used_at"] = 0


class DotBridge(OAuthProvider):
    """OAuth server whose consent step is pairing a `dina1:` setup code."""

    def __init__(
        self,
        *,
        public_url: str,
        homenode_did: str = "",
        msgbox_url: str = "",
        transport_mode: str = "msgbox",
        core_url: str = "",
        state_dir: Path = DEFAULT_STATE_DIR,
        redirect_hosts: tuple[str, ...] = DEFAULT_REDIRECT_HOSTS,
        hosting: Provisioner | None = None,
    ) -> None:
        public_url = public_url.rstrip("/")
        parsed = urlparse(public_url)
        local = parsed.hostname in ("localhost", "127.0.0.1", "::1")
        if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
            raise ValueError("--public-url must be https (http only for localhost)")
        if homenode_did == "" and hosting is None:
            raise ValueError("give --homenode-did, or run with hosted cells")
        if homenode_did != "" and not homenode_did.startswith("did:"):
            raise ValueError("--homenode-did must be a DID")
        if homenode_did != "" and transport_mode == "msgbox" and not msgbox_url:
            raise ValueError("transport msgbox needs --msgbox-url")
        if homenode_did != "" and transport_mode == "direct" and not core_url:
            raise ValueError("transport direct needs --core-url")
        super().__init__(
            base_url=public_url,
            client_registration_options=ClientRegistrationOptions(
                enabled=True, valid_scopes=[DOT_SCOPE], default_scopes=[DOT_SCOPE]
            ),
            revocation_options=RevocationOptions(enabled=True),
            required_scopes=[DOT_SCOPE],
        )
        self.public_url = public_url
        self.resource_url = f"{public_url}/mcp"
        self.homenode_did = homenode_did
        self.msgbox_url = msgbox_url
        self.transport_mode = transport_mode
        self.core_url = core_url
        self.redirect_hosts = tuple(h.lower() for h in redirect_hosts)
        self.hosting = hosting
        self.state = BridgeState(state_dir)
        self._pending: dict[str, _Pending] = {}
        self._codes: dict[str, tuple[AuthorizationCode, str]] = {}
        self._clients: dict[str, DinaClient] = {}
        self._clients_lock = threading.Lock()

    # ── client registration ────────────────────────────────────────────

    def _redirect_allowed(self, uri: str) -> bool:
        parsed = urlparse(uri)
        host = (parsed.hostname or "").lower()
        if parsed.scheme == "http" and host in ("localhost", "127.0.0.1"):
            return host in self.redirect_hosts
        return parsed.scheme == "https" and host in self.redirect_hosts

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        raw = self.state.get_client(client_id)
        return OAuthClientInformationFull.model_validate(raw) if raw else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        if not client_info.client_id:
            raise RegistrationError("invalid_client_metadata", "client_id is required")
        uris = [str(u) for u in client_info.redirect_uris or []]
        if not uris or not all(self._redirect_allowed(u) for u in uris):
            raise RegistrationError(
                "invalid_redirect_uri", "this bridge links only to its allowed hosts"
            )
        if client_info.scope and set(client_info.scope.split()) - {DOT_SCOPE}:
            raise RegistrationError("invalid_client_metadata", f"scope must be {DOT_SCOPE}")
        self.state.put_client(client_info.client_id, client_info.model_dump(mode="json"))

    # ── authorization: hand the owner to the link page ─────────────────

    async def authorize(
        self, client: OAuthClientInformationFull, params: AuthorizationParams
    ) -> str:
        if not client.client_id or self.state.get_client(client.client_id) is None:
            raise AuthorizeError("unauthorized_client", "client is not registered")
        # RFC 8707: ChatGPT names the server a token is for. Refuse any other, so
        # a token minted here is never good for a different resource.
        if params.resource is not None and params.resource.rstrip("/") != self.resource_url:
            raise AuthorizeError("invalid_request", f"resource must be {self.resource_url}")
        now = time.time()
        self._pending = {k: p for k, p in self._pending.items() if p.expires_at >= now}
        request_id = secrets.token_urlsafe(24)
        self._pending[request_id] = _Pending(
            client_id=client.client_id,
            client_name=client.client_name or "",
            params=params,
            expires_at=now + PENDING_TTL_SECONDS,
        )
        return f"{self.public_url}/link?req={request_id}"

    async def link_page(self, request: Request) -> Response:
        if request.method == "GET":
            request_id = request.query_params.get("req", "")
            pending = self._live_pending(request_id)
            if pending is None:
                return _page("This link request has expired. Start again from ChatGPT.", 400)
            return self._link_form(request_id, pending, "")

        form = await request.form()
        request_id = str(form.get("req", ""))
        pending = self._live_pending(request_id)
        if pending is None:
            return _page("This link request has expired. Start again from ChatGPT.", 400)
        if pending.cell != "":
            return _page("This sign-up is already under way. Finish it on your Dina page.", 409)
        pending.attempts += 1
        import anyio.to_thread

        if str(form.get("action", "own")) == "create":
            return await self._create(request_id, pending, form)
        setup_code = str(form.get("setup_code", ""))
        if self.homenode_did == "":
            return self._link_form(request_id, pending, "Linking your own Dina is not offered here.")
        try:
            link_id = await anyio.to_thread.run_sync(self.pair_link, setup_code)
        except BridgeError as exc:
            if pending.attempts >= MAX_LINK_ATTEMPTS:
                self._pending.pop(request_id, None)
                return _page(f"{exc} No tries left. Start again from ChatGPT.", 400)
            return self._link_form(request_id, pending, str(exc))
        return self._finish(request_id, pending, link_id)

    async def _create(self, request_id: str, pending: _Pending, form: Any) -> Response:
        """HOSTED_DINA §4 steps 1–3: an invite, a new cell, then the cell's own page."""
        import anyio.to_thread

        if self.hosting is None:
            return self._link_form(request_id, pending, "Creating a Dina is not offered here.")
        invite = str(form.get("invite", ""))
        name = str(form.get("display_name", "")).strip()
        if name == "":
            return self._link_form(request_id, pending, "Give your Dina a name.")
        if not self.state.take_invite(invite):
            if pending.attempts >= MAX_LINK_ATTEMPTS:
                self._pending.pop(request_id, None)
                return _page("That invite code is not valid. No tries left.", 400)
            return self._link_form(request_id, pending, "That invite code is not valid or was used.")
        try:
            label, ticket = await anyio.to_thread.run_sync(self.hosting.create, name)
        except Exception as exc:
            self.state.release_invite(invite)
            message = str(exc) if exc.__class__.__name__ == "HostingError" else "Could not create your Dina. Try again."
            return self._link_form(request_id, pending, message)
        pending.cell = label
        pending.invite = invite
        back = f"{self.public_url}/link/done?req={request_id}"
        target = (
            f"{self.hosting.owner_origin(label)}/#ticket={quote(ticket, safe='')}"
            f"&return={quote(back, safe='')}"
        )
        return RedirectResponse(target, status_code=303, headers=_NO_STORE)

    async def link_done(self, request: Request) -> Response:
        """HOSTED_DINA §4 steps 6–7: pair the link once the cell's Core is up."""
        import anyio.to_thread

        request_id = request.query_params.get("req", "")
        pending = self._live_pending(request_id)
        if pending is None or pending.cell == "" or self.hosting is None:
            return _page("This link request has expired. Start again from ChatGPT.", 400)
        label = pending.cell
        state = self.hosting.state(label)
        if state in ("failed", "stopped"):
            # Nobody got this cell's words, so nothing is lost by removing it;
            # the invite goes back so the person can try again.
            self._pending.pop(request_id, None)
            try:
                deleted = await anyio.to_thread.run_sync(self.hosting.delete_unclaimed, label)
            except Exception:
                deleted = False
            if not deleted:
                # Someone's Dina, or not removable now: the invite stays spent.
                return _page("This sign-up did not finish. Open your Dina page, or ask for help.", 400)
            self.state.release_invite(pending.invite)
            return _page("Setting up your Dina failed. Start again from ChatGPT; your invite still works.", 400)
        code = self.hosting.take_bootstrap(label)
        if code is None:
            return _waiting_page("Finishing your Dina…")
        try:
            link_id = await anyio.to_thread.run_sync(self.pair_cell, label, code)
        except BridgeError as exc:
            self._pending.pop(request_id, None)
            return _page(f"{exc} Start again from ChatGPT.", 400)
        return self._finish(request_id, pending, link_id)

    def _finish(self, request_id: str, pending: _Pending, link_id: str) -> Response:
        self._pending.pop(request_id, None)
        code = secrets.token_urlsafe(32)
        params = pending.params
        self._codes[code] = (
            AuthorizationCode(
                code=code,
                client_id=pending.client_id,
                redirect_uri=params.redirect_uri,
                redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
                scopes=[DOT_SCOPE],
                expires_at=time.time() + AUTH_CODE_TTL_SECONDS,
                code_challenge=params.code_challenge,
                resource=params.resource,
            ),
            link_id,
        )
        target = construct_redirect_uri(str(params.redirect_uri), code=code, state=params.state)
        return RedirectResponse(target, status_code=303, headers=_NO_STORE)

    def _link_form(self, request_id: str, pending: _Pending, error: str) -> HTMLResponse:
        return _link_form(
            request_id,
            pending,
            error,
            own=self.homenode_did != "",
            create=self.hosting is not None,
        )

    def _live_pending(self, request_id: str) -> _Pending | None:
        pending = self._pending.get(request_id)
        if pending is None or pending.expires_at < time.time():
            self._pending.pop(request_id, None)
            return None
        return pending

    # ── pairing ────────────────────────────────────────────────────────

    def _config(self) -> Config:
        return Config(
            core_url=self.core_url,
            timeout=30.0,
            device_name=LINK_DEVICE_NAME,
            role="agent",
            msgbox_url=self.msgbox_url,
            homenode_did=self.homenode_did,
            transport_mode=self.transport_mode,
        )

    def _transport(self, identity: CLIIdentity):
        from .transport import select_transport

        return select_transport(
            mode=self.transport_mode,
            core_url=self.core_url or None,
            msgbox_url=self.msgbox_url or None,
            homenode_did=self.homenode_did,
            timeout=15.0,
            identity=identity,
        )

    def pair_link(self, setup_code: str) -> str:
        """Pair a fresh key with Core using the owner's setup code; return the link id."""
        try:
            setup = parse_setup_code(setup_code)
        except SetupCodeError as exc:
            raise BridgeError(f"That setup code is not valid: {exc}.") from exc
        if setup.homenode_did != self.homenode_did:
            raise BridgeError("That setup code is for a different Dina.")
        return self._pair(setup.code, lambda identity: self._transport(identity), {})

    def pair_cell(self, label: str, code: str) -> str:
        """Pair a fresh key with a hosted cell's Core with its dot bootstrap code."""
        return self._pair(code, lambda _identity: self._cell_transport(label), {"kind": "cell", "cell": label})

    def _cell_transport(self, label: str):
        from .transport import UnixSocketTransport

        assert self.hosting is not None
        return UnixSocketTransport(self.hosting.core_socket(label), timeout=30.0)

    def _pair(self, code: str, transport_for, extra: dict) -> str:
        link_id = f"lnk_{secrets.token_hex(8)}"
        link_dir = self.state.link_dir(link_id)
        identity = CLIIdentity(link_dir / "identity")
        try:
            identity.generate()
            body = json.dumps(
                {
                    "code": code,
                    "device_name": LINK_DEVICE_NAME,
                    "public_key_multibase": identity.public_key_multibase(),
                    "role": "agent",
                    # HOSTED_DINA §3.2: the narrowest scope, whatever code the
                    # owner made, so a breached bridge holds keys that do little.
                    "narrow_scope": "dot",
                }
            )
            try:
                resp = transport_for(identity).request(
                    "POST",
                    "/v1/pair/complete",
                    headers={"Content-Type": "application/json"},
                    body=body,
                )
            except Exception as exc:
                raise BridgeError("Dina could not be reached. Try again.") from exc
            if resp.status >= 400:
                raise BridgeError(
                    "Your Dina refused the link."
                    if extra
                    else "Dina refused that code. Make a new one in the app."
                )
            try:
                data = json.loads(resp.body) if resp.body else {}
            except ValueError:
                data = {}
            if data.get("scope") != "dot":
                # A Core too old to narrow gave this key the code's own,
                # wider scope: take it back rather than hold it.
                self._revoke(identity, transport_for(identity))
                raise BridgeError("This Dina is too old to link safely. Update it, then try again.")
        except BaseException:
            shutil.rmtree(link_dir, ignore_errors=True)
            raise
        self.state.put_link(
            link_id,
            {
                "did": identity.did(),
                "device_id": str(data.get("device_id", "")),
                "created_at": int(time.time()),
                **extra,
            },
        )
        return link_id

    @staticmethod
    def _revoke(identity: CLIIdentity, transport: Any) -> bool:
        path = "/v1/devices/self"
        try:
            did, ts, nonce, sig = identity.sign_request("DELETE", path, b"")
            resp = transport.request(
                "DELETE",
                path,
                headers={"X-DID": did, "X-Timestamp": ts, "X-Nonce": nonce, "X-Signature": sig},
                body=None,
            )
            return resp.status in (200, 204, 404)
        except Exception:
            return False

    def unlink(self, link_id: str) -> bool:
        """Revoke the link's device at Core, then forget it. True if Core confirmed."""
        link = self.state.get_link(link_id)
        if link is None:
            raise KeyError(link_id)
        identity = CLIIdentity(self.state.link_dir(link_id) / "identity")
        confirmed = False
        try:
            path = "/v1/devices/self"
            did, ts, nonce, sig = identity.sign_request("DELETE", path, b"")
            transport = (
                self._cell_transport(link["cell"])
                if link.get("kind") == "cell"
                else self._transport(identity)
            )
            resp = transport.request(
                "DELETE",
                path,
                headers={"X-DID": did, "X-Timestamp": ts, "X-Nonce": nonce, "X-Signature": sig},
                body=None,
            )
            confirmed = resp.status in (200, 204, 404)
        except Exception:
            confirmed = False
        with self._clients_lock:
            client = self._clients.pop(link_id, None)
        if client is not None:
            client.close()
        self.state.drop_link(link_id)
        shutil.rmtree(self.state.link_dir(link_id), ignore_errors=True)
        return confirmed

    def client_for_link(self, link_id: str) -> DinaClient:
        link = self.state.get_link(link_id)
        if link is None:
            raise DinaClientError("this ChatGPT link was removed; link it again")
        if link.get("kind") == "cell":
            # HOSTED_DINA §7: a locked cell answers in words the dot can pass on.
            label = str(link.get("cell", ""))
            if self.hosting is None or self.hosting.state(label) != "unlocked":
                where = self.hosting.owner_origin(label) if self.hosting is not None else ""
                raise DinaClientError(
                    f"Your Dina is locked. Open your Dina page to unlock it: {where}".rstrip(": ")
                )
        with self._clients_lock:
            client = self._clients.get(link_id)
            if client is None:
                identity = CLIIdentity(self.state.link_dir(link_id) / "identity")
                transport = (
                    self._cell_transport(str(link["cell"])) if link.get("kind") == "cell" else None
                )
                client = DinaClient(self._config(), identity=identity, transport=transport)
                self._clients[link_id] = client
            return client

    def current_client(self) -> DinaClient:
        """The resolver mcp_server uses: the caller's link, from its bearer token."""
        token = get_access_token()
        link_id = token.claims.get("link_id") if token is not None else None
        if not isinstance(link_id, str):
            raise DinaClientError("not linked; sign in from ChatGPT first")
        return self.client_for_link(link_id)

    # ── codes and tokens ───────────────────────────────────────────────

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        entry = self._codes.get(authorization_code)
        if entry is None:
            return None
        code, _ = entry
        if code.client_id != client.client_id or code.expires_at < time.time():
            self._codes.pop(authorization_code, None)
            return None
        return code

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        entry = self._codes.pop(authorization_code.code, None)
        if entry is None:
            raise TokenError("invalid_grant", "authorization code already used")
        return self._issue(client.client_id or "", entry[1], secrets.token_hex(8))

    def _issue(self, client_id: str, link_id: str, family: str) -> OAuthToken:
        now = time.time()
        access = f"dda_{secrets.token_urlsafe(32)}"
        refresh = f"ddr_{secrets.token_urlsafe(32)}"
        base = {"client_id": client_id, "link_id": link_id, "family": family}
        self.state.put_tokens(
            {
                access: {**base, "kind": "access", "expires_at": now + ACCESS_TOKEN_TTL_SECONDS},
                refresh: {**base, "kind": "refresh", "expires_at": now + REFRESH_TOKEN_TTL_SECONDS},
            }
        )
        return OAuthToken(
            access_token=access,
            token_type="Bearer",
            expires_in=ACCESS_TOKEN_TTL_SECONDS,
            refresh_token=refresh,
            scope=DOT_SCOPE,
        )

    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> RefreshToken | None:
        record = self.state.get_token(refresh_token, "refresh")
        if record is None or record["client_id"] != client.client_id:
            return None
        return RefreshToken(
            token=refresh_token,
            client_id=record["client_id"],
            scopes=[DOT_SCOPE],
            expires_at=int(record["expires_at"]),
        )

    async def exchange_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: RefreshToken,
        scopes: list[str],
    ) -> OAuthToken:
        if set(scopes) - {DOT_SCOPE}:
            raise TokenError("invalid_scope", f"scope must be {DOT_SCOPE}")
        record = self.state.get_token(refresh_token.token, "refresh")
        if record is None:
            raise TokenError("invalid_grant", "refresh token is no longer valid")
        # Rotate: the old pair dies with the new one's birth.
        self.state.drop_tokens(family=record["family"])
        return self._issue(record["client_id"], record["link_id"], secrets.token_hex(8))

    async def load_access_token(self, token: str) -> AccessToken | None:  # type: ignore[override]
        record = self.state.get_token(token, "access")
        if record is None:
            return None
        return AccessToken(
            token=token,
            client_id=record["client_id"],
            scopes=[DOT_SCOPE],
            expires_at=int(record["expires_at"]),
            claims={"link_id": record["link_id"]},
        )

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        kind = "access" if isinstance(token, AccessToken) else "refresh"
        record = self.state.get_token(token.token, kind)
        if record is not None:
            self.state.drop_tokens(family=record["family"])


# ── the link page ──────────────────────────────────────────────────────

_NO_STORE = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}
_PAGE_HEADERS = {
    **_NO_STORE,
    # No form-action: the POST answers with a redirect to ChatGPT, which
    # form-action would block in Chromium.
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
}
_STYLE = (
    "body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 16px;"
    "color:#1d2433;background:#f7f8fa}h1{font-size:1.4rem}textarea{width:100%;font:14px monospace;"
    "box-sizing:border-box}button{font-size:1rem;padding:.5rem 1.2rem}.err{color:#a3261a}"
    ".who{background:#fff;border:1px solid #d8dce3;padding:.75rem 1rem;border-radius:6px}"
)


def _page(message: str, status: int) -> HTMLResponse:
    body = (
        f"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
        f"<title>Link to Dina</title><style>{_STYLE}</style><h1>Link to Dina</h1>"
        f"<p>{html.escape(message)}</p>"
    )
    return HTMLResponse(body, status_code=status, headers=_PAGE_HEADERS)


def _waiting_page(message: str) -> HTMLResponse:
    body = (
        f"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
        f"<meta http-equiv=refresh content=2><title>Link to Dina</title><style>{_STYLE}</style>"
        f"<h1>Link to Dina</h1><p>{html.escape(message)}</p>"
    )
    return HTMLResponse(body, status_code=200, headers=_PAGE_HEADERS)


def _link_form(
    request_id: str,
    pending: _Pending,
    error: str,
    *,
    own: bool = True,
    create: bool = False,
) -> HTMLResponse:
    host = urlparse(str(pending.params.redirect_uri)).hostname or ""
    name = pending.client_name or "An app"
    err = f"<p class=err>{html.escape(error)}</p>" if error else ""
    req = html.escape(request_id, quote=True)
    create_form = (
        f"<h2>Create my Dina</h2>"
        f"<p>We run a Dina for you. Only your passphrase opens it, and you can move it "
        f"to your own phone or server at any time.</p>"
        f"<form method=post action=/link><input type=hidden name=req value='{req}'>"
        f"<input type=hidden name=action value=create>"
        f"<p><label>Invite code<br><input name=invite required autocomplete=off></label></p>"
        f"<p><label>Your name or your business's<br><input name=display_name required "
        f"maxlength=60 autocomplete=off></label></p>"
        f"<p><button type=submit>Create my Dina</button></p></form>"
        if create
        else ""
    )
    own_form = (
        f"<h2>I have a Dina</h2>"
        f"<p>In the Dina app, open Settings → Agents, make a setup code, and paste it here.</p>"
        f"<form method=post action=/link><input type=hidden name=req value='{req}'>"
        f"<input type=hidden name=action value=own>"
        f"<textarea name=setup_code rows=4 required autocomplete=off "
        f"placeholder='dina1:…'></textarea><p><button type=submit>Link</button></p></form>"
        if own
        else ""
    )
    body = (
        f"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
        f"<title>Link to Dina</title><style>{_STYLE}</style><h1>Link to Dina</h1>"
        f"<p class=who><b>{html.escape(name)}</b> at <b>{html.escape(host)}</b> wants to act "
        f"for you as an agent. It can draft tenders and read how they go. It cannot see "
        f"prices, your limits or your vault, and it cannot open a tender or pay.</p>"
        f"{err}{create_form}{own_form}"
    )
    return HTMLResponse(body, status_code=400 if error else 200, headers=_PAGE_HEADERS)


# ── wiring ─────────────────────────────────────────────────────────────


def build_bridge_server(bridge: DotBridge):
    """Attach the bridge to the shared MCP server under the `dot` profile."""
    from . import mcp_server

    mcp_server.configure_profile("dot")
    mcp_server.mcp.auth = bridge
    mcp_server.set_client_resolver(bridge.current_client)
    mcp_server.mcp.custom_route("/link", methods=["GET", "POST"])(bridge.link_page)
    mcp_server.mcp.custom_route("/link/done", methods=["GET"])(bridge.link_done)
    return mcp_server.mcp


def run_bridge(bridge: DotBridge, host: str, port: int) -> None:
    server = build_bridge_server(bridge)
    server.run(transport="http", host=host, port=port, path="/mcp")
