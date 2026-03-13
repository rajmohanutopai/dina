"""System test fixtures — all services real, zero mocks.

Brings up 2 Core+Brain pairs + PLC + PDS + Jetstream + AppView (full stack)
via Docker Compose. Seeds AppView Postgres with test data for trust queries.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from cryptography.hazmat.primitives.serialization import load_pem_private_key

# ---------------------------------------------------------------------------
# Paths & ports
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
COMPOSE_FILE = PROJECT_ROOT / "docker-compose-system.yml"
SECRETS_DIR = PROJECT_ROOT / "secrets"

HEALTH_TIMEOUT = 240  # seconds
HEALTH_INTERVAL = 0.5  # seconds

# Default port base — overridable by shell via PORT_* env vars.
_DEFAULT_PORT_BASE = 19300


def _port_free(port: int) -> bool:
    """Check if a TCP port is free on localhost."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.settimeout(0.5)
        s.connect(("localhost", port))
        s.close()
        return False
    except (ConnectionRefusedError, OSError):
        return True


def _allocate_ports(base: int | None = None) -> dict[str, int]:
    """Find a free port base and compute all port assignments.

    Scans from *base* (default 19300), stepping by 500 until the base port
    is free.  Returns a dict matching the PORTS layout.
    """
    if base is None:
        base = int(os.environ.get("PORT_CORE_ALONSO", str(_DEFAULT_PORT_BASE)))

    for _ in range(40):
        if _port_free(base):
            break
        base += 500

    ports = {
        "core_alonso": base,
        "core_sancho": base + 1,
        "brain_alonso": base + 100,
        "brain_sancho": base + 101,
        "postgres": base + 132,
        "appview_web": base + 200,
        "plc": base + 300,
        "pds": base + 301,
        "jetstream": base + 302,
    }

    # Push into env so Docker Compose picks them up.
    _env_keys = {
        "core_alonso": "PORT_CORE_ALONSO",
        "core_sancho": "PORT_CORE_SANCHO",
        "brain_alonso": "PORT_BRAIN_ALONSO",
        "brain_sancho": "PORT_BRAIN_SANCHO",
        "postgres": "PORT_POSTGRES",
        "appview_web": "PORT_APPVIEW",
        "plc": "PORT_PLC",
        "pds": "PORT_PDS",
        "jetstream": "PORT_JETSTREAM",
    }
    for key, env_var in _env_keys.items():
        os.environ[env_var] = str(ports[key])

    return ports


# Initial allocation.
PORTS = _allocate_ports()

# Hardcoded test token — matches DINA_CLIENT_TOKEN in docker-compose-system.yml.
# Used as bearer auth for Core admin/client endpoints.
_SYSTEM_TEST_TOKEN = "test-system-admin-token"


# ---------------------------------------------------------------------------
# Docker lifecycle
# ---------------------------------------------------------------------------

class SystemServices:
    """Manages the Docker Compose stack for system tests."""

    def __init__(self) -> None:
        self._started = False
        self.admin_token = _SYSTEM_TEST_TOKEN

    # -- URL accessors --

    def core_url(self, actor: str) -> str:
        return f"http://localhost:{PORTS[f'core_{actor}']}"

    def brain_url(self, actor: str) -> str:
        return f"http://localhost:{PORTS[f'brain_{actor}']}"

    @property
    def appview_url(self) -> str:
        return f"http://localhost:{PORTS['appview_web']}"

    @property
    def pds_url(self) -> str:
        return f"http://localhost:{PORTS['pds']}"

    @property
    def plc_url(self) -> str:
        return f"http://localhost:{PORTS['plc']}"

    @property
    def jetstream_url(self) -> str:
        return f"http://localhost:{PORTS['jetstream']}"

    @property
    def postgres_dsn(self) -> str:
        return f"postgresql://dina:dina@localhost:{PORTS['postgres']}/dina_trust"

    # -- Lifecycle --

    def start(self, restart: bool = False) -> None:
        global PORTS

        if restart:
            print("\n  [system] Tearing down existing stack (restart)...")
            self._compose("down", "-v")

        # Try up to 5 times — on port conflict, re-allocate and retry immediately.
        for attempt in range(5):
            base = PORTS["core_alonso"]
            print(
                f"  [system] Starting system stack "
                f"(ports {base}+, attempt {attempt + 1})..."
            )
            up_args = ["up", "-d"] if os.environ.get("DINA_SKIP_DOCKER_BUILD") == "1" else ["up", "--build", "-d"]
            result = self._compose(*up_args)
            if result.returncode == 0:
                break

            stderr = (result.stderr or "").lower()
            if "port is already allocated" in stderr or "address already in use" in stderr or "bind for" in stderr:
                print(f"  [system] Port conflict on base {base} — re-allocating...")
                self._compose("down", "-v")
                PORTS = _allocate_ports(base + 500)
                continue

            raise RuntimeError(
                f"docker compose up failed (exit {result.returncode}):\n"
                f"{(result.stderr or '')[-1000:]}"
            )
        else:
            raise RuntimeError("Failed to start system stack after 5 port re-allocations")

        self._wait_for_health()
        self._started = True
        print("  [system] All services healthy.")

    def stop(self) -> None:
        if self._started:
            self._save_llm_usage()
            print("\n  [system] Stopping system stack...")
            self._compose("down", "-v")
            print("  [system] Stack stopped.")

    def _save_llm_usage(self) -> None:
        """Collect LLM usage from Brain healthz before teardown."""
        cost_dir = os.environ.get("DINA_LLM_COST_DIR")
        if not cost_dir:
            return
        total = {"total_calls": 0, "total_tokens_in": 0, "total_tokens_out": 0, "total_cost_usd": 0.0}
        for actor in ("alonso", "sancho"):
            try:
                r = httpx.get(f"{self.brain_url(actor)}/healthz", timeout=5)
                usage = r.json().get("llm_usage", {})
                total["total_calls"] += usage.get("total_calls", 0)
                total["total_tokens_in"] += usage.get("total_tokens_in", 0)
                total["total_tokens_out"] += usage.get("total_tokens_out", 0)
                total["total_cost_usd"] += usage.get("total_cost_usd", 0.0)
            except Exception:
                pass
        if total["total_calls"] > 0:
            os.makedirs(cost_dir, exist_ok=True)
            with open(os.path.join(cost_dir, "system.json"), "w") as f:
                json.dump(total, f)

    def _compose(self, *args: str) -> subprocess.CompletedProcess:
        # Use COMPOSE_PROJECT_NAME from env (set by run_user_story_tests.sh)
        # or fall back to "dina-system" for isolation from other stacks.
        project = os.environ.get("COMPOSE_PROJECT_NAME", "dina-system")
        cmd = ["docker", "compose", "-p", project, "-f", str(COMPOSE_FILE)] + list(args)
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
            cwd=str(PROJECT_ROOT),
        )

    def _all_healthy(self) -> bool:
        """Quick probe of all service endpoints in parallel."""
        from concurrent.futures import ThreadPoolExecutor, as_completed

        checks = [
            (self.core_url("alonso") + "/healthz", "core-alonso"),
            (self.core_url("sancho") + "/healthz", "core-sancho"),
            (self.brain_url("alonso") + "/healthz", "brain-alonso"),
            (self.brain_url("sancho") + "/healthz", "brain-sancho"),
            (self.appview_url + "/health", "appview-web"),
            (self.plc_url + "/healthz", "plc"),
            (self.pds_url + "/xrpc/_health", "pds"),
        ]

        def _http_ok(url: str) -> bool:
            try:
                r = httpx.get(url, timeout=3)
                return r.status_code == 200
            except Exception:
                return False

        with ThreadPoolExecutor(max_workers=len(checks) + 2) as pool:
            futures = {pool.submit(_http_ok, url): label for url, label in checks}
            futures[pool.submit(self._tcp_probe, "localhost", PORTS["postgres"])] = "postgres"
            futures[pool.submit(self._tcp_probe, "localhost", PORTS["jetstream"])] = "jetstream"
            for fut in as_completed(futures):
                if not fut.result():
                    return False
        return True

    def _tcp_probe(self, host: str, port: int) -> bool:
        try:
            sock = socket.create_connection((host, port), timeout=3)
            sock.close()
            return True
        except (OSError, ConnectionRefusedError):
            return False

    def extract_core_private_key(self, actor: str = "alonso") -> bytes:
        """Extract Core's Ed25519 private key PEM from a running container."""
        result = self._compose(
            "exec", "-T", f"core-{actor}",
            "cat", "/run/secrets/service_keys/private/core_ed25519_private.pem",
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to extract core private key: {result.stderr[:200]}"
            )
        return result.stdout.encode() if isinstance(result.stdout, str) else result.stdout

    def _wait_for_health(self) -> None:
        deadline = time.time() + HEALTH_TIMEOUT
        while time.time() < deadline:
            if self._all_healthy():
                return
            remaining = int(deadline - time.time())
            print(f"  [system] Waiting for services... ({remaining}s remaining)")
            time.sleep(HEALTH_INTERVAL)
        raise TimeoutError(
            f"System services not healthy after {HEALTH_TIMEOUT}s"
        )


# ---------------------------------------------------------------------------
# Session fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def system_services():
    """Start the full Docker stack for the test session."""
    svc = SystemServices()
    # Default: always restart to ensure tests run against latest code.
    # Set SYSTEM_RESTART=0 to skip tear-down and reuse running containers.
    restart = os.environ.get("SYSTEM_RESTART", "1") != "0"
    svc.start(restart=restart)
    yield svc
    svc.stop()


class BrainSigner:
    """Ed25519 request signer for calling Brain API endpoints directly.

    Loads Core's private key from the running Docker container and signs
    requests using the canonical payload format that Brain verifies.
    """

    def __init__(self, private_key_pem: bytes) -> None:
        key = load_pem_private_key(private_key_pem, password=None)
        self._private_key = key

    def _sign(self, method: str, path: str, body: bytes, query: str = "") -> dict[str, str]:
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        body_hash = hashlib.sha256(body).hexdigest()
        payload = f"{method}\n{path}\n{query}\n{timestamp}\n{body_hash}"
        signature = self._private_key.sign(payload.encode("utf-8"))
        return {
            "X-DID": "did:key:zSystemTestSigner",
            "X-Timestamp": timestamp,
            "X-Signature": signature.hex(),
        }

    def post(self, url: str, *, json: dict | None = None, timeout: int = 30) -> httpx.Response:
        """POST with Ed25519 signed headers — drop-in replacement for httpx.post."""
        import json as _json
        body = _json.dumps(json).encode() if json is not None else b""
        # Extract path from URL for signature
        parsed = httpx.URL(url)
        path = parsed.raw_path.decode("ascii")
        headers = self._sign("POST", path, body)
        headers["Content-Type"] = "application/json"
        return httpx.post(url, content=body, headers=headers, timeout=timeout)


@pytest.fixture(scope="session")
def brain_headers(system_services):
    """Bearer auth for Core vault/admin endpoints.

    Brain API endpoints now require Ed25519 — use brain_signer fixture instead.
    """
    return {"Authorization": f"Bearer {system_services.admin_token}"}


@pytest.fixture(scope="session")
def admin_headers(system_services):
    """Bearer auth for Core admin endpoints (persona, unlock, etc.)."""
    return {"Authorization": f"Bearer {system_services.admin_token}"}


@pytest.fixture(scope="session")
def brain_signer(system_services) -> BrainSigner:
    """Ed25519 signer for direct Brain API calls.

    Extracts Core's private key from the running Docker container and returns
    a BrainSigner that can sign POST requests to Brain's /api/v1/* endpoints.

    Usage in tests:
        r = brain_signer.post(f"{alonso_brain}/api/v1/reason", json={...}, timeout=60)
    """
    pem = system_services.extract_core_private_key("alonso")
    return BrainSigner(pem)


# ---------------------------------------------------------------------------
# Persona setup (session-scoped, runs once)
# ---------------------------------------------------------------------------

PERSONAS = ["personal", "consumer", "health"]


@pytest.fixture(scope="session", autouse=True)
def setup_personas(system_services, admin_headers, brain_headers):
    """Create and unlock personas on both Core nodes, clear vaults."""
    for actor in ("alonso", "sancho"):
        base = system_services.core_url(actor)
        for name in PERSONAS:
            # Create (idempotent — ignores "already exists")
            try:
                httpx.post(
                    f"{base}/v1/personas",
                    json={"name": name, "tier": "restricted" if name == "health" else "open", "passphrase": "test"},
                    headers=admin_headers,
                    timeout=10,
                )
            except Exception:
                pass
            # Unlock
            try:
                httpx.post(
                    f"{base}/v1/persona/unlock",
                    json={"persona": name, "passphrase": "test"},
                    headers=admin_headers,
                    timeout=10,
                )
            except Exception:
                pass
        # Clear vaults for clean test state
        for name in PERSONAS:
            try:
                httpx.post(
                    f"{base}/v1/vault/clear",
                    json={"persona": name},
                    headers=brain_headers,
                    timeout=10,
                )
            except Exception:
                pass


# ---------------------------------------------------------------------------
# AppView data seeding
# ---------------------------------------------------------------------------

def _seed_appview(dsn: str) -> dict:
    """Insert test data directly into AppView Postgres.

    Returns dict of created IDs for test assertions.
    """
    try:
        import psycopg2
    except ImportError:
        pytest.skip("psycopg2 not installed — skipping AppView seed")

    now = datetime.now(timezone.utc)
    ids: dict = {}

    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    cur = conn.cursor()

    # Subjects
    subj_alonso = f"subj_{uuid.uuid4().hex[:12]}"
    subj_sancho = f"subj_{uuid.uuid4().hex[:12]}"
    ids["subject_alonso"] = subj_alonso
    ids["subject_sancho"] = subj_sancho

    for sid, name, did in [
        (subj_alonso, "Don Alonso", "did:plc:alonso"),
        (subj_sancho, "Sancho Panza", "did:plc:sancho"),
    ]:
        cur.execute(
            """INSERT INTO subjects (id, name, subject_type, did, identifiers_json, needs_recalc, created_at, updated_at)
               VALUES (%s, %s, 'did', %s, '[]'::jsonb, true, %s, %s)
               ON CONFLICT (id) DO NOTHING""",
            (sid, name, did, now, now),
        )

    # DID profiles
    for did, score in [("did:plc:alonso", 0.85), ("did:plc:sancho", 0.72)]:
        cur.execute(
            """INSERT INTO did_profiles (did, needs_recalc, total_attestations_about, positive_about, overall_trust_score, computed_at)
               VALUES (%s, false, 5, 4, %s, %s)
               ON CONFLICT (did) DO NOTHING""",
            (did, score, now),
        )

    # Attestations
    att1_uri = f"at://did:plc:alonso/com.dina.trust.attestation/{uuid.uuid4().hex[:12]}"
    att2_uri = f"at://did:plc:sancho/com.dina.trust.attestation/{uuid.uuid4().hex[:12]}"
    ids["attestation_1"] = att1_uri
    ids["attestation_2"] = att2_uri

    for uri, author, subj_id, sentiment in [
        (att1_uri, "did:plc:alonso", subj_sancho, "positive"),
        (att2_uri, "did:plc:sancho", subj_alonso, "positive"),
    ]:
        cur.execute(
            """INSERT INTO attestations (uri, author_did, cid, subject_id, subject_ref_raw, category, sentiment, record_created_at, indexed_at, search_content)
               VALUES (%s, %s, %s, %s, %s::jsonb, 'quality', %s, %s, %s, %s)
               ON CONFLICT (uri) DO NOTHING""",
            (
                uri, author,
                f"bafyrei{uuid.uuid4().hex[:40]}",
                subj_id,
                '{"type": "did", "did": "' + author + '"}',
                sentiment, now, now,
                f"Test attestation from {author}",
            ),
        )

    # Trust edges (schema: id, from_did, to_did, edge_type, weight, source_uri, created_at)
    for src, tgt, kind, uri in [
        ("did:plc:alonso", "did:plc:sancho", "vouch", att1_uri),
        ("did:plc:sancho", "did:plc:alonso", "attestation", att2_uri),
    ]:
        edge_id = f"edge_{uuid.uuid4().hex[:12]}"
        cur.execute(
            """INSERT INTO trust_edges (id, from_did, to_did, edge_type, weight, source_uri, created_at)
               VALUES (%s, %s, %s, %s, 1.0, %s, %s)
               ON CONFLICT DO NOTHING""",
            (edge_id, src, tgt, kind, uri, now),
        )

    cur.close()
    conn.close()
    return ids


def _clear_appview(dsn: str) -> None:
    """Truncate seeded tables for clean state."""
    try:
        import psycopg2
    except ImportError:
        return
    try:
        conn = psycopg2.connect(dsn)
        conn.autocommit = True
        cur = conn.cursor()
        for table in ("trust_edges", "attestations", "did_profiles", "subjects"):
            cur.execute(f"DELETE FROM {table}")
        cur.close()
        conn.close()
    except Exception:
        pass


@pytest.fixture(scope="session", autouse=True)
def seed_appview(system_services):
    """Seed AppView Postgres with test trust data."""
    dsn = system_services.postgres_dsn
    _clear_appview(dsn)
    ids = _seed_appview(dsn)
    yield ids
    _clear_appview(dsn)


# ---------------------------------------------------------------------------
# URL shortcuts
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def alonso_core(system_services):
    return system_services.core_url("alonso")


@pytest.fixture(scope="session")
def sancho_core(system_services):
    return system_services.core_url("sancho")


@pytest.fixture(scope="session")
def alonso_brain(system_services):
    return system_services.brain_url("alonso")


@pytest.fixture(scope="session")
def sancho_brain(system_services):
    return system_services.brain_url("sancho")


@pytest.fixture(scope="session")
def appview(system_services):
    return system_services.appview_url


@pytest.fixture(scope="session")
def pds_url(system_services):
    return system_services.pds_url


# ---------------------------------------------------------------------------
# PDS account helpers
# ---------------------------------------------------------------------------


def _create_pds_account(
    pds_url: str, email: str, handle: str, password: str
) -> tuple[str, str]:
    """Create or login to a PDS account. Returns (did, accessJwt)."""
    r = httpx.post(
        f"{pds_url}/xrpc/com.atproto.server.createAccount",
        json={"email": email, "password": password, "handle": handle},
        timeout=15,
    )
    if r.status_code == 200:
        data = r.json()
        return data["did"], data["accessJwt"]
    # Account may already exist from a previous run — try login
    login_r = httpx.post(
        f"{pds_url}/xrpc/com.atproto.server.createSession",
        json={"identifier": email, "password": password},
        timeout=15,
    )
    if login_r.status_code == 200:
        data = login_r.json()
        return data["did"], data["accessJwt"]
    raise RuntimeError(
        f"Failed to create/login PDS account ({handle}): "
        f"create={r.status_code} {r.text[:200]}, "
        f"login={login_r.status_code} {login_r.text[:200]}"
    )


# ---------------------------------------------------------------------------
# PDS account fixtures (session-scoped)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def pds_account(system_services):
    """Create pipeline test account on the local PDS. Returns (did, access_jwt)."""
    return _create_pds_account(
        system_services.pds_url, "tester@dina.test", "tester.test", "test-pw-system"
    )


@pytest.fixture(scope="session")
def pds_auth_headers(pds_account):
    """Authorization headers for the PDS test account."""
    _, jwt = pds_account
    return {"Authorization": f"Bearer {jwt}"}


@pytest.fixture(scope="session")
def reviewer_alice(system_services):
    """Create reviewer Alice's PDS account. Returns (did, access_jwt)."""
    return _create_pds_account(
        system_services.pds_url, "alice@dina.test", "alice.test", "test-pw-alice"
    )


@pytest.fixture(scope="session")
def reviewer_bob(system_services):
    """Create reviewer Bob's PDS account. Returns (did, access_jwt)."""
    return _create_pds_account(
        system_services.pds_url, "bob@dina.test", "bob.test", "test-pw-bob"
    )


@pytest.fixture(scope="session")
def reviewer_charlie(system_services):
    """Create unverified reviewer Charlie's PDS account. Returns (did, access_jwt)."""
    return _create_pds_account(
        system_services.pds_url, "charlie@dina.test", "charlie.test", "test-pw-charlie"
    )


@pytest.fixture(scope="session")
def reviewer_diana(system_services):
    """Create reviewer Diana's PDS account (verified via vouch from Alice)."""
    return _create_pds_account(
        system_services.pds_url, "diana@dina.test", "diana.test", "test-pw-diana"
    )


@pytest.fixture(scope="session")
def reviewer_eve(system_services):
    """Create unverified reviewer Eve's PDS account. Returns (did, access_jwt)."""
    return _create_pds_account(
        system_services.pds_url, "eve@dina.test", "eve.test", "test-pw-eve"
    )


# ---------------------------------------------------------------------------
# Failure diagnostic hook — dump recent audit/reasoning traces on test failure
# ---------------------------------------------------------------------------

@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """On test failure, fetch recent audit traces from Core and print them.

    This gives immediate visibility into what Brain did during a failed test,
    making it possible to debug reasoning path regressions without
    re-running with extra logging.
    """
    outcome = yield
    report = outcome.get_result()

    if report.when != "call" or not report.failed:
        return

    # Try to get system_services from the test's fixtures
    services = None
    for fixture_name in ("system_services",):
        if fixture_name in item.funcargs:
            services = item.funcargs[fixture_name]
            break

    if services is None:
        return

    # Fetch recent audit traces from both Core nodes
    print("\n" + "=" * 80)
    print("  AUDIT TRACE DUMP (last 10 entries per node)")
    print("=" * 80)

    for actor in ("alonso", "sancho"):
        core_url = services.core_url(actor)
        admin_token = services.admin_token
        try:
            resp = httpx.get(
                f"{core_url}/v1/audit/query",
                params={"action": "reason_trace", "limit": "10"},
                headers={"Authorization": f"Bearer {admin_token}"},
                timeout=5,
            )
            if resp.status_code == 200:
                data = resp.json()
                entries = data.get("entries", [])
                if entries:
                    print(f"\n  [{actor}] {len(entries)} reason_trace entries:")
                    for e in entries:
                        ts = e.get("timestamp", "?")
                        persona = e.get("persona", "?")
                        reason = e.get("reason", "")
                        meta_raw = e.get("metadata", "{}")
                        try:
                            meta = json.loads(meta_raw)
                            prompt_p = meta.get("prompt_preview", "")[:80]
                            resp_p = meta.get("response_preview", "")[:80]
                            tools = [t.get("name", "?") for t in meta.get("tools_called", [])]
                            vault_used = meta.get("vault_context_used", "?")
                            model = meta.get("model", "?")
                        except (json.JSONDecodeError, TypeError):
                            prompt_p = resp_p = ""
                            tools = []
                            vault_used = "?"
                            model = "?"
                        print(f"    [{ts}] persona={persona} model={model}")
                        print(f"      reason: {reason}")
                        print(f"      vault_used={vault_used} tools={tools}")
                        if prompt_p:
                            print(f"      prompt: {prompt_p}...")
                        if resp_p:
                            print(f"      response: {resp_p}...")
                        print()
                else:
                    print(f"\n  [{actor}] No reason_trace entries found.")
            else:
                print(f"\n  [{actor}] Audit query returned {resp.status_code}")
        except Exception as exc:
            print(f"\n  [{actor}] Failed to fetch audit traces: {exc}")

    print("=" * 80)
