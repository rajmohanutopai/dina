"""Mock classes for Dina integration tests.

These mocks define the **contract** each real module must satisfy.
They are the living specification for the codebase rewrite.

All mocks are pure Python — no real LLM, no real network, no real blockchain.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any, Callable


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class SilenceTier(Enum):
    """Three-tier silence classification."""
    TIER_1_FIDUCIARY = 1   # Interrupt — silence would cause harm
    TIER_2_SOLICITED = 2   # Notify — user asked for this
    TIER_3_ENGAGEMENT = 3  # Silent — save for daily briefing


class TrustRing(Enum):
    """Identity-based trust layers."""
    RING_1_UNVERIFIED = 1
    RING_2_VERIFIED = 2
    RING_3_SKIN_IN_GAME = 3


class ActionRisk(Enum):
    """Risk level for agent actions."""
    SAFE = auto()       # Read-only, auto-approve
    MODERATE = auto()   # Needs user approval
    HIGH = auto()       # Always flagged (financial, data sharing)
    BLOCKED = auto()    # Untrusted vendor or escalation attempt


class PersonaType(Enum):
    """Standard persona compartments."""
    CONSUMER = "consumer"
    PROFESSIONAL = "professional"
    SOCIAL = "social"
    HEALTH = "health"
    FINANCIAL = "financial"
    CITIZEN = "citizen"
    CUSTOM = "custom"


class LLMTarget(Enum):
    """Where to route LLM inference."""
    LOCAL = auto()       # llama-server (Gemma 3n)
    CLOUD = auto()       # Claude/Gemini via PII scrubber
    ON_DEVICE = auto()   # Rich client on-device LLM
    NONE = auto()        # SQLite FTS5 only, no LLM needed


class ConnectorStatus(Enum):
    """Connector health status."""
    ACTIVE = auto()
    PAUSED = auto()
    ERROR = auto()
    DISABLED = auto()


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Notification:
    """A notification from Dina to the user."""
    tier: SilenceTier
    title: str
    body: str
    actions: list[str] = field(default_factory=list)
    timestamp: float = field(default_factory=time.time)
    source: str = ""


@dataclass
class DIDDocument:
    """Minimal DID Document for testing."""
    did: str
    public_key: str
    service_endpoint: str
    verification_method: str = ""


@dataclass
class DinaMessage:
    """Typed Dina-to-Dina message."""
    type: str           # e.g. "dina/social/arrival", "dina/commerce/inquiry"
    from_did: str
    to_did: str
    payload: dict[str, Any]
    signature: str = ""
    timestamp: float = field(default_factory=time.time)


@dataclass
class AgentIntent:
    """Intent submitted by an external agent for Dina approval."""
    agent_did: str
    action: str         # "send_email", "transfer_money", "search", etc.
    target: str         # recipient or resource
    context: dict[str, Any] = field(default_factory=dict)
    constraints: dict[str, Any] = field(default_factory=dict)
    risk_level: ActionRisk = ActionRisk.SAFE


@dataclass
class ExpertAttestation:
    """Signed expert review in the Reputation Graph."""
    expert_did: str
    expert_trust_ring: TrustRing
    product_category: str
    product_id: str
    rating: int
    verdict: dict[str, Any]
    source_url: str
    deep_link: str = ""
    deep_link_context: str = ""
    creator_name: str = ""
    signature: str = ""
    timestamp: float = field(default_factory=time.time)


@dataclass
class OutcomeReport:
    """Anonymized purchase outcome for the Reputation Graph."""
    reporter_trust_ring: TrustRing
    reporter_age_days: int
    product_category: str
    product_id: str
    purchase_verified: bool
    time_since_purchase_days: int
    outcome: str        # "still_using", "returned", "broken", etc.
    satisfaction: str    # "positive", "neutral", "negative"
    issues: list[str] = field(default_factory=list)
    signature: str = ""
    timestamp: float = field(default_factory=time.time)


@dataclass
class Draft:
    """An email/message draft in Tier 4 staging."""
    draft_id: str
    to: str
    subject: str
    body: str
    confidence: float
    created_at: float = field(default_factory=time.time)
    expires_at: float = 0.0
    sent: bool = False


@dataclass
class PaymentIntent:
    """A payment intent in Tier 4 staging."""
    intent_id: str
    method: str         # "upi", "crypto", "web"
    intent_uri: str
    merchant: str
    amount: float
    currency: str
    recommendation: str = ""
    created_at: float = field(default_factory=time.time)
    expires_at: float = 0.0
    executed: bool = False


@dataclass
class SharingRule:
    """Per-contact sharing rules for Dina-to-Dina communication."""
    contact_did: str
    persona: PersonaType
    allowed: list[str] = field(default_factory=list)
    denied: list[str] = field(default_factory=list)


@dataclass
class EstateBeneficiary:
    """A beneficiary in the digital estate plan."""
    name: str
    dina_did: str
    receives_personas: list[PersonaType]
    access_type: str = "full_decrypt"  # or "read_only_90_days"


@dataclass
class EstatePlan:
    """Digital estate configuration."""
    trigger: str = "dead_mans_switch"
    switch_interval_days: int = 90
    beneficiaries: list[EstateBeneficiary] = field(default_factory=list)
    default_action: str = "destroy"


# ---------------------------------------------------------------------------
# Mock: Human (the user)
# ---------------------------------------------------------------------------

class MockHuman:
    """Simulates the user — approvals, commands, queries."""

    def __init__(self) -> None:
        self.notifications: list[Notification] = []
        self.approval_responses: dict[str, bool] = {}  # action → approve/deny
        self.default_approve: bool = True
        self.liveness_responses: list[bool] = []  # for dead man's switch
        self._liveness_index: int = 0

    def receive_notification(self, notification: Notification) -> None:
        self.notifications.append(notification)

    def approve(self, action: str) -> bool:
        if action in self.approval_responses:
            return self.approval_responses[action]
        return self.default_approve

    def set_approval(self, action: str, approved: bool) -> None:
        self.approval_responses[action] = approved

    def respond_to_liveness(self) -> bool:
        if self._liveness_index < len(self.liveness_responses):
            resp = self.liveness_responses[self._liveness_index]
            self._liveness_index += 1
            return resp
        return False  # default: no response (simulates death/incapacity)

    def query(self, question: str) -> str:
        """Simulate user asking Dina a question."""
        return question


# ---------------------------------------------------------------------------
# Mock: Identity & Personas
# ---------------------------------------------------------------------------

class MockIdentity:
    """Root identity with SLIP-0010 persona derivation."""

    def __init__(self, did: str | None = None) -> None:
        self.root_did = did or f"did:plc:{uuid.uuid4().hex[:40]}"
        self.root_private_key = hashlib.sha256(self.root_did.encode()).hexdigest()
        self.bip39_mnemonic = "abandon " * 23 + "art"  # placeholder 24 words
        self.personas: dict[PersonaType, MockPersona] = {}
        self.devices: list[str] = []

    def derive_persona(self, persona_type: PersonaType) -> MockPersona:
        if persona_type not in self.personas:
            # SLIP-0010 Ed25519 hardened derivation (mocked)
            path = f"/persona/{persona_type.value}"
            derived_key = hashlib.sha256(
                f"{self.root_private_key}{path}".encode()
            ).hexdigest()
            persona_did = f"did:key:z6Mk{derived_key[:40]}"
            self.personas[persona_type] = MockPersona(
                persona_type=persona_type,
                did=persona_did,
                derived_key=derived_key,
                storage_partition=f"partition_{persona_type.value}",
            )
        return self.personas[persona_type]

    def sign(self, data: bytes) -> str:
        """Sign data with root key (mocked as HMAC)."""
        return hashlib.sha256(self.root_private_key.encode() + data).hexdigest()

    def verify(self, data: bytes, signature: str) -> bool:
        return self.sign(data) == signature

    def register_device(self, device_id: str) -> str:
        """Generate device-delegated key."""
        self.devices.append(device_id)
        return hashlib.sha256(
            f"{self.root_private_key}device:{device_id}".encode()
        ).hexdigest()


@dataclass
class MockPersona:
    """A cryptographic persona compartment."""
    persona_type: PersonaType
    did: str
    derived_key: str
    storage_partition: str
    allowed_fields: list[str] = field(default_factory=list)

    def encrypt(self, data: str) -> str:
        """Mock encryption — in reality AES-256-GCM with persona key."""
        return f"ENC[{self.storage_partition}]:{hashlib.sha256(data.encode()).hexdigest()}"

    def decrypt(self, encrypted: str) -> str | None:
        """Mock decryption — only works if partition matches."""
        if f"ENC[{self.storage_partition}]:" in encrypted:
            return "DECRYPTED_CONTENT"
        return None  # Cannot decrypt other persona's data


# ---------------------------------------------------------------------------
# Mock: Vault (Storage Tiers 0-5)
# ---------------------------------------------------------------------------

class MockVault:
    """SQLite vault mock with six-tier encrypted storage."""

    def __init__(self) -> None:
        self._tiers: dict[int, dict[str, Any]] = {i: {} for i in range(6)}
        self._partitions: dict[str, dict[str, Any]] = {}  # per-persona
        self._fts_index: dict[str, list[str]] = {}  # full-text search

    def store(self, tier: int, key: str, value: Any,
              persona: PersonaType | None = None) -> None:
        self._tiers[tier][key] = value
        if persona:
            partition = f"partition_{persona.value}"
            if partition not in self._partitions:
                self._partitions[partition] = {}
            self._partitions[partition][key] = value

    def retrieve(self, tier: int, key: str,
                 persona: PersonaType | None = None) -> Any | None:
        if persona:
            partition = f"partition_{persona.value}"
            return self._partitions.get(partition, {}).get(key)
        return self._tiers[tier].get(key)

    def search_fts(self, query: str) -> list[str]:
        """Full-text search across Tier 1."""
        results = []
        for key, keywords in self._fts_index.items():
            if any(query.lower() in kw.lower() for kw in keywords):
                results.append(key)
        return results

    def index_for_fts(self, key: str, text: str) -> None:
        self._fts_index[key] = text.split()

    def delete(self, tier: int, key: str) -> bool:
        """Permanent deletion — truly gone."""
        deleted = key in self._tiers[tier]
        self._tiers[tier].pop(key, None)
        for partition in self._partitions.values():
            partition.pop(key, None)
        self._fts_index.pop(key, None)
        return deleted

    def per_persona_partition(self, persona: PersonaType) -> dict[str, Any]:
        partition = f"partition_{persona.value}"
        return dict(self._partitions.get(partition, {}))

    def snapshot(self) -> dict[str, Any]:
        """Create encrypted snapshot for backup/archive."""
        return {"tiers": dict(self._tiers), "timestamp": time.time()}


class MockStagingTier:
    """Tier 4 — ephemeral staging for drafts and payment intents."""

    def __init__(self, expiry_seconds: float = 72 * 3600) -> None:
        self._items: dict[str, Any] = {}
        self._expiry_seconds = expiry_seconds

    def store_draft(self, draft: Draft) -> str:
        if draft.expires_at == 0.0:
            draft.expires_at = draft.created_at + self._expiry_seconds
        self._items[draft.draft_id] = draft
        return draft.draft_id

    def store_payment_intent(self, intent: PaymentIntent) -> str:
        if intent.expires_at == 0.0:
            intent.expires_at = intent.created_at + self._expiry_seconds
        self._items[intent.intent_id] = intent
        return intent.intent_id

    def get(self, item_id: str) -> Any | None:
        item = self._items.get(item_id)
        if item and hasattr(item, "expires_at") and time.time() > item.expires_at:
            del self._items[item_id]
            return None
        return item

    def auto_expire(self, current_time: float | None = None) -> int:
        """Remove expired items. Returns count of removed items."""
        now = current_time or time.time()
        expired = [
            k for k, v in self._items.items()
            if hasattr(v, "expires_at") and now > v.expires_at
        ]
        for k in expired:
            del self._items[k]
        return len(expired)


# ---------------------------------------------------------------------------
# Mock: PII Scrubber
# ---------------------------------------------------------------------------

class MockPIIScrubber:
    """PII scrubbing with replacement map and de-sanitizer."""

    # PII patterns to detect and replace
    PII_PATTERNS: dict[str, str] = {
        "Rajmohan": "[PERSON_1]",
        "Sancho": "[PERSON_2]",
        "Maria": "[PERSON_3]",
        "rajmohan@email.com": "[EMAIL_1]",
        "sancho@email.com": "[EMAIL_2]",
        "+91-9876543210": "[PHONE_1]",
        "123 Main Street": "[ADDRESS_1]",
        "4111-2222-3333-4444": "[CC_NUM]",
        "XXXX-XXXX-1234": "[AADHAAR]",
    }

    def __init__(self, extra_patterns: dict[str, str] | None = None) -> None:
        self._replacement_map: dict[str, str] = dict(self.PII_PATTERNS)
        if extra_patterns:
            self._replacement_map.update(extra_patterns)
        self._reverse_map: dict[str, str] = {
            v: k for k, v in self._replacement_map.items()
        }
        self.scrub_log: list[dict[str, Any]] = []

    def scrub(self, text: str) -> tuple[str, dict[str, str]]:
        """Scrub PII from text. Returns (scrubbed_text, replacement_map)."""
        scrubbed = text
        used_replacements: dict[str, str] = {}
        for pii, placeholder in self._replacement_map.items():
            if pii in scrubbed:
                scrubbed = scrubbed.replace(pii, placeholder)
                used_replacements[placeholder] = pii
        self.scrub_log.append({
            "original_length": len(text),
            "scrubbed_length": len(scrubbed),
            "replacements": len(used_replacements),
        })
        return scrubbed, used_replacements

    def desanitize(self, text: str, replacement_map: dict[str, str]) -> str:
        """Restore PII from scrubbed text using the replacement map."""
        result = text
        for placeholder, original in replacement_map.items():
            result = result.replace(placeholder, original)
        return result

    def validate_clean(self, text: str) -> bool:
        """Check that no known PII remains in text."""
        return not any(pii in text for pii in self._replacement_map)


# ---------------------------------------------------------------------------
# Mock: Key Manager
# ---------------------------------------------------------------------------

class MockKeyManager:
    """Key management — derivation, encryption, rotation."""

    def __init__(self, identity: MockIdentity) -> None:
        self._identity = identity

    @property
    def root_key(self) -> str:
        return self._identity.root_private_key

    def derive_persona_key(self, persona_type: PersonaType) -> str:
        persona = self._identity.derive_persona(persona_type)
        return persona.derived_key

    def derive_device_key(self, device_id: str) -> str:
        return self._identity.register_device(device_id)

    def key_wrap(self, plaintext: str, passphrase: str) -> str:
        """Mock key wrapping: passphrase → Argon2id (KEK) → AES-256-GCM wraps plaintext (DEK)."""
        kek = hashlib.sha256(passphrase.encode()).hexdigest()
        return f"WRAPPED[{kek[:8]}]:{hashlib.sha256(plaintext.encode()).hexdigest()}"

    # Backward compat alias
    argon2id_encrypt = key_wrap


# ---------------------------------------------------------------------------
# Mock: Silence Classifier
# ---------------------------------------------------------------------------

class MockSilenceClassifier:
    """Classifies events into silence tiers."""

    # Default classification rules
    FIDUCIARY_KEYWORDS = {
        "malicious", "phishing", "fraud", "scam", "breach", "emergency",
        "security", "unauthorized",
    }
    SOLICITED_TYPES = {"alarm", "price_alert", "search_results", "reminder"}

    def __init__(self) -> None:
        self.user_overrides: dict[str, SilenceTier] = {}
        self.classification_log: list[dict[str, Any]] = []

    def classify(self, event_type: str, content: str = "",
                 context: dict[str, Any] | None = None) -> SilenceTier:
        """Classify an event into a silence tier."""
        # User overrides take precedence
        if event_type in self.user_overrides:
            tier = self.user_overrides[event_type]
            self._log(event_type, tier, "user_override")
            return tier

        # Tier 1: fiduciary — silence would cause harm
        if any(kw in content.lower() for kw in self.FIDUCIARY_KEYWORDS):
            self._log(event_type, SilenceTier.TIER_1_FIDUCIARY, "keyword_match")
            return SilenceTier.TIER_1_FIDUCIARY

        # Tier 2: solicited — user asked for this
        if event_type in self.SOLICITED_TYPES:
            self._log(event_type, SilenceTier.TIER_2_SOLICITED, "solicited_type")
            return SilenceTier.TIER_2_SOLICITED

        # Context-dependent classification
        if context and context.get("user_waiting"):
            self._log(event_type, SilenceTier.TIER_2_SOLICITED, "context_waiting")
            return SilenceTier.TIER_2_SOLICITED

        # Default: Tier 3
        self._log(event_type, SilenceTier.TIER_3_ENGAGEMENT, "default")
        return SilenceTier.TIER_3_ENGAGEMENT

    def set_override(self, event_type: str, tier: SilenceTier) -> None:
        self.user_overrides[event_type] = tier

    def _log(self, event_type: str, tier: SilenceTier, reason: str) -> None:
        self.classification_log.append({
            "event_type": event_type,
            "tier": tier,
            "reason": reason,
            "timestamp": time.time(),
        })


# ---------------------------------------------------------------------------
# Mock: Whisper Assembler
# ---------------------------------------------------------------------------

class MockWhisperAssembler:
    """Assembles contextual whispers from Vault data."""

    def __init__(self, vault: MockVault) -> None:
        self._vault = vault
        self.whisper_log: list[dict[str, Any]] = []

    def assemble_context(self, contact_did: str,
                         situation: str = "") -> str | None:
        """Assemble a contextual whisper for a given contact/situation."""
        # Search vault for relevant context
        context_items = []
        for key, value in self._vault._tiers[1].items():
            if isinstance(value, dict) and value.get("contact") == contact_did:
                context_items.append(value)

        if not context_items:
            return None

        # Build whisper from context
        whisper_parts = []
        for item in context_items:
            if "last_message" in item:
                whisper_parts.append(item["last_message"])
            if "context_flag" in item:
                whisper_parts.append(item["context_flag"])
            if "preference" in item:
                whisper_parts.append(item["preference"])

        whisper = ". ".join(whisper_parts) if whisper_parts else None
        self.whisper_log.append({
            "contact": contact_did,
            "situation": situation,
            "whisper": whisper,
        })
        return whisper


# ---------------------------------------------------------------------------
# Mock: LLM Router
# ---------------------------------------------------------------------------

class MockLLMRouter:
    """Routes tasks to the correct LLM based on type and persona."""

    def __init__(self) -> None:
        self.routing_log: list[dict[str, Any]] = []

    def route(self, task_type: str,
              persona: PersonaType | None = None) -> LLMTarget:
        """Determine where to route LLM inference."""
        # Sensitive personas: NEVER cloud
        if persona in (PersonaType.HEALTH, PersonaType.FINANCIAL):
            target = LLMTarget.LOCAL
            self._log(task_type, persona, target, "sensitive_persona")
            return target

        # Simple lookup: no LLM needed
        if task_type in ("fts_search", "exact_match", "id_lookup"):
            target = LLMTarget.NONE
            self._log(task_type, persona, target, "no_llm_needed")
            return target

        # Basic summarization/drafting: local LLM
        if task_type in ("summarize", "draft", "classify", "embed"):
            target = LLMTarget.LOCAL
            self._log(task_type, persona, target, "basic_task")
            return target

        # Complex reasoning: cloud via PII scrubber
        if task_type in ("multi_step_analysis", "complex_reasoning"):
            target = LLMTarget.CLOUD
            self._log(task_type, persona, target, "complex_task")
            return target

        # Interactive chat: on-device for latency
        if task_type == "interactive_chat":
            target = LLMTarget.ON_DEVICE
            self._log(task_type, persona, target, "latency_sensitive")
            return target

        # Default: local
        target = LLMTarget.LOCAL
        self._log(task_type, persona, target, "default")
        return target

    def _log(self, task_type: str, persona: PersonaType | None,
             target: LLMTarget, reason: str) -> None:
        self.routing_log.append({
            "task_type": task_type,
            "persona": persona,
            "target": target,
            "reason": reason,
        })


# ---------------------------------------------------------------------------
# Mock: P2P Channel (DIDComm v2.1)
# ---------------------------------------------------------------------------

class MockP2PChannel:
    """DIDComm v2.1 encrypted P2P communication."""

    def __init__(self) -> None:
        self.messages: list[DinaMessage] = []
        self.authenticated_peers: set[str] = set()
        self.allowed_contacts: set[str] = set()
        self.queue: list[DinaMessage] = []  # for offline peers

    def authenticate(self, local_did: str, remote_did: str,
                     local_identity: MockIdentity,
                     remote_doc: DIDDocument) -> bool:
        """Mutual DID authentication."""
        # Verify remote DID matches document
        if remote_doc.did != remote_did:
            return False
        # Check allowed contacts
        if remote_did not in self.allowed_contacts:
            return False
        self.authenticated_peers.add(remote_did)
        return True

    def send(self, message: DinaMessage) -> bool:
        """Send an encrypted message to a peer."""
        if message.to_did not in self.authenticated_peers:
            # Queue for later delivery
            self.queue.append(message)
            return False
        self.messages.append(message)
        return True

    def receive(self) -> DinaMessage | None:
        """Receive next message from peers."""
        if self.messages:
            return self.messages.pop(0)
        return None

    def add_contact(self, did: str) -> None:
        self.allowed_contacts.add(did)


class MockPLCResolver:
    """Resolves did:plc to DID Documents via PLC Directory lookup."""

    def __init__(self) -> None:
        self._registry: dict[str, DIDDocument] = {}

    def register(self, doc: DIDDocument) -> None:
        self._registry[doc.did] = doc

    def resolve(self, did: str) -> DIDDocument | None:
        return self._registry.get(did)


class MockRelay:
    """Relay for NAT-traversal — sees only encrypted blobs."""

    def __init__(self) -> None:
        self.forwarded: list[dict[str, str]] = []

    def forward(self, from_did: str, to_did: str,
                encrypted_blob: str) -> bool:
        """Forward encrypted blob. Relay cannot read content."""
        self.forwarded.append({
            "from": from_did,
            "to": to_did,
            "blob_hash": hashlib.sha256(encrypted_blob.encode()).hexdigest(),
        })
        return True


# ---------------------------------------------------------------------------
# Mock: External Agent (OpenClaw-type)
# ---------------------------------------------------------------------------

class MockExternalAgent:
    """Task agent that executes delegated work via MCP protocol."""

    def __init__(self, agent_did: str = "", name: str = "OpenClaw") -> None:
        self.agent_did = agent_did or f"did:plc:Agent{uuid.uuid4().hex[:32]}"
        self.name = name
        self.intents_submitted: list[AgentIntent] = []
        self.tasks_executed: list[dict[str, Any]] = []
        self.status: str = "idle"
        self._should_fail: bool = False
        self._should_escalate: bool = False

    def submit_intent(self, intent: AgentIntent) -> AgentIntent:
        """Submit an intent to Dina for approval."""
        intent.agent_did = self.agent_did
        self.intents_submitted.append(intent)
        return intent

    def execute_task(self, task: dict[str, Any]) -> dict[str, Any]:
        """Execute an approved task."""
        if self._should_fail:
            self.status = "failed"
            raise RuntimeError(f"Agent {self.name} crashed during execution")
        if self._should_escalate:
            # Attempt privilege escalation
            task["escalated"] = True
        self.status = "executing"
        result = {
            "task_id": task.get("task_id", str(uuid.uuid4())),
            "status": "completed",
            "result": f"Task '{task.get('action', 'unknown')}' completed by {self.name}",
        }
        self.tasks_executed.append(result)
        self.status = "idle"
        return result

    def report_status(self) -> dict[str, str]:
        return {"agent": self.name, "status": self.status, "did": self.agent_did}

    def set_should_fail(self, fail: bool = True) -> None:
        self._should_fail = fail

    def set_should_escalate(self, escalate: bool = True) -> None:
        self._should_escalate = escalate


# ---------------------------------------------------------------------------
# Mock: Review Bot
# ---------------------------------------------------------------------------

class MockReviewBot:
    """Specialist review bot with reputation score and source attribution."""

    def __init__(self, bot_did: str = "", reputation: int = 90) -> None:
        self.bot_did = bot_did or f"did:plc:Bot{uuid.uuid4().hex[:34]}"
        self.reputation_score = reputation
        self.queries: list[dict[str, Any]] = []
        self._responses: dict[str, dict[str, Any]] = {}

    def add_response(self, query_keyword: str,
                     response: dict[str, Any]) -> None:
        self._responses[query_keyword] = response

    def query_product(self, query: str,
                      requester_trust_ring: TrustRing = TrustRing.RING_2_VERIFIED,
                      max_sources: int = 5) -> dict[str, Any]:
        """Query the bot for product recommendations."""
        self.queries.append({
            "query": query,
            "trust_ring": requester_trust_ring,
            "max_sources": max_sources,
        })

        # Find matching response
        for keyword, response in self._responses.items():
            if keyword.lower() in query.lower():
                return response

        # Default response
        return {
            "recommendations": [],
            "bot_signature": "mock_sig",
            "bot_did": self.bot_did,
        }


class MockLegalBot:
    """Specialist legal bot — form filling, draft-only mode."""

    def __init__(self, bot_did: str = "", reputation: int = 91) -> None:
        self.bot_did = bot_did or f"did:plc:Legal{uuid.uuid4().hex[:32]}"
        self.reputation_score = reputation
        self.form_fills: list[dict[str, Any]] = []

    def form_fill(self, task: str, identity_data: dict[str, Any],
                  constraints: dict[str, Any] | None = None) -> Draft:
        """Fill forms — always returns a draft, never submits."""
        constraints = constraints or {}
        self.form_fills.append({
            "task": task,
            "identity_fields": list(identity_data.keys()),
            "constraints": constraints,
        })
        return Draft(
            draft_id=f"legal_{uuid.uuid4().hex[:8]}",
            to="government_portal",
            subject=f"Draft: {task}",
            body=f"Form filled for {task}. Review required.",
            confidence=0.85,
        )


# ---------------------------------------------------------------------------
# Mock: Reputation Graph
# ---------------------------------------------------------------------------

class MockReputationGraph:
    """Federated reputation ledger with signed tombstones."""

    def __init__(self) -> None:
        self.attestations: list[ExpertAttestation] = []
        self.outcomes: list[OutcomeReport] = []
        self.bot_scores: dict[str, float] = {}
        self.trust_scores: dict[str, float] = {}
        self.tombstones: list[dict[str, str]] = []

    def add_attestation(self, attestation: ExpertAttestation) -> None:
        self.attestations.append(attestation)
        self._recalculate_product_score(attestation.product_id)

    def add_outcome(self, outcome: OutcomeReport) -> None:
        self.outcomes.append(outcome)
        self._recalculate_product_score(outcome.product_id)

    def get_trust_score(self, did: str) -> float:
        return self.trust_scores.get(did, 0.0)

    def set_trust_score(self, did: str, score: float) -> None:
        self.trust_scores[did] = score

    def get_bot_score(self, bot_did: str) -> float:
        return self.bot_scores.get(bot_did, 50.0)

    def update_bot_score(self, bot_did: str, delta: float) -> None:
        current = self.bot_scores.get(bot_did, 50.0)
        self.bot_scores[bot_did] = max(0.0, min(100.0, current + delta))

    def signed_tombstone(self, target_id: str, author_did: str,
                         signature: str) -> bool:
        """Delete an entry via signed tombstone. Only author can delete."""
        # Find the entry
        for att in self.attestations:
            if (att.product_id == target_id and att.expert_did == author_did):
                self.attestations.remove(att)
                self.tombstones.append({
                    "target": target_id,
                    "author": author_did,
                    "signature": signature,
                })
                return True
        return False

    def _recalculate_product_score(self, product_id: str) -> None:
        """Recalculate aggregate score for a product."""
        pass  # Scores are computed, not stored


# ---------------------------------------------------------------------------
# Mock: Trust Evaluator
# ---------------------------------------------------------------------------

class MockTrustEvaluator:
    """Computes the composite trust score."""

    def compute_composite(
        self,
        ring: TrustRing,
        time_alive_days: int,
        transaction_count: int,
        transaction_volume: float,
        outcome_count: int,
        peer_attestations: int,
        credential_count: int,
    ) -> float:
        """
        Trust = f(ring, time, transactions, outcomes, peers, credentials)
        Returns a score 0.0 - 100.0.
        """
        # Base score from ring
        ring_base = {
            TrustRing.RING_1_UNVERIFIED: 5.0,
            TrustRing.RING_2_VERIFIED: 30.0,
            TrustRing.RING_3_SKIN_IN_GAME: 50.0,
        }[ring]

        # Time factor (log scale, caps at ~15 points)
        time_factor = min(15.0, (time_alive_days / 365) * 10)

        # Transaction factor
        tx_factor = min(20.0, (transaction_count / 100) * 10 +
                       (transaction_volume / 50000) * 5)

        # Outcome factor
        outcome_factor = min(10.0, (outcome_count / 50) * 10)

        # Peer attestation factor
        peer_factor = min(10.0, peer_attestations * 2)

        # Credential factor
        cred_factor = min(10.0, credential_count * 3)

        return min(100.0, ring_base + time_factor + tx_factor +
                   outcome_factor + peer_factor + cred_factor)


# ---------------------------------------------------------------------------
# Mock: Go Core (Internal API)
# ---------------------------------------------------------------------------

class MockGoCore:
    """Go Core internal API — vault, DID, PII, notifications."""

    def __init__(self, vault: MockVault, identity: MockIdentity,
                 scrubber: MockPIIScrubber) -> None:
        self._vault = vault
        self._identity = identity
        self._scrubber = scrubber
        self._notifications_sent: list[Notification] = []
        self.api_calls: list[dict[str, Any]] = []

    def vault_query(self, query: str, persona: PersonaType | None = None) -> list[Any]:
        self.api_calls.append({"endpoint": "/v1/vault/query", "query": query})
        return self._vault.search_fts(query)

    def vault_store(self, key: str, value: Any, tier: int = 1,
                    persona: PersonaType | None = None) -> None:
        self.api_calls.append({"endpoint": "/v1/vault/store", "key": key})
        self._vault.store(tier, key, value, persona)

    def did_sign(self, data: bytes) -> str:
        self.api_calls.append({"endpoint": "/v1/did/sign"})
        return self._identity.sign(data)

    def did_verify(self, data: bytes, signature: str) -> bool:
        self.api_calls.append({"endpoint": "/v1/did/verify"})
        return self._identity.verify(data, signature)

    def pii_scrub(self, text: str) -> tuple[str, dict[str, str]]:
        self.api_calls.append({"endpoint": "/v1/pii/scrub"})
        return self._scrubber.scrub(text)

    def notify(self, notification: Notification) -> None:
        self.api_calls.append({"endpoint": "/v1/notify", "tier": notification.tier})
        self._notifications_sent.append(notification)


# ---------------------------------------------------------------------------
# Mock: Python Brain
# ---------------------------------------------------------------------------

class MockPythonBrain:
    """Python Brain — guardian angel loop, reasoning, classification."""

    def __init__(self, classifier: MockSilenceClassifier,
                 whisper: MockWhisperAssembler,
                 router: MockLLMRouter) -> None:
        self._classifier = classifier
        self._whisper = whisper
        self._router = router
        self.processed: list[dict[str, Any]] = []
        self.reasoned: list[dict[str, Any]] = []
        self._crashed = False

    def process(self, data: dict[str, Any]) -> dict[str, Any]:
        """Process new data — classify, extract, index."""
        if self._crashed:
            raise RuntimeError("Brain has crashed (OOM)")
        result = {
            "tier": self._classifier.classify(
                data.get("type", "unknown"),
                data.get("content", ""),
            ),
            "processed": True,
        }
        self.processed.append(result)
        return result

    def reason(self, query: str, context: dict[str, Any] | None = None,
               persona: PersonaType | None = None) -> str:
        """Complex reasoning — multi-step analysis."""
        if self._crashed:
            raise RuntimeError("Brain has crashed (OOM)")
        target = self._router.route("complex_reasoning", persona)
        result = f"Reasoned answer for: {query} (via {target.name})"
        self.reasoned.append({"query": query, "target": target})
        return result

    def crash(self) -> None:
        self._crashed = True

    def restart(self) -> None:
        self._crashed = False


# ---------------------------------------------------------------------------
# Mock: Connectors (Ingestion Layer)
# ---------------------------------------------------------------------------

class MockConnector:
    """Base class for data ingestion connectors."""

    def __init__(self, name: str, persona: PersonaType,
                 poll_interval_minutes: int = 15) -> None:
        self.name = name
        self.persona = persona
        self.poll_interval_minutes = poll_interval_minutes
        self.status = ConnectorStatus.ACTIVE
        self.last_poll: float | None = None
        self.items_ingested: int = 0
        self._data: list[dict[str, Any]] = []

    def add_data(self, items: list[dict[str, Any]]) -> None:
        self._data.extend(items)

    def poll(self) -> list[dict[str, Any]]:
        """Pull data from source."""
        self.last_poll = time.time()
        new_items = list(self._data)
        self._data.clear()
        self.items_ingested += len(new_items)
        return new_items

    def normalize(self, raw_item: dict[str, Any]) -> dict[str, Any]:
        """Normalize raw data into vault format."""
        return {
            "id": raw_item.get("id", str(uuid.uuid4())),
            "source": self.name,
            "persona": self.persona.value,
            "content": raw_item.get("content", ""),
            "timestamp": raw_item.get("timestamp", time.time()),
        }


class MockGmailConnector(MockConnector):
    """Gmail connector — read-only, OAuth."""

    def __init__(self, persona: PersonaType = PersonaType.PROFESSIONAL) -> None:
        super().__init__("gmail", persona, poll_interval_minutes=15)
        self.oauth_scope = "readonly"
        self.dedup_ids: set[str] = set()

    def poll(self) -> list[dict[str, Any]]:
        items = super().poll()
        # Deduplicate by message ID
        new_items = []
        for item in items:
            msg_id = item.get("message_id", item.get("id"))
            if msg_id not in self.dedup_ids:
                self.dedup_ids.add(msg_id)
                new_items.append(item)
        return new_items


class MockCalendarConnector(MockConnector):
    """Calendar connector — CalDAV."""

    def __init__(self, persona: PersonaType = PersonaType.PROFESSIONAL) -> None:
        super().__init__("calendar", persona, poll_interval_minutes=30)


class MockWhatsAppConnector(MockConnector):
    """WhatsApp connector — Android NotificationListener, text only."""

    def __init__(self, persona: PersonaType = PersonaType.SOCIAL) -> None:
        super().__init__("whatsapp", persona, poll_interval_minutes=0)
        self.text_only = True
        self.device_key: str | None = None

    def set_device_key(self, key: str) -> None:
        self.device_key = key

    def push_to_home_node(self, items: list[dict[str, Any]]) -> bool:
        """Push captured notifications to Home Node."""
        if not self.device_key:
            return False  # Must authenticate first
        # Strip media — text only
        for item in items:
            item.pop("media", None)
            item.pop("photo", None)
        self._data.extend(items)
        return True


# ---------------------------------------------------------------------------
# Mock: Client Devices
# ---------------------------------------------------------------------------

class MockRichClient:
    """Phone/Laptop with local cache and on-device LLM."""

    def __init__(self, device_id: str = "", cache_months: int = 6) -> None:
        self.device_id = device_id or f"device_{uuid.uuid4().hex[:8]}"
        self.cache_months = cache_months
        self.local_cache: dict[str, Any] = {}
        self.offline_queue: list[dict[str, Any]] = []
        self.sync_checkpoint: float = 0.0
        self.connected: bool = True
        self.device_key: str | None = None

    def cache_item(self, key: str, value: Any) -> None:
        self.local_cache[key] = value

    def queue_offline(self, item: dict[str, Any]) -> None:
        self.offline_queue.append(item)

    def sync(self, home_node_items: list[dict[str, Any]]) -> None:
        for item in home_node_items:
            self.local_cache[item.get("id", str(uuid.uuid4()))] = item
        self.sync_checkpoint = time.time()

    def push_queued(self) -> list[dict[str, Any]]:
        items = list(self.offline_queue)
        self.offline_queue.clear()
        return items

    def search_local(self, query: str) -> list[Any]:
        """Search local cache (works offline)."""
        return [
            v for v in self.local_cache.values()
            if isinstance(v, dict) and query.lower() in
            json.dumps(v).lower()
        ]


class MockThinClient:
    """Glasses/Watch/Browser — no local cache, WebSocket only."""

    def __init__(self, device_id: str = "") -> None:
        self.device_id = device_id or f"thin_{uuid.uuid4().hex[:8]}"
        self.connected: bool = False
        self.device_key: str | None = None
        self.received_streams: list[Any] = []

    def connect(self, home_node: MockGoCore) -> bool:
        """Connect via authenticated WebSocket."""
        if not self.device_key:
            return False
        self.connected = True
        return True

    def receive_stream(self, data: Any) -> None:
        if self.connected:
            self.received_streams.append(data)


# ---------------------------------------------------------------------------
# Mock: Estate Manager
# ---------------------------------------------------------------------------

class MockEstateManager:
    """Digital estate — dead man's switch and beneficiary transfer."""

    def __init__(self, identity: MockIdentity,
                 plan: EstatePlan | None = None) -> None:
        self._identity = identity
        self._plan = plan or EstatePlan()
        self.liveness_checks: list[dict[str, Any]] = []
        self.estate_mode_active: bool = False
        self.keys_delivered: dict[str, list[PersonaType]] = {}
        self.data_destroyed: bool = False

    def liveness_check(self, human: MockHuman) -> bool:
        """Periodic liveness check — 'Still here?'"""
        response = human.respond_to_liveness()
        self.liveness_checks.append({
            "timestamp": time.time(),
            "responded": response,
        })
        return response

    def enter_estate_mode(self) -> None:
        """Enter estate mode after failed liveness checks."""
        self.estate_mode_active = True

    def deliver_keys(self, p2p: MockP2PChannel) -> dict[str, list[PersonaType]]:
        """Deliver per-beneficiary keys via Dina-to-Dina."""
        if not self.estate_mode_active:
            return {}
        for beneficiary in self._plan.beneficiaries:
            personas = beneficiary.receives_personas
            self.keys_delivered[beneficiary.dina_did] = personas
            # Send keys via encrypted channel
            msg = DinaMessage(
                type="dina/estate/key_delivery",
                from_did=self._identity.root_did,
                to_did=beneficiary.dina_did,
                payload={
                    "personas": [p.value for p in personas],
                    "access_type": beneficiary.access_type,
                },
            )
            p2p.send(msg)
        return self.keys_delivered

    def destroy_remaining(self) -> None:
        """Destroy unclaimed data per estate plan."""
        if self._plan.default_action == "destroy":
            self.data_destroyed = True


# ---------------------------------------------------------------------------
# Mock: Dina Core (Full System)
# ---------------------------------------------------------------------------

class MockDinaCore:
    """The full Dina engine — wires all subsystems together."""

    def __init__(
        self,
        identity: MockIdentity | None = None,
        vault: MockVault | None = None,
    ) -> None:
        self.identity = identity or MockIdentity()
        self.vault = vault or MockVault()
        self.scrubber = MockPIIScrubber()
        self.key_manager = MockKeyManager(self.identity)
        self.classifier = MockSilenceClassifier()
        self.whisper = MockWhisperAssembler(self.vault)
        self.llm_router = MockLLMRouter()
        self.go_core = MockGoCore(self.vault, self.identity, self.scrubber)
        self.brain = MockPythonBrain(self.classifier, self.whisper, self.llm_router)
        self.p2p = MockP2PChannel()
        self.staging = MockStagingTier()
        self.reputation = MockReputationGraph()
        self.trust = MockTrustEvaluator()
        self.estate: MockEstateManager | None = None

    def classify_action_risk(self, intent: AgentIntent) -> ActionRisk:
        """Classify the risk level of an agent's intent."""
        action = intent.action.lower()
        if action in ("search", "lookup", "read"):
            return ActionRisk.SAFE
        if action in ("send_email", "create_draft", "update_calendar"):
            return ActionRisk.MODERATE
        if action in ("transfer_money", "share_data", "delete"):
            return ActionRisk.HIGH
        return ActionRisk.MODERATE

    def approve_intent(self, intent: AgentIntent,
                       human: MockHuman) -> bool:
        """Process an agent intent through the safety layer."""
        risk = self.classify_action_risk(intent)
        intent.risk_level = risk

        if risk == ActionRisk.SAFE:
            return True
        if risk == ActionRisk.BLOCKED:
            return False
        # Moderate or High: ask user
        return human.approve(intent.action)
