"""Integration tests for the staging ingestion pipeline.

Tests the full flow: connector pushes to staging → Brain claims →
classifies → resolves → item stored in persona vault.

Set DINA_INTEGRATION=docker to run against real containers.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
import base58
import httpx
import pytest

DOCKER_MODE = os.environ.get("DINA_INTEGRATION") == "docker"

pytestmark = pytest.mark.skipif(not DOCKER_MODE, reason="requires Docker")


@pytest.fixture
def core(docker_services):
    return {
        "url": docker_services.core_url,
        "headers": {"Authorization": f"Bearer {docker_services.client_token}"},
    }


def _post(core, path, body=None):
    return httpx.post(
        f"{core['url']}{path}", json=body or {},
        headers=core["headers"], timeout=10,
    )


class TestStagingIngest:
    """POST /v1/staging/ingest stores items in staging."""

    def test_ingest_returns_staging_id(self, core) -> None:
        """Ingest returns a staging ID with status 201."""
        item = {
            "connector_id": "gmail-test",
            "source": "gmail",
            "source_id": f"msg-ingest-{int(time.time())}",
            "type": "email",
            "summary": "Test email for staging",
            "body": "Full email content here.",
            "sender": "test@example.com",
        }
        resp = _post(core, "/v1/staging/ingest", item)
        assert resp.status_code == 201, f"ingest: {resp.text}"
        data = resp.json()
        assert "id" in data
        assert data["id"] != ""

    def test_dedup_same_source_id(self, core) -> None:
        """Same (connector_id, source, source_id) is a no-op."""
        source_id = f"msg-dedup-{int(time.time())}"
        item = {
            "connector_id": "gmail-test",
            "source": "gmail",
            "source_id": source_id,
            "type": "email",
            "summary": "Dedup test",
            "body": "Content",
        }
        r1 = _post(core, "/v1/staging/ingest", item)
        assert r1.status_code == 201

        r2 = _post(core, "/v1/staging/ingest", item)
        assert r2.status_code in (200, 201)
        # Dedup: second ingest returns the same ID as the first.
        id1 = r1.json().get("id", "")
        id2 = r2.json().get("id", "")
        assert id1 == id2, f"dedup must return original ID: {id1} != {id2}"


class TestStagingClaimResolve:
    """Brain claims → classifies → resolves staging items."""

    def test_claim_resolve_stored(self, core) -> None:
        """Claim pending item, resolve to open persona → stored."""
        # Ingest an item.
        source_id = f"msg-resolve-{int(time.time())}"
        _post(core, "/v1/staging/ingest", {
            "connector_id": "gmail-test",
            "source": "gmail",
            "source_id": source_id,
            "type": "note",
            "summary": "Resolve test",
            "body": "Content to classify",
            "sender": "user@example.com",
        })

        # Claim.
        claim_resp = _post(core, "/v1/staging/claim", {"limit": 10})
        assert claim_resp.status_code == 200
        items = claim_resp.json().get("items", [])
        our_item = None
        for it in items:
            if it.get("source_id") == source_id:
                our_item = it
                break

        if our_item is None:
            pytest.skip("item not found in claim (may have been claimed by another test)")

        # Resolve to general (which is open by default).
        resolve_resp = _post(core, "/v1/staging/resolve", {
            "id": our_item["id"],
            "target_persona": "general",
            "classified_item": {
                "type": "note",
                "summary": "Resolve test",
                "body_text": "Content to classify",
                "sender": "user@example.com",
                "sender_trust": "unknown",
                "source_type": "unknown",
                "confidence": "low",
                "retrieval_policy": "caveated",
                "staging_id": our_item["id"],
                "connector_id": "gmail-test",
            },
        })
        assert resolve_resp.status_code == 200
        data = resolve_resp.json()
        assert data.get("status") == "stored", f"expected stored, got: {data}"

        # Verify the classified item was actually persisted in the persona vault.
        search_resp = _post(core, "/v1/vault/query", {
            "persona": "general",
            "query": "Resolve test",
            "mode": "fts5",
            "include_all": True,
        })
        assert search_resp.status_code == 200
        results = search_resp.json().get("items", [])
        found = any(
            "Resolve test" in (r.get("summary", r.get("Summary", ""))
                               + r.get("body_text", r.get("body", "")))
            for r in results
        )
        assert found, f"Classified item must be in persona vault after resolve: {[r.get('summary', r.get('Summary', '')) for r in results]}"


def _connector_sign(priv, did, method, path, body_bytes):
    """Sign a request as a connector service key."""
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    nonce = secrets.token_hex(16)
    body_hash = hashlib.sha256(body_bytes).hexdigest()
    payload = f"{method}\n{path}\n\n{timestamp}\n{nonce}\n{body_hash}"
    sig = priv.sign(payload.encode())
    return {
        "X-DID": did,
        "X-Timestamp": timestamp,
        "X-Nonce": nonce,
        "X-Signature": sig.hex(),
        "Content-Type": "application/json",
    }


class TestConnectorAuth:
    """Real connector service-key auth for staging ingest."""

    @pytest.fixture(autouse=True)
    def _register_connector_key(self, core, docker_services):
        """Generate connector Ed25519 keypair and register via test endpoint."""
        self._priv = Ed25519PrivateKey.generate()
        pub_raw = self._priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        pub_prefixed = b"\xed\x01" + pub_raw
        self._did = "did:key:z" + base58.b58encode(pub_prefixed).decode()
        self._core_url = docker_services.core_url

        # Register via test-only endpoint (requires DINA_TEST_MODE=true).
        resp = httpx.post(
            f"{self._core_url}/v1/test/register-service-key",
            json={
                "did": self._did,
                "public_key": pub_raw.hex(),
                "service_id": "connector",
            },
            headers=core["headers"],
            timeout=10,
        )
        if resp.status_code == 404:
            pytest.skip("DINA_TEST_MODE not enabled — cannot register connector key")
        assert resp.status_code == 200, f"register: {resp.text}"

    def test_connector_signed_ingest_succeeds(self):
        """Connector service-key signed POST /v1/staging/ingest succeeds."""
        body = json.dumps({
            "connector_id": "gmail-connector-test",
            "source": "gmail",
            "source_id": f"conn-auth-{int(time.time())}",
            "type": "email",
            "summary": "Connector auth test",
            "body": "Email ingested with real connector service key.",
            "sender": "test@gmail.com",
        }).encode()

        headers = _connector_sign(
            self._priv, self._did, "POST", "/v1/staging/ingest", body,
        )
        resp = httpx.post(
            f"{self._core_url}/v1/staging/ingest",
            content=body, headers=headers, timeout=10,
        )
        assert resp.status_code == 201, (
            f"connector-signed ingest must succeed: {resp.status_code} {resp.text}"
        )
        assert resp.json().get("id", "") != ""

    def test_connector_signed_vault_query_denied(self):
        """Connector service key cannot access /v1/vault/query."""
        body = json.dumps({
            "persona": "general", "query": "test", "mode": "fts5",
        }).encode()

        headers = _connector_sign(
            self._priv, self._did, "POST", "/v1/vault/query", body,
        )
        resp = httpx.post(
            f"{self._core_url}/v1/vault/query",
            content=body, headers=headers, timeout=10,
        )
        assert resp.status_code == 403, (
            f"connector must NOT access vault/query: {resp.status_code} {resp.text}"
        )

    def test_connector_signed_staging_claim_denied(self):
        """Connector service key cannot claim staging items (Brain-only)."""
        body = json.dumps({"limit": 10}).encode()

        headers = _connector_sign(
            self._priv, self._did, "POST", "/v1/staging/claim", body,
        )
        resp = httpx.post(
            f"{self._core_url}/v1/staging/claim",
            content=body, headers=headers, timeout=10,
        )
        assert resp.status_code == 403, (
            f"connector must NOT claim staging: {resp.status_code} {resp.text}"
        )
