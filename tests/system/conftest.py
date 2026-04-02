"""System test fixtures — all services real, zero mocks.

Uses the pre-started union test stack (prepare_non_unit_env.sh).
Seeds AppView Postgres with test data for trust queries.
"""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from datetime import datetime, timezone

import httpx
import pytest
from cryptography.hazmat.primitives.serialization import load_pem_private_key

from tests.shared.test_stack import TestStackServices


# ---------------------------------------------------------------------------
# Session fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def system_services():
    """Locate the pre-started test stack for system testing.

    Reads .test-stack.json written by prepare_non_unit_env.sh.
    Does NOT manage Docker lifecycle.
    """
    svc = TestStackServices()
    svc.assert_ready()
    yield svc


class BrainSigner:
    """Ed25519 request signer for calling Brain API endpoints directly.

    Loads Core's private key from the running Docker container and signs
    requests using the canonical payload format that Brain verifies.
    """

    def __init__(self, private_key_pem: bytes) -> None:
        key = load_pem_private_key(private_key_pem, password=None)
        self._private_key = key

    def _sign(self, method: str, path: str, body: bytes, query: str = "") -> dict[str, str]:
        import secrets as _secrets
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        nonce = _secrets.token_hex(16)
        body_hash = hashlib.sha256(body).hexdigest()
        payload = f"{method}\n{path}\n{query}\n{timestamp}\n{nonce}\n{body_hash}"
        signature = self._private_key.sign(payload.encode("utf-8"))
        return {
            "X-DID": "did:key:zSystemTestSigner",
            "X-Timestamp": timestamp,
            "X-Nonce": nonce,
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
    return {"Authorization": f"Bearer {system_services.client_token}"}


@pytest.fixture(scope="session")
def admin_headers(system_services):
    """Bearer auth for Core admin endpoints (persona, unlock, etc.)."""
    return {"Authorization": f"Bearer {system_services.client_token}"}


@pytest.fixture(scope="session")
def brain_signer(system_services) -> BrainSigner:
    """Ed25519 signer for direct Brain API calls.

    Extracts Core's private key and returns a BrainSigner that can sign
    POST requests to Brain's /api/v1/* endpoints.

    Usage in tests:
        r = brain_signer.post(f"{alonso_brain}/api/v1/reason", json={...}, timeout=60)
    """
    pem = system_services.core_private_key("alonso")
    return BrainSigner(pem)


# ---------------------------------------------------------------------------
# Persona setup (session-scoped, runs once)
# ---------------------------------------------------------------------------

PERSONA_TIERS = {"general": "default", "consumer": "standard", "health": "sensitive"}
PERSONAS = list(PERSONA_TIERS.keys())


@pytest.fixture(scope="session", autouse=True)
def setup_personas(system_services, admin_headers, brain_headers, alonso_did, sancho_did):
    """Create and unlock personas on both Core nodes, clear vaults."""
    for actor in ("alonso", "sancho"):
        base = system_services.core_url(actor)
        for name in PERSONAS:
            tier = PERSONA_TIERS[name]
            try:
                httpx.post(
                    f"{base}/v1/personas",
                    json={"name": name, "tier": tier, "passphrase": "test"},
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
        # Grant Brain access to sensitive personas (health) via approval flow.
        # This mirrors the real admin flow: Brain requests access → Core creates
        # pending approval → admin approves → grant is active.
        # Without this, cross-persona disclosure tests fail because Brain can't
        # query the health vault (ErrApprovalRequired).
        for name in PERSONAS:
            tier = PERSONA_TIERS[name]
            if tier == "sensitive":
                # Trigger a vault query as Brain to create pending approval
                try:
                    httpx.post(
                        f"{base}/v1/vault/query",
                        json={"persona": name, "query": "test", "mode": "fts5"},
                        headers=brain_headers,
                        timeout=10,
                    )
                except Exception:
                    pass
                # List pending approvals and approve them
                try:
                    r = httpx.get(
                        f"{base}/v1/approvals",
                        headers=admin_headers,
                        timeout=10,
                    )
                    if r.status_code == 200:
                        for approval in r.json().get("approvals", []):
                            if approval.get("persona_id") == name:
                                httpx.post(
                                    f"{base}/v1/persona/approve",
                                    json={"id": approval["id"]},
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

    # Register contacts between actors so D2D messaging works.
    contacts = [
        ("alonso", sancho_did, "sancho"),
        ("sancho", alonso_did, "alonso"),
    ]
    for actor, contact_did, contact_name in contacts:
        base = system_services.core_url(actor)
        try:
            httpx.post(
                f"{base}/v1/contacts",
                json={"did": contact_did, "name": contact_name},
                headers=admin_headers,
                timeout=10,
            )
        except Exception:
            pass


# ---------------------------------------------------------------------------
# AppView data seeding
# ---------------------------------------------------------------------------

def _seed_appview(dsn: str, alonso_did: str, sancho_did: str) -> dict:
    """Insert test data directly into AppView Postgres.

    Uses the real PLC-registered DIDs for both actors.
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
        (subj_alonso, "Don Alonso", alonso_did),
        (subj_sancho, "Sancho Panza", sancho_did),
    ]:
        cur.execute(
            """INSERT INTO subjects (id, name, subject_type, did, identifiers_json, needs_recalc, created_at, updated_at)
               VALUES (%s, %s, 'did', %s, '[]'::jsonb, true, %s, %s)
               ON CONFLICT (id) DO NOTHING""",
            (sid, name, did, now, now),
        )

    # DID profiles
    for did, score in [(alonso_did, 0.85), (sancho_did, 0.72)]:
        cur.execute(
            """INSERT INTO did_profiles (did, needs_recalc, total_attestations_about, positive_about, overall_trust_score, computed_at)
               VALUES (%s, false, 5, 4, %s, %s)
               ON CONFLICT (did) DO NOTHING""",
            (did, score, now),
        )

    # Attestations
    att1_uri = f"at://{alonso_did}/com.dina.trust.attestation/{uuid.uuid4().hex[:12]}"
    att2_uri = f"at://{sancho_did}/com.dina.trust.attestation/{uuid.uuid4().hex[:12]}"
    ids["attestation_1"] = att1_uri
    ids["attestation_2"] = att2_uri

    for uri, author, subj_id, sentiment in [
        (att1_uri, alonso_did, subj_sancho, "positive"),
        (att2_uri, sancho_did, subj_alonso, "positive"),
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
        (alonso_did, sancho_did, "vouch", att1_uri),
        (sancho_did, alonso_did, "attestation", att2_uri),
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
def seed_appview(system_services, alonso_did, sancho_did):
    """Seed AppView Postgres with test trust data."""
    dsn = system_services.postgres_dsn
    _clear_appview(dsn)
    ids = _seed_appview(dsn, alonso_did, sancho_did)
    yield ids
    _clear_appview(dsn)


# ---------------------------------------------------------------------------
# URL shortcuts
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def alonso_did(system_services) -> str:
    """Real PLC-registered DID for Alonso, fetched from Core API."""
    return system_services.actor_did("alonso")


@pytest.fixture(scope="session")
def sancho_did(system_services) -> str:
    """Real PLC-registered DID for Sancho, fetched from Core API."""
    return system_services.actor_did("sancho")


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
    """On test failure, fetch recent audit traces from Core and print them."""
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

    admin_token = services.client_token
    for actor in ("alonso", "sancho"):
        core_url = services.core_url(actor)
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
