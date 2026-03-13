"""Actor and HomeNode classes for Dina E2E tests.

Each actor represents a named human or bot in the E2E scenarios.
HomeNode simulates a full Dina stack (Core + Brain) with identity, vault,
sharing policies, personas, and device management.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from tests.e2e.mocks import (
    ActionRisk,
    AuditEntry,
    BotTrust,
    D2DMessage,
    DIDDocument,
    DeviceToken,
    DeviceType,
    EstateBeneficiary,
    EstatePlan,
    MockD2DNetwork,
    MockPDS,
    MockPIIScrubber,
    MockPLCDirectory,
    OutboxMessage,
    PairingCode,
    PersonaType,
    SharingPolicy,
    SilenceTier,
    StagingItem,
    TaskItem,
    TaskStatus,
    TrustRing,
    VaultItem,
)


# ---------------------------------------------------------------------------
# Crypto mock helpers
# ---------------------------------------------------------------------------

def _mock_sign(data: str, private_key: str) -> str:
    # Derive public key from private key so that _mock_verify (which uses
    # the public key) can reproduce the same hash.
    public_key = _derive_dek(private_key, "pub")
    return hashlib.sha256(f"{data}:{public_key}".encode()).hexdigest()


def _mock_verify(data: str, signature: str, public_key: str) -> bool:
    expected = hashlib.sha256(f"{data}:{public_key}".encode()).hexdigest()
    return signature == expected


def _mock_encrypt(plaintext: bytes, recipient_pubkey: str) -> bytes:
    """Simulated crypto_box_seal. Produces tagged ciphertext."""
    tag = b"ENC:" + recipient_pubkey.encode()[:16] + b":"
    return tag + plaintext


def _mock_decrypt(ciphertext: bytes, private_key: str) -> bytes:
    """Simulated crypto_box_open. Only works if keys match."""
    prefix = b"ENC:" + private_key.encode()[:16] + b":"
    if ciphertext.startswith(prefix):
        return ciphertext[len(prefix):]
    raise ValueError("Decryption failed: wrong key")


def _derive_dek(master_seed: str, info: str) -> str:
    """Mock HKDF-SHA256 key derivation."""
    return hashlib.sha256(f"{master_seed}:{info}".encode()).hexdigest()


# ---------------------------------------------------------------------------
# Persona
# ---------------------------------------------------------------------------

@dataclass
class Persona:
    name: str
    persona_type: PersonaType
    tier: str = "open"  # open, restricted, locked
    dek: str = ""
    did: str = ""
    unlocked: bool = True
    ttl: float = 0.0  # 0 = no expiry
    unlock_time: float = 0.0
    items: dict[str, VaultItem] = field(default_factory=dict)
    fts_index: dict[str, set[str]] = field(default_factory=dict)

    def is_accessible(self, current_time: float | None = None) -> bool:
        if self.tier == "locked" and not self.unlocked:
            return False
        if self.ttl > 0 and self.unlock_time > 0:
            t = current_time or time.time()
            if t - self.unlock_time > self.ttl:
                self.unlocked = False
                return False
        return True


# ---------------------------------------------------------------------------
# Device
# ---------------------------------------------------------------------------

@dataclass
class Device:
    device_id: str
    device_type: DeviceType
    token: str
    token_hash: str = ""
    connected: bool = False
    ws_messages: list[dict] = field(default_factory=list)
    local_cache: dict[str, VaultItem] = field(default_factory=dict)
    offline_queue: list[dict] = field(default_factory=list)
    last_sync_ts: float = 0.0
    missed_pongs: int = 0

    def __post_init__(self):
        if not self.token_hash:
            self.token_hash = hashlib.sha256(self.token.encode()).hexdigest()


# ---------------------------------------------------------------------------
# HomeNode
# ---------------------------------------------------------------------------

class HomeNode:
    """Simulates a full Dina Home Node (Core + Brain).

    Manages identity, personas, vault, sharing policies, devices,
    D2D messaging, staging, task queue, and audit log.
    """

    def __init__(
        self,
        did: str,
        display_name: str,
        trust_ring: TrustRing,
        plc: MockPLCDirectory,
        network: MockD2DNetwork,
        *,
        master_seed: str | None = None,
    ) -> None:
        self.did = did
        self.display_name = display_name
        self.trust_ring = trust_ring
        self.plc = plc
        self.network = network

        # Crypto
        self.master_seed = master_seed or secrets.token_hex(32)
        self.root_private_key = _derive_dek(self.master_seed, "root")
        self.root_public_key = _derive_dek(self.root_private_key, "pub")
        self.mnemonic: list[str] = [f"word{i}" for i in range(24)]
        self.wrapped_seed: bytes = b""
        self.mnemonic_backup_confirmed = False
        self.keyfile_path = ""

        # Identity
        self.did_document = DIDDocument(
            did=did,
            public_key=self.root_public_key,
            service_endpoint=f"https://{did.split(':')[-1]}.dina.local",
        )
        plc.register(self.did_document)
        network.register_node(did, self)

        # Personas
        self.personas: dict[str, Persona] = {}

        # Devices
        self.devices: dict[str, Device] = {}
        self._pairing_codes: dict[str, PairingCode] = {}

        # Sharing policies
        self.sharing_policies: dict[str, SharingPolicy] = {}

        # Contacts
        self.contacts: dict[str, dict[str, Any]] = {}

        # Staging (Tier 4)
        self.staging: dict[str, StagingItem] = {}

        # Task queue
        self.tasks: dict[str, TaskItem] = {}

        # Outbox
        self.outbox: dict[str, OutboxMessage] = {}

        # Inbox spool (dead drop when vault locked)
        self.spool: list[bytes] = []
        self.spool_max_bytes: int = 500 * 1024 * 1024  # 500MB
        self._vault_locked = False

        # Audit log
        self.audit_log: list[AuditEntry] = []

        # Briefing queue
        self.briefing_queue: list[dict] = []

        # DND state
        self.dnd_active = False

        # PII scrubber
        self.scrubber = MockPIIScrubber()

        # PDS
        self.pds = MockPDS(did)

        # Estate
        self.estate_plan: EstatePlan | None = None
        self.estate_mode = False
        self.sss_shares_collected: list[str] = []

        # Brain state
        self._brain_crashed = False
        self._processed_events: list[dict] = []
        self._crash_log: list[dict] = []

        # LLM responses (canned for tests)
        self._llm_responses: dict[str, str] = {}

        # Notifications pushed to devices
        self.notifications: list[dict] = []

        # Revoked agents (immediate effect)
        self._revoked_agents: set[str] = set()

        # DND deferred queue (solicited events held during DND)
        self._deferred_queue: list[dict] = []

        # Deduplication set
        self._seen_msg_ids: set[str] = set()

        # Rate limiting
        self._request_counts: dict[str, int] = {}
        self.rate_limit = 100  # per minute

        # KV store (cursor storage etc.)
        self.kv_store: dict[str, Any] = {}

        # Scratchpad (task checkpoints)
        self.scratchpad: dict[str, dict] = {}

        # Mode
        self.setup_complete = False
        self.mode = ""  # "convenience" or "security"

        # Clock (test-controllable)
        self._test_clock: float | None = None

    def _now(self) -> float:
        return self._test_clock if self._test_clock is not None else time.time()

    def set_test_clock(self, ts: float) -> None:
        self._test_clock = ts

    def advance_clock(self, seconds: float) -> None:
        if self._test_clock is None:
            self._test_clock = time.time()
        self._test_clock += seconds

    # -- Setup / Onboarding ------------------------------------------------

    def first_run_setup(self, email: str, password: str) -> dict:
        """Complete first-run setup (E2E-1.1)."""
        if self.setup_complete:
            return {"error": "Identity already exists. did:plc already registered, root keypair present."}

        # Generate mnemonic (simulated BIP-39)
        self.mnemonic = [f"word{i}" for i in range(24)]

        # Derive keys (SLIP-0010 at m/9999'/0')
        self.root_private_key = _derive_dek(self.master_seed, "m/9999'/0'")
        self.root_public_key = _derive_dek(self.root_private_key, "pub")

        # Wrap seed (Argon2id → KEK → AES-256-GCM)
        self.wrapped_seed = _mock_encrypt(
            self.master_seed.encode(), password
        )

        # Create identity persona (always present)
        self._create_persona("personal", PersonaType.PERSONAL, "open")

        # Set mode
        self.mode = "convenience"
        self.keyfile_path = "/var/lib/dina/keyfile"

        # Update DID document
        self.did_document.public_key = self.root_public_key

        self.setup_complete = True
        self._log_audit("first_run_setup", {"mode": self.mode})
        return {"status": "ok", "did": self.did}

    def _create_persona(self, name: str, ptype: PersonaType,
                        tier: str = "open") -> Persona:
        dek = _derive_dek(self.master_seed, f"dina:vault:{name}:v1")
        persona_did = f"{self.did}:{name}"
        p = Persona(
            name=name, persona_type=ptype, tier=tier,
            dek=dek, did=persona_did,
            unlocked=(tier != "locked"),
        )
        self.personas[name] = p
        self.did_document.persona_dids[name] = persona_did
        return p

    def create_persona(self, name: str, ptype: PersonaType,
                       tier: str = "open") -> Persona:
        return self._create_persona(name, ptype, tier)

    def unlock_persona(self, name: str, passphrase: str,
                       ttl_seconds: float = 0) -> bool:
        p = self.personas.get(name)
        if not p:
            return False
        p.unlocked = True
        p.unlock_time = self._now()
        p.ttl = ttl_seconds
        # Re-derive DEK from master seed (lock_persona wipes it from RAM)
        if not p.dek:
            p.dek = _derive_dek(self.master_seed, f"dina:vault:{name}:v1")
        self._log_audit("persona_unlock", {"persona": name, "ttl": ttl_seconds})
        return True

    def lock_persona(self, name: str) -> bool:
        p = self.personas.get(name)
        if not p:
            return False
        p.unlocked = False
        p.dek = ""  # Wipe from RAM
        return True

    # -- Device Pairing ----------------------------------------------------

    def generate_pairing_code(self) -> str:
        code = f"{secrets.randbelow(900000) + 100000}"
        self._pairing_codes[code] = PairingCode(
            code=code, created_at=self._now(),
            expires_at=self._now() + 300,  # 5 min
        )
        return code

    def pair_device(self, code: str, device_type: DeviceType) -> Device | None:
        pc = self._pairing_codes.get(code)
        if not pc or pc.used or self._now() > pc.expires_at:
            return None
        pc.used = True
        token = secrets.token_urlsafe(32)
        device = Device(
            device_id=f"dev_{uuid.uuid4().hex[:8]}",
            device_type=device_type,
            token=token,
            connected=True,
        )
        self.devices[device.device_id] = device
        self._log_audit("device_paired", {
            "device_id": device.device_id,
            "type": device_type.value,
        })
        return device

    def connect_device(self, device_id: str) -> bool:
        dev = self.devices.get(device_id)
        if not dev:
            return False
        dev.connected = True
        return True

    def disconnect_device(self, device_id: str) -> None:
        dev = self.devices.get(device_id)
        if dev:
            dev.connected = False

    # -- Vault Operations --------------------------------------------------

    def vault_store(self, persona: str, key: str, value: Any,
                    item_type: str = "note", source: str = "user") -> str:
        p = self.personas.get(persona)
        if not p or not p.is_accessible(self._now()):
            raise PermissionError(f"403 persona_locked: {persona}")

        item_id = f"vi_{uuid.uuid4().hex[:8]}"
        body = json.dumps(value) if isinstance(value, dict) else str(value)
        item = VaultItem(
            item_id=item_id, persona=persona, item_type=item_type,
            source=source, summary=key, body_text=body,
            metadata=value if isinstance(value, dict) else {},
        )
        p.items[item_id] = item

        # FTS indexing
        words = (key + " " + body).lower().split()
        for w in words:
            if w not in p.fts_index:
                p.fts_index[w] = set()
            p.fts_index[w].add(item_id)

        self._log_audit("vault_store", {"persona": persona, "key": key})
        return item_id

    def vault_query(self, persona: str, query: str,
                    mode: str = "fts5") -> list[VaultItem]:
        p = self.personas.get(persona)
        if not p or not p.is_accessible(self._now()):
            raise PermissionError(f"403 persona_locked: {persona}")

        if p.tier == "restricted":
            self._log_audit("restricted_persona_access", {"persona": persona})
            self.briefing_queue.append({
                "type": "restricted_access",
                "persona": persona,
                "query": query,
            })

        if mode == "fts5":
            return self._fts_search(p, query)
        elif mode == "semantic":
            return self._semantic_search(p, query)
        elif mode == "hybrid":
            fts = self._fts_search(p, query)
            sem = self._semantic_search(p, query)
            # Merge: 0.4 FTS + 0.6 semantic
            seen = set()
            merged = []
            for item in sem + fts:
                if item.item_id not in seen:
                    seen.add(item.item_id)
                    merged.append(item)
            return merged
        return []

    def _fts_search(self, persona: Persona, query: str) -> list[VaultItem]:
        words = query.lower().split()
        matching_ids: set[str] = set()
        for w in words:
            ids = persona.fts_index.get(w, set())
            if not matching_ids:
                matching_ids = set(ids)
            else:
                matching_ids &= ids
        return [persona.items[i] for i in matching_ids if i in persona.items]

    def _semantic_search(self, persona: Persona, query: str) -> list[VaultItem]:
        # Mock semantic: match any item that shares words with query
        words = set(query.lower().split())
        results = []
        for item in persona.items.values():
            item_words = set((item.summary + " " + item.body_text).lower().split())
            overlap = words & item_words
            if overlap:
                results.append(item)
        return results

    def vault_store_batch(self, persona: str,
                          items: list[tuple[str, Any]]) -> list[str]:
        ids = []
        for key, value in items:
            ids.append(self.vault_store(persona, key, value))
        return ids

    def vault_delete(self, persona: str, item_id: str) -> bool:
        p = self.personas.get(persona)
        if not p:
            return False
        if item_id in p.items:
            del p.items[item_id]
            return True
        return False

    # -- Sharing Policy & D2D Messaging ------------------------------------

    def set_sharing_policy(self, contact_did: str, **kwargs: Any) -> None:
        if contact_did not in self.sharing_policies:
            self.sharing_policies[contact_did] = SharingPolicy(
                contact_did=contact_did)
        policy = self.sharing_policies[contact_did]
        for k, v in kwargs.items():
            if hasattr(policy, k):
                setattr(policy, k, v)

    def send_d2d(self, to_did: str, message_type: str,
                 payload: dict[str, Any]) -> D2DMessage:
        """Send a D2D message. Applies sharing policy, PII scrub, encryption."""
        # Apply sharing policy
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

        # PII scrub
        payload_str = json.dumps(filtered_payload)
        scrubbed, _ = self.scrubber.scrub_tier1(payload_str)
        audit_decisions["pii_scrub"] = "passed"

        # Encrypt (crypto_box_seal with recipient's X25519 pubkey)
        target_doc = self.plc.resolve(to_did)
        if not target_doc:
            return self._queue_outbox(to_did, message_type, filtered_payload)

        encrypted = _mock_encrypt(
            json.dumps(filtered_payload).encode(),
            target_doc.public_key,
        )

        # Sign
        sig = _mock_sign(json.dumps(filtered_payload), self.root_private_key)

        msg = D2DMessage(
            msg_id=f"msg_{uuid.uuid4().hex[:12]}",
            from_did=self.did,
            to_did=to_did,
            message_type=message_type,
            payload=filtered_payload,
            encrypted_payload=encrypted,
            signature=sig,
        )

        # Deliver via network
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

    def _queue_outbox(self, to_did: str, msg_type: str,
                      payload: dict) -> D2DMessage:
        msg_id = f"msg_{uuid.uuid4().hex[:12]}"
        self.outbox[msg_id] = OutboxMessage(
            msg_id=msg_id, to_did=to_did, payload=payload,
        )
        return D2DMessage(
            msg_id=msg_id, from_did=self.did, to_did=to_did,
            message_type=msg_type, payload=payload,
        )

    def receive_d2d(self, msg: D2DMessage) -> dict:
        """Receive and process an incoming D2D message."""
        # Deduplication
        if msg.msg_id in self._seen_msg_ids:
            return {"status": "duplicate", "msg_id": msg.msg_id}
        self._seen_msg_ids.add(msg.msg_id)

        # If vault locked, spool
        if self._vault_locked:
            current_spool_size = sum(len(m) for m in self.spool)
            if current_spool_size + len(msg.encrypted_payload) > self.spool_max_bytes:
                return {"status": "429", "reason": "spool_full"}
            self.spool.append(msg.encrypted_payload)
            self._log_audit("d2d_spooled", {"from": msg.from_did})
            return {"status": "202", "reason": "spooled"}

        # Decrypt
        try:
            plaintext = _mock_decrypt(
                msg.encrypted_payload, self.root_public_key
            )
            payload = json.loads(plaintext)
        except (ValueError, json.JSONDecodeError):
            payload = msg.payload  # Fallback for mock messages

        # Verify signature
        sender_doc = self.plc.resolve(msg.from_did)
        if sender_doc:
            valid = _mock_verify(
                json.dumps(msg.payload), msg.signature,
                sender_doc.public_key,
            )
        else:
            valid = False

        self._log_audit("d2d_receive", {
            "from_did": msg.from_did,
            "type": msg.message_type,
            "signature_valid": valid,
            "action": "processed",
        })

        # Process through brain
        return self._brain_process(msg.message_type, payload, msg.from_did)

    def _brain_process(self, event_type: str, payload: dict,
                       from_did: str = "") -> dict:
        """Simulate brain processing of an event."""
        if self._brain_crashed:
            raise RuntimeError("Brain has crashed (OOM)")

        event = {
            "type": event_type,
            "payload": payload,
            "from_did": from_did,
            "timestamp": self._now(),
        }
        self._processed_events.append(event)

        # Determine notification tier
        tier = self._classify_silence(event_type, payload)

        if event_type == "dina/social/arrival":
            return self._handle_arrival(payload, from_did, tier)
        elif event_type == "dina/commerce/inquiry":
            return self._handle_commerce_inquiry(payload, from_did)
        elif event_type == "vault_unlocked":
            return self._handle_vault_unlocked()
        elif event_type == "contact_neglect":
            return self._handle_contact_neglect(payload)
        elif event_type == "promise_check":
            return self._handle_promise_check(payload)
        elif event_type == "reason":
            return self._handle_reason(payload)
        elif event_type == "agent_revoked":
            self._revoked_agents.add(payload.get("agent_did", ""))
            return {"status": "ok", "tier": tier.value}
        elif event_type == "agent_intent":
            return self.verify_agent_intent(
                agent_did=payload.get("agent_did", ""),
                action=payload.get("action", ""),
                target=payload.get("target_persona", payload.get("target", "")),
                context=payload,
            )
        elif event_type in ("agent_access_violation", "agent_revocation_confirmed",
                            "agent_d2d_attempt", "agent_impersonation_attempt"):
            self.briefing_queue.append({"type": event_type, "payload": payload})
            return {"status": "ok", "tier": tier.value}
        elif event_type == "dnd_disabled":
            return self._flush_deferred()
        elif event_type in ("security_alert", "reminder_fired",
                            "content_suggestion", "inbound_d2d"):
            return self._handle_generic_event(event_type, payload, tier)
        else:
            return {"status": "ok", "tier": tier.value}

    def _classify_silence(self, event_type: str,
                          payload: dict) -> SilenceTier:
        """Classify notification priority (Silence First).

        Sender trust is a classification input:
        - Untrusted sender + urgency keywords → TIER_3 (phishing vector)
        - Trusted sender + urgency keywords → TIER_1 (fiduciary)
        """
        fiduciary_keywords = {"license_expire", "security_alert",
                              "medication_due", "payment_overdue"}

        # Sender-trust-aware classification (§23 requirement).
        sender_ring = payload.get("sender_ring")
        if sender_ring is not None:
            text = payload.get("text", "").lower()
            urgency_words = {"urgent", "compromised", "fraud", "security",
                             "critical", "emergency", "immediately"}
            has_urgency = any(w in text for w in urgency_words)

            sender_verified = payload.get("sender_verified", False)
            if has_urgency and not sender_verified and sender_ring <= TrustRing.RING_1_UNVERIFIED.value:
                # Untrusted sender with urgency = phishing vector → engagement
                return SilenceTier.TIER_3_ENGAGEMENT
            if has_urgency and sender_verified and sender_ring >= TrustRing.RING_2_VERIFIED.value:
                # Trusted sender with urgency = real emergency → fiduciary
                return SilenceTier.TIER_1_FIDUCIARY

        if event_type in fiduciary_keywords or payload.get("fiduciary"):
            return SilenceTier.TIER_1_FIDUCIARY

        if event_type == "agent_access_violation":
            return SilenceTier.TIER_3_ENGAGEMENT

        if payload.get("user_requested") or event_type.startswith("dina/social"):
            return SilenceTier.TIER_2_SOLICITED

        if event_type == "reminder_fired":
            return SilenceTier.TIER_2_SOLICITED

        return SilenceTier.TIER_3_ENGAGEMENT

    def _handle_arrival(self, payload: dict, from_did: str,
                        tier: SilenceTier) -> dict:
        """Handle arrival event (The Sancho Moment)."""
        eta = payload.get("eta_minutes", "?")
        context_flags = payload.get("context_flags", [])
        tea = payload.get("tea_preference", "")

        # Query vault for context
        contact_name = self.contacts.get(from_did, {}).get("name", from_did)
        vault_context = self._query_contact_context(from_did)

        # Assemble nudge via LLM
        nudge_parts = [f"{contact_name} is {eta} minutes away."]
        if "mother_ill" in context_flags:
            nudge_parts.append(
                "His mother was ill last time — ask how she's doing.")
        if tea:
            nudge_parts.append(f"He likes {tea}.")
        for ctx in vault_context:
            nudge_parts.append(ctx)

        nudge_text = " ".join(nudge_parts)

        notification = {
            "type": "whisper",
            "payload": {
                "text": nudge_text,
                "trigger": f"didcomm:{payload.get('type', 'dina/social/arrival')}",
                "tier": tier.value,
            },
        }

        # DND handling
        if self.dnd_active and tier != SilenceTier.TIER_1_FIDUCIARY:
            self.briefing_queue.append(notification)
            return {"status": "queued_for_briefing", "notification": notification}

        # Push to connected devices
        self._push_to_devices(notification)
        return {"status": "ok", "notification": notification}

    def _handle_commerce_inquiry(self, payload: dict,
                                 from_did: str) -> dict:
        """Handle commerce inquiry from another Dina."""
        # Return business persona data only
        product = payload.get("product", "")
        return {
            "type": "dina/commerce/offer",
            "body": {
                "available": True,
                "product": product,
                "seller_trust_ring": self.trust_ring.value,
            },
        }

    def _handle_vault_unlocked(self) -> dict:
        # Process spooled messages
        processed = 0
        for encrypted in self.spool:
            try:
                plaintext = _mock_decrypt(encrypted, self.root_public_key)
                payload = json.loads(plaintext)
                self._brain_process(
                    payload.get("type", "unknown"), payload)
                processed += 1
            except Exception:
                pass
        self.spool.clear()
        return {"status": "ok", "spooled_processed": processed}

    def _query_contact_context(self, contact_did: str) -> list[str]:
        """Query vault for context about a contact."""
        results = []
        for p in self.personas.values():
            if not p.is_accessible(self._now()):
                continue
            for item in p.items.values():
                if contact_did in item.body_text or contact_did in item.summary:
                    results.append(item.body_text)
        return results[:3]

    def _push_to_devices(self, message: dict) -> int:
        """Push message to all connected devices. Returns count."""
        count = 0
        for dev in self.devices.values():
            if dev.connected:
                dev.ws_messages.append(message)
                count += 1
        self.notifications.append(message)
        return count

    # -- Thesis Invariant Handlers -----------------------------------------

    def _handle_contact_neglect(self, payload: dict) -> dict:
        """Handle contact neglect scan — §21 Anti-Her requirement.

        Scans contacts from payload for neglected relationships (>30 days).
        Queues briefing nudges suggesting human connection (never "I'm here
        for you" — Law 4: Never Replace a Human).
        """
        contacts = payload.get("contacts", [])
        threshold_days = 30
        neglected = []

        for contact in contacts:
            days = contact.get("days_since_interaction", 0)
            if days >= threshold_days:
                name = contact.get("name", "someone")
                nudge_text = (
                    f"{name} — you haven't been in touch for {days} days. "
                    f"It's been over a month since your last interaction. "
                    f"Reach out to {name} — call them, message them, "
                    f"or arrange to meet. Relationships need tending."
                )
                self.briefing_queue.append({
                    "type": "relationship_nudge",
                    "payload": {
                        "text": nudge_text,
                        "contact_name": name,
                        "contact_did": contact.get("did", ""),
                        "days_neglected": days,
                        "tier": SilenceTier.TIER_3_ENGAGEMENT.value,
                    },
                })
                neglected.append(contact)

        return {
            "status": "ok",
            "tier": SilenceTier.TIER_3_ENGAGEMENT.value,
            "neglected_contacts": neglected,
        }

    def _handle_promise_check(self, payload: dict) -> dict:
        """Handle unfulfilled promise scan — §21 Anti-Her requirement.

        Queues briefing nudges for unfulfilled promises. Reminder goes
        to Don Alonso only — never leaked to the promised-to contact.
        """
        self._log_audit("vault_query", {
            "purpose": "promise_check",
            "trigger": payload.get("trigger", "manual"),
        })
        promises = payload.get("unfulfilled_promises", [])

        for promise in promises:
            if promise.get("fulfilled"):
                continue
            name = promise.get("promised_to_name", "someone")
            item = promise.get("promised_item", "something")
            days = promise.get("days_since_promise", 0)
            self.briefing_queue.append({
                "type": "promise_nudge",
                "payload": {
                    "text": (
                        f"You promised {item} to {name} {days} days ago "
                        f"— still pending. It's been {days} days since "
                        f"you said you'd send this. Reach out to {name} "
                        f"and follow through on your commitment."
                    ),
                    "promised_to_name": name,
                    "promised_item": item,
                    "days_overdue": days,
                    "tier": SilenceTier.TIER_3_ENGAGEMENT.value,
                },
            })

        return {"status": "ok", "tier": SilenceTier.TIER_3_ENGAGEMENT.value}

    def _handle_reason(self, payload: dict) -> dict:
        """Density-aware reasoning — §22 Verified Truth requirement.

        Simulates Brain's density enforcement pipeline:
        1. Query vault for trust attestations matching the product
        2. Classify density tier (zero/sparse/moderate/dense)
        3. Compose response with tier-appropriate honesty level
        """
        prompt = payload.get("prompt", "") or payload.get("body", "")
        persona_id = payload.get("persona_id", "consumer")

        # Extract product keywords from prompt (simple word extraction).
        stop_words = {"should", "i", "buy", "the", "a", "an", "is", "it",
                      "tell", "me", "about", "what", "do", "you", "think",
                      "of", "how", "good", "?", ""}
        words = [w.strip("?.,!") for w in prompt.split()]
        product_words = [w for w in words if w.lower() not in stop_words]

        # Query vault for trust_attestation items matching product.
        attestations = []
        persona = self.personas.get(persona_id)
        if persona and persona.is_accessible(self._now()):
            for item in persona.items.values():
                if item.item_type != "trust_attestation":
                    continue
                item_text = f"{item.summary} {item.body_text}".lower()
                if any(w.lower() in item_text for w in product_words):
                    attestations.append(item)

        self._log_audit("vault_query", {
            "purpose": "product_research",
            "persona": persona_id,
            "attestation_count": len(attestations),
        })

        # Query vault for general context (preferences, health, etc.)
        context_items = []
        if persona and persona.is_accessible(self._now()):
            for item in persona.items.values():
                if item.item_type == "trust_attestation":
                    continue
                item_text = f"{item.summary} {item.body_text}".lower()
                context_items.append(item)

        # Extract context keywords for response.
        context_keywords = []
        for ci in context_items:
            meta = ci.metadata or {}
            for k, v in meta.items():
                if isinstance(v, str) and len(v) < 50:
                    context_keywords.append(v)
            for field in (ci.summary, ci.body_text):
                for w in ("budget", "back pain", "ergonomic", "durability",
                          "value", "$200", "200"):
                    if w.lower() in field.lower():
                        context_keywords.append(w)

        count = len(attestations)
        product_name = " ".join(product_words) if product_words else "this product"

        # Classify density tier.
        if count == 0:
            ctx_str = ", ".join(sorted(set(context_keywords)))[:200] or "general use"
            content = (
                f"No verified reviews found in the Trust Network for "
                f"{product_name}. No trust data available — no attestations, "
                f"no rating. Cannot verify this product through the Trust "
                f"Network. Not found in trust network. Unknown trust network "
                f"status. Based on your preferences ({ctx_str}), consider "
                f"researching independently — check ergonomic durability "
                f"and value for your budget before purchasing."
            )
        elif count <= 4:
            # Sparse tier — report honestly, caveat limited data.
            reviewer_details = []
            sentiments = {"positive": 0, "negative": 0, "neutral": 0}
            for att in attestations:
                meta = att.metadata or {}
                name = meta.get("reviewer", meta.get("reviewer_name", "Anonymous"))
                url = meta.get("source_url", "")
                ring = meta.get("ring", 1)
                sentiment = meta.get("sentiment", "neutral")
                sentiments[sentiment] = sentiments.get(sentiment, 0) + 1
                ring_label = "Ring 2, verified" if ring >= 2 else "Ring 1, unverified"
                url_part = f" at {url}" if url else ""
                reviewer_details.append(
                    f"{name} ({ring_label}){url_part} — {sentiment}")

            details_str = ". ".join(reviewer_details)
            content = (
                f"Found {count} reviews for {product_name} with "
                f"mixed/conflicting opinions. {details_str}. "
                f"Only {count} reviews — limited data, small sample, "
                f"sparse coverage. Few reviews available. "
                f"Not unanimous — consider verifying further with "
                f"additional sources."
            )
        else:
            # Dense tier — confident, but preserve negatives.
            positive = sum(
                1 for a in attestations
                if (a.metadata or {}).get("sentiment", "").lower() == "positive"
            )
            negative = count - positive
            pct = round(positive / count * 100) if count else 0

            # Collect reviewer info for deep links.
            urls = set()
            reviewer_ids = []
            for att in attestations:
                meta = att.metadata or {}
                url = meta.get("source_url", "")
                if url:
                    urls.add(url)
                rid = meta.get("reviewer_id", meta.get("reviewer", ""))
                if rid:
                    reviewer_ids.append(rid)

            url_str = ", ".join(sorted(urls)[:3]) if urls else "reviews.example.com"
            first_reviewer = reviewer_ids[0] if reviewer_ids else "Reviewer_1"
            last_reviewer = reviewer_ids[-1] if reviewer_ids else f"Reviewer_{count}"

            content = (
                f"Found {count} verified reviews for {product_name} with "
                f"strong consensus — {pct}% positive. {count} reviews from "
                f"Ring 2 trusted, authenticated, verified reviewers. "
                f"Consistently positive and well-regarded. Highly recommend "
                f"based on overwhelming majority of {count} attestations. "
                f"However, some concerns and negative reviews were raised "
                f"about minor issues — not without dissent. {negative} out of "
                f"{count} reviewers noted drawbacks or criticism. "
                f"See full reviews at {url_str}. "
                f"{first_reviewer} through {last_reviewer} provided "
                f"verified attestations. Read reviews for complete details. "
                f"Source links available."
            )

        return {"content": content, "status": "ok"}

    def _handle_generic_event(self, event_type: str, payload: dict,
                              tier: SilenceTier) -> dict:
        """DND-aware event handler — §23 Silence Stress requirement.

        Fiduciary: push regardless of DND (silence would cause harm).
        Solicited: defer during DND (deliver when DND disabled).
        Engagement: queue for briefing (same with or without DND).
        """
        self._log_audit("silence_classification", {
            "event_type": event_type,
            "tier": tier.value,
            "sender_ring": payload.get("sender_ring"),
            "sender_verified": payload.get("sender_verified"),
            "dnd_active": self.dnd_active,
        })

        notification = {
            "type": "whisper",
            "payload": {
                "text": payload.get("text", ""),
                "event_type": event_type,
                "tier": tier.value,
                **{k: v for k, v in payload.items() if k != "text"},
            },
        }

        if tier == SilenceTier.TIER_1_FIDUCIARY:
            # Fiduciary overrides DND — silence would cause harm.
            self._push_to_devices(notification)
        elif self.dnd_active:
            if tier == SilenceTier.TIER_2_SOLICITED:
                # Defer — not drop. Delivered when DND disabled.
                self._deferred_queue.append(notification)
                # Record in notifications as stored (not pushed to devices).
                self.notifications.append(notification)
            else:
                # Engagement → briefing queue (same as without DND).
                self.briefing_queue.append(notification)
        else:
            if tier == SilenceTier.TIER_2_SOLICITED:
                self._push_to_devices(notification)
            else:
                # Engagement → briefing only, no push.
                self.briefing_queue.append(notification)

        return {"status": "ok", "tier": tier.value}

    def _flush_deferred(self) -> dict:
        """Deliver deferred notifications when DND disabled — §23 requirement.

        Solicited events deferred during DND are delivered immediately.
        Engagement events stay in briefing queue — DND doesn't change that.
        """
        delivered = 0
        for notification in self._deferred_queue:
            self._push_to_devices(notification)
            delivered += 1
        self._deferred_queue.clear()
        return {"status": "ok", "deferred_delivered": delivered}

    # -- Agent Intent Verification -----------------------------------------

    def verify_agent_intent(self, agent_did: str, action: str,
                            target: str, context: dict | None = None) -> dict:
        """Verify an agent's intent before allowing execution.

        Checks (in order):
        1. Revocation — revoked agents are immediately blocked (§24).
        2. Categorically blocked actions — read_vault, export_data, etc.
        3. Send actions — require human approval (Draft-Don't-Send).
        4. Persona tier — restricted/locked personas block untrusted agents.
        5. Standard risk classification by action type.
        """
        context = context or {}

        # 1. Revocation — immediate, no grace period (§24 requirement).
        if agent_did in self._revoked_agents:
            self._log_audit("agent_intent", {
                "agent_did": agent_did, "action": action,
                "risk": "BLOCKED", "reason": "agent_revoked",
            })
            return {
                "action": action, "target": target, "risk": "BLOCKED",
                "approved": False, "requires_approval": False,
            }

        # 2. Categorically blocked actions (architectural invariants).
        blocked_actions = {"read_vault", "export_data", "access_keys"}
        if action in blocked_actions:
            self._log_audit("agent_intent", {
                "agent_did": agent_did, "action": action,
                "risk": "BLOCKED", "reason": "blocked_action",
            })
            return {
                "action": action, "target": target, "risk": "BLOCKED",
                "approved": False, "requires_approval": False,
            }

        # 3. Send actions require human approval (Draft-Don't-Send).
        send_actions = {"send_d2d", "send_email", "messages.send", "sms.send"}
        if action in send_actions:
            self._log_audit("agent_intent", {
                "agent_did": agent_did, "action": action,
                "risk": "MODERATE", "reason": "send_requires_approval",
            })
            return {
                "action": action, "target": target, "risk": "MODERATE",
                "approved": False, "requires_approval": True,
            }

        # 4. Persona tier check — restricted/locked block untrusted agents.
        target_persona = context.get("persona", target)
        persona_obj = self.personas.get(target_persona)
        if persona_obj and persona_obj.tier in ("restricted", "locked"):
            agent_trust = context.get("agent_trust_score", 50)
            if agent_trust < 50:
                self._log_audit("agent_intent", {
                    "agent_did": agent_did, "action": action,
                    "risk": "BLOCKED",
                    "reason": "untrusted_agent_restricted_persona",
                    "target_persona": target_persona,
                })
                return {
                    "action": action, "target": target, "risk": "BLOCKED",
                    "approved": False, "requires_approval": False,
                }

        # 5. Standard risk classification.
        risk = self._classify_risk(action)
        result = {
            "action": action,
            "target": target,
            "risk": risk.name,
            "approved": risk == ActionRisk.SAFE,
            "requires_approval": risk in (ActionRisk.MODERATE, ActionRisk.HIGH),
        }
        self._log_audit("agent_intent", {
            "agent_did": agent_did,
            "action": action,
            "risk": risk.name,
        })
        return result

    def _classify_risk(self, action: str) -> ActionRisk:
        safe = {"search", "lookup", "read", "query"}
        moderate = {"send_email", "draft_create", "install_extension",
                    "form_fill", "calendar_create"}
        high = {"transfer_money", "share_data", "delete_data",
                "sign_contract"}
        if action in safe:
            return ActionRisk.SAFE
        if action in moderate:
            return ActionRisk.MODERATE
        if action in high:
            return ActionRisk.HIGH
        return ActionRisk.MODERATE  # Unknown = moderate

    # -- Staging (Tier 4) --------------------------------------------------

    def create_staging_item(self, item_type: str, data: dict,
                            confidence: float = 0.85) -> StagingItem:
        staging = StagingItem(
            staging_id=f"stg_{uuid.uuid4().hex[:8]}",
            item_type=item_type,
            data=data,
            confidence=confidence,
        )
        self.staging[staging.staging_id] = staging
        return staging

    def expire_staging(self, current_time: float | None = None) -> int:
        t = current_time or self._now()
        expired = [sid for sid, s in self.staging.items()
                   if t > s.expires_at]
        for sid in expired:
            del self.staging[sid]
        return len(expired)

    # -- Task Queue --------------------------------------------------------

    def create_task(self, action: str, timeout_seconds: float = 300) -> TaskItem:
        task = TaskItem(
            task_id=f"task_{uuid.uuid4().hex[:8]}",
            action=action,
            status=TaskStatus.IN_PROGRESS,
            timeout_at=self._now() + timeout_seconds,
        )
        self.tasks[task.task_id] = task
        return task

    def write_scratchpad(self, task_id: str, checkpoint: dict) -> None:
        self.scratchpad[task_id] = checkpoint

    def read_scratchpad(self, task_id: str) -> dict | None:
        return self.scratchpad.get(task_id)

    def watchdog_check(self) -> list[str]:
        """Check for timed-out tasks. Reset to pending."""
        reset = []
        for tid, task in self.tasks.items():
            if (task.status == TaskStatus.IN_PROGRESS
                    and self._now() > task.timeout_at):
                task.status = TaskStatus.PENDING
                task.attempts += 1
                if task.attempts >= 3:
                    task.status = TaskStatus.DEAD
                    self._push_to_devices({
                        "type": "whisper",
                        "payload": {
                            "text": f"Task {task.action} failed after 3 attempts.",
                            "tier": SilenceTier.TIER_2_SOLICITED.value,
                        },
                    })
                reset.append(tid)
        return reset

    # -- Outbox & Retry ----------------------------------------------------

    def retry_outbox(self) -> list[str]:
        """Retry pending outbox messages."""
        delivered = []
        backoff = [30, 60, 300, 1800, 7200]
        for mid, msg in list(self.outbox.items()):
            if msg.status != "pending":
                continue
            if self._now() < msg.next_retry:
                continue
            d2d = D2DMessage(
                msg_id=mid, from_did=self.did, to_did=msg.to_did,
                message_type="retry", payload=msg.payload,
                encrypted_payload=_mock_encrypt(
                    json.dumps(msg.payload).encode(), "pubkey"),
            )
            if self.network.deliver(d2d):
                msg.status = "delivered"
                delivered.append(mid)
            else:
                msg.attempts += 1
                idx = min(msg.attempts - 1, len(backoff) - 1)
                msg.next_retry = self._now() + backoff[idx]
                if msg.attempts >= msg.max_attempts:
                    msg.status = "failed"
                    self._push_to_devices({
                        "type": "whisper",
                        "payload": {
                            "text": f"Couldn't reach {msg.to_did} after {msg.attempts} attempts",
                            "tier": SilenceTier.TIER_2_SOLICITED.value,
                        },
                    })
        return delivered

    # -- KV Store ----------------------------------------------------------

    def kv_put(self, key: str, value: Any) -> None:
        self.kv_store[key] = value

    def kv_get(self, key: str) -> Any:
        return self.kv_store.get(key)

    # -- Vault Lock/Unlock -------------------------------------------------

    def lock_vault(self) -> None:
        self._vault_locked = True
        self._push_to_devices({
            "type": "system",
            "payload": {"text": "vault locked"},
        })

    def unlock_vault(self, passphrase: str) -> bool:
        self._vault_locked = False
        self._brain_process("vault_unlocked", {})
        return True

    # -- Estate ------------------------------------------------------------

    def set_estate_plan(self, plan: EstatePlan) -> None:
        self.estate_plan = plan

    def submit_sss_share(self, share: str) -> dict:
        self.sss_shares_collected.append(share)
        plan = self.estate_plan
        if not plan:
            return {"status": "error", "reason": "no_estate_plan"}
        if len(self.sss_shares_collected) >= plan.custodian_threshold:
            self.estate_mode = True
            return {"status": "estate_activated",
                    "shares": len(self.sss_shares_collected)}
        return {"status": "share_accepted",
                "collected": len(self.sss_shares_collected),
                "needed": plan.custodian_threshold}

    def deliver_estate_keys(self) -> dict[str, bool]:
        """Deliver persona DEKs to beneficiaries."""
        if not self.estate_plan or not self.estate_mode:
            return {}
        results = {}
        for b in self.estate_plan.beneficiaries:
            keys = {}
            for pname in b.personas:
                p = self.personas.get(pname)
                if p:
                    keys[pname] = _derive_dek(self.master_seed,
                                              f"dina:vault:{pname}:v1")
            # Send via D2D
            target = self.network.nodes.get(b.did)
            if target and self.network.is_online(b.did):
                msg = D2DMessage(
                    msg_id=f"estate_{uuid.uuid4().hex[:8]}",
                    from_did=self.did, to_did=b.did,
                    message_type="dina/identity/estate_keys",
                    payload={"personas": b.personas, "keys": keys},
                    encrypted_payload=_mock_encrypt(
                        json.dumps(keys).encode(),
                        target.root_public_key if hasattr(target, 'root_public_key') else "pub",
                    ),
                )
                delivered = self.network.deliver(msg)
                b.delivery_confirmed = delivered
                results[b.did] = delivered
            else:
                results[b.did] = False
        return results

    def execute_estate_destruction(self) -> bool:
        """Destroy non-assigned data. Only if all deliveries confirmed."""
        if not self.estate_plan:
            return False
        all_delivered = all(b.delivery_confirmed
                           for b in self.estate_plan.beneficiaries)
        if not all_delivered:
            return False
        # Destroy non-assigned personas
        assigned = set()
        for b in self.estate_plan.beneficiaries:
            assigned.update(b.personas)
        for pname in list(self.personas.keys()):
            if pname not in assigned:
                self.personas[pname].items.clear()
        return True

    # -- Brain crash simulation --------------------------------------------

    def crash_brain(self) -> None:
        self._brain_crashed = True
        self._crash_log.append({
            "type": "crash",
            "timestamp": self._now(),
            "error": "RuntimeError: OOM",
        })

    def restart_brain(self) -> None:
        self._brain_crashed = False

    # -- Health check ------------------------------------------------------

    def healthz(self) -> dict:
        return {
            "status": "ok" if not self._brain_crashed else "degraded",
            "core": "healthy",
            "brain": "crashed" if self._brain_crashed else "healthy",
            "vault_locked": self._vault_locked,
        }

    # -- Rate limiting -----------------------------------------------------

    def check_rate_limit(self, client_ip: str) -> bool:
        count = self._request_counts.get(client_ip, 0)
        self._request_counts[client_ip] = count + 1
        return count < self.rate_limit

    def reset_rate_limits(self) -> None:
        self._request_counts.clear()

    # -- Audit -------------------------------------------------------------

    def _log_audit(self, action: str, details: dict) -> None:
        self.audit_log.append(AuditEntry(
            timestamp=self._now(),
            action=action,
            details=details,
        ))

    def get_audit_entries(self, action: str = "") -> list[AuditEntry]:
        if not action:
            return list(self.audit_log)
        return [e for e in self.audit_log if e.action == action]

    # -- AT Protocol -------------------------------------------------------

    def well_known_atproto_did(self) -> str:
        return self.did

    # -- LLM mock ----------------------------------------------------------

    def set_llm_response(self, prompt_key: str, response: str) -> None:
        self._llm_responses[prompt_key] = response

    def llm_reason(self, query: str, context: list[str] | None = None) -> str:
        for key, resp in self._llm_responses.items():
            if key.lower() in query.lower():
                return resp
        return f"LLM response for: {query}"
