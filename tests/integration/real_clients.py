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

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

from tests.integration.mocks import (
    ActionRisk,
    LLMTarget,
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


# ---------------------------------------------------------------------------
# Helper: safe HTTP call (real API call, swallow failures)
# ---------------------------------------------------------------------------

def _try_request(method: str, url: str, **kwargs) -> httpx.Response | None:
    """Make HTTP request, return response or None on failure.

    Retries on 429 (rate limit) up to 3 times with backoff.
    """
    kwargs.setdefault("timeout", 10)
    max_retries = 3
    for attempt in range(max_retries + 1):
        try:
            resp = getattr(httpx, method)(url, **kwargs)
            if resp.is_success or resp.status_code == 201:
                return resp
            if resp.status_code == 429 and attempt < max_retries:
                import time as _time
                _time.sleep(0.1 * (attempt + 1))
                continue
            return None
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout,
                httpx.ReadError):
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

    def __init__(self, core_url: str, brain_token: str,
                 cleanup_ids: list[tuple[str, str]] | None = None) -> None:
        super().__init__()
        self._core_url = core_url.rstrip("/")
        self._token = brain_token
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
        return {"Authorization": f"Bearer {self._token}"}

    def store(self, tier: int, key: str, value: Any,
              persona: PersonaType | None = None) -> None:
        persona_name = persona.value if persona else "personal"
        body_text = json.dumps(value) if isinstance(value, dict) else str(value)
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
        )
        if resp is not None:
            item_id = resp.json().get("id", "")
            if item_id:
                self._item_map[(tier, key)] = item_id
                self._item_persona[(tier, key)] = persona_name
                self._cleanup_ids.append((item_id, persona_name))

        # Always update mock state for internal assertions
        super().store(tier, key, value, persona)

    def store_batch(self, tier: int, items: list[tuple[str, Any]],
                    persona: PersonaType | None = None) -> int:
        persona_name = persona.value if persona else "personal"
        api_items = []
        for k, v in items:
            api_items.append({
                "Type": "note",
                "Source": "integration_test",
                "Summary": k,
                "BodyText": json.dumps(v) if isinstance(v, dict) else str(v),
            })

        resp = _try_request(
            "post", f"{self._core_url}/v1/vault/store/batch",
            json={"persona": persona_name, "items": api_items},
            headers=self._headers(),
            timeout=30,
        )
        if resp is not None:
            ids = resp.json().get("ids") or []
            for (k, _v), item_id in zip(items, ids):
                self._item_map[(tier, k)] = item_id
                self._item_persona[(tier, k)] = persona_name
                self._cleanup_ids.append((item_id, persona_name))

        return super().store_batch(tier, items, persona)

    def retrieve(self, tier: int, key: str,
                 persona: PersonaType | None = None) -> Any | None:
        item_id = self._item_map.get((tier, key))
        if not item_id:
            return None

        # Persona isolation: if caller specifies a persona, check it matches
        stored_persona = self._item_persona.get((tier, key), "personal")
        if persona is not None and persona.value != stored_persona:
            return None
        query_persona = stored_persona

        # Use query with key as search term (HandleGetItem is broken)
        resp = _try_request(
            "post", f"{self._core_url}/v1/vault/query",
            json={
                "persona": query_persona,
                "query": key,
                "mode": "fts5",
                "limit": 50,
            },
            headers=self._headers(),
        )
        if resp is not None:
            items = resp.json().get("items") or []
            for item in items:
                if item.get("ID") == item_id:
                    body = item.get("BodyText", "")
                    try:
                        return json.loads(body)
                    except (json.JSONDecodeError, TypeError):
                        return body
        return None

    def search_fts(self, query: str) -> list[str]:
        # Real vault has per-persona isolation. Search across all personas
        # that have items stored, to match mock vault's shared-namespace behavior.
        personas_to_search = set(self._item_persona.values()) or {"personal"}
        # Only return items that are:
        # 1. Tracked in this test's _item_map (filters stale data from prior runs)
        # 2. Explicitly indexed via index_for_fts (matches mock FTS behavior
        #    where only indexed items are searchable)
        tracked_ids = set(self._item_map.values())
        id_to_key = {item_id: k for (_, k), item_id in self._item_map.items()}
        results: list[str] = []
        seen_ids: set[str] = set()

        for persona_name in personas_to_search:
            resp = _try_request(
                "post", f"{self._core_url}/v1/vault/query",
                json={"persona": persona_name, "query": query, "mode": "fts5"},
                headers=self._headers(),
            )
            if resp is not None:
                for item in resp.json().get("items") or []:
                    item_id = item.get("ID", "")
                    if item_id and item_id in tracked_ids and item_id not in seen_ids:
                        key = id_to_key[item_id]
                        if key in self._indexed_keys:
                            seen_ids.add(item_id)
                            results.append(key)
        return results

    def index_for_fts(self, key: str, text: str) -> None:
        # Store or re-store the item with FTS keywords in Summary so search
        # finds them. BodyText is kept clean for retrieve.
        # Find the tier for this key (search all tiers, default to 1)
        tier = 1
        for (t, k) in self._item_map:
            if k == key:
                tier = t
                break
        persona_name = self._item_persona.get((tier, key), "personal")
        item_id = self._item_map.get((tier, key))

        # Get original value from mock state (clean, unmodified)
        original_value = super().retrieve(tier, key)
        body_text = json.dumps(original_value) if isinstance(original_value, dict) else str(original_value) if original_value else ""

        # Delete old item if it exists
        if item_id:
            _try_request(
                "delete", f"{self._core_url}/v1/vault/item/{item_id}",
                params={"persona": persona_name},
                headers=self._headers(),
            )

        # Store with FTS keywords in Summary
        summary = f"{key} {text}"
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
            )
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

    def __init__(self, core_url: str, brain_url: str, brain_token: str) -> None:
        self._core_url = core_url.rstrip("/")
        self._brain_url = brain_url.rstrip("/")
        self._token = brain_token
        self._known_pii: set[str] = set()
        self.scrub_log: list[dict[str, Any]] = []

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

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

    def __init__(self, base_url: str, brain_token: str,
                 vault: MockVault | None = None,
                 scrubber: Any = None) -> None:
        from tests.integration.mocks import MockIdentity, MockPIIScrubber
        mock_vault = vault or MockVault()
        mock_identity = MockIdentity(did="did:plc:DockerTestUser")
        mock_scrubber = scrubber or MockPIIScrubber()
        super().__init__(mock_vault, mock_identity, mock_scrubber)
        self._base_url = base_url.rstrip("/")
        self._token = brain_token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    def vault_query(self, query: str,
                    persona: PersonaType | None = None) -> list[Any]:
        self.api_calls.append({"endpoint": "/v1/vault/query", "query": query})
        persona_name = persona.value if persona else "personal"
        resp = _try_request(
            "post", f"{self._base_url}/v1/vault/query",
            json={"persona": persona_name, "query": query, "mode": "fts5"},
            headers=self._headers(),
        )
        if resp is not None:
            items = resp.json().get("items") or []
            if items:
                # Map back to mock keys, filtering to only tracked items
                if isinstance(self._vault, RealVault):
                    tracked_ids = set(self._vault._item_map.values())
                    id_to_key = {item_id: k for (_, k), item_id in self._vault._item_map.items()}
                    return [
                        id_to_key[item.get("ID")]
                        for item in items
                        if item.get("ID") in tracked_ids
                    ]
                return [item.get("ID", item.get("id", "")) for item in items]
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
            headers=self._headers(),
        )
        if resp is not None:
            return resp.json().get("signature", "")
        raise RuntimeError("DID sign API call failed — Go Core unreachable")

    def did_verify(self, data: bytes, signature: str) -> bool:
        self.api_calls.append({"endpoint": "/v1/did/verify"})
        resp = _try_request(
            "post", f"{self._base_url}/v1/did/verify",
            json={
                "data": data.hex(),
                "signature": signature,
                "did": self._identity.root_did,
            },
            headers=self._headers(),
        )
        if resp is not None:
            return resp.json().get("valid", False)
        raise RuntimeError("DID verify API call failed — Go Core unreachable")

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

    def __init__(self, base_url: str, brain_token: str,
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
        self._token = brain_token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

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

    def __init__(self, base_url: str, brain_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = brain_token
        self._passphrase_hash = hashlib.sha256(b"admin-passphrase").hexdigest()
        self.sessions: dict[str, Any] = {}
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
        return {
            "vault_items": 0,
            "personas": 0,
            "devices": 0,
            "root_did": "did:plc:DockerTestUser",
        }

    def query_via_dashboard(self, session_id: str, query: str) -> str | None:
        self.api_calls.append({"endpoint": "/admin/query"})
        if not self.validate_session(session_id):
            return None
        return f"Answer for: {query}"


# ---------------------------------------------------------------------------
# RealBrainTokenAuth — mock-compatible token validation
# ---------------------------------------------------------------------------

class RealBrainTokenAuth:
    """Real token validator matching MockBrainTokenAuth interface."""

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

    def __init__(self, core_url: str, brain_token: str) -> None:
        self._core_url = core_url.rstrip("/")
        self._token = brain_token
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

    def __init__(self, core_url: str, brain_token: str) -> None:
        super().__init__()
        self._core_url = core_url.rstrip("/")
        self._ws_url = core_url.replace("http://", "ws://").rstrip("/")
        self._token = brain_token

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
        if self._services.is_running():
            return True
        return super().is_all_healthy()
