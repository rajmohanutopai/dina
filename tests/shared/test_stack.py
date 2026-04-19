"""Shared service locator for the prepared test stack.

Reads .test-stack.json written by prepare_non_unit_env.sh.
Provides URLs, tokens, key extraction, agent exec, and assert_ready().

Does NOT:
  - run docker compose
  - allocate ports
  - rebuild images
  - silently start missing services
"""

from __future__ import annotations

import json
import socket
import subprocess
from pathlib import Path
from urllib.parse import urlparse

import httpx


class TestStackServices:
    """Runtime accessor for the prepared test stack."""

    def __init__(self, manifest_path: str = ".test-stack.json") -> None:
        with open(manifest_path) as f:
            self._manifest = json.load(f)

    # --- Actor URLs ---

    def core_url(self, actor: str) -> str:
        return self._manifest["actors"][actor]["core"]

    def brain_url(self, actor: str) -> str:
        return self._manifest["actors"][actor]["brain"]

    # --- Service URLs ---

    @property
    def plc_url(self) -> str:
        return self._manifest["services"]["plc"]

    @property
    def pds_url(self) -> str:
        return self._manifest["services"]["pds"]

    @property
    def postgres_dsn(self) -> str:
        return self._manifest["services"]["postgres"]

    @property
    def appview_url(self) -> str:
        return self._manifest["services"]["appview"]

    # --- Tokens ---

    @property
    def client_token(self) -> str:
        path = self._manifest["secrets"]["client_token"]
        return Path(path).read_text().strip()

    # --- Key extraction (for Brain service-key signing in tests) ---

    def core_private_key(self, actor: str) -> bytes:
        """Read Core's Ed25519 private key from the actor's secrets directory.

        Layout: secrets/service_keys/{actor}/core_ed25519_private.pem
        Matches install.sh key provisioning and Docker volume mounts.
        """
        key_dir = self._manifest["secrets"][f"{actor}_keys"]
        pem_path = Path(key_dir) / "core_ed25519_private.pem"
        if not pem_path.exists():
            # Fallback: extract from running container (current E2E pattern).
            project = self._manifest["project"]
            compose_file = self._manifest["compose_file"]
            result = subprocess.run(
                [
                    "docker", "compose", "-p", project, "-f", compose_file,
                    "exec", f"{actor}-core",
                    "cat", "/run/secrets/service_keys/private/core_ed25519_private.pem",
                ],
                capture_output=True,
                timeout=10,
            )
            if result.returncode == 0:
                return result.stdout
            raise FileNotFoundError(
                f"Cannot find Core private key for {actor}: {pem_path}"
            )
        return pem_path.read_bytes()

    # --- Agent exec (for release tests) ---

    def agent_exec(self, cmd: list[str]) -> subprocess.CompletedProcess:
        """Run a command inside the dummy-agent container.

        Note: this is the ONLY Docker exec allowed from test code.
        It does not manage lifecycle — just runs a command in the
        already-prepared container.
        """
        project = self._manifest["project"]
        compose_file = self._manifest["compose_file"]
        return subprocess.run(
            [
                "docker", "compose", "-p", project, "-f", compose_file,
                "exec", "dummy-agent",
            ] + cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )

    # --- Actor DIDs (dynamic, from real PLC-registered identities) ---

    def actor_did(self, actor: str, retries: int = 3, delay: float = 1.0) -> str:
        """Return the real PLC-registered DID for an actor.

        Try the running Core first (fast, 3 retries). If unavailable,
        fall back to the committed fixture file.
        """
        import time
        url = self.core_url(actor)
        for attempt in range(retries):
            try:
                headers = {"Authorization": f"Bearer {self.client_token}"}
                resp = httpx.get(f"{url}/v1/did", headers=headers, timeout=5)
                if resp.status_code == 200:
                    data = resp.json()
                    did = data.get("did") or data.get("id") or ""
                    if did.startswith("did:"):
                        return did
            except (httpx.ConnectError, httpx.TimeoutException):
                pass
            if attempt < retries - 1:
                time.sleep(delay)

        # Fallback: read from fixture file
        fixture_path = Path(__file__).resolve().parent.parent / "fixtures" / "test_actors.json"
        if fixture_path.exists():
            import json as _json
            actors = _json.loads(fixture_path.read_text()).get("actors", {})
            if actor in actors:
                return actors[actor]["did"]

        raise RuntimeError(
            f"Could not fetch DID for actor '{actor}' from {url}/v1/did "
            f"and no fixture file found"
        )

    # --- Actors ---

    @property
    def actors(self) -> list[str]:
        return list(self._manifest["actors"].keys())

    # --- Health ---

    def assert_ready(self) -> None:
        """Verify ALL declared services are responding. Raises if not.

        Checks every actor (Core + Brain) and every infrastructure
        service (PLC, PDS, Postgres, AppView). Matches the same set
        that prepare_non_unit_env.sh health-checks.
        """
        # Actor nodes
        for actor, urls in self._manifest["actors"].items():
            r = httpx.get(f"{urls['core']}/healthz", timeout=5)
            assert r.status_code == 200, f"{actor} Core not healthy: {r.status_code}"
            r = httpx.get(f"{urls['brain']}/healthz", timeout=5)
            assert r.status_code == 200, f"{actor} Brain not healthy: {r.status_code}"

        # Infrastructure (HTTP services)
        health_paths = {
            "pds": "/xrpc/_health",
            "plc": "/_health",  # plc.directory exposes /_health, not /healthz
            "appview": "/health",
        }
        for name, url in self._manifest["services"].items():
            if name == "postgres":
                continue  # checked below
            health = health_paths.get(name, "/healthz")
            r = httpx.get(f"{url}{health}", timeout=5)
            assert r.status_code == 200, f"{name} not healthy: {r.status_code}"

        # Postgres (TCP connect check — no psycopg2 dependency)
        dsn = self._manifest["services"].get("postgres", "")
        if dsn:
            parsed = urlparse(dsn)
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5)
            try:
                sock.connect((parsed.hostname or "localhost", parsed.port or 5432))
                sock.close()
            except (ConnectionRefusedError, OSError) as exc:
                raise AssertionError(f"Postgres not reachable: {exc}") from exc
