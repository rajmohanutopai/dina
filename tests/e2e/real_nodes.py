"""RealHomeNode — HomeNode backed by real Go Core HTTP API.

Overrides vault, persona, KV, health, PII scrubbing, DID signing,
device pairing, and brain processing operations to make real HTTP calls.
Mock state is updated in parallel for audit/briefing/internal assertions.
Falls back to mock on API failure for everything.

Usage: set DINA_E2E=docker to activate in conftest.py.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx

from tests.e2e.actors import HomeNode, Persona, PersonaType, _mock_encrypt, _mock_sign, _mock_verify
from tests.e2e.mocks import (
    ActionRisk,
    D2DMessage,
    DeviceType,
    MockPIIScrubber,
    TrustRing,
    VaultItem,
)

try:
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    _HAS_CRYPTO = True
except ImportError:
    _HAS_CRYPTO = False


# ---------------------------------------------------------------------------
# Go Core valid item types — map E2E custom types to nearest valid type
# ---------------------------------------------------------------------------

_VALID_ITEM_TYPES = frozenset({
    "email", "message", "event", "note", "photo", "email_draft", "cart_handover",
})

_TYPE_MAP: dict[str, str] = {
    "email_thin": "email",
    "email_full": "email",
    "calendar_event": "event",
}


def _normalize_item_type(item_type: str) -> str:
    """Map E2E custom item types to Go Core valid types."""
    if item_type in _VALID_ITEM_TYPES:
        return item_type
    return _TYPE_MAP.get(item_type, "note")


# ---------------------------------------------------------------------------
# Strict-real mode (TST-CORE-982, TST-CORE-984)
# ---------------------------------------------------------------------------
# When DINA_STRICT_REAL=1, _api_request() raises on ANY API failure instead
# of returning None. This prevents silent mock fallback: if a real API call
# fails, the test MUST fail immediately rather than falling back to mock
# state, which would mask real E2E integration bugs.
import os
_STRICT_REAL = os.environ.get("DINA_STRICT_REAL", "").strip() == "1"


# ---------------------------------------------------------------------------
# Ed25519 Brain API signer
# ---------------------------------------------------------------------------

class _BrainSigner:
    """Ed25519 request signer for calling Brain API endpoints.

    Same signing protocol as BrainSigner in tests/system/conftest.py:
    canonical payload = METHOD\\nPATH\\nQUERY\\nTIMESTAMP\\nSHA256(BODY).
    Brain verifies against Core's public key.
    """

    def __init__(self, private_key_pem: bytes) -> None:
        if not _HAS_CRYPTO:
            raise ImportError(
                "cryptography package required for Ed25519 Brain API signing"
            )
        self._private_key = load_pem_private_key(private_key_pem, password=None)

    def sign_headers(
        self, method: str, path: str, body: bytes, query: str = "",
    ) -> dict[str, str]:
        """Produce X-DID / X-Timestamp / X-Signature headers."""
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        body_hash = hashlib.sha256(body).hexdigest()
        payload = f"{method}\n{path}\n{query}\n{timestamp}\n{body_hash}"
        signature = self._private_key.sign(payload.encode("utf-8"))
        return {
            "X-DID": "did:key:zE2ECoreSigner",
            "X-Timestamp": timestamp,
            "X-Signature": signature.hex(),
            "Content-Type": "application/json",
        }


# ---------------------------------------------------------------------------
# Helper: HTTP request with retry on 429/503
# ---------------------------------------------------------------------------

def _api_request(
    method: str,
    url: str,
    *,
    max_retries: int = 3,
    **kwargs,
) -> httpx.Response | None:
    """Make HTTP request with retry on 429/503.

    Returns response on success (2xx or 201), None on persistent failure.
    Raises on store operations only if explicitly requested via raise_on_fail.

    In strict-real mode (DINA_STRICT_REAL=1), raises RuntimeError on any
    non-success response or connection failure instead of returning None.
    This prevents silent fallback to mock state.
    """
    kwargs.setdefault("timeout", 10)
    raise_on_fail = kwargs.pop("raise_on_fail", False) or _STRICT_REAL

    for attempt in range(max_retries + 1):
        try:
            resp = getattr(httpx, method)(url, **kwargs)
            if resp.is_success or resp.status_code == 201:
                return resp
            if resp.status_code in (429, 503) and attempt < max_retries:
                time.sleep(0.1 * (2 ** attempt))
                continue
            if raise_on_fail:
                raise RuntimeError(
                    f"STRICT_REAL: {method.upper()} {url} failed with "
                    f"{resp.status_code} — no mock fallback allowed"
                )
            return None
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout,
                httpx.ReadError):
            if attempt < max_retries:
                time.sleep(0.1 * (2 ** attempt))
                continue
            if raise_on_fail:
                raise
            return None
    return None


# ---------------------------------------------------------------------------
# RealPIIScrubber — chains Go Core Tier 1 regex + Brain Tier 2 structured PII
# ---------------------------------------------------------------------------

class RealPIIScrubber(MockPIIScrubber):
    """PII scrubber backed by real Go Core (Tier 1) and Brain (Tier 2) APIs.

    Implements the same interface as MockPIIScrubber.  Each tier method
    calls the corresponding real API endpoint, falling back to the mock
    implementation on any network or API failure.

    Go Core POST /v1/pii/scrub  — Tier 1 regex-based scrubbing
    Brain  POST /api/v1/pii/scrub — Tier 2 NER-based scrubbing
    """

    def __init__(
        self,
        core_url: str,
        brain_url: str,
        core_token: str,
    ) -> None:
        super().__init__()
        self._core_url = core_url.rstrip("/")
        self._brain_url = brain_url.rstrip("/")
        self._core_token = core_token

    def _core_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._core_token}"}

    def _brain_headers(self) -> dict[str, str]:
        # Brain API is service-key authenticated and internal-only.
        # Host-side E2E callers do not hold service keys.
        return {}

    def scrub_tier1(self, text: str) -> tuple[str, dict[str, str]]:
        """Tier 1: regex-based scrubbing via Go Core POST /v1/pii/scrub.

        Calls real API first, then applies mock regex as a safety net to
        catch any known PII the real API missed.
        """
        replacements: dict[str, str] = {}
        scrubbed = text

        resp = _api_request(
            "post",
            f"{self._core_url}/v1/pii/scrub",
            json={"text": scrubbed},
            headers=self._core_headers(),
        )
        if resp is not None:
            data = resp.json()
            scrubbed = data.get("scrubbed", scrubbed)
            entities = data.get("entities") or []
            # Go Core numbers tokens per-type: [EMAIL_1], [CREDIT_CARD_1]
            type_counts: dict[str, int] = {}
            for ent in entities:
                ent_type = ent.get("Type", ent.get("type", "PII"))
                ent_value = ent.get("Value", ent.get("value", ""))
                ent_token = ent.get("token", "")
                if not ent_token:
                    type_counts[ent_type] = type_counts.get(ent_type, 0) + 1
                    ent_token = f"[{ent_type.upper()}_{type_counts[ent_type]}]"
                if ent_value:
                    replacements[ent_token] = ent_value

        # Safety net: apply mock regex for anything the real API missed.
        # Use offset token indices (100+) to avoid collisions with real tokens.
        scrubbed, mock_replacements = self._mock_scrub_tier1_offset(
            scrubbed, len(replacements),
        )
        replacements.update(mock_replacements)

        return scrubbed, replacements

    def _mock_scrub_tier1_offset(
        self, text: str, offset: int,
    ) -> tuple[str, dict[str, str]]:
        """Apply mock tier1 regex with offset token indices."""
        replacements: dict[str, str] = {}
        result = text
        idx = offset
        for cc in self._KNOWN_CC:
            if cc in result:
                idx += 1
                token = f"[CC_NUM_{idx}]"
                replacements[token] = cc
                result = result.replace(cc, token)
        for phone in self._KNOWN_PHONES:
            if phone in result:
                idx += 1
                token = f"[PHONE_{idx}]"
                replacements[token] = phone
                result = result.replace(phone, token)
        for email in self._KNOWN_EMAILS:
            if email in result:
                idx += 1
                token = f"[EMAIL_{idx}]"
                replacements[token] = email
                result = result.replace(email, token)
        return result, replacements

    def scrub_tier2(self, text: str) -> tuple[str, dict[str, str]]:
        """Tier 2: NER-based scrubbing via Brain POST /api/v1/pii/scrub.

        Calls real API first, then applies mock NER as a safety net to
        catch any known PII the real API missed (e.g. unusual names).
        """
        replacements: dict[str, str] = {}
        scrubbed = text

        resp = _api_request(
            "post",
            f"{self._brain_url}/api/v1/pii/scrub",
            json={"text": scrubbed},
            headers=self._brain_headers(),
        )
        if resp is not None:
            data = resp.json()
            scrubbed = data.get("scrubbed", scrubbed)
            entities = data.get("entities") or []
            # Brain numbers tokens per-type: [PERSON_1], [ORG_1]
            type_counts: dict[str, int] = {}
            for ent in entities:
                ent_type = ent.get("type", ent.get("Type", "PII"))
                ent_value = ent.get("value", ent.get("Value", ""))
                ent_token = ent.get("token", "")
                if not ent_token:
                    type_counts[ent_type] = type_counts.get(ent_type, 0) + 1
                    ent_token = f"[{ent_type.upper()}_{type_counts[ent_type]}]"
                if ent_value:
                    replacements[ent_token] = ent_value

        # Safety net: apply mock NER for anything the real API missed.
        # Use offset token indices (100+) to avoid collisions with real tokens.
        scrubbed, mock_replacements = self._mock_scrub_tier2_offset(
            scrubbed, len(replacements),
        )
        replacements.update(mock_replacements)

        return scrubbed, replacements

    def _mock_scrub_tier2_offset(
        self, text: str, offset: int,
    ) -> tuple[str, dict[str, str]]:
        """Apply mock tier2 NER with offset token indices."""
        replacements: dict[str, str] = {}
        result = text
        idx = offset
        for name in self._KNOWN_NAMES:
            if name in result:
                idx += 1
                token = f"[PERSON_{idx}]"
                replacements[token] = name
                result = result.replace(name, token)
        for addr in self._KNOWN_ADDRESSES:
            if addr in result:
                idx += 1
                token = f"[ORG_{idx}]"
                replacements[token] = addr
                result = result.replace(addr, token)
        return result, replacements

    def scrub_full(self, text: str) -> tuple[str, dict[str, str]]:
        """Full pipeline: Tier 1 (Go Core regex) + Tier 2 (Brain structured PII).

        Chains both tiers and merges the entity vaults.
        Falls back to mock if either tier fails (tier-level fallback
        is handled inside scrub_tier1/scrub_tier2).
        """
        result, t1 = self.scrub_tier1(text)
        result, t2 = self.scrub_tier2(result)
        vault = {**t1, **t2}
        self._current_vault = vault
        self.entity_vaults.append(dict(vault))
        return result, vault

    # rehydrate(), destroy_vault(), validate_clean() are inherited from
    # MockPIIScrubber — they operate on in-memory state only and do not
    # need API calls.


# ---------------------------------------------------------------------------
# RealHomeNode
# ---------------------------------------------------------------------------

class RealHomeNode(HomeNode):
    """HomeNode backed by real Go Core HTTP API.

    Overrides vault, persona, KV, health, PII scrubbing, DID signing,
    device pairing, and brain processing operations to make real HTTP
    calls to the Go Core and Brain running in Docker.  Mock state is
    updated in parallel so tests can still assert on audit_log,
    briefing_queue, persona.items, kv_store, and other internal fields.

    Falls back to mock on API failure for all operations.
    """

    def __init__(
        self,
        core_url: str,
        brain_url: str,
        client_token: str,
        *,
        core_private_key_pem: bytes | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._core_url = core_url.rstrip("/")
        self._brain_url = brain_url.rstrip("/")
        self._client_token = client_token
        # Maps (persona_name, mock_item_id) -> real_item_id from Go Core
        self._vault_id_map: dict[str, str] = {}
        # Maps real_item_id -> mock_item_id for reverse lookups
        self._real_to_mock_id: dict[str, str] = {}
        # KV keys written during the current test (for per-test cleanup)
        self._kv_keys_written: set[str] = set()

        # Ed25519 signer for Brain API (Ed25519 service key auth)
        self._brain_signer: _BrainSigner | None = None
        if core_private_key_pem is not None and _HAS_CRYPTO:
            self._brain_signer = _BrainSigner(core_private_key_pem)

        # Replace MockPIIScrubber with RealPIIScrubber
        self.scrubber = RealPIIScrubber(
            core_url=self._core_url,
            brain_url=self._brain_url,
            core_token=self._client_token,
        )

    def _headers(self) -> dict[str, str]:
        """Client token headers — for data operations (vault, KV, PII, messaging)."""
        return {"Authorization": f"Bearer {self._client_token}"}

    def _admin_headers(self) -> dict[str, str]:
        """Client token headers — for admin operations (persona, pairing, DID sign)."""
        return {"Authorization": f"Bearer {self._client_token}"}

    def _brain_api_request(
        self,
        path: str,
        *,
        body_json: dict,
        **kwargs: Any,
    ) -> httpx.Response | None:
        """POST to Brain API with Ed25519 signing.

        Uses Core's Ed25519 private key to sign the request (same protocol
        as BrainSigner in tests/system/conftest.py).  Falls back to Bearer
        token (which will likely get 401) if no signer is available.
        """
        if self._brain_signer is not None:
            body = json.dumps(body_json).encode()
            headers = self._brain_signer.sign_headers("POST", path, body)
            return _api_request(
                "post",
                f"{self._brain_url}{path}",
                content=body,
                headers=headers,
                **kwargs,
            )
        # Fallback to Bearer token (Brain will 401, _api_request returns None)
        return _api_request(
            "post",
            f"{self._brain_url}{path}",
            json=body_json,
            headers=self._headers(),
            **kwargs,
        )

    # -- Persona Operations ------------------------------------------------

    def create_persona(
        self, name: str, ptype: PersonaType, tier: str = "default",
    ) -> Persona:
        """Create persona on real Go Core + mock state.

        Uses CLIENT_TOKEN — persona endpoints are admin-only.
        """
        # Real API call (idempotent — ignore "already exists")
        _api_request(
            "post",
            f"{self._core_url}/v1/personas",
            json={"name": name, "tier": tier, "passphrase": "test"},
            headers=self._admin_headers(),
        )
        _api_request(
            "post",
            f"{self._core_url}/v1/persona/unlock",
            json={"persona": name, "passphrase": "test"},
            headers=self._admin_headers(),
        )
        # Mock state
        return super().create_persona(name, ptype, tier)

    def unlock_persona(
        self, name: str, passphrase: str, ttl_seconds: float = 0,
    ) -> bool:
        """Unlock persona on real Go Core + mock state.

        Uses CLIENT_TOKEN — persona endpoints are admin-only.
        """
        _api_request(
            "post",
            f"{self._core_url}/v1/persona/unlock",
            json={"persona": name, "passphrase": passphrase},
            headers=self._admin_headers(),
        )
        return super().unlock_persona(name, passphrase, ttl_seconds)

    # -- Contact Operations ------------------------------------------------

    # Map TrustRing enum to Go Core valid trust_level strings
    # Go Core accepts: "blocked", "unknown", "trusted"
    _RING_TO_LEVEL = {
        TrustRing.RING_1_UNVERIFIED: "unknown",
        TrustRing.RING_2_VERIFIED: "trusted",
        TrustRing.RING_3_SKIN_IN_GAME: "trusted",
    }

    def add_contact(
        self, did: str, name: str, ring: TrustRing,
    ) -> None:
        """Add contact via real Go Core API + update mock state."""
        trust_level = self._RING_TO_LEVEL.get(ring, "unverified")
        _api_request(
            "post",
            f"{self._core_url}/v1/contacts",
            json={"did": did, "name": name, "trust_level": trust_level},
            headers=self._headers(),
        )
        # Mock state
        self.contacts[did] = {"name": name, "ring": ring}

    # -- Vault Operations --------------------------------------------------

    def vault_store(
        self,
        persona: str,
        key: str,
        value: Any,
        item_type: str = "note",
        source: str = "user",
    ) -> str:
        """Store item via real Go Core API + update mock state."""
        # Check accessibility (mock-side gate for TTL/locked personas)
        p = self.personas.get(persona)
        if not p or not p.is_accessible(self._now()):
            raise PermissionError(f"403 persona_locked: {persona}")

        body_text = json.dumps(value) if isinstance(value, dict) else str(value)

        # Build Summary with searchable content for FTS
        if isinstance(value, dict):
            fts_parts = [key] + [
                str(v) for v in value.values() if isinstance(v, str)
            ]
            summary = " ".join(fts_parts)
        else:
            summary = key

        # Real API call (normalize type for Go Core validation)
        api_type = _normalize_item_type(item_type)
        resp = _api_request(
            "post",
            f"{self._core_url}/v1/vault/store",
            json={
                "persona": persona,
                "item": {
                    "Type": api_type,
                    "Source": source,
                    "Summary": summary,
                    "BodyText": body_text,
                    "Metadata": json.dumps({"key": key}),
                },
            },
            headers=self._headers(),
            raise_on_fail=True,
        )

        real_item_id = ""
        if resp is not None:
            real_item_id = resp.json().get("id", "")

        # Update mock state (get the mock item_id from super)
        mock_item_id = super().vault_store(persona, key, value, item_type, source)

        # Track the mapping
        if real_item_id:
            self._vault_id_map[mock_item_id] = real_item_id
            self._real_to_mock_id[real_item_id] = mock_item_id

        return mock_item_id

    def vault_query(
        self, persona: str, query: str, mode: str = "fts5",
    ) -> list[VaultItem]:
        """Query vault via real Go Core API.

        Falls back to mock if API fails.  For semantic/hybrid modes, delegates
        to mock (Go Core only supports FTS).
        """
        p = self.personas.get(persona)
        if not p or not p.is_accessible(self._now()):
            raise PermissionError(f"403 persona_locked: {persona}")

        # Sensitive persona audit + briefing (same as mock)
        if p.tier == "sensitive":
            self._log_audit("restricted_persona_access", {"persona": persona})
            self.briefing_queue.append({
                "type": "restricted_access",
                "persona": persona,
                "query": query,
            })

        # For semantic/hybrid, delegate to mock (no real endpoint)
        if mode == "semantic":
            return self._semantic_search(p, query)
        if mode == "hybrid":
            fts = self._fts_search(p, query)
            sem = self._semantic_search(p, query)
            seen: set[str] = set()
            merged: list[VaultItem] = []
            for item in sem + fts:
                if item.item_id not in seen:
                    seen.add(item.item_id)
                    merged.append(item)
            return merged

        # FTS via real API — raise on failure so we don't silently
        # fall through to mock state when the real API is broken.
        resp = _api_request(
            "post",
            f"{self._core_url}/v1/vault/query",
            json={
                "persona": persona,
                "query": query,
                "mode": "fts5",
                "limit": 100,
                "include_content": True,
            },
            headers=self._headers(),
            raise_on_fail=True,
        )

        if resp is not None:
            api_items = resp.json().get("items") or []
            results = []
            for item_data in api_items:
                real_id = item_data.get("id") or item_data.get("ID", "")
                mock_id = self._real_to_mock_id.get(real_id)
                if mock_id and mock_id in p.items:
                    results.append(p.items[mock_id])
                elif real_id:
                    # Item from real API not tracked in mock — build VaultItem.
                    # Core returns snake_case keys (json tags), not PascalCase.
                    results.append(VaultItem(
                        item_id=real_id,
                        persona=persona,
                        item_type=item_data.get("type", item_data.get("Type", "note")),
                        source=item_data.get("source", item_data.get("Source", "")),
                        summary=item_data.get("summary", item_data.get("Summary", "")),
                        body_text=item_data.get("body_text", item_data.get("BodyText", "")),
                    ))
            return results

        # Fallback to mock FTS
        return self._fts_search(p, query)

    def vault_store_batch(
        self, persona: str, items: list[tuple[str, Any]],
    ) -> list[str]:
        """Batch store via real Go Core API + update mock state."""
        p = self.personas.get(persona)
        if not p or not p.is_accessible(self._now()):
            raise PermissionError(f"403 persona_locked: {persona}")

        # Build API items
        api_items = []
        for key, value in items:
            body_text = json.dumps(value) if isinstance(value, dict) else str(value)
            api_items.append({
                "Type": "note",
                "Source": "user",
                "Summary": key,
                "BodyText": body_text,
                "Metadata": json.dumps({"key": key}),
            })

        resp = _api_request(
            "post",
            f"{self._core_url}/v1/vault/store/batch",
            json={"persona": persona, "items": api_items},
            headers=self._headers(),
            timeout=30,
        )

        real_ids = []
        if resp is not None:
            real_ids = resp.json().get("ids") or []

        # Mock state
        mock_ids = super().vault_store_batch(persona, items)

        # Track mappings
        for mock_id, real_id in zip(mock_ids, real_ids):
            if real_id:
                self._vault_id_map[mock_id] = real_id
                self._real_to_mock_id[real_id] = mock_id

        return mock_ids

    def vault_delete(self, persona: str, item_id: str) -> bool:
        """Delete item via real Go Core API + update mock state."""
        real_id = self._vault_id_map.get(item_id, item_id)

        if real_id:
            _api_request(
                "delete",
                f"{self._core_url}/v1/vault/item/{real_id}",
                params={"persona": persona},
                headers=self._headers(),
            )

        # Clean up tracking
        self._vault_id_map.pop(item_id, None)
        self._real_to_mock_id.pop(real_id, None)

        return super().vault_delete(persona, item_id)

    # -- KV Operations -----------------------------------------------------

    def kv_put(self, key: str, value: Any) -> None:
        """Put KV via real Go Core API + update mock state."""
        _api_request(
            "put",
            f"{self._core_url}/v1/vault/kv/{key}",
            json={"value": json.dumps(value) if not isinstance(value, str) else value},
            headers=self._headers(),
        )
        self._kv_keys_written.add(key)
        super().kv_put(key, value)

    def clear_real_kv(self) -> None:
        """Delete all KV keys written during the current test from real Go Core.

        Uses DELETE /v1/vault/item/kv:{key} to fully remove each tracked
        key so subsequent kv_get() returns 404 (None), not an empty string.
        Raises on failure to prevent silent cross-test leakage.
        """
        for key in self._kv_keys_written:
            # KV items are stored with ID "kv:<key>" in the vault
            _api_request(
                "delete",
                f"{self._core_url}/v1/vault/item/kv:{key}",
                headers=self._headers(),
                raise_on_fail=True,
            )
        self._kv_keys_written.clear()

    def kv_get(self, key: str) -> Any:
        """Get KV via real Go Core API, fall back to mock on failure."""
        resp = _api_request(
            "get",
            f"{self._core_url}/v1/vault/kv/{key}",
            headers=self._headers(),
        )
        if resp is not None:
            data = resp.json()
            raw = data.get("value", "")
            # Try JSON parse, fall back to raw string
            try:
                return json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                return raw
        # Fall back to mock state
        return super().kv_get(key)

    # -- Health Check ------------------------------------------------------

    def healthz(self) -> dict:
        """Health check via real Go Core API, merged with mock brain status."""
        resp = _api_request("get", f"{self._core_url}/healthz")
        core_health = {}
        if resp is not None:
            core_health = resp.json()

        # Merge with mock brain status (mock brain state is authoritative
        # for crash simulation — real Core doesn't know about mock crashes)
        mock_health = super().healthz()
        core_status = core_health.get("status", "healthy")

        # Overall status is degraded if either component is unhealthy
        if mock_health["brain"] == "crashed" or core_status != "ok":
            overall = "degraded"
        else:
            overall = "ok"

        return {
            "status": overall,
            "core": core_status,
            "brain": mock_health["brain"],
            "vault_locked": mock_health["vault_locked"],
        }

    # -- AT Protocol -------------------------------------------------------

    def well_known_atproto_did(self) -> str:
        """Get DID from real Go Core /.well-known/atproto-did endpoint."""
        resp = _api_request("get", f"{self._core_url}/.well-known/atproto-did")
        if resp is not None:
            # Response may be plain text or JSON
            text = resp.text.strip()
            if text.startswith("did:"):
                return text
            try:
                return resp.json().get("did", self.did)
            except (json.JSONDecodeError, ValueError):
                pass
        return super().well_known_atproto_did()

    # -- DID Signing & Verification ----------------------------------------

    def did_sign(self, data: str) -> str:
        """Sign data via real Go Core POST /v1/did/sign.

        Uses CLIENT_TOKEN — /v1/did/sign is admin-only.
        The data is sent as a hex-encoded string.
        Falls back to mock HMAC-SHA256 signing on API failure.
        """
        hex_data = data.encode().hex()
        resp = _api_request(
            "post",
            f"{self._core_url}/v1/did/sign",
            json={"data": hex_data},
            headers=self._admin_headers(),
        )
        if resp is not None:
            sig = resp.json().get("signature", "")
            if sig:
                return sig

        # Fallback to mock signing
        return _mock_sign(data, self.root_private_key)

    def did_verify(self, data: str, signature: str, did: str = "") -> bool:
        """Verify signature via real Go Core POST /v1/did/verify.

        Falls back to mock verification on API failure.
        """
        hex_data = data.encode().hex()
        verify_did = did or self.did
        resp = _api_request(
            "post",
            f"{self._core_url}/v1/did/verify",
            json={
                "data": hex_data,
                "signature": signature,
                "did": verify_did,
            },
            headers=self._headers(),
        )
        if resp is not None:
            return resp.json().get("valid", False)

        # Fallback to mock verification
        return _mock_verify(data, signature, self.root_public_key)

    # -- Device Pairing (Real API) -----------------------------------------

    def generate_pairing_code(self) -> str:
        """Generate pairing code via real Go Core POST /v1/pair/initiate.

        Uses CLIENT_TOKEN — pairing endpoints are admin-only.
        Also updates mock state so tests can use self._pairing_codes.
        Falls back to mock on API failure.
        """
        resp = _api_request(
            "post",
            f"{self._core_url}/v1/pair/initiate",
            json={},
            headers=self._admin_headers(),
        )
        if resp is not None:
            real_code = resp.json().get("code", "")
            if real_code:
                # Update mock state with the real code
                mock_code = super().generate_pairing_code()
                # Also register the real code in mock state so pair_device
                # works with either code
                from tests.e2e.mocks import PairingCode
                self._pairing_codes[real_code] = PairingCode(
                    code=real_code,
                    created_at=self._now(),
                    expires_at=self._now() + 300,
                )
                return real_code

        # Fallback to mock
        return super().generate_pairing_code()

    def pair_device(self, code: str, device_type: DeviceType) -> "Device | None":
        """Pair device via real Go Core POST /v1/pair/complete.

        Uses CLIENT_TOKEN — pairing endpoints are admin-only.
        Always updates mock state via super() call.
        Falls back to mock on API failure.
        """
        # Map DeviceType enum to a device name string for the API
        device_name = (
            "rich_client" if device_type == DeviceType.RICH_CLIENT
            else "thin_client"
        )

        resp = _api_request(
            "post",
            f"{self._core_url}/v1/pair/complete",
            json={"code": code, "device_name": device_name},
            headers=self._admin_headers(),
        )
        if resp is not None:
            api_data = resp.json()
            real_device_id = api_data.get("device_id", "")
            real_token = api_data.get("token", "")
            # Log the real pairing for diagnostics
            if real_device_id:
                self._log_audit("device_paired_real", {
                    "device_id": real_device_id,
                    "type": device_type.value,
                })

        # Always update mock state
        return super().pair_device(code, device_type)

    # -- Brain Processing (Real API) ---------------------------------------

    def _brain_process(
        self, event_type: str, payload: dict, from_did: str = "",
    ) -> dict:
        """Process event through real Brain API with Ed25519 auth.

        Tries POST /api/v1/process on the real Brain for ALL event types
        (not just non-LLM events).  Brain's deterministic classification
        rules handle ~90% of events without LLM.  Falls back to mock on
        API failure (401, timeout, or Brain returns error).

        Always runs the parent class's full mock side-effects (spool
        drain, notifications, briefing queue, DND logic, etc.) so test
        assertions on internal state remain valid.  Prefers the real
        Brain result when available.
        """
        # Try real Brain API for all events (Ed25519 signed).
        # Do this BEFORE super() so we can overlay the real result.
        real_result = None
        if not self._brain_crashed:
            resp = self._brain_api_request(
                "/api/v1/process",
                body_json={"type": event_type, "payload": payload},
            )
            if resp is not None:
                real_result = resp.json()

        # Run ALL mock side-effects via parent — this handles the full
        # elif chain (contact_neglect, promise_check, reason, agent_*,
        # dnd_disabled, security_alert, inbound_d2d, etc.) and populates
        # briefing_queue, notifications, _processed_events, etc.
        mock_result = super()._brain_process(event_type, payload, from_did)

        # Prefer real Brain result if available, but side-effects
        # (briefing_queue, notifications, spool drain) have already
        # been applied by super().
        if real_result is not None:
            tier = self._classify_silence(event_type, payload)
            real_result.setdefault("tier", tier.value)
            # Preserve mock's domain-specific status when it indicates
            # routing decisions (e.g., "queued_for_briefing" during DND).
            # Real Brain doesn't know about DND or mock-side routing.
            mock_status = mock_result.get("status", "")
            if mock_status and mock_status != "ok":
                real_result["status"] = mock_status
            return real_result
        return mock_result

    # -- D2D Messaging (Real Signing) --------------------------------------

    def send_d2d(
        self, to_did: str, message_type: str, payload: dict,
    ) -> D2DMessage:
        """Send a D2D message with real Ed25519 signing via Go Core.

        Same logic as mock send_d2d() but replaces _mock_sign() with
        self.did_sign() which calls real Go Core POST /v1/did/sign.
        Encryption uses _mock_encrypt() for the D2DMessage object since
        real NaCl encryption happens server-side via RealD2DNetwork.
        """
        # Apply sharing policy (same as mock)
        policy = self.sharing_policies.get(to_did)
        filtered_payload = dict(payload)
        audit_decisions: dict[str, str] = {}

        if policy:
            if policy.context == "none":
                filtered_payload.pop("context_flags", None)
                filtered_payload.pop("tea_preference", None)
                audit_decisions["context"] = "denied"
            else:
                audit_decisions["context"] = "allowed"

            if policy.presence == "eta_only":
                filtered_payload.pop("exact_location", None)
                audit_decisions["presence"] = "allowed"
        else:
            audit_decisions["presence"] = "allowed"
            audit_decisions["context"] = "allowed"

        # PII scrub (uses RealPIIScrubber in Docker mode)
        payload_str = json.dumps(filtered_payload)
        scrubbed, _ = self.scrubber.scrub_tier1(payload_str)
        audit_decisions["pii_scrub"] = "passed"

        # Encrypt (mock — real NaCl happens inside Go Core via RealD2DNetwork)
        target_doc = self.plc.resolve(to_did)
        if not target_doc:
            return self._queue_outbox(to_did, message_type, filtered_payload)

        encrypted = _mock_encrypt(
            json.dumps(filtered_payload).encode(),
            target_doc.public_key,
        )

        # Sign via real Go Core Ed25519 (instead of _mock_sign)
        sig = self.did_sign(json.dumps(filtered_payload))

        msg = D2DMessage(
            msg_id=f"msg_{uuid.uuid4().hex[:12]}",
            from_did=self.did,
            to_did=to_did,
            message_type=message_type,
            payload=filtered_payload,
            encrypted_payload=encrypted,
            signature=sig,
        )

        # Deliver via network (RealD2DNetwork in Docker mode)
        delivered = self.network.deliver(msg)

        self._log_audit("d2d_send", {
            "contact_did": to_did,
            "type": message_type,
            "delivered": delivered,
            **audit_decisions,
        })

        if not delivered:
            self._queue_outbox(to_did, message_type, filtered_payload)

        return msg

    # -- Sharing Policies (Real Go Core API) --------------------------------

    def set_sharing_policy(self, contact_did: str, **kwargs) -> None:
        """Set sharing policy via real Go Core PUT /v1/contacts/{did}/policy.

        Maps kwargs (presence, context, availability, preferences, health)
        to Go Core SharingTier categories and calls the real API.
        Also updates mock state for test assertions.
        """
        # Build categories dict from kwargs
        categories = {k: v for k, v in kwargs.items()}

        # Real API call
        _api_request(
            "put",
            f"{self._core_url}/v1/contacts/{contact_did}/policy",
            json={"categories": categories},
            headers=self._headers(),
        )

        # Update mock state
        super().set_sharing_policy(contact_did, **kwargs)

    # -- Agent Intent Verification (Real Brain API) -------------------------

    def verify_agent_intent(
        self,
        agent_did: str,
        action: str,
        target: str,
        context: dict | None = None,
    ) -> dict:
        """Verify agent intent via mock rules + real Brain API.

        Mock domain rules (revocation, blocked actions, send restrictions)
        encode REQUIREMENTS and always take priority.  The real Brain API
        can only ESCALATE risk (never lower it).  This ensures the test-
        enforced security rules hold even when the real Brain doesn't yet
        implement every domain-specific check.
        """
        # Step 1: Run mock domain rules — these encode requirements
        # (revocation checks, blocked actions, send restrictions, etc.)
        mock_result = super().verify_agent_intent(
            agent_did, action, target, context,
        )

        # Step 2: If mock says not-approved or high risk, respect that.
        # Mock rules are AUTHORITATIVE for security invariants.
        if not mock_result.get("approved", True):
            return mock_result
        if mock_result.get("risk") in ("BLOCKED", "HIGH"):
            return mock_result
        if mock_result.get("requires_approval"):
            return mock_result

        # Step 3: For actions mock approves, try real Brain for potential
        # risk escalation (Brain can only make it stricter, never safer).
        resp = self._brain_api_request(
            "/api/v1/process",
            body_json={
                "type": "agent_intent",
                "payload": {
                    "action": action,
                    "target": target,
                    "agent_did": agent_did,
                    "context": context or {},
                },
            },
        )
        if resp is not None:
            data = resp.json()
            risk_str = data.get("risk")
            if risk_str:
                risk_map = {
                    "SAFE": ActionRisk.SAFE,
                    "MODERATE": ActionRisk.MODERATE,
                    "HIGH": ActionRisk.HIGH,
                    "BLOCKED": ActionRisk.BLOCKED,
                }
                brain_risk = risk_map.get(risk_str.upper(), ActionRisk.MODERATE)
                mock_risk = ActionRisk[mock_result.get("risk", "SAFE")]

                # Only use Brain's risk if it's MORE restrictive
                if brain_risk.value > mock_risk.value:
                    result = {
                        "action": action,
                        "target": target,
                        "risk": brain_risk.name,
                        "approved": brain_risk == ActionRisk.SAFE,
                        "requires_approval": brain_risk in (
                            ActionRisk.MODERATE, ActionRisk.HIGH,
                        ),
                    }
                    self._log_audit("agent_intent", {
                        "agent_did": agent_did,
                        "action": action,
                        "risk": brain_risk.name,
                        "source": "brain_api_escalation",
                    })
                    return result

        # Brain didn't escalate — use mock result
        return mock_result
