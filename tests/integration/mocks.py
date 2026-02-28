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
    """Connector health state machine.

    State transitions::

        ACTIVE ──► NEEDS_REFRESH ──► ACTIVE       (auto-refresh succeeded)
        ACTIVE ──► NEEDS_REFRESH ──► EXPIRED       (refresh failed)
        EXPIRED ──► ACTIVE                          (user re-authorizes)
        EXPIRED ──► REVOKED                         (token permanently invalid)
        * ──► PAUSED                                (user pauses)
        * ──► DISABLED                              (user disables)
        REVOKED ──► ACTIVE                          (user re-authorizes)
    """
    ACTIVE = auto()
    NEEDS_REFRESH = auto()
    EXPIRED = auto()
    REVOKED = auto()
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
    """Signed expert review in the Trust Network."""
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
    """Anonymized purchase outcome for the Trust Network."""
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
class OAuthToken:
    """OAuth 2.0 token with expiry and refresh metadata."""
    access_token: str
    refresh_token: str
    expires_at: float              # Unix timestamp
    issued_at: float = field(default_factory=time.time)
    scopes: list[str] = field(default_factory=lambda: ["readonly"])
    revoked: bool = False

    @property
    def is_expired(self) -> bool:
        return time.time() >= self.expires_at

    @property
    def needs_refresh(self) -> bool:
        """True if token expires within 5 minutes."""
        return not self.revoked and (self.expires_at - time.time()) < 300


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
    trigger: str = "custodian_threshold"
    custodian_threshold: int = 3
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

    def receive_notification(self, notification: Notification) -> None:
        self.notifications.append(notification)

    def approve(self, action: str) -> bool:
        if action in self.approval_responses:
            return self.approval_responses[action]
        return self.default_approve

    def set_approval(self, action: str, approved: bool) -> None:
        self.approval_responses[action] = approved

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
    """SQLite vault mock with six-tier encrypted storage.

    Models the single-writer / read-pool pattern:
    - ``store()`` and ``store_batch()`` use the write connection (serialized)
    - ``retrieve()`` and ``search_fts()`` use the read pool (concurrent)

    In production: one ``*sql.DB`` with ``MaxOpenConns=1`` for writes,
    a separate ``*sql.DB`` with ``PRAGMA query_only=ON`` for reads.
    """

    # Simulated PRAGMAs (verified by tests)
    PRAGMAS: dict[str, str | int] = {
        "journal_mode": "WAL",
        "synchronous": "NORMAL",
        "foreign_keys": "ON",
        "busy_timeout": 5000,
    }

    BATCH_SIZE: int = 100  # items per write transaction for ingestion

    def __init__(self) -> None:
        self._tiers: dict[int, dict[str, Any]] = {i: {} for i in range(6)}
        self._partitions: dict[str, dict[str, Any]] = {}  # per-persona
        self._fts_index: dict[str, list[str]] = {}  # full-text search
        self._write_count: int = 0  # total individual writes
        self._tx_count: int = 0     # total transactions (1 per batch or single write)
        self._batch_notifications: list[dict[str, Any]] = []  # brain notifications

    def store(self, tier: int, key: str, value: Any,
              persona: PersonaType | None = None) -> None:
        self._tiers[tier][key] = value
        if persona:
            partition = f"partition_{persona.value}"
            if partition not in self._partitions:
                self._partitions[partition] = {}
            self._partitions[partition][key] = value
        self._write_count += 1
        self._tx_count += 1

    def store_batch(self, tier: int, items: list[tuple[str, Any]],
                    persona: PersonaType | None = None) -> int:
        """Write multiple items in a single transaction.

        Returns the number of items written. In production this is a
        single ``BEGIN … INSERT … INSERT … COMMIT`` on the write connection.
        """
        for key, value in items:
            self._tiers[tier][key] = value
            if persona:
                partition = f"partition_{persona.value}"
                if partition not in self._partitions:
                    self._partitions[partition] = {}
                self._partitions[partition][key] = value
            self._write_count += 1
        self._tx_count += 1  # one transaction for the whole batch
        self._batch_notifications.append({
            "tier": tier,
            "persona": persona,
            "count": len(items),
            "timestamp": time.time(),
        })
        return len(items)

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

    def raw_file_header(self, persona: PersonaType) -> bytes:
        """Simulate reading the first 16 bytes of a persona's .sqlite file.

        In production: ``open(f"{persona.value}.sqlite", "rb").read(16)``.
        In mock: if the partition has data, return random-looking bytes
        (simulating encrypted content).  If the partition is empty, return
        the unencrypted SQLite magic header — which the CI test must reject.
        """
        partition = f"partition_{persona.value}"
        if self._partitions.get(partition):
            # Encrypted — first 16 bytes are indistinguishable from random
            import hashlib
            return hashlib.sha256(persona.value.encode()).digest()[:16]
        # Empty / uninitialized — plaintext SQLite header (the failure case)
        return b"SQLite format 3\x00"

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
    """Routes tasks to the correct LLM based on type, persona, and mode.

    Two modes:
    - "offline": llama-server + whisper-server available. Basic tasks → LOCAL, complex → CLOUD.
    - "online": no local LLM/STT. Basic tasks → CLOUD (Gemini 2.5 Flash Lite),
                voice → CLOUD (Deepgram Nova-3), complex → CLOUD.

    Invariant (both modes): sensitive personas (health, financial) → LOCAL/ON_DEVICE.
    In online mode, sensitive tasks route to on-device LLM if available.
    """

    def __init__(self, profile: str = "offline") -> None:
        self.profile = profile  # "offline" or "online"
        self.routing_log: list[dict[str, Any]] = []

    def route(self, task_type: str,
              persona: PersonaType | None = None) -> LLMTarget:
        """Determine where to route LLM inference."""
        # Sensitive personas: NEVER cloud
        if persona in (PersonaType.HEALTH, PersonaType.FINANCIAL):
            if self.profile == "offline":
                target = LLMTarget.LOCAL
                self._log(task_type, persona, target, "sensitive_persona")
            else:
                # Online mode: sensitive data cannot go to cloud.
                # Route to on-device if available, otherwise reject.
                target = LLMTarget.ON_DEVICE
                self._log(task_type, persona, target, "sensitive_persona_on_device")
            return target

        # Simple lookup: no LLM needed
        if task_type in ("fts_search", "exact_match", "id_lookup"):
            target = LLMTarget.NONE
            self._log(task_type, persona, target, "no_llm_needed")
            return target

        # Basic summarization/drafting
        if task_type in ("summarize", "draft", "classify", "embed"):
            if self.profile == "offline":
                target = LLMTarget.LOCAL
                self._log(task_type, persona, target, "basic_task")
            else:
                target = LLMTarget.CLOUD
                self._log(task_type, persona, target, "basic_task_cloud_profile")
            return target

        # Complex reasoning: cloud via PII scrubber (both profiles)
        if task_type in ("multi_step_analysis", "complex_reasoning"):
            target = LLMTarget.CLOUD
            self._log(task_type, persona, target, "complex_task")
            return target

        # Interactive chat: on-device for latency
        if task_type == "interactive_chat":
            target = LLMTarget.ON_DEVICE
            self._log(task_type, persona, target, "latency_sensitive")
            return target

        # Default: depends on profile
        if self.profile == "offline":
            target = LLMTarget.LOCAL
            self._log(task_type, persona, target, "default")
        else:
            target = LLMTarget.CLOUD
            self._log(task_type, persona, target, "default_cloud_profile")
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
    """Specialist review bot with trust score and source attribution."""

    def __init__(self, bot_did: str = "", trust_score: int = 90) -> None:
        self.bot_did = bot_did or f"did:plc:Bot{uuid.uuid4().hex[:34]}"
        self.trust_score = trust_score
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

    def __init__(self, bot_did: str = "", trust_score: int = 91) -> None:
        self.bot_did = bot_did or f"did:plc:Legal{uuid.uuid4().hex[:32]}"
        self.trust_score = trust_score
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
# Mock: Trust Network
# ---------------------------------------------------------------------------

class MockTrustNetwork:
    """Federated trust ledger with signed tombstones."""

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
        self.notifications_emitted: list[Notification] = []
        self.status_log: list[dict[str, Any]] = []

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

    def batch_ingest(self, items: list[dict[str, Any]],
                     vault: MockVault) -> int:
        """Ingest items into the vault using batch writes.

        Collects items into batches of ``vault.BATCH_SIZE`` and calls
        ``vault.store_batch()`` for each batch — one transaction per batch,
        one brain notification per batch.

        Returns total items ingested.
        """
        batch_size = vault.BATCH_SIZE
        total = 0
        for i in range(0, len(items), batch_size):
            chunk = items[i:i + batch_size]
            batch_items = []
            for raw in chunk:
                normalized = self.normalize(raw)
                batch_items.append((normalized["id"], normalized))
            vault.store_batch(1, batch_items, persona=self.persona)
            total += len(batch_items)
        self.items_ingested += total
        return total

    def _transition(self, new_status: ConnectorStatus, reason: str = "") -> None:
        """Record a status transition."""
        old = self.status
        self.status = new_status
        self.status_log.append({
            "from": old,
            "to": new_status,
            "reason": reason,
            "timestamp": time.time(),
        })


class MockGmailConnector(MockConnector):
    """Gmail connector — read-only, OAuth, with token lifecycle.

    Token lifecycle state machine::

        ACTIVE ─(token nearing expiry)─► NEEDS_REFRESH
        NEEDS_REFRESH ─(refresh succeeds)─► ACTIVE
        NEEDS_REFRESH ─(refresh fails)─► EXPIRED  + Tier 2 notification
        EXPIRED ─(user re-authorizes)─► ACTIVE
        EXPIRED ─(provider revokes)─► REVOKED  + Tier 2 notification
        REVOKED ─(user re-authorizes)─► ACTIVE
    """

    def __init__(self, persona: PersonaType = PersonaType.PROFESSIONAL) -> None:
        super().__init__("gmail", persona, poll_interval_minutes=15)
        self.oauth_scope = "readonly"
        self.dedup_ids: set[str] = set()
        self._oauth_token: OAuthToken | None = None
        self._refresh_handler: Callable[[OAuthToken], OAuthToken | None] | None = None
        self.refresh_attempts: int = 0
        self.cursor: str | None = None  # sync cursor for resumption
        self._contacts: list[dict[str, Any]] = []
        self._fast_sync_batch_size: int = 50
        self._backfill_queue: list[dict[str, Any]] = []
        self._backfill_complete: bool = False
        self._time_horizon_days: int | None = None

    def set_oauth_token(self, token: OAuthToken) -> None:
        """Store the OAuth token (in production, key-wrapped in Tier 0)."""
        self._oauth_token = token
        self._transition(ConnectorStatus.ACTIVE, "token_set")

    def set_refresh_handler(
        self, handler: Callable[[OAuthToken], OAuthToken | None]
    ) -> None:
        """Register a callback that attempts token refresh.

        Returns a new OAuthToken on success, None on failure.
        """
        self._refresh_handler = handler

    def check_token_health(self) -> ConnectorStatus:
        """Evaluate token health and transition state if needed.

        Called automatically before each poll.  Can also be called by
        the connector scheduler between polls.
        """
        if self._oauth_token is None:
            self._transition(ConnectorStatus.EXPIRED, "no_token")
            return self.status

        if self._oauth_token.revoked:
            self._transition(ConnectorStatus.REVOKED, "token_revoked")
            self._emit_reauth_notification("revoked")
            return self.status

        if self._oauth_token.is_expired:
            self._transition(ConnectorStatus.EXPIRED, "token_expired")
            self._emit_reauth_notification("expired")
            return self.status

        if self._oauth_token.needs_refresh:
            self._transition(ConnectorStatus.NEEDS_REFRESH, "token_expiring_soon")
            self._attempt_refresh()
            return self.status

        # Token is healthy
        if self.status not in (ConnectorStatus.PAUSED, ConnectorStatus.DISABLED):
            if self.status != ConnectorStatus.ACTIVE:
                self._transition(ConnectorStatus.ACTIVE, "token_healthy")
        return self.status

    def _attempt_refresh(self) -> bool:
        """Try to refresh the token. Returns True on success."""
        self.refresh_attempts += 1
        if self._refresh_handler and self._oauth_token:
            new_token = self._refresh_handler(self._oauth_token)
            if new_token is not None:
                self._oauth_token = new_token
                self._transition(ConnectorStatus.ACTIVE, "refresh_succeeded")
                return True
        # Refresh failed
        self._transition(ConnectorStatus.EXPIRED, "refresh_failed")
        self._emit_reauth_notification("expired")
        return False

    def _emit_reauth_notification(self, reason: str) -> None:
        """Emit a Tier 2 notification asking user to re-authorize."""
        notification = Notification(
            tier=SilenceTier.TIER_2_SOLICITED,
            title="Gmail access expired",
            body=f"Gmail connector needs re-authorization ({reason}). [Re-authorize]",
            actions=["re_authorize", "dismiss"],
            source="connector_health",
        )
        self.notifications_emitted.append(notification)

    def reauthorize(self, new_token: OAuthToken) -> None:
        """User re-authorizes — provides a fresh token."""
        self._oauth_token = new_token
        self._transition(ConnectorStatus.ACTIVE, "user_reauthorized")

    def revoke(self) -> None:
        """Simulate token revocation (e.g. user changed Google password)."""
        if self._oauth_token:
            self._oauth_token.revoked = True
        self._transition(ConnectorStatus.REVOKED, "provider_revoked")
        self._emit_reauth_notification("revoked")

    def add_contacts(self, contacts: list[dict[str, Any]]) -> None:
        """Add contacts to be synced."""
        self._contacts.extend(contacts)

    def sync_contacts(self) -> list[dict[str, Any]]:
        """Sync contacts from Gmail to vault."""
        contacts = list(self._contacts)
        self._contacts.clear()
        return contacts

    def save_cursor(self, cursor: str) -> None:
        """Persist sync cursor for resumption across restarts."""
        self.cursor = cursor

    def fast_sync(self, all_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Return the first batch quickly for fast initial sync.

        Remaining items are queued for background backfill.
        """
        first_batch = all_items[:self._fast_sync_batch_size]
        self._backfill_queue = all_items[self._fast_sync_batch_size:]
        return first_batch

    def backfill(self) -> list[dict[str, Any]]:
        """Process remaining items in background after fast sync."""
        items = list(self._backfill_queue)
        self._backfill_queue.clear()
        self._backfill_complete = True
        return items

    def set_time_horizon(self, days: int) -> None:
        """Set the time horizon for ingestion."""
        self._time_horizon_days = days

    def filter_by_time_horizon(
        self, items: list[dict[str, Any]], now: float | None = None
    ) -> list[dict[str, Any]]:
        """Filter items to only include those within the time horizon."""
        if self._time_horizon_days is None:
            return items
        cutoff = (now or time.time()) - (self._time_horizon_days * 86400)
        return [
            item for item in items
            if item.get("timestamp", 0) >= cutoff
        ]

    def poll(self) -> list[dict[str, Any]]:
        # Check token health before polling
        if self._oauth_token is not None:
            self.check_token_health()
            if self.status not in (ConnectorStatus.ACTIVE,):
                return []  # Cannot poll without valid token
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


class MockTelegramConnector(MockConnector):
    """Telegram connector — server-side Bot API, full message+media support."""

    def __init__(self, persona: PersonaType = PersonaType.SOCIAL) -> None:
        super().__init__("telegram", persona, poll_interval_minutes=5)
        self.supports_media = True
        self.bot_token: str | None = None

    def set_bot_token(self, token: str) -> None:
        self.bot_token = token

    def ingest_from_bot_api(self, items: list[dict[str, Any]]) -> bool:
        """Ingest messages from Telegram Bot API on Home Node."""
        if not self.bot_token:
            return False  # Must configure bot token first
        # Telegram supports full media — no stripping needed
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
    """Digital estate — SSS custodian-based recovery and beneficiary transfer."""

    def __init__(self, identity: MockIdentity,
                 plan: EstatePlan | None = None) -> None:
        self._identity = identity
        self._plan = plan or EstatePlan()
        self.shares_collected: list[bytes] = []
        self.estate_mode_active: bool = False
        self.keys_delivered: dict[str, list[PersonaType]] = {}
        self.data_destroyed: bool = False
        self.delivery_confirmations: dict[str, bool] = {}  # did → confirmed

    def submit_share(self, share: bytes) -> bool:
        """Submit an SSS share from a custodian.

        Returns True if the share is accepted (non-empty, valid bytes).
        Returns False if the share is invalid (empty or corrupted marker).
        """
        if not share or share == b"CORRUPTED":
            return False
        self.shares_collected.append(share)
        return True

    def enter_estate_mode(self) -> None:
        """Enter estate mode after custodian threshold is met.

        Raises RuntimeError if insufficient shares have been collected.
        """
        if len(self.shares_collected) < self._plan.custodian_threshold:
            raise RuntimeError(
                f"Cannot enter estate mode: {len(self.shares_collected)} shares "
                f"collected, {self._plan.custodian_threshold} required"
            )
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

    def derive_beneficiary_key(self, beneficiary_did: str,
                               persona: PersonaType) -> str:
        """Derive a unique key for a beneficiary from the master key + their DID.

        Each beneficiary gets a distinct derived key per persona, ensuring
        no two beneficiaries share the same decryption material.
        """
        derivation_input = (
            f"{self._identity.root_private_key}"
            f":estate:{beneficiary_did}:{persona.value}"
        )
        return hashlib.sha256(derivation_input.encode()).hexdigest()

    def confirm_delivery(self, beneficiary_did: str) -> None:
        """Record that a beneficiary has confirmed receipt of their keys."""
        self.delivery_confirmations[beneficiary_did] = True

    def all_deliveries_confirmed(self) -> bool:
        """Check whether all beneficiaries have confirmed receipt."""
        for b in self._plan.beneficiaries:
            if not self.delivery_confirmations.get(b.dina_did, False):
                return False
        return True

    def destroy_remaining(self) -> None:
        """Destroy unclaimed data per estate plan.

        When gated on delivery confirmation, destruction only proceeds
        if all beneficiaries have confirmed receipt.
        """
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
        self.trust_network = MockTrustNetwork()
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


# ---------------------------------------------------------------------------
# Mock: BRAIN_TOKEN Authentication (§1.1)
# ---------------------------------------------------------------------------

class MockBrainTokenAuth:
    """Token-based authentication between Go Core and Python Brain.

    Both services mount the same secret file. Requests without valid
    BRAIN_TOKEN are rejected. Admin endpoints are never accessible
    to the brain — only operational endpoints.
    """

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

    def __init__(self, token: str | None = None) -> None:
        self.token = token or hashlib.sha256(
            uuid.uuid4().bytes
        ).hexdigest()
        self.auth_log: list[dict[str, Any]] = []

    def validate(self, presented_token: str, endpoint: str) -> bool:
        """Constant-time token validation with endpoint authorization."""
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

    def rotate(self) -> str:
        """Rotate to a new token. Old token becomes invalid."""
        self.token = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
        return self.token


# ---------------------------------------------------------------------------
# Mock: WebSocket Protocol (§2.1)
# ---------------------------------------------------------------------------

@dataclass
class WSMessage:
    """WebSocket message envelope per architecture §17."""
    type: str  # auth, auth_ok, auth_fail, query, whisper, whisper_stream,
               # system, ping, pong, error, command, ack
    id: str = ""
    payload: dict[str, Any] = field(default_factory=dict)
    reply_to: str = ""
    ts: float = field(default_factory=time.time)


class MockWebSocketConnection:
    """Single WebSocket connection to the Home Node."""

    def __init__(self, device_id: str) -> None:
        self.device_id = device_id
        self.connected: bool = False
        self.authenticated: bool = False
        self.client_token: str = ""
        self.sent: list[WSMessage] = []
        self.received: list[WSMessage] = []
        self.missed_pongs: int = 0
        self.last_pong_ts: float = 0.0

    def connect(self) -> None:
        self.connected = True

    def authenticate(self, token: str, valid_tokens: set[str]) -> WSMessage:
        """Send auth frame, receive auth_ok or auth_fail."""
        self.client_token = token
        if token in valid_tokens:
            self.authenticated = True
            return WSMessage(type="auth_ok", payload={"device": self.device_id})
        return WSMessage(type="auth_fail")

    def send(self, msg: WSMessage) -> bool:
        if not self.connected or not self.authenticated:
            return False
        self.sent.append(msg)
        return True

    def receive(self, msg: WSMessage) -> None:
        if self.connected:
            self.received.append(msg)

    def handle_ping(self, ping: WSMessage) -> WSMessage | None:
        """Respond to ping with pong. Returns None if disconnected."""
        if not self.connected:
            return None
        pong = WSMessage(type="pong", ts=time.time())
        self.last_pong_ts = pong.ts
        self.missed_pongs = 0
        return pong

    def close(self, code: int = 1000, reason: str = "") -> None:
        self.connected = False
        self.authenticated = False


class MockWebSocketServer:
    """Home Node WebSocket server managing device connections."""

    def __init__(self) -> None:
        self.connections: dict[str, MockWebSocketConnection] = {}
        self.valid_tokens: set[str] = set()
        self.message_buffer: dict[str, list[WSMessage]] = {}
        self.buffer_max: int = 50
        self.buffer_ttl_seconds: float = 300.0
        self.ping_interval: float = 30.0
        self.max_missed_pongs: int = 3

    def add_valid_token(self, token: str) -> None:
        self.valid_tokens.add(token)

    def accept(self, device_id: str) -> MockWebSocketConnection:
        conn = MockWebSocketConnection(device_id)
        conn.connect()
        self.connections[device_id] = conn
        return conn

    def authenticate_connection(
        self, conn: MockWebSocketConnection, token: str
    ) -> WSMessage:
        result = conn.authenticate(token, self.valid_tokens)
        if result.type == "auth_ok":
            # Replay buffered messages
            buffered = self.message_buffer.pop(conn.device_id, [])
            for msg in buffered:
                conn.receive(msg)
        return result

    def push_to_device(self, device_id: str, msg: WSMessage) -> bool:
        """Push message to device. Buffer if disconnected."""
        conn = self.connections.get(device_id)
        if conn and conn.connected and conn.authenticated:
            conn.receive(msg)
            return True
        # Buffer for later
        self.message_buffer.setdefault(device_id, [])
        if len(self.message_buffer[device_id]) < self.buffer_max:
            self.message_buffer[device_id].append(msg)
        return False

    def send_ping(self, device_id: str) -> WSMessage | None:
        """Send ping to a device. Returns pong or None."""
        conn = self.connections.get(device_id)
        if not conn or not conn.connected:
            return None
        ping = WSMessage(type="ping", ts=time.time())
        pong = conn.handle_ping(ping)
        if pong is None:
            conn.missed_pongs += 1
            if conn.missed_pongs >= self.max_missed_pongs:
                conn.close(code=1001, reason="missed_pongs")
        return pong

    def disconnect_device(self, device_id: str) -> None:
        conn = self.connections.get(device_id)
        if conn:
            conn.close()


# ---------------------------------------------------------------------------
# Mock: Admin UI / Session (§2.2)
# ---------------------------------------------------------------------------

class MockAdminSession:
    """Admin dashboard session with Argon2id authentication."""

    def __init__(self, device_id: str = "browser_001",
                 ttl_seconds: float = 3600) -> None:
        self.session_id = uuid.uuid4().hex
        self.device_id = device_id
        self.created_at = time.time()
        self.expires_at = self.created_at + ttl_seconds
        self.ttl_seconds = ttl_seconds

    def is_valid(self, current_time: float | None = None) -> bool:
        now = current_time or time.time()
        return now < self.expires_at

    def is_expired(self, current_time: float | None = None) -> bool:
        return not self.is_valid(current_time)


class MockAdminAPI:
    """Admin UI gateway — login, dashboard, device management."""

    def __init__(self, identity: MockIdentity, vault: MockVault) -> None:
        self._identity = identity
        self._vault = vault
        self._passphrase_hash = hashlib.sha256(b"admin-passphrase").hexdigest()
        self.sessions: dict[str, MockAdminSession] = {}
        self.api_calls: list[dict[str, Any]] = []

    def login(self, passphrase: str) -> MockAdminSession | None:
        """Authenticate with Argon2id passphrase and create session."""
        self.api_calls.append({"endpoint": "/admin/login"})
        provided_hash = hashlib.sha256(passphrase.encode()).hexdigest()
        if provided_hash != self._passphrase_hash:
            return None
        session = MockAdminSession()
        self.sessions[session.session_id] = session
        return session

    def validate_session(self, session_id: str) -> bool:
        session = self.sessions.get(session_id)
        if not session or session.is_expired():
            return False
        return True

    def dashboard(self, session_id: str) -> dict[str, Any] | None:
        """Get dashboard data. Returns None if session invalid."""
        self.api_calls.append({"endpoint": "/admin/dashboard"})
        if not self.validate_session(session_id):
            return None
        return {
            "vault_items": len(self._vault._tiers[1]),
            "personas": len(self._identity.personas),
            "devices": len(self._identity.devices),
            "root_did": self._identity.root_did,
        }

    def query_via_dashboard(self, session_id: str,
                            query: str) -> str | None:
        """Submit query through admin dashboard."""
        self.api_calls.append({"endpoint": "/admin/query", "query": query})
        if not self.validate_session(session_id):
            return None
        return f"Dashboard response for: {query}"


# ---------------------------------------------------------------------------
# Mock: Device Pairing (§2.3)
# ---------------------------------------------------------------------------

@dataclass
class MockPairingCode:
    """6-digit pairing code with 5-minute TTL."""
    code: str
    created_at: float = field(default_factory=time.time)
    expires_at: float = 0.0
    used: bool = False

    def __post_init__(self) -> None:
        if self.expires_at == 0.0:
            self.expires_at = self.created_at + 300  # 5 minutes

    def is_valid(self, current_time: float | None = None) -> bool:
        now = current_time or time.time()
        return not self.used and now < self.expires_at


@dataclass
class MockClientToken:
    """Token issued to a paired device."""
    token: str
    device_id: str
    device_name: str
    created_at: float = field(default_factory=time.time)
    revoked: bool = False

    @property
    def token_hash(self) -> str:
        return hashlib.sha256(self.token.encode()).hexdigest()


class MockPairingManager:
    """Device pairing — 6-digit code → CLIENT_TOKEN issuance."""

    def __init__(self) -> None:
        self.pending_codes: dict[str, MockPairingCode] = {}
        self.paired_devices: dict[str, MockClientToken] = {}  # hash → token

    def generate_code(self) -> MockPairingCode:
        """Generate a 6-digit pairing code."""
        code = f"{hash(time.time()) % 1000000:06d}"
        pairing = MockPairingCode(code=code)
        self.pending_codes[code] = pairing
        return pairing

    def complete_pairing(self, code: str,
                         device_name: str) -> MockClientToken | None:
        """Validate code and issue CLIENT_TOKEN."""
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
# Mock: Onboarding (§2.5)
# ---------------------------------------------------------------------------

class OnboardingStep(Enum):
    """10 silent steps of managed onboarding."""
    CREATE_MNEMONIC = 1
    DERIVE_ROOT_KEY = 2
    REGISTER_DID = 3
    DERIVE_DEKS = 4
    CREATE_DATABASES = 5
    WRAP_MASTER_KEY = 6
    SET_MODE = 7
    START_BRAIN = 8
    INITIAL_SYNC = 9
    DONE = 10


class MockOnboardingManager:
    """Manages the 10-step onboarding flow + progressive disclosure."""

    PROGRESSIVE_PROMPTS = {
        7: "Write down your 24-word recovery phrase",
        14: "Want to connect Telegram too?",
        30: "Separate health and financial data into compartments?",
        90: "You can now self-host your Home Node",
    }

    def __init__(self, identity: MockIdentity, vault: MockVault) -> None:
        self._identity = identity
        self._vault = vault
        self.completed_steps: set[int] = set()
        self.setup_date: float = time.time()
        self.mode: str = "convenience"  # or "security"
        self.pii_consent_cloud: bool = False

    def execute_step(self, step: OnboardingStep) -> bool:
        """Execute a single onboarding step."""
        if step.value in self.completed_steps:
            return True  # idempotent
        if step.value > 1 and (step.value - 1) not in self.completed_steps:
            return False  # must complete previous step first

        if step == OnboardingStep.CREATE_MNEMONIC:
            assert len(self._identity.bip39_mnemonic.split()) == 24
        elif step == OnboardingStep.DERIVE_ROOT_KEY:
            assert self._identity.root_private_key
        elif step == OnboardingStep.REGISTER_DID:
            assert self._identity.root_did.startswith("did:")
        elif step == OnboardingStep.CREATE_DATABASES:
            self._vault.store(0, "identity_initialized", True)
        elif step == OnboardingStep.SET_MODE:
            self._vault.store(0, "vault_mode", self.mode)

        self.completed_steps.add(step.value)
        return True

    def run_all(self) -> bool:
        """Execute all 10 steps."""
        for step in OnboardingStep:
            if not self.execute_step(step):
                return False
        return True

    def is_complete(self) -> bool:
        return OnboardingStep.DONE.value in self.completed_steps

    def get_personas_after_setup(self) -> list[PersonaType]:
        """After onboarding, only /personal exists."""
        if self.is_complete():
            return [PersonaType.CONSUMER]  # maps to /personal
        return []

    def get_progressive_prompt(self, days_since_setup: int) -> str | None:
        """Returns prompt text if a milestone is due."""
        return self.PROGRESSIVE_PROMPTS.get(days_since_setup)


# ---------------------------------------------------------------------------
# Mock: Docker Infrastructure (§5.x)
# ---------------------------------------------------------------------------

class MockHealthcheck:
    """Container healthcheck endpoint simulation."""

    def __init__(self, endpoint: str = "/healthz",
                 interval: int = 10, retries: int = 3) -> None:
        self.endpoint = endpoint
        self.interval = interval
        self.retries = retries
        self.passing: bool = True
        self.consecutive_failures: int = 0

    def check(self) -> bool:
        if self.passing:
            self.consecutive_failures = 0
            return True
        self.consecutive_failures += 1
        return False

    def is_healthy(self) -> bool:
        return self.passing and self.consecutive_failures == 0

    def is_unhealthy(self) -> bool:
        return self.consecutive_failures >= self.retries

    def set_passing(self, passing: bool) -> None:
        self.passing = passing
        if passing:
            self.consecutive_failures = 0


class MockDockerContainer:
    """Simulates a Docker container for integration testing."""

    def __init__(self, name: str, healthcheck: MockHealthcheck | None = None,
                 networks: list[str] | None = None,
                 ports: dict[int, int] | None = None,
                 depends_on: list[str] | None = None) -> None:
        self.name = name
        self.healthcheck = healthcheck or MockHealthcheck()
        self.networks = networks or []
        self.ports = ports or {}
        self.depends_on = depends_on or []
        self.running: bool = False
        self.environment: dict[str, str] = {}
        self.secrets: dict[str, str] = {}
        self.volumes: dict[str, str] = {}
        self.restart_count: int = 0
        self.logs: list[str] = []

    def start(self) -> bool:
        self.running = True
        self.logs.append(json.dumps({
            "time": time.time(), "level": "info",
            "msg": f"{self.name} started", "module": self.name,
        }))
        return True

    def stop(self) -> None:
        self.running = False

    def restart(self) -> bool:
        self.stop()
        self.restart_count += 1
        return self.start()

    def can_reach(self, other: "MockDockerContainer") -> bool:
        """Check network reachability (shared Docker network)."""
        return bool(set(self.networks) & set(other.networks))

    def is_port_exposed(self, port: int) -> bool:
        return port in self.ports.values()

    def log(self, level: str, msg: str, **fields: Any) -> None:
        entry = {"time": time.time(), "level": level,
                 "msg": msg, "module": self.name}
        entry.update(fields)
        self.logs.append(json.dumps(entry))

    def get_logs_json(self) -> list[dict[str, Any]]:
        """Return logs as parsed JSON objects."""
        result = []
        for line in self.logs:
            try:
                result.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        return result


class MockDockerCompose:
    """Simulates docker-compose with startup ordering."""

    def __init__(self, profile: str = "") -> None:
        self.profile = profile
        brain_net = "dina-brain-net"
        pds_net = "dina-pds-net"
        public_net = "dina-public"

        self.containers: dict[str, MockDockerContainer] = {
            "pds": MockDockerContainer(
                "pds",
                healthcheck=MockHealthcheck("/xrpc/_health", interval=30),
                networks=[pds_net],
                ports={2583: 2583},
            ),
            "core": MockDockerContainer(
                "core",
                healthcheck=MockHealthcheck("/healthz"),
                networks=[brain_net, pds_net, public_net],
                ports={8100: 8100, 8300: 8300},
                depends_on=["pds"],
            ),
            "brain": MockDockerContainer(
                "brain",
                healthcheck=MockHealthcheck("/healthz"),
                networks=[brain_net],
                depends_on=["core"],
            ),
        }
        if profile == "local-llm":
            self.containers["llama"] = MockDockerContainer(
                "llama",
                healthcheck=MockHealthcheck("/health"),
                networks=[brain_net],
            )

    def up(self) -> bool:
        """Start containers in dependency order."""
        order = self._resolve_start_order()
        for name in order:
            container = self.containers[name]
            container.start()
            if container.healthcheck:
                container.healthcheck.set_passing(True)
        return True

    def down(self) -> None:
        for container in self.containers.values():
            container.stop()

    def _resolve_start_order(self) -> list[str]:
        """Topological sort of container dependencies."""
        visited: set[str] = set()
        order: list[str] = []

        def visit(name: str) -> None:
            if name in visited:
                return
            visited.add(name)
            container = self.containers.get(name)
            if container:
                for dep in container.depends_on:
                    visit(dep)
            order.append(name)

        for name in self.containers:
            visit(name)
        return order

    def is_all_healthy(self) -> bool:
        return all(
            c.running and (not c.healthcheck or c.healthcheck.is_healthy())
            for c in self.containers.values()
        )


# ---------------------------------------------------------------------------
# Mock: Crash Recovery (§6.x)
# ---------------------------------------------------------------------------

class MockScratchpad:
    """Brain checkpoint storage for crash recovery."""

    def __init__(self) -> None:
        self.checkpoints: dict[str, dict[str, Any]] = {}

    def save(self, task_id: str, step: int,
             context: dict[str, Any]) -> None:
        self.checkpoints[task_id] = {
            "step": step, "context": context,
            "timestamp": time.time(),
        }

    def load(self, task_id: str) -> dict[str, Any] | None:
        return self.checkpoints.get(task_id)

    def delete(self, task_id: str) -> bool:
        return self.checkpoints.pop(task_id, None) is not None

    def has_checkpoint(self, task_id: str) -> bool:
        return task_id in self.checkpoints


class MockOutbox:
    """DIDComm outbox with exponential backoff retry."""

    BACKOFF_SCHEDULE = [30, 60, 300, 1800, 7200]  # seconds

    def __init__(self) -> None:
        self.messages: dict[str, DinaMessage] = {}
        self.retry_counts: dict[str, int] = {}
        self.failed: set[str] = set()
        self.delivered: set[str] = set()

    def enqueue(self, msg: DinaMessage) -> str:
        msg_id = f"msg_{uuid.uuid4().hex[:8]}"
        self.messages[msg_id] = msg
        self.retry_counts[msg_id] = 0
        return msg_id

    def get_pending(self) -> list[tuple[str, DinaMessage]]:
        return [
            (mid, msg) for mid, msg in self.messages.items()
            if mid not in self.delivered and mid not in self.failed
        ]

    def ack(self, msg_id: str) -> bool:
        if msg_id in self.messages:
            self.delivered.add(msg_id)
            return True
        return False

    def retry(self, msg_id: str) -> bool:
        count = self.retry_counts.get(msg_id, 0)
        if count >= len(self.BACKOFF_SCHEDULE):
            self.failed.add(msg_id)
            return False
        self.retry_counts[msg_id] = count + 1
        return True

    def get_backoff(self, msg_id: str) -> int:
        count = self.retry_counts.get(msg_id, 0)
        idx = min(count, len(self.BACKOFF_SCHEDULE) - 1)
        return self.BACKOFF_SCHEDULE[idx]


class MockInboxSpool:
    """Encrypted spool for messages to locked personas."""

    def __init__(self, max_bytes: int = 500 * 1024 * 1024) -> None:
        self.blobs: dict[str, bytes] = {}
        self.max_bytes = max_bytes
        self._used_bytes = 0

    def store(self, data: bytes) -> str | None:
        """Store encrypted blob. Returns None if spool full."""
        if self._used_bytes + len(data) > self.max_bytes:
            return None
        blob_id = f"spool_{uuid.uuid4().hex[:8]}"
        self.blobs[blob_id] = data
        self._used_bytes += len(data)
        return blob_id

    def retrieve(self, blob_id: str) -> bytes | None:
        return self.blobs.get(blob_id)

    def drain(self) -> list[bytes]:
        """Drain all spooled messages (persona unlocked)."""
        items = list(self.blobs.values())
        self.blobs.clear()
        self._used_bytes = 0
        return items

    def is_full(self, new_size: int = 0) -> bool:
        return self._used_bytes + new_size > self.max_bytes

    @property
    def used_bytes(self) -> int:
        return self._used_bytes


class MockCrashLog:
    """Crash log stored in identity.sqlite."""

    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []

    def record(self, error: str, traceback: str = "",
               sanitized_line: str = "") -> None:
        self.entries.append({
            "timestamp": time.time(),
            "error": error,
            "traceback": traceback,
            "sanitized_line": sanitized_line,
        })

    def get_recent(self, count: int = 10) -> list[dict[str, Any]]:
        return self.entries[-count:]


# ---------------------------------------------------------------------------
# Mock: Schema Migration & Export/Import (§12)
# ---------------------------------------------------------------------------

class MockSchemaMigration:
    """Schema migration with pre-flight backup and rollback."""

    def __init__(self, current_version: int = 1) -> None:
        self.current_version = current_version
        self.applied: list[int] = []
        self.backup: dict[str, Any] | None = None
        self.rolled_back: bool = False
        self.integrity_ok: bool = True

    def pre_flight_backup(self, vault: MockVault) -> None:
        """Create backup before migration."""
        self.backup = vault.snapshot()

    def apply(self, target_version: int,
              vault: MockVault) -> bool:
        """Apply migration. Returns False if integrity check fails."""
        self.pre_flight_backup(vault)
        if not self.integrity_ok:
            self.rollback(vault)
            return False
        self.current_version = target_version
        self.applied.append(target_version)
        return True

    def rollback(self, vault: MockVault) -> bool:
        if self.backup:
            self.rolled_back = True
            return True
        return False

    def set_integrity_failure(self) -> None:
        self.integrity_ok = False


class MockExportArchive:
    """Export/import archive for data portability."""

    def __init__(self) -> None:
        self.data: dict[str, Any] = {}
        self.checksum: str = ""
        self.exported_at: float = 0.0
        self.personas: list[str] = []
        self.did: str = ""
        self.tampered: bool = False

    def export_from(self, vault: MockVault,
                    identity: MockIdentity) -> None:
        """Create export archive from vault + identity."""
        self.data = vault.snapshot()
        self.did = identity.root_did
        self.personas = [p.value for p in identity.personas]
        self.exported_at = time.time()
        self.checksum = hashlib.sha256(
            json.dumps(self.data, sort_keys=True).encode()
        ).hexdigest()

    def import_into(self, vault: MockVault,
                    identity: MockIdentity) -> bool:
        """Import archive. Rejects tampered data."""
        if self.tampered:
            return False
        current_checksum = hashlib.sha256(
            json.dumps(self.data, sort_keys=True).encode()
        ).hexdigest()
        if current_checksum != self.checksum:
            return False
        # Restore data
        for tier_str, items in self.data.get("tiers", {}).items():
            tier = int(tier_str)
            for key, value in items.items():
                vault.store(tier, key, value)
        return True

    def tamper(self) -> None:
        """Simulate archive tampering."""
        self.tampered = True
        self.data["tampered"] = True


# ---------------------------------------------------------------------------
# Mock: Performance Metrics (§13)
# ---------------------------------------------------------------------------

class MockPerformanceMetrics:
    """Tracks latency and throughput for performance tests."""

    def __init__(self) -> None:
        self.latencies_ms: list[float] = []
        self.errors: int = 0
        self.total_requests: int = 0

    def record(self, latency_ms: float, error: bool = False) -> None:
        self.latencies_ms.append(latency_ms)
        self.total_requests += 1
        if error:
            self.errors += 1

    def percentile(self, p: int) -> float:
        """Get p-th percentile latency."""
        if not self.latencies_ms:
            return 0.0
        sorted_l = sorted(self.latencies_ms)
        idx = int(len(sorted_l) * p / 100)
        return sorted_l[min(idx, len(sorted_l) - 1)]

    @property
    def p50(self) -> float:
        return self.percentile(50)

    @property
    def p99(self) -> float:
        return self.percentile(99)

    @property
    def error_rate(self) -> float:
        return self.errors / max(self.total_requests, 1)


# ---------------------------------------------------------------------------
# Mock: Chaos Engineering (§14)
# ---------------------------------------------------------------------------

class MockChaosMonkey:
    """Failure injection for chaos engineering tests."""

    def __init__(self) -> None:
        self.kill_targets: list[MockDockerContainer] = []
        self.network_partitions: list[tuple[str, str]] = []
        self.latency_ms: int = 0
        self.cpu_pressure: bool = False
        self.memory_pressure: bool = False
        self.disk_io_saturation: bool = False

    def kill_random(self, container: MockDockerContainer) -> None:
        """SIGKILL a container."""
        container.stop()
        self.kill_targets.append(container)

    def partition_network(self, service_a: str,
                          service_b: str) -> None:
        self.network_partitions.append((service_a, service_b))

    def is_partitioned(self, a: str, b: str) -> bool:
        return (a, b) in self.network_partitions or \
               (b, a) in self.network_partitions

    def add_latency(self, ms: int) -> None:
        self.latency_ms = ms

    def apply_resource_pressure(
        self, cpu: bool = False, memory: bool = False,
        disk_io: bool = False
    ) -> None:
        self.cpu_pressure = cpu
        self.memory_pressure = memory
        self.disk_io_saturation = disk_io


# ---------------------------------------------------------------------------
# Mock: Audit Log & Compliance (§15)
# ---------------------------------------------------------------------------

@dataclass
class AuditEntry:
    """Immutable audit trail entry."""
    actor: str
    action: str
    resource: str
    result: str  # "success", "denied", "error"
    details: dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)


class MockAuditLog:
    """Append-only audit trail."""

    def __init__(self) -> None:
        self.entries: list[AuditEntry] = []

    def record(self, actor: str, action: str, resource: str,
               result: str = "success",
               details: dict[str, Any] | None = None) -> None:
        self.entries.append(AuditEntry(
            actor=actor, action=action, resource=resource,
            result=result, details=details or {},
        ))

    def query(self, actor: str | None = None,
              action: str | None = None) -> list[AuditEntry]:
        results = self.entries
        if actor:
            results = [e for e in results if e.actor == actor]
        if action:
            results = [e for e in results if e.action == action]
        return results

    def has_pii(self, pii_patterns: list[str]) -> bool:
        """Check if any audit entry contains PII."""
        for entry in self.entries:
            text = json.dumps(entry.details)
            if any(pii in text for pii in pii_patterns):
                return True
        return False

    def export(self) -> list[dict[str, Any]]:
        return [
            {"actor": e.actor, "action": e.action,
             "resource": e.resource, "result": e.result,
             "details": e.details, "timestamp": e.timestamp}
            for e in self.entries
        ]


# ---------------------------------------------------------------------------
# Mock: Push Notifications (§16.11)
# ---------------------------------------------------------------------------

@dataclass
class PushPayload:
    """Push notification — wake-only, NO user data."""
    device_token: str
    platform: str  # "fcm", "apns", "unifiedpush"
    title: str = "Dina"
    body: str = ""
    data: dict[str, Any] = field(default_factory=dict)


class MockPushProvider:
    """Platform push notification provider (FCM/APNs/UnifiedPush)."""

    def __init__(self, platform: str = "fcm") -> None:
        self.platform = platform
        self.sent: list[PushPayload] = []

    def send_wake(self, device_token: str) -> bool:
        """Send wake-only push — NO user data in payload."""
        payload = PushPayload(
            device_token=device_token,
            platform=self.platform,
        )
        self.sent.append(payload)
        return True

    def get_payloads(self) -> list[PushPayload]:
        return list(self.sent)

    def payloads_contain_user_data(self) -> bool:
        """Verify no push payload contains user data."""
        for p in self.sent:
            if p.body or p.data:
                return True
        return False


# ---------------------------------------------------------------------------
# Mock: Deployment Profiles (§16.12)
# ---------------------------------------------------------------------------

class MockDeploymentProfile:
    """Docker compose deployment profile."""

    def __init__(self, profile: str = "cloud") -> None:
        self.profile = profile  # "cloud" or "local-llm"

    @property
    def container_count(self) -> int:
        return 4 if self.profile == "local-llm" else 3

    @property
    def has_llama(self) -> bool:
        return self.profile == "local-llm"

    @property
    def containers(self) -> list[str]:
        base = ["core", "brain", "pds"]
        if self.has_llama:
            base.append("llama")
        return base


# ---------------------------------------------------------------------------
# Mock: Noise XX / Forward Secrecy (§16.6)
# ---------------------------------------------------------------------------

class MockNoiseSession:
    """Noise XX handshake session for forward secrecy."""

    def __init__(self, local_did: str, remote_did: str) -> None:
        self.local_did = local_did
        self.remote_did = remote_did
        self.session_key = hashlib.sha256(
            f"{local_did}{remote_did}{time.time()}".encode()
        ).hexdigest()
        self.ratchet_count: int = 0
        self.established: bool = False
        self.past_keys: list[str] = []

    def handshake(self) -> bool:
        """Mutual authentication + session key establishment."""
        self.established = True
        return True

    def ratchet(self) -> str:
        """Rotate session key (forward secrecy)."""
        self.past_keys.append(self.session_key)
        self.session_key = hashlib.sha256(
            self.session_key.encode()
        ).hexdigest()
        self.ratchet_count += 1
        return self.session_key

    def can_decrypt_past(self, old_key: str) -> bool:
        """Past keys should NOT be derivable from current key."""
        return old_key == self.session_key  # only current key works


# ---------------------------------------------------------------------------
# Mock: Trust AppView (§16.7)
# ---------------------------------------------------------------------------

class MockAppView:
    """AT Protocol AppView — read-only trust indexer."""

    def __init__(self) -> None:
        self.indexed_records: list[dict[str, Any]] = []
        self.cursor: int = 0
        self.lexicon_filter = "com.dina.trust."

    def consume_firehose(
        self, records: list[dict[str, Any]]
    ) -> int:
        """Filter and index records from AT Protocol firehose."""
        indexed = 0
        for record in records:
            lexicon = record.get("lexicon", "")
            if lexicon.startswith(self.lexicon_filter) or \
               lexicon == "com.dina.identity.attestation":
                self.indexed_records.append(record)
                indexed += 1
            self.cursor += 1
        return indexed

    def query_by_did(self, did: str) -> list[dict[str, Any]]:
        return [r for r in self.indexed_records
                if r.get("author_did") == did]

    def query_by_product(self, product_id: str) -> list[dict[str, Any]]:
        return [r for r in self.indexed_records
                if r.get("product_id") == product_id]

    def compute_aggregate(self, product_id: str) -> float:
        """Deterministic aggregate score computation."""
        records = self.query_by_product(product_id)
        if not records:
            return 0.0
        ratings = [r.get("rating", 0) for r in records if "rating" in r]
        return sum(ratings) / len(ratings) if ratings else 0.0


# ---------------------------------------------------------------------------
# Mock: Ingress Tiers (§16.5)
# ---------------------------------------------------------------------------

class MockIngressTier:
    """Network ingress tier for Home Node reachability."""

    def __init__(self, tier: str, endpoint: str) -> None:
        self.tier = tier  # "community", "production", "sovereign"
        self.endpoint = endpoint
        self.active: bool = True
        self.tls: bool = True

    @staticmethod
    def community(node_name: str) -> "MockIngressTier":
        return MockIngressTier("community",
                               f"https://{node_name}.tailnet.ts.net")

    @staticmethod
    def production(domain: str) -> "MockIngressTier":
        return MockIngressTier("production", f"https://{domain}")

    @staticmethod
    def sovereign(ipv6: str) -> "MockIngressTier":
        return MockIngressTier("sovereign", f"https://[{ipv6}]")


# ---------------------------------------------------------------------------
# Mock: Three-Layer Verification (§16.8)
# ---------------------------------------------------------------------------

class MockVerificationLayer:
    """Three-layer AppView verification."""

    def __init__(self) -> None:
        self.layer1_checks: int = 0  # cryptographic proof
        self.layer2_checks: int = 0  # consensus (anti-censorship)
        self.layer3_checks: int = 0  # direct PDS spot-check

    def verify_signature(self, record: dict[str, Any],
                         public_key: str) -> bool:
        """Layer 1: Cryptographic proof — verify Ed25519 signature."""
        self.layer1_checks += 1
        return "signature" in record and len(record["signature"]) > 0

    def consensus_check(self, results_a: list[dict],
                        results_b: list[dict]) -> bool:
        """Layer 2: Compare two AppView results for censorship."""
        self.layer2_checks += 1
        # Significant count discrepancy = censorship
        if len(results_a) > 0 and len(results_b) > 0:
            ratio = min(len(results_a), len(results_b)) / \
                    max(len(results_a), len(results_b))
            return ratio > 0.5  # less than 50% overlap = suspicious
        return True

    def spot_check_pds(self, appview_records: list[dict],
                       pds_records: list[dict]) -> bool:
        """Layer 3: Direct PDS spot-check (1-in-100 audit)."""
        self.layer3_checks += 1
        # All AppView records should exist in PDS
        appview_ids = {r.get("id") for r in appview_records}
        pds_ids = {r.get("id") for r in pds_records}
        return appview_ids.issubset(pds_ids)


# ---------------------------------------------------------------------------
# Mock: Timestamp Anchoring (§16.9)
# ---------------------------------------------------------------------------

class MockTimestampAnchor:
    """Merkle root hash anchored to L2 chain."""

    def __init__(self) -> None:
        self.anchored_roots: list[dict[str, Any]] = []

    def compute_merkle_root(self, records: list[dict]) -> str:
        """Compute Merkle root from signed records."""
        leaves = [hashlib.sha256(
            json.dumps(r, sort_keys=True).encode()
        ).hexdigest() for r in records]
        while len(leaves) > 1:
            new_leaves = []
            for i in range(0, len(leaves), 2):
                if i + 1 < len(leaves):
                    combined = leaves[i] + leaves[i + 1]
                else:
                    combined = leaves[i] + leaves[i]
                new_leaves.append(
                    hashlib.sha256(combined.encode()).hexdigest()
                )
            leaves = new_leaves
        return leaves[0] if leaves else ""

    def anchor_to_l2(self, merkle_root: str) -> dict[str, Any]:
        """Anchor Merkle root hash to L2 chain."""
        entry = {
            "merkle_root": merkle_root,
            "chain": "base",
            "tx_hash": hashlib.sha256(
                merkle_root.encode()
            ).hexdigest()[:40],
            "timestamp": time.time(),
        }
        self.anchored_roots.append(entry)
        return entry

    def verify_proof(self, record: dict, merkle_root: str,
                     proof: list[str]) -> bool:
        """Verify a record's inclusion in a Merkle tree."""
        leaf = hashlib.sha256(
            json.dumps(record, sort_keys=True).encode()
        ).hexdigest()
        current = leaf
        for sibling in proof:
            combined = current + sibling if current < sibling \
                else sibling + current
            current = hashlib.sha256(combined.encode()).hexdigest()
        return current == merkle_root


# ---------------------------------------------------------------------------
# Mock: SSS (Shamir's Secret Sharing) Manager (Architecture §5)
# ---------------------------------------------------------------------------

class MockSSSManager:
    """Shamir's Secret Sharing — split, rotate, and recover master key."""

    def __init__(self, identity: MockIdentity, threshold: int = 3,
                 total_shares: int = 5) -> None:
        self._identity = identity
        self.threshold = threshold
        self.total_shares = total_shares
        self._shares: list[dict[str, Any]] = []
        self._rotation_count: int = 0
        self._recovery_manifest: dict[str, Any] | None = None

    def split(self) -> list[dict[str, Any]]:
        """Split master key into shares using Shamir's Secret Sharing.

        Each share is encrypted to the custodian's public key.
        """
        self._shares = []
        for i in range(self.total_shares):
            share_data = hashlib.sha256(
                f"{self._identity.root_private_key}:share:{i}:"
                f"rotation:{self._rotation_count}".encode()
            ).hexdigest()
            self._shares.append({
                "index": i,
                "data": share_data,
                "rotation": self._rotation_count,
            })
        return list(self._shares)

    def encrypt_share_for_custodian(self, share: dict[str, Any],
                                     custodian_did: str) -> dict[str, Any]:
        """Encrypt a share with custodian's public key (NaCl crypto_box_seal)."""
        encrypted = hashlib.sha256(
            f"{share['data']}:{custodian_did}".encode()
        ).hexdigest()
        return {
            "index": share["index"],
            "encrypted_data": f"NACL_SEALED[{custodian_did[:20]}]:{encrypted}",
            "custodian_did": custodian_did,
            "rotation": share["rotation"],
        }

    def decrypt_share(self, encrypted_share: dict[str, Any],
                      custodian_did: str) -> dict[str, Any] | None:
        """Decrypt a share — only works if custodian_did matches."""
        if encrypted_share.get("custodian_did") != custodian_did:
            return None  # Wrong custodian — cannot decrypt
        return {
            "index": encrypted_share["index"],
            "data": f"DECRYPTED_SHARE_{encrypted_share['index']}",
            "rotation": encrypted_share["rotation"],
        }

    def rotate(self) -> list[dict[str, Any]]:
        """Re-split with new randomness — old shares become useless.

        Master key/seed stays the same; only the polynomial changes.
        """
        old_rotation = self._rotation_count
        self._rotation_count += 1
        new_shares = self.split()
        # Old shares are now mathematically useless
        return new_shares

    def is_share_valid(self, share: dict[str, Any]) -> bool:
        """Check if a share belongs to the current rotation."""
        return share.get("rotation") == self._rotation_count

    def recover(self, shares: list[dict[str, Any]]) -> str | None:
        """Recover master key from threshold shares.

        Returns the key if enough valid shares provided, None otherwise.
        """
        valid = [s for s in shares if self.is_share_valid(s)]
        if len(valid) < self.threshold:
            return None
        return self._identity.root_private_key

    def publish_recovery_manifest(self, custodian_dids: list[str],
                                   pds_url: str = "https://pds.dina.host") -> dict[str, Any]:
        """Publish a signed recovery manifest to AT Protocol PDS.

        Manifest contains ONLY custodian DIDs — never the actual shares.
        """
        manifest = {
            "type": "com.dina.recovery.manifest",
            "owner_did": self._identity.root_did,
            "custodian_dids": custodian_dids,
            "threshold": self.threshold,
            "total_shares": self.total_shares,
            "rotation": self._rotation_count,
            "pds_url": pds_url,
            "signature": self._identity.sign(
                json.dumps(custodian_dids, sort_keys=True).encode()
            ),
        }
        self._recovery_manifest = manifest
        return manifest

    @property
    def recovery_manifest(self) -> dict[str, Any] | None:
        return self._recovery_manifest


# ---------------------------------------------------------------------------
# Mock: Backup / Disaster Recovery (Architecture §13)
# ---------------------------------------------------------------------------

class MockBackupManager:
    """Encrypted Home Node backups to blob store."""

    def __init__(self, vault: MockVault, identity: MockIdentity) -> None:
        self._vault = vault
        self._identity = identity
        self.snapshots: list[dict[str, Any]] = []
        self.snapshot_frequency = "daily"

    def create_snapshot(self, passphrase: str = "backup_key") -> dict[str, Any]:
        """Create encrypted snapshot of vault + identity.

        Steps:
        1. Pause writes (WAL checkpoint)
        2. Create tar.gz of databases
        3. Encrypt with Argon2id(passphrase) → AES-256-GCM
        """
        snapshot_data = self._vault.snapshot()
        kek = hashlib.sha256(passphrase.encode()).hexdigest()
        encrypted = f"AES256GCM[{kek[:16]}]:{hashlib.sha256(json.dumps(snapshot_data, sort_keys=True).encode()).hexdigest()}"
        snapshot = {
            "encrypted_data": encrypted,
            "encryption": "AES-256-GCM",
            "kdf": "Argon2id",
            "did": self._identity.root_did,
            "timestamp": time.time(),
            "checksum": hashlib.sha256(encrypted.encode()).hexdigest(),
            "plaintext_written_to_disk": False,
        }
        self.snapshots.append(snapshot)
        return snapshot

    def restore_from_snapshot(self, snapshot: dict[str, Any],
                               passphrase: str = "backup_key") -> bool:
        """Restore Home Node from encrypted snapshot."""
        kek = hashlib.sha256(passphrase.encode()).hexdigest()
        if kek[:16] not in snapshot.get("encrypted_data", ""):
            return False  # Wrong passphrase
        return True

    def list_snapshots(self) -> list[dict[str, Any]]:
        return list(self.snapshots)


# ---------------------------------------------------------------------------
# Mock: Voice STT (Architecture §16, §17)
# ---------------------------------------------------------------------------

class MockSTTProvider:
    """Speech-to-text provider — Deepgram Nova-3 or Gemini fallback."""

    def __init__(self, provider: str = "deepgram") -> None:
        self.provider = provider  # "deepgram" or "gemini"
        self.connection_type = "websocket"
        self.transcriptions: list[dict[str, Any]] = []
        self.available = True

    @property
    def latency_ms(self) -> int:
        if self.provider == "deepgram":
            return 200  # 150-300ms range
        return 500  # Gemini fallback is slower

    @property
    def cost_per_minute(self) -> float:
        if self.provider == "deepgram":
            return 0.0077
        return 0.0003  # $0.30/1M audio tokens ≈ this per minute

    def transcribe(self, audio_chunk: bytes) -> dict[str, Any]:
        if not self.available:
            raise ConnectionError(f"{self.provider} STT unavailable")
        result = {
            "text": f"Transcribed via {self.provider}",
            "provider": self.provider,
            "latency_ms": self.latency_ms,
            "connection": self.connection_type,
        }
        self.transcriptions.append(result)
        return result

    def fail(self) -> None:
        self.available = False

    def recover(self) -> None:
        self.available = True


class MockSTTRouter:
    """Routes STT to primary (Deepgram) with fallback (Gemini)."""

    def __init__(self) -> None:
        self.primary = MockSTTProvider("deepgram")
        self.fallback = MockSTTProvider("gemini")
        self.failover_count: int = 0

    def transcribe(self, audio_chunk: bytes) -> dict[str, Any]:
        try:
            return self.primary.transcribe(audio_chunk)
        except ConnectionError:
            self.failover_count += 1
            return self.fallback.transcribe(audio_chunk)

    def supports_all_profiles(self) -> bool:
        """STT is available in all deployment profiles."""
        return True


# ---------------------------------------------------------------------------
# Mock: Bot Query Sanitizer (Architecture §10)
# ---------------------------------------------------------------------------

class MockBotQuerySanitizer:
    """Ensures bot queries contain no identifying information."""

    FORBIDDEN_FIELDS = {
        "user_did", "user_name", "home_node_url", "persona_path",
        "session_id", "device_id", "email", "phone", "address",
        "medical_diagnosis", "financial_details", "aadhaar",
    }

    def sanitize_query(self, raw_query: dict[str, Any]) -> dict[str, Any]:
        """Strip all identifying information from a bot query.

        Returns only: query text, trust_ring level, response_format, max_sources.
        """
        sanitized = {
            "query": raw_query.get("query", ""),
            "requester_trust_ring": raw_query.get("requester_trust_ring", 2),
            "response_format": raw_query.get("response_format", "structured"),
            "max_sources": raw_query.get("max_sources", 5),
        }
        return sanitized

    def validate_no_pii(self, query: dict[str, Any]) -> list[str]:
        """Check a query payload for forbidden fields. Returns violations."""
        violations = []
        for key in query:
            if key in self.FORBIDDEN_FIELDS:
                violations.append(key)
        # Also check query text for DID patterns
        query_text = query.get("query", "")
        if "did:" in query_text:
            violations.append("did_in_query_text")
        return violations


# ---------------------------------------------------------------------------
# Mock: Dead Drop Ingress (Architecture §2 — Three Valves)
# ---------------------------------------------------------------------------

class MockDeadDropIngress:
    """Dead drop ingress with three-valve rate limiting.

    Valve 1: Token bucket per IP (50 req/hr) + global (1000 req/hr) + payload cap (256KB)
    Valve 2: Spool disk quota (500MB)
    Valve 3: Sweeper feedback (blocklist spam IPs after unlock)
    """

    def __init__(self) -> None:
        self.ip_buckets: dict[str, int] = {}  # IP → count this hour
        self.global_count: int = 0
        self.ip_limit: int = 50
        self.global_limit: int = 1000
        self.payload_cap_bytes: int = 256 * 1024  # 256KB
        self.blocklist: set[str] = set()
        self.spool = MockInboxSpool()
        self.vault_locked: bool = True
        self.did_buckets: dict[str, int] = {}  # DID → count (unlocked only)
        self.did_limit: int = 100
        self.history: list[dict[str, Any]] = []  # stored silently for expired

    def receive(self, ip: str, payload: bytes,
                sender_did: str | None = None,
                ttl_seconds: int = 900,
                message_age_seconds: int = 0) -> tuple[int, str]:
        """Process incoming message through three valves.

        Returns (http_status, reason).
        """
        # Valve 1a: IP blocklist
        if ip in self.blocklist:
            return (429, "ip_blocklisted")

        # Valve 1b: Payload cap
        if len(payload) > self.payload_cap_bytes:
            return (413, "payload_too_large")

        # Valve 1c: IP rate limit
        self.ip_buckets.setdefault(ip, 0)
        if self.ip_buckets[ip] >= self.ip_limit:
            return (429, "ip_rate_limit")
        self.ip_buckets[ip] += 1

        # Valve 1d: Global rate limit
        if self.global_count >= self.global_limit:
            return (429, "global_rate_limit")
        self.global_count += 1

        # Vault unlocked fast path: per-DID rate limit
        if not self.vault_locked and sender_did:
            self.did_buckets.setdefault(sender_did, 0)
            if self.did_buckets[sender_did] >= self.did_limit:
                return (429, "per_did_rate_limit")
            self.did_buckets[sender_did] += 1

        # Valve 2: Spool quota
        blob_id = self.spool.store(payload)
        if blob_id is None:
            return (429, "spool_full")

        return (200, blob_id)

    def sweep(self, trust_evaluator: Any = None) -> list[dict[str, Any]]:
        """Sweeper (Valve 3): process spool after unlock.

        Returns list of processed items with TTL status.
        """
        processed = []
        for blob_id, blob in list(self.spool.blobs.items()):
            entry = {
                "blob_id": blob_id,
                "data": blob,
                "expired": False,
                "notified": False,
                "spam": False,
            }
            processed.append(entry)
        self.spool.blobs.clear()
        self.spool._used_bytes = 0
        return processed

    def blocklist_ip(self, ip: str) -> None:
        """Add IP to permanent blocklist (spam DID detected by sweeper)."""
        self.blocklist.add(ip)

    def store_expired_silently(self, data: bytes) -> None:
        """Store expired message in vault history — no user notification."""
        self.history.append({"data": data, "status": "expired_silent",
                             "timestamp": time.time()})


# ---------------------------------------------------------------------------
# Mock: Task Queue (Architecture §4 — Outbox Pattern)
# ---------------------------------------------------------------------------

class MockTaskQueue:
    """Task queue with dead-letter, timeout, and retry semantics."""

    DEAD_LETTER_THRESHOLD = 3
    PROCESSING_TIMEOUT_SECONDS = 300  # 5 minutes

    def __init__(self) -> None:
        self.tasks: dict[str, dict[str, Any]] = {}
        self.dead_letter: list[str] = []
        self.notifications: list[dict[str, Any]] = []

    def enqueue(self, task_id: str, payload: dict[str, Any]) -> None:
        self.tasks[task_id] = {
            "status": "pending",
            "payload": payload,
            "attempts": 0,
            "created_at": time.time(),
            "timeout_at": None,
        }

    def start_processing(self, task_id: str) -> None:
        task = self.tasks[task_id]
        task["status"] = "processing"
        task["timeout_at"] = time.time() + self.PROCESSING_TIMEOUT_SECONDS
        task["attempts"] += 1

    def ack(self, task_id: str) -> None:
        self.tasks[task_id]["status"] = "completed"

    def fail(self, task_id: str) -> None:
        """Record a failure. After DEAD_LETTER_THRESHOLD, move to dead letter."""
        task = self.tasks[task_id]
        if task["attempts"] >= self.DEAD_LETTER_THRESHOLD:
            task["status"] = "dead"
            self.dead_letter.append(task_id)
            self.notifications.append({
                "tier": SilenceTier.TIER_2_SOLICITED,
                "message": "Brain failed to process an event 3 times. Check crash logs.",
                "task_id": task_id,
            })
        else:
            task["status"] = "pending"

    def watchdog_sweep(self, current_time: float | None = None) -> list[str]:
        """Reset tasks stuck in processing past timeout_at."""
        now = current_time or time.time()
        reset = []
        for tid, task in self.tasks.items():
            if (task["status"] == "processing"
                    and task["timeout_at"]
                    and now > task["timeout_at"]):
                task["status"] = "pending"
                reset.append(tid)
        return reset


# ---------------------------------------------------------------------------
# Mock: HKDF Key Manager (Architecture §6)
# ---------------------------------------------------------------------------

class MockHKDFKeyManager:
    """HKDF-based key derivation for backup, archive, sync, trust keys."""

    def __init__(self, master_seed: str) -> None:
        self._seed = master_seed
        self._keys: dict[str, str] = {}

    def derive(self, info: str) -> str:
        """Derive a 256-bit key using HKDF with the given info string.

        Deterministic: same seed + info always produces same key.
        """
        key = hashlib.sha256(f"{self._seed}:{info}".encode()).hexdigest()
        self._keys[info] = key
        return key

    def backup_key(self) -> str:
        return self.derive("dina:backup:v1")

    def archive_key(self) -> str:
        return self.derive("dina:archive:v1")

    def sync_key(self) -> str:
        return self.derive("dina:sync:v1")

    def trust_key(self) -> str:
        return self.derive("dina:trust:v1")

    @property
    def derived_keys(self) -> dict[str, str]:
        return dict(self._keys)


# ---------------------------------------------------------------------------
# Mock: Argon2id Parameters (Architecture §6)
# ---------------------------------------------------------------------------

@dataclass
class Argon2idParams:
    """Argon2id KDF parameters — OWASP 2024 compliant."""
    memory_mb: int = 128
    iterations: int = 3
    parallelism: int = 4

    def derive_kek(self, passphrase: str, salt: bytes = b"dina_salt") -> str:
        """Derive KEK from passphrase using Argon2id parameters."""
        return hashlib.sha256(
            f"{passphrase}:{self.memory_mb}:{self.iterations}:"
            f"{self.parallelism}:{salt.hex()}".encode()
        ).hexdigest()


# ---------------------------------------------------------------------------
# Mock: Vault Query (Architecture §4 — include_content + pagination)
# ---------------------------------------------------------------------------

class MockVaultQuery:
    """Vault query API with include_content and pagination support."""

    DEFAULT_LIMIT = 20
    MAX_LIMIT = 100

    def __init__(self, vault: MockVault) -> None:
        self._vault = vault
        self._items: list[dict[str, Any]] = []

    def add_item(self, item_id: str, summary: str, body_text: str,
                 persona: PersonaType | None = None) -> None:
        self._items.append({
            "id": item_id, "summary": summary,
            "body_text": body_text, "persona": persona,
        })

    def query(self, search: str, include_content: bool = False,
              limit: int | None = None,
              offset: int = 0) -> dict[str, Any]:
        """Execute vault query with architecture-spec response format."""
        effective_limit = min(limit or self.DEFAULT_LIMIT, self.MAX_LIMIT)

        # Filter items (simplified: all match)
        matching = [it for it in self._items
                    if search.lower() in it["summary"].lower()
                    or search.lower() in it["body_text"].lower()]

        page = matching[offset:offset + effective_limit]
        has_more = offset + effective_limit < len(matching)

        results = []
        for item in page:
            entry: dict[str, Any] = {"id": item["id"], "summary": item["summary"]}
            if include_content:
                entry["body_text"] = item["body_text"]
            results.append(entry)

        response: dict[str, Any] = {
            "items": results,
            "pagination": {
                "has_more": has_more,
            },
        }
        if has_more:
            response["pagination"]["next_offset"] = offset + effective_limit

        return response


# ---------------------------------------------------------------------------
# Mock: Hybrid Search (Architecture §4)
# ---------------------------------------------------------------------------

class MockHybridSearch:
    """Hybrid search with FTS5 + cosine similarity scoring."""

    FTS5_WEIGHT = 0.4
    COSINE_WEIGHT = 0.6

    def __init__(self) -> None:
        self._items: list[dict[str, Any]] = []

    def add_item(self, item_id: str, fts5_rank: float,
                 cosine_similarity: float) -> None:
        self._items.append({
            "id": item_id,
            "fts5_rank": fts5_rank,
            "cosine_similarity": cosine_similarity,
        })

    def search(self, query: str) -> list[dict[str, Any]]:
        results = []
        for item in self._items:
            relevance = (self.FTS5_WEIGHT * item["fts5_rank"]
                         + self.COSINE_WEIGHT * item["cosine_similarity"])
            results.append({
                "id": item["id"],
                "relevance": round(relevance, 4),
                "fts5_rank": item["fts5_rank"],
                "cosine_similarity": item["cosine_similarity"],
            })
        return sorted(results, key=lambda x: x["relevance"], reverse=True)


# ---------------------------------------------------------------------------
# Mock: KV Store (Architecture §6 — brain stateless, sync cursors)
# ---------------------------------------------------------------------------

class MockKVStore:
    """Key-value store in identity.sqlite for sync cursors."""

    def __init__(self) -> None:
        self._store: dict[str, dict[str, Any]] = {}

    def put(self, key: str, value: str) -> None:
        self._store[key] = {
            "value": value,
            "updated_at": time.time(),
        }

    def get(self, key: str) -> str | None:
        entry = self._store.get(key)
        return entry["value"] if entry else None

    def delete(self, key: str) -> bool:
        return self._store.pop(key, None) is not None


# ---------------------------------------------------------------------------
# Mock: Boot Manager (Architecture §2 — persona DB lifecycle)
# ---------------------------------------------------------------------------

class MockBootManager:
    """Home Node boot sequence — tracks which persona DBs are open."""

    def __init__(self, identity: MockIdentity) -> None:
        self._identity = identity
        self.opened_dbs: set[str] = set()
        self.dek_in_ram: set[str] = set()
        self.brain_notified: bool = False
        self.brain_notification_payload: dict[str, Any] | None = None

    def boot(self) -> None:
        """Execute boot sequence per §2 architecture."""
        # Step 5-6: Open identity + personal only
        self.opened_dbs.add("identity.sqlite")
        self.opened_dbs.add("personal.sqlite")
        self.dek_in_ram.add("identity")
        self.dek_in_ram.add("personal")
        # Step 7: Other persona DBs remain CLOSED
        # Step 8: Notify brain
        self.brain_notified = True
        self.brain_notification_payload = {"event": "vault_unlocked"}

    def is_persona_open(self, persona: str) -> bool:
        return f"{persona}.sqlite" in self.opened_dbs

    def open_persona(self, persona: str) -> None:
        """Explicitly open a persona DB (user unlocks it)."""
        self.opened_dbs.add(f"{persona}.sqlite")
        self.dek_in_ram.add(persona)


# ---------------------------------------------------------------------------
# Mock: Sharing Policy Manager (Architecture §9)
# ---------------------------------------------------------------------------

class MockSharingPolicyManager:
    """D2D sharing policy with security defaults and bulk updates."""

    DEFAULT_POLICY = {
        "presence": "eta_only",
        "availability": "free_busy",
        "context": "summary",
        "preferences": "full",
        "location": "none",
        "health": "none",
    }

    def __init__(self) -> None:
        self.contacts: dict[str, dict[str, Any]] = {}
        self.audit_log: list[dict[str, Any]] = []

    def add_contact(self, did: str, trust_level: str = "unverified",
                    policy: dict[str, str] | None = None) -> dict[str, Any]:
        contact = {
            "did": did,
            "trust_level": trust_level,
            "sharing_policy": policy if policy is not None else dict(self.DEFAULT_POLICY),
        }
        self.contacts[did] = contact
        return contact

    def get_policy(self, did: str) -> dict[str, str] | None:
        contact = self.contacts.get(did)
        return contact["sharing_policy"] if contact else None

    def egress_check(self, did: str, categories: dict[str, Any]) -> dict[str, Any]:
        """Check what data can be shared with a contact.

        Returns only categories allowed by sharing_policy.
        """
        policy = self.get_policy(did)
        if not policy:
            return {}

        allowed = {}
        for category, data in categories.items():
            rule = policy.get(category, "none")
            if rule != "none":
                # Validate data format — must be tiered dict, not raw string
                if isinstance(data, str):
                    # Malformed: raw string instead of {summary, full}
                    continue  # Drop silently
                allowed[category] = data

            self.audit_log.append({
                "contact": did,
                "category": category,
                "decision": "allowed" if rule != "none" else "denied",
                "reason": f"policy:{rule}",
                "timestamp": time.time(),
            })

        return allowed

    def bulk_update(self, filter_field: str, filter_value: str,
                    policy_update: dict[str, str]) -> int:
        """Bulk update policy for contacts matching filter."""
        updated = 0
        for did, contact in self.contacts.items():
            if contact.get(filter_field) == filter_value:
                contact["sharing_policy"].update(policy_update)
                updated += 1
        return updated

    def purge_audit_older_than(self, max_age_days: int = 90) -> int:
        """Purge audit entries older than max_age_days."""
        cutoff = time.time() - (max_age_days * 86400)
        before = len(self.audit_log)
        self.audit_log = [e for e in self.audit_log if e["timestamp"] > cutoff]
        return before - len(self.audit_log)


# ---------------------------------------------------------------------------
# Mock: Watchdog (Architecture §16)
# ---------------------------------------------------------------------------

class MockWatchdog:
    """Internal watchdog — checks health, injects Tier 2 notifications."""

    def __init__(self) -> None:
        self.checks: list[dict[str, Any]] = []
        self.notifications: list[dict[str, Any]] = []
        self.interval_seconds: int = 3600  # 1 hour

    def check(self, connector_healthy: bool = True,
              disk_usage_pct: float = 50.0,
              brain_healthy: bool = True) -> list[dict[str, Any]]:
        """Run watchdog checks. Returns list of breach notifications."""
        breaches = []
        if not connector_healthy:
            breaches.append({"level": "warning",
                             "text": "Connector liveness check failed"})
        if disk_usage_pct > 90.0:
            breaches.append({"level": "warning",
                             "text": f"Disk usage at {disk_usage_pct}%"})
        if not brain_healthy:
            breaches.append({"level": "warning",
                             "text": "Brain health check failed"})

        for breach in breaches:
            self.notifications.append({
                "type": "system",
                "tier": SilenceTier.TIER_2_SOLICITED,
                "payload": breach,
                "timestamp": time.time(),
            })
        self.checks.append({
            "connector": connector_healthy,
            "disk": disk_usage_pct,
            "brain": brain_healthy,
            "breaches": len(breaches),
        })
        return breaches


# ---------------------------------------------------------------------------
# Mock: WebSocket Session Manager (Architecture §17)
# ---------------------------------------------------------------------------

class MockWSSessionManager:
    """WebSocket session management — auth timeout, ping/pong, missed buffer."""

    AUTH_TIMEOUT_SECONDS = 5
    PING_INTERVAL_SECONDS = 30
    PONG_TIMEOUT_SECONDS = 10
    MAX_MISSED_PONGS = 3
    BUFFER_CAPACITY = 50
    BUFFER_TTL_SECONDS = 300  # 5 minutes

    def __init__(self) -> None:
        self.sessions: dict[str, dict[str, Any]] = {}

    def connect(self, device_id: str) -> str:
        """Accept WebSocket upgrade, start auth timer."""
        session_id = f"ws_{uuid.uuid4().hex[:8]}"
        self.sessions[session_id] = {
            "device_id": device_id,
            "authenticated": False,
            "auth_deadline": time.time() + self.AUTH_TIMEOUT_SECONDS,
            "missed_pongs": 0,
            "status": "connected",
            "buffer": [],
            "buffer_created_at": None,
        }
        return session_id

    def authenticate(self, session_id: str, token: str,
                     current_time: float | None = None) -> bool:
        """Authenticate with CLIENT_TOKEN within timeout."""
        now = current_time or time.time()
        session = self.sessions.get(session_id)
        if not session:
            return False
        if now > session["auth_deadline"]:
            session["status"] = "closed_auth_timeout"
            return False
        session["authenticated"] = True
        return True

    def ping(self, session_id: str) -> None:
        """Send ping to client."""
        pass  # Tracked by pong response

    def pong(self, session_id: str) -> None:
        """Receive pong from client."""
        session = self.sessions.get(session_id)
        if session:
            session["missed_pongs"] = 0

    def miss_pong(self, session_id: str) -> bool:
        """Record missed pong. Returns True if connection should close."""
        session = self.sessions.get(session_id)
        if not session:
            return True
        session["missed_pongs"] += 1
        if session["missed_pongs"] >= self.MAX_MISSED_PONGS:
            session["status"] = "closed_missed_pongs"
            return True
        return False

    def buffer_message(self, session_id: str, message: dict[str, Any]) -> bool:
        """Buffer message for disconnected client. Returns False if full."""
        session = self.sessions.get(session_id)
        if not session:
            return False
        if len(session["buffer"]) >= self.BUFFER_CAPACITY:
            return False  # Buffer full, drop message
        if not session["buffer"]:
            session["buffer_created_at"] = time.time()
        session["buffer"].append(message)
        return True

    def drain_buffer(self, session_id: str) -> list[dict[str, Any]]:
        """On reconnect, drain buffered messages."""
        session = self.sessions.get(session_id)
        if not session:
            return []
        messages = list(session["buffer"])
        session["buffer"].clear()
        session["buffer_created_at"] = None
        return messages

    def expire_buffer(self, session_id: str,
                      current_time: float | None = None) -> int:
        """Expire buffer after TTL. Returns count of expired messages."""
        now = current_time or time.time()
        session = self.sessions.get(session_id)
        if not session or not session["buffer_created_at"]:
            return 0
        if now - session["buffer_created_at"] > self.BUFFER_TTL_SECONDS:
            count = len(session["buffer"])
            session["buffer"].clear()
            session["buffer_created_at"] = None
            return count
        return 0

    def ack_message(self, session_id: str, msg_index: int) -> bool:
        """Client ACKs a specific buffered message."""
        session = self.sessions.get(session_id)
        if not session or msg_index >= len(session["buffer"]):
            return False
        session["buffer"].pop(msg_index)
        return True


# ---------------------------------------------------------------------------
# Mock: Reconnect Backoff (Architecture §17)
# ---------------------------------------------------------------------------

class MockReconnectBackoff:
    """Client-side exponential backoff: 1s → 2s → 4s → 8s → 16s → max 30s."""

    MAX_BACKOFF_SECONDS = 30

    def __init__(self) -> None:
        self.attempt: int = 0
        self.backoff_history: list[float] = []

    def next_backoff(self) -> float:
        delay = min(2 ** self.attempt, self.MAX_BACKOFF_SECONDS)
        self.backoff_history.append(delay)
        self.attempt += 1
        return delay

    def reset(self) -> None:
        self.attempt = 0
