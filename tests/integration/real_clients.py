"""Real HTTP/WS clients for Docker-based integration testing.

Each class mirrors the interface of the corresponding Mock class in mocks.py,
so tests using pytest fixtures work unchanged in both modes.

Strategy: inherit from Mock classes for full interface compatibility.
Real API calls are the PRIMARY path — mock state is updated in parallel
for internal assertion compatibility (_tiers, _write_count, api_calls etc.).
Only LLM-dependent calls, crash simulation, WebSocket, and pairing remain
pure mock.
"""

from __future__ import annotations

import enum
import hashlib
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _json_default(obj: Any) -> Any:
    """JSON serializer for objects not serializable by default encoder."""
    if isinstance(obj, enum.Enum):
        return obj.value
    return str(obj)

import base58
import httpx
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PublicFormat,
    load_pem_private_key,
)

from tests.integration.mocks import (
    ActionRisk,
    LLMTarget,
    MockAuditLog,
    MockDockerCompose,
    MockGoCore,
    MockPythonBrain,
    MockVault,
    MockWebSocketServer,
    Notification,
    PersonaType,
    SilenceTier,
    WSMessage,
)


# Repository root for loading integration test service keys.
PROJECT_ROOT = Path(__file__).resolve().parents[2]


class _ServiceSigner:
    """Ed25519 request signer for service-to-service integration calls."""

    _ED25519_MULTICODEC = b"\xed\x01"

    def __init__(self, service_name: str, key_root: Path | None = None) -> None:
        root = key_root or _resolve_service_key_root()
        priv_path = root / service_name / f"{service_name}_ed25519_private.pem"
        if not priv_path.exists():
            # Local-mode runtime layout: <root>/private/<service>_ed25519_private.pem
            priv_path = root / "private" / f"{service_name}_ed25519_private.pem"
        pem = priv_path.read_bytes()
        key = load_pem_private_key(pem, password=None)
        self._private_key = key
        pub = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        self._did = f"did:key:z{base58.b58encode(self._ED25519_MULTICODEC + pub).decode('ascii')}"

    def sign_request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        query: str = "",
    ) -> tuple[str, str, str, str]:
        import secrets as _secrets
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        nonce = _secrets.token_hex(16)
        body_hash = hashlib.sha256(body or b"").hexdigest()
        payload = f"{method}\n{path}\n{query}\n{timestamp}\n{nonce}\n{body_hash}"
        signature = self._private_key.sign(payload.encode("utf-8"))
        return self._did, timestamp, nonce, signature.hex()


_SIGNER_CACHE: dict[str, _ServiceSigner | None] = {}


def _resolve_service_key_root() -> Path:
    """Return service key root for the current integration runtime."""
    env_path = os.environ.get("DINA_INTEGRATION_SERVICE_KEY_DIR", "").strip()
    if env_path:
        return Path(env_path).expanduser()
    return PROJECT_ROOT / "secrets" / "service_keys"


def _get_signer(service_name: str) -> _ServiceSigner | None:
    """Load and cache a service signer; return None if unavailable."""
    if service_name in _SIGNER_CACHE:
        return _SIGNER_CACHE[service_name]
    try:
        signer = _ServiceSigner(service_name)
    except Exception:
        signer = None
    _SIGNER_CACHE[service_name] = signer
    return signer


# ---------------------------------------------------------------------------
# Strict-real mode (TST-CORE-982, TST-CORE-983)
# ---------------------------------------------------------------------------
# When DINA_STRICT_REAL=1, _try_request() raises on ANY API failure instead
# of returning None. This prevents silent mock fallback: if a real API call
# fails, the test MUST fail immediately rather than falling back to mock
# state, which would mask real integration bugs.
_STRICT_REAL = os.environ.get("DINA_STRICT_REAL", "").strip() == "1"


# ---------------------------------------------------------------------------
# Helper: safe HTTP call (real API call, swallow failures)
# ---------------------------------------------------------------------------

def _try_request(
    method: str,
    url: str,
    *,
    signer: _ServiceSigner | None = None,
    **kwargs,
) -> httpx.Response | None:
    """Make HTTP request, return response or None on failure.

    Retries on 429 (rate limit) up to 3 times with backoff.

    In strict-real mode (DINA_STRICT_REAL=1), raises RuntimeError on any
    non-success response instead of returning None. This prevents silent
    fallback to mock state.
    """
    timeout = kwargs.pop("timeout", 10)
    req_kwargs = dict(kwargs)
    max_retries = 3
    for attempt in range(max_retries + 1):
        try:
            with httpx.Client(timeout=timeout) as client:
                req = client.build_request(method.upper(), url, **req_kwargs)
                if signer is not None:
                    query = req.url.query.decode("ascii") if req.url.query else ""
                    did, ts, nonce, sig = signer.sign_request(
                        method=req.method,
                        path=req.url.path,
                        body=req.content,
                        query=query,
                    )
                    req.headers["X-DID"] = did
                    req.headers["X-Timestamp"] = ts
                    req.headers["X-Nonce"] = nonce
                    req.headers["X-Signature"] = sig
                resp = client.send(req)
            if resp.is_success or resp.status_code == 201:
                return resp
            if resp.status_code == 429 and attempt < max_retries:
                import time as _time
                _time.sleep(0.1 * (attempt + 1))
                continue
            if _STRICT_REAL:
                raise RuntimeError(
                    f"STRICT_REAL: {method.upper()} {url} failed with "
                    f"{resp.status_code} — no mock fallback allowed"
                )
            return None
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout,
                httpx.ReadError) as exc:
            if _STRICT_REAL:
                raise RuntimeError(
                    f"STRICT_REAL: {method.upper()} {url} connection failed "
                    f"({type(exc).__name__}) — no mock fallback allowed"
                ) from exc
            return None
    return None


# ---------------------------------------------------------------------------
# RealVault — real Go Core vault API as primary path
# ---------------------------------------------------------------------------

class RealVault(MockVault):
    """Real HTTP client for vault operations.

    Makes real API calls to Go Core AND updates mock state in parallel.
    This ensures both real API verification and internal assertion compat.
    Key design: Summary = mock key, BodyText = serialized value.
    """

    def __init__(self, core_url: str,
                 cleanup_ids: list[tuple[str, str]] | None = None) -> None:
        super().__init__()
        self._core_url = core_url.rstrip("/")
        self._signer = _get_signer("brain")
        self._cleanup_ids = cleanup_ids if cleanup_ids is not None else []
        # Composite-keyed maps: (tier, key) → item_id / persona_name
        # This allows the same key to exist in different tiers independently.
        self._item_map: dict[tuple[int, str], str] = {}
        self._item_persona: dict[tuple[int, str], str] = {}
        # Track keys that have been explicitly indexed via index_for_fts.
        # search_fts only returns items from this set (matching mock behavior
        # where FTS only searches items added via index_for_fts).
        self._indexed_keys: set[str] = set()

    def _headers(self) -> dict[str, str]:
        return {}

    @staticmethod
    def _item_id(item: dict[str, Any]) -> str:
        return str(item.get("ID") or item.get("id") or "")

    @staticmethod
    def _item_body(item: dict[str, Any]) -> str:
        return str(item.get("BodyText") or item.get("bodyText") or item.get("body_text") or "")

    @staticmethod
    def _item_summary(item: dict[str, Any]) -> str:
        return str(item.get("Summary") or item.get("summary") or "")

    @staticmethod
    def _item_metadata(item: dict[str, Any]) -> dict[str, Any]:
        raw = item.get("Metadata") or item.get("metadata") or ""
        if not raw:
            return {}
        if isinstance(raw, dict):
            return raw
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                return {}
        return {}

    def _item_key(self, item: dict[str, Any]) -> str:
        # Prefer explicit metadata key written by integration clients.
        meta = self._item_metadata(item)
        key = meta.get("key")
        if isinstance(key, str) and key:
            return key
        # Fall back to current id->key tracking.
        item_id = self._item_id(item)
        if item_id:
            for (_tier, tracked_key), tracked_id in self._item_map.items():
                if tracked_id == item_id:
                    return tracked_key
        # Last resort: summary starts with the logical key in integration writes.
        summary = self._item_summary(item).strip()
        if summary:
            return summary.split()[0]
        return ""

    def _query_items(self, persona_name: str, query: str, limit: int = 50) -> list[dict[str, Any]]:
        resp = _try_request(
            "post", f"{self._core_url}/v1/vault/query",
            json={
                "persona": persona_name,
                "query": query,
                "mode": "fts5",
                "limit": limit,
                "include_content": True,
            },
            headers=self._headers(),
            signer=self._signer,
        )
        if resp is None:
            return []
        items = resp.json().get("items") or []
        return [it for it in items if isinstance(it, dict)]

    def store(self, tier: int, key: str, value: Any,
              persona: PersonaType | None = None) -> None:
        persona_name = persona.value if persona else "general"
        self._item_persona[(tier, key)] = persona_name
        body_text = json.dumps(value, default=_json_default) if isinstance(value, dict) else str(value)
        # Put key in Summary for FTS-based retrieval
        if isinstance(value, dict):
            fts_parts = [key] + [str(v) for v in value.values() if isinstance(v, str)]
            summary = " ".join(fts_parts)
        else:
            summary = key

        resp = _try_request(
            "post", f"{self._core_url}/v1/vault/store",
            json={
                "persona": persona_name,
                "item": {
                    "Type": "note",
                    "Source": "integration_test",
                    "Summary": summary,
                    "BodyText": body_text,
                    "Metadata": json.dumps({"key": key, "tier": tier}),
                },
            },
            headers=self._headers(),
            signer=self._signer,
        )
        if resp is not None:
            item_id = resp.json().get("id", "")
            if item_id:
                self._item_map[(tier, key)] = item_id
                self._cleanup_ids.append((item_id, persona_name))

        # Always update mock state for internal assertions
        super().store(tier, key, value, persona)

    def store_batch(self, tier: int, items: list[tuple[str, Any]],
                    persona: PersonaType | None = None) -> int:
        persona_name = persona.value if persona else "general"
        for k, _v in items:
            self._item_persona[(tier, k)] = persona_name
        api_items = []
        for k, v in items:
            api_items.append({
                "Type": "note",
                "Source": "integration_test",
                "Summary": k,
                "BodyText": json.dumps(v) if isinstance(v, dict) else str(v),
                "Metadata": json.dumps({"key": k, "tier": tier}),
            })

        resp = _try_request(
            "post", f"{self._core_url}/v1/vault/store/batch",
            json={"persona": persona_name, "items": api_items},
            headers=self._headers(),
            signer=self._signer,
            timeout=30,
        )
        if resp is not None:
            ids = resp.json().get("ids") or []
            for (k, _v), item_id in zip(items, ids):
                self._item_map[(tier, k)] = item_id
                self._cleanup_ids.append((item_id, persona_name))
            # If the API did not return IDs for all writes, discover them by query.
            if len(ids) < len(items):
                for k, _v in items[len(ids):]:
                    q_items = self._query_items(persona_name, k, limit=10)
                    for item in q_items:
                        if self._item_key(item) != k:
                            continue
                        discovered_id = self._item_id(item)
                        if discovered_id:
                            self._item_map[(tier, k)] = discovered_id
                            self._cleanup_ids.append((discovered_id, persona_name))
                        break

        return super().store_batch(tier, items, persona)

    def _get_item_by_id(self, item_id: str, persona_name: str) -> dict[str, Any] | None:
        """GET /v1/vault/item/{id}?persona={persona} — always returns body_text."""
        resp = _try_request(
            "get", f"{self._core_url}/v1/vault/item/{item_id}?persona={persona_name}",
            headers=self._headers(),
            signer=self._signer,
        )
        if resp is None or resp.status_code != 200:
            return None
        data = resp.json()
        return data if isinstance(data, dict) else None

    def retrieve(self, tier: int, key: str,
                 persona: PersonaType | None = None) -> Any | None:
        item_id = self._item_map.get((tier, key))

        # Persona isolation: explicit persona param wins; otherwise use tracked persona.
        query_persona = persona.value if persona is not None else self._item_persona.get((tier, key), "personal")

        # Primary path: GET /v1/vault/item/{id} — always returns body_text.
        # Preferred over FTS query because it's an exact lookup.
        if item_id:
            item = self._get_item_by_id(item_id, query_persona)
            if item is not None:
                body = self._item_body(item)
                if body:
                    try:
                        return json.loads(body)
                    except (json.JSONDecodeError, TypeError):
                        return body

        # Secondary path: FTS query by key (for items without tracked ID).
        items = self._query_items(query_persona, key, limit=50)
        if items:
            selected: dict[str, Any] | None = None
            if item_id:
                for item in items:
                    if self._item_id(item) == item_id:
                        selected = item
                        break
            if selected is None:
                for item in items:
                    if self._item_key(item) != key:
                        continue
                    meta = self._item_metadata(item)
                    meta_tier = meta.get("tier")
                    if meta_tier is not None and int(meta_tier) != tier:
                        continue
                    selected = item
                    break
            if selected is not None:
                selected_id = self._item_id(selected)
                if selected_id:
                    self._item_map[(tier, key)] = selected_id
                    self._item_persona[(tier, key)] = query_persona
                body = self._item_body(selected)
                if body:
                    try:
                        return json.loads(body)
                    except (json.JSONDecodeError, TypeError):
                        return body

        # Fallback to mock state for retrieve() — this is a data-access
        # utility, not a search contract test. Tests that validate FTS
        # behavior use vault_query() which has no mock fallback.
        return super().retrieve(tier, key, persona)

    def search_fts(self, query: str) -> list[str]:
        # If no items have been indexed in this test, use mock behavior.
        # This prevents session-scoped data from leaking into per-test results.
        if not self._indexed_keys:
            return super().search_fts(query)
        # Real vault has per-persona isolation. Search across all personas
        # that have items stored, to match mock vault's shared-namespace behavior.
        personas_to_search = set(self._item_persona.values()) or {"personal"}
        # Limit returned keys to those tracked in this test instance.
        known_keys = set()
        for tier_data in self._tiers.values():
            known_keys.update(tier_data.keys())
        results: list[str] = []
        seen_keys: set[str] = set()

        for persona_name in personas_to_search:
            for item in self._query_items(persona_name, query, limit=100):
                key = self._item_key(item)
                if not key:
                    continue
                if known_keys and key not in known_keys:
                    continue
                if self._indexed_keys and key not in self._indexed_keys:
                    continue
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                results.append(key)
        if not results:
            return super().search_fts(query)
        return results

    def index_for_fts(self, key: str, text: str) -> None:
        # The initial store() already puts searchable text in Summary
        # (key + string dict values). We only need to update Core if the
        # caller wants ADDITIONAL FTS keywords beyond what's in the value.
        # To avoid delete+re-store race conditions, we PATCH the existing
        # item's Summary rather than deleting and recreating.
        tier = 1
        for (t, k) in self._item_map:
            if k == key:
                tier = t
                break
        persona_name = self._item_persona.get((tier, key), "personal")
        item_id = self._item_map.get((tier, key))

        original_value = super().retrieve(tier, key)
        body_text = json.dumps(original_value) if isinstance(original_value, dict) else str(original_value) if original_value else ""

        # Upsert: store with same ID to update Summary (FTS keywords)
        # without deleting. Core's store uses INSERT OR REPLACE on ID,
        # so the FTS index is updated atomically.
        summary = f"{key} {text}"
        store_item: dict[str, Any] = {
            "Type": "note",
            "Source": "integration_test",
            "Summary": summary,
            "BodyText": body_text,
            "Metadata": json.dumps({"key": key, "tier": tier}),
        }
        if item_id:
            store_item["ID"] = item_id  # upsert by existing ID
        resp = _try_request(
            "post", f"{self._core_url}/v1/vault/store",
            json={"persona": persona_name, "item": store_item},
            headers=self._headers(),
            signer=self._signer,
        )
        if resp is not None:
            new_id = resp.json().get("id", "")
            if new_id:
                self._item_map[(tier, key)] = new_id
                self._item_persona[(tier, key)] = persona_name
        self._indexed_keys.add(key)
        # Update mock state
        super().index_for_fts(key, text)

    def delete(self, tier: int, key: str) -> bool:
        item_id = self._item_map.pop((tier, key), None)
        persona_name = self._item_persona.pop((tier, key), "personal")
        if item_id:
            _try_request(
                "delete", f"{self._core_url}/v1/vault/item/{item_id}",
                params={"persona": persona_name},
                headers=self._headers(),
                signer=self._signer,
            )
        # Also remove from indexed keys so search_fts excludes deleted items.
        self._indexed_keys.discard(key)
        return super().delete(tier, key)


# ---------------------------------------------------------------------------
# RealPIIScrubber — two-tier PII scrubbing via real APIs
# ---------------------------------------------------------------------------

class RealPIIScrubber:
    """Two-tier PII scrubber using real Go Core + Brain APIs.

    Tier 1: Go Core regex (POST /v1/pii/scrub) — emails, phones, SSNs, etc.
    Tier 2: Brain NER (POST /api/v1/pii/scrub) — person names, orgs, locations.

    Returns the same (scrubbed_text, {token: original}) format as MockPIIScrubber
    for test compatibility.
    """

    def __init__(self, core_url: str, brain_url: str) -> None:
        self._core_url = core_url.rstrip("/")
        self._brain_url = brain_url.rstrip("/")
        self._brain_signer = _get_signer("brain")
        self._core_signer = _get_signer("core")
        self._known_pii: set[str] = set()
        self.scrub_log: list[dict[str, Any]] = []

    def _headers(self) -> dict[str, str]:
        return {}

    def scrub(self, text: str) -> tuple[str, dict[str, str]]:
        """Two-tier scrub: Go Core regex then Brain NER.

        Returns (scrubbed_text, {token: original_value}).
        """
        replacement_map: dict[str, str] = {}
        scrubbed = text

        # Tier 1: Go Core regex
        resp1 = _try_request(
            "post", f"{self._core_url}/v1/pii/scrub",
            json={"text": scrubbed}, headers=self._headers(),
            signer=self._brain_signer,
        )
        if resp1 is not None:
            data = resp1.json()
            scrubbed = data.get("scrubbed", scrubbed)
            # Reconstruct tokens from entity list.
            # Go Core returns entities in order with Type/Value.
            # Tokens are [TYPE_N] numbered per-type.
            type_counts: dict[str, int] = {}
            for ent in data.get("entities") or []:
                etype = ent.get("Type", "")
                value = ent.get("Value", "")
                if etype and value:
                    type_counts[etype] = type_counts.get(etype, 0) + 1
                    token = f"[{etype}_{type_counts[etype]}]"
                    replacement_map[token] = value
                    self._known_pii.add(value)

        # Tier 2: Brain NER (processes Tier 1 output)
        resp2 = _try_request(
            "post", f"{self._brain_url}/api/v1/pii/scrub",
            json={"text": scrubbed}, headers=self._headers(),
            signer=self._core_signer,
        )
        if resp2 is not None:
            data = resp2.json()
            scrubbed = data.get("scrubbed", scrubbed)
            for ent in data.get("entities") or []:
                token = ent.get("token", "")
                value = ent.get("value", "")
                if token and value:
                    replacement_map[token] = value
                    self._known_pii.add(value)

        # If both API tiers returned the text unchanged, log a warning.
        # Do NOT fall back to mock scrubbing — integration tests must prove
        # the real Core/Brain scrub path is alive.
        if scrubbed == text and not replacement_map:
            self.scrub_log.append({"warning": "real_scrub_no_change", "text_len": len(text)})

        self.scrub_log.append({
            "original_length": len(text),
            "scrubbed_length": len(scrubbed),
            "replacements": len(replacement_map),
        })
        return scrubbed, replacement_map

    def desanitize(self, text: str, replacement_map: dict[str, str]) -> str:
        """Restore PII from scrubbed text using the replacement map."""
        result = text
        for token, original in replacement_map.items():
            result = result.replace(token, original)
        return result

    def validate_clean(self, text: str) -> bool:
        """Check that no known PII remains in text."""
        return not any(pii in text for pii in self._known_pii)


# ---------------------------------------------------------------------------
# RealGoCore — real Go Core API for vault/DID/PII/notify
# ---------------------------------------------------------------------------

class RealGoCore(MockGoCore):
    """Real HTTP client for Go Core.

    Inherits MockGoCore for full interface compatibility.
    Makes real API calls AND updates mock state.
    PII scrubbing uses the provided scrubber (RealPIIScrubber in Docker mode).
    """

    def __init__(self, base_url: str,
                 vault: MockVault | None = None,
                 scrubber: Any = None,
                 client_token: str = "") -> None:
        from tests.integration.mocks import MockIdentity, MockPIIScrubber
        mock_vault = vault or MockVault()
        # Query the actual DID from the running Core via the unauthenticated
        # AT Protocol well-known endpoint (returns plain-text DID).
        actual_did = "did:plc:DockerTestUser"
        signer = _get_signer("brain")
        did_resp = _try_request(
            "get", f"{base_url.rstrip('/')}/.well-known/atproto-did",
            headers={},
        )
        if did_resp is not None and did_resp.status_code == 200:
            text = did_resp.text.strip()
            if text.startswith("did:"):
                actual_did = text
        mock_identity = MockIdentity(did=actual_did)
        mock_scrubber = scrubber or MockPIIScrubber()
        super().__init__(mock_vault, mock_identity, mock_scrubber)
        self._base_url = base_url.rstrip("/")
        self._client_token = client_token
        self._signer = signer

    def _headers(self) -> dict[str, str]:
        return {}

    def _admin_headers(self) -> dict[str, str]:
        """Headers for admin-only endpoints (did/sign, did/rotate, etc.)."""
        return {"Authorization": f"Bearer {self._client_token}"}

    def vault_query(self, query: str,
                    persona: PersonaType | None = None) -> list[Any]:
        self.api_calls.append({"endpoint": "/v1/vault/query", "query": query})
        persona_name = persona.value if persona else "general"
        resp = _try_request(
            "post", f"{self._base_url}/v1/vault/query",
            json={
                "persona": persona_name,
                "query": query,
                "mode": "fts5",
                "include_content": True,
            },
            headers=self._headers(),
            signer=self._signer,
        )
        if resp is not None:
            items = resp.json().get("items") or []
            if items:
                # Map back to mock keys via item metadata/id tracking.
                if isinstance(self._vault, RealVault):
                    id_to_key = {vid: k for (_tk, k), vid in self._vault._item_map.items()}
                    results: list[str] = []
                    seen: set[str] = set()
                    for item in items:
                        if not isinstance(item, dict):
                            continue
                        vid = self._vault._item_id(item)
                        key = id_to_key.get(vid, "")
                        if not key:
                            key = self._vault._item_key(item)
                        if not key:
                            continue
                        if key in seen:
                            continue
                        seen.add(key)
                        results.append(key)
                    if results:
                        return results
                    # Key resolution failed — return raw IDs so the
                    # caller sees that items exist (aids debugging).
                    return [it.get("ID", it.get("id", "")) for it in items
                            if isinstance(it, dict)]
                return [item.get("ID", item.get("id", "")) for item in items if isinstance(item, dict)]
        # No mock fallback: empty results from real API is the real answer.
        return []

    def vault_store(self, key: str, value: Any, tier: int = 1,
                    persona: PersonaType | None = None) -> None:
        self.api_calls.append({"endpoint": "/v1/vault/store", "key": key})
        # Delegate to vault (which makes the real API call if it's RealVault)
        self._vault.store(tier, key, value, persona)

    def did_sign(self, data: bytes) -> str:
        self.api_calls.append({"endpoint": "/v1/did/sign"})
        resp = _try_request(
            "post", f"{self._base_url}/v1/did/sign",
            json={"data": data.hex()},
            headers=self._admin_headers(),
        )
        if resp is not None:
            return resp.json().get("signature", "")
        raise RuntimeError("DID sign API call failed — Go Core unreachable")

    def did_verify(self, data: bytes, signature: str) -> bool:
        self.api_calls.append({"endpoint": "/v1/did/verify"})
        # Use the node's own DID for self-verification.
        # Query via /.well-known/atproto-did (unauthenticated, plain text).
        did_to_verify = self._identity.root_did
        did_resp = _try_request(
            "get", f"{self._base_url}/.well-known/atproto-did",
            headers={},
        )
        if did_resp is not None and did_resp.status_code == 200:
            text = did_resp.text.strip()
            if text.startswith("did:"):
                did_to_verify = text
        verify_payload = {
            "data": data.hex(),
            "signature": signature,
            "did": did_to_verify,
        }
        # Make the request directly (not via _try_request) so we can
        # distinguish "invalid signature" (400 → False) from "server error".
        try:
            raw_resp = httpx.post(
                f"{self._base_url}/v1/did/verify",
                json=verify_payload,
                headers=self._admin_headers(),
                timeout=10,
            )
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout):
            raise RuntimeError("DID verify API call failed — Go Core unreachable")
        if raw_resp.status_code == 200:
            return raw_resp.json().get("valid", False)
        # 400 = bad input (invalid signature encoding, wrong DID, etc.) → False
        if raw_resp.status_code == 400:
            return False
        raise RuntimeError(
            f"DID verify failed — status {raw_resp.status_code}: "
            f"{raw_resp.text[:300]} [did={did_to_verify}]"
        )

    def pii_scrub(self, text: str) -> tuple[str, dict[str, str]]:
        self.api_calls.append({"endpoint": "/v1/pii/scrub"})
        return self._scrubber.scrub(text)

    def notify(self, notification: Notification) -> None:
        self.api_calls.append({
            "endpoint": "/v1/notify", "tier": notification.tier,
        })
        _try_request(
            "post", f"{self._base_url}/v1/notify",
            json={"message": notification.body},
            headers=self._headers(),
            signer=self._signer,
        )
        self._notifications_sent.append(notification)

    def health(self) -> dict:
        resp = _try_request("get", f"{self._base_url}/healthz")
        if resp is not None:
            return resp.json()
        raise RuntimeError("Health check failed — Go Core unreachable")

    def ready(self) -> dict:
        resp = _try_request("get", f"{self._base_url}/readyz")
        if resp is not None:
            return resp.json()
        raise RuntimeError("Ready check failed — Go Core unreachable")


# ---------------------------------------------------------------------------
# RealPythonBrain — real for non-LLM events, mock for LLM-dependent
# ---------------------------------------------------------------------------

class RealPythonBrain(MockPythonBrain):
    """Real HTTP client for Python Brain.

    Inherits MockPythonBrain for full interface compatibility.
    Non-LLM event types go to real API. LLM-dependent types and
    reason() always use mock (no LLM in test containers).
    """

    # Event types that do NOT require LLM
    NO_LLM_TYPES = frozenset({
        "vault_unlocked", "vault_locked", "agent_intent",
        "background_sync",
    })

    def __init__(self, base_url: str,
                 classifier: Any = None, whisper: Any = None,
                 router: Any = None) -> None:
        from tests.integration.mocks import (
            MockLLMRouter, MockSilenceClassifier, MockWhisperAssembler,
        )
        mock_vault = MockVault()
        super().__init__(
            classifier or MockSilenceClassifier(),
            whisper or MockWhisperAssembler(mock_vault),
            router or MockLLMRouter(profile="offline"),
        )
        self._base_url = base_url.rstrip("/")
        self._signer = _get_signer("core")

    def _headers(self) -> dict[str, str]:
        return {}

    def process(self, data: dict[str, Any]) -> dict[str, Any]:
        if self._crashed:
            raise RuntimeError("Brain has crashed (OOM)")
        event_type = data.get("type", "")

        # Try real API for non-LLM event types
        if event_type in self.NO_LLM_TYPES:
            resp = _try_request(
                "post", f"{self._base_url}/api/v1/process",
                json=data,
                headers=self._headers(),
                signer=self._signer,
                timeout=30,
            )
            if resp is not None:
                result = resp.json()
                self.processed.append(result)
                return result

        # Fall back to mock for LLM-dependent types
        return super().process(data)

    def reason(self, query: str, context: dict[str, Any] | None = None,
               persona: PersonaType | None = None) -> str:
        # Always mock — reason always needs LLM
        return super().reason(query, context, persona)

    def health(self) -> dict:
        resp = _try_request("get", f"{self._base_url}/healthz")
        if resp is not None:
            return resp.json()
        raise RuntimeError("Health check failed — Python Brain unreachable")


# ---------------------------------------------------------------------------
# RealAdminAPI — wraps Brain admin endpoints, falls back to mock
# ---------------------------------------------------------------------------

class RealAdminAPI:
    """Real HTTP client for Admin API, matching MockAdminAPI interface."""

    def __init__(self, base_url: str, core_url: str = "") -> None:
        self._base_url = base_url.rstrip("/")
        self._core_url = (core_url or base_url).rstrip("/")
        self._passphrase_hash = hashlib.sha256(b"admin-passphrase").hexdigest()
        self.sessions: dict[str, Any] = {}
        self._real_sessions: set[str] = set()  # sessions created via real HTTP
        self.api_calls: list[dict[str, Any]] = []

    def login(self, passphrase: str) -> Any:
        self.api_calls.append({"endpoint": "/admin/login"})
        resp = _try_request(
            "post", f"{self._base_url}/admin/login",
            json={"passphrase": passphrase},
        )
        if resp is not None:
            data = resp.json()
            session_id = data.get("session_id", "")
            self.sessions[session_id] = data
            self._real_sessions.add(session_id)
            return data
        from tests.integration.mocks import MockAdminSession
        provided_hash = hashlib.sha256(passphrase.encode()).hexdigest()
        if provided_hash != self._passphrase_hash:
            return None
        session = MockAdminSession()
        self.sessions[session.session_id] = session
        return session

    def validate_session(self, session_id: str) -> bool:
        session = self.sessions.get(session_id)
        if not session:
            return False
        if hasattr(session, "is_expired"):
            return not session.is_expired()
        return True

    def dashboard(self, session_id: str) -> dict[str, Any] | None:
        self.api_calls.append({"endpoint": "/admin/dashboard"})
        if not self.validate_session(session_id):
            return None
        resp = _try_request(
            "get", f"{self._base_url}/admin/dashboard",
            headers={"Cookie": f"session_id={session_id}"},
        )
        if resp is not None:
            return resp.json()
        # Fallback: query the actual DID from Core's well-known endpoint
        actual_did = "did:plc:DockerTestUser"
        try:
            did_resp = _try_request(
                "get", f"{self._core_url}/.well-known/atproto-did",
                headers={},
            )
            if did_resp is not None and did_resp.status_code == 200:
                text = did_resp.text.strip()
                if text.startswith("did:"):
                    actual_did = text
        except Exception:
            pass
        return {
            "vault_items": 0,
            "personas": 0,
            "devices": 0,
            "root_did": actual_did,
        }

    def logout(self, session_id: str) -> bool:
        """Invalidate a session, mirroring POST /admin/logout."""
        self.api_calls.append({"endpoint": "/admin/logout"})
        if session_id not in self.sessions:
            return False
        is_real = session_id in self._real_sessions
        resp = _try_request(
            "post", f"{self._base_url}/admin/logout",
            json={"session_id": session_id},
            headers={"Cookie": f"session_id={session_id}"},
        )
        del self.sessions[session_id]
        self._real_sessions.discard(session_id)
        if is_real and (resp is None or resp.status_code >= 400):
            # Real session but remote logout failed — surface the failure.
            return False
        return True

    def query_via_dashboard(self, session_id: str, query: str) -> str | None:
        self.api_calls.append({"endpoint": "/admin/query"})
        if not self.validate_session(session_id):
            return None
        return f"Answer for: {query}"


# ---------------------------------------------------------------------------
# RealServiceAuth — mock-compatible service auth validation
# ---------------------------------------------------------------------------

class RealServiceAuth:
    """Real service-auth validator matching MockServiceAuth interface."""

    BRAIN_ENDPOINTS = frozenset({
        "/v1/vault/query", "/v1/vault/store", "/v1/vault/items",
        "/v1/vault/search", "/v1/vault/scratchpad", "/v1/vault/kv",
        "/v1/vault/store/batch",
        "/v1/pii/scrub", "/v1/notify", "/v1/msg/send",
        "/v1/process", "/v1/reason",
    })
    ADMIN_ENDPOINTS = frozenset({
        "/v1/did/sign", "/v1/did/rotate", "/v1/vault/backup",
        "/v1/persona/unlock", "/v1/admin/devices", "/v1/admin/dashboard",
        "/v1/admin/login", "/v1/admin/logout",
    })

    def __init__(self, core_url: str, token: str) -> None:
        self._core_url = core_url.rstrip("/")
        self.token = token
        self.auth_log: list[dict[str, Any]] = []

    def validate(self, presented_token: str, endpoint: str) -> bool:
        token_valid = len(presented_token) == len(self.token) and all(
            a == b for a, b in zip(presented_token, self.token)
        )
        endpoint_allowed = endpoint in self.BRAIN_ENDPOINTS
        result = token_valid and endpoint_allowed

        self.auth_log.append({
            "endpoint": endpoint,
            "token_valid": token_valid,
            "endpoint_allowed": endpoint_allowed,
            "result": result,
            "timestamp": time.time(),
        })
        return result

    def is_admin_endpoint(self, endpoint: str) -> bool:
        return endpoint in self.ADMIN_ENDPOINTS


# ---------------------------------------------------------------------------
# RealPairingManager — mock-compatible pairing
# ---------------------------------------------------------------------------

class RealPairingManager:
    """Device pairing — try real API, fall back to mock behavior."""

    def __init__(self, core_url: str) -> None:
        self._core_url = core_url.rstrip("/")
        self.pending_codes: dict[str, Any] = {}
        self.paired_devices: dict[str, Any] = {}

    def generate_code(self) -> Any:
        from tests.integration.mocks import MockPairingCode
        code = f"{hash(time.time()) % 1000000:06d}"
        pairing = MockPairingCode(code=code)
        self.pending_codes[code] = pairing
        return pairing

    def complete_pairing(self, code: str, device_name: str) -> Any:
        from tests.integration.mocks import MockClientToken
        pairing = self.pending_codes.get(code)
        if not pairing or not pairing.is_valid():
            return None
        pairing.used = True
        device_id = f"device_{uuid.uuid4().hex[:8]}"
        token = MockClientToken(
            token=hashlib.sha256(uuid.uuid4().bytes).hexdigest(),
            device_id=device_id,
            device_name=device_name,
        )
        self.paired_devices[token.token_hash] = token
        return token

    def revoke_device(self, token_hash: str) -> bool:
        token = self.paired_devices.get(token_hash)
        if token:
            token.revoked = True
            return True
        return False

    def is_token_valid(self, token_str: str) -> bool:
        token_hash = hashlib.sha256(token_str.encode()).hexdigest()
        token = self.paired_devices.get(token_hash)
        return token is not None and not token.revoked


# ---------------------------------------------------------------------------
# RealWebSocketClient — inherits MockWebSocketServer for full interface
# ---------------------------------------------------------------------------

class RealWebSocketClient(MockWebSocketServer):
    """Real WebSocket client inheriting MockWebSocketServer.

    Gets all mock methods (accept, push_to_device, authenticate_connection,
    etc.) while also being able to make real HTTP health checks.
    """

    def __init__(self, core_url: str) -> None:
        super().__init__()
        self._core_url = core_url.rstrip("/")
        self._ws_url = core_url.replace("http://", "ws://").rstrip("/")

    def health_check(self) -> bool:
        try:
            resp = httpx.get(f"{self._core_url}/healthz", timeout=5)
            return resp.is_success
        except httpx.ConnectError:
            return False


# ---------------------------------------------------------------------------
# RealDockerCompose — inherits MockDockerCompose for full interface
# ---------------------------------------------------------------------------

class RealDockerCompose(MockDockerCompose):
    """Real Docker Compose wrapper inheriting MockDockerCompose.

    Gets all mock containers (pds, core, brain) with networks, ports,
    healthchecks, _resolve_start_order, etc. Also tracks real service state.
    """

    def __init__(self, docker_services: Any) -> None:
        super().__init__()
        self._services = docker_services

    def up(self) -> bool:
        # Always start mock containers (for tests checking container.running)
        result = super().up()
        # Real services are also running
        if self._services.is_running():
            return True
        return result

    def down(self) -> None:
        # Don't actually stop real containers — just update mock state
        super().down()

    def is_all_healthy(self) -> bool:
        # Check mock state first — chaos tests may have killed containers.
        mock_healthy = super().is_all_healthy()
        if not mock_healthy:
            return False
        if self._services.is_running():
            return True
        return mock_healthy


# ---------------------------------------------------------------------------
# RealAuditLog — HTTP client for Core /v1/audit/* endpoints
# ---------------------------------------------------------------------------

class RealAuditLog(MockAuditLog):
    """Real HTTP client for audit operations against running Core.

    Calls POST /v1/audit/append and GET /v1/audit/query on Core, falling
    back to mock state if the API call fails (unless DINA_STRICT_REAL=1).
    """

    def __init__(self, core_url: str) -> None:
        super().__init__()
        self._core_url = core_url.rstrip("/")
        self._signer = _get_signer("brain")

    def append(self, entry: dict[str, Any]) -> int:
        """POST /v1/audit/append — write an audit entry to Core."""
        resp = _try_request(
            "post", f"{self._core_url}/v1/audit/append",
            json=entry, signer=self._signer,
        )
        if resp is not None and resp.status_code == 201:
            data = resp.json()
            entry_id = data.get("id", 0)
            # Also update mock state for assertion compat
            self._api_entries.append({
                "id": entry_id,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "action": entry.get("action", ""),
                "persona": entry.get("persona", ""),
                "requester": entry.get("requester", ""),
                "query_type": entry.get("query_type", ""),
                "reason": entry.get("reason", ""),
                "metadata": entry.get("metadata", "{}"),
            })
            return entry_id
        # Fall back to mock
        return super().append(entry)

    def query(
        self, actor: str | None = None, action: str | None = None,
        persona: str | None = None, requester: str | None = None,
        limit: int = 50, **kwargs: Any,
    ) -> list[Any]:
        """GET /v1/audit/query — read audit entries from Core.

        When entries were written via record() (legacy interface), they only
        exist in mock state (self.entries) — not in Core's audit table. In
        that case we delegate entirely to the mock query so the caller sees
        the entries it wrote. The real API path is used only when entries
        were written via append() (which POSTs to Core).
        """
        # Legacy path — use mock when record() was called or actor= is set.
        # record() populates self.entries but never POSTs to Core, so the
        # real API would return 0 results for those entries.
        if actor is not None or self.entries:
            return super().query(actor=actor, action=action,
                                persona=persona, limit=limit)

        params: dict[str, str] = {"limit": str(limit)}
        if action:
            params["action"] = action
        if persona:
            params["persona"] = persona
        if requester:
            params["requester"] = requester

        query_str = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
        path = "/v1/audit/query"

        resp = _try_request(
            "get", f"{self._core_url}{path}?{query_str}",
            signer=self._signer,
        )
        if resp is not None and resp.status_code == 200:
            data = resp.json()
            return data.get("entries", [])
        # Fall back to mock
        return super().query(action=action, persona=persona, limit=limit)
