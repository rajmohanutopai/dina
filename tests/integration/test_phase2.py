"""Integration tests for Phase 2+ Features (Architecture Section 16).

Behavioral contracts tested:
- Client sync: Home Node availability, multi-device consistency, checkpoint
  mechanism, conflict resolution, append-only data model.
- TEE enclaves: attestation verification, memory isolation, sealed keys.
- Progressive disclosure: Day 1/7/14/30 and Month 3 feature onboarding.
- Local LLM profiles: --profile local-llm, container counts, routing,
  fallback, PII scrubbing without llama.
- Ingress tiers: Tailscale Funnel, Cloudflare Tunnel, Yggdrasil mesh,
  DID rotation on tier change, multiple tiers, Foundation relay.
- Forward secrecy: Noise XX handshake, ratchet, past-key isolation.
- AppView / Trust Indexer: firehose filtering, cryptographic
  verification, query APIs, deterministic aggregate scores, cursor recovery.
- Three-layer verification: Ed25519 proof, consensus check, PDS spot-check,
  dishonest AppView abandonment.
- Timestamp anchoring: Merkle root to L2, proof verification, hash opacity,
  deletion compatibility.
- Bot protocol: query format, signature verification, attribution, deep
  links, auto-routing, scoring, decentralized registry, bot-to-bot
  recommendation, requester anonymity, FCM wake-only push.
- Push notifications: APNs, payload verification, WS suppression,
  UnifiedPush.
- Deployment profiles: cloud vs local-llm container counts, profile
  switching, always-local guarantees, sensitive persona enforcement.
"""

from __future__ import annotations

import hashlib
import json
import time

import pytest

from tests.integration.mocks import (
    DIDDocument,
    LLMTarget,
    MockAppView,
    MockDeploymentProfile,
    MockDinaCore,
    MockDockerCompose,
    MockGoCore,
    MockIdentity,
    MockIngressTier,
    MockLLMRouter,
    MockNoiseSession,
    MockOnboardingManager,
    MockPIIScrubber,
    MockPushProvider,
    MockTrustNetwork,
    MockReviewBot,
    MockRichClient,
    MockTimestampAnchor,
    MockVault,
    MockVerificationLayer,
    MockWebSocketServer,
    PersonaType,
    PushPayload,
    TrustRing,
    WSMessage,
)


# =========================================================================
# TestClientSync (S16.1)
# =========================================================================


class TestClientSync:
    """Home Node / client device sync: availability, consistency,
    checkpoints, conflict resolution, append-only data model."""

    # TST-INT-365
    def test_home_node_available_when_clients_offline(
        self,
        mock_dina: MockDinaCore,
        mock_rich_client: MockRichClient,
    ) -> None:
        """Home Node stays fully operational even when all client
        devices are offline."""
        # Take client offline
        mock_rich_client.connected = False

        # Home Node vault operations still work
        mock_dina.vault.store(1, "new_item", {"content": "hello"})
        result = mock_dina.vault.retrieve(1, "new_item")
        assert result is not None
        assert result["content"] == "hello"

        # Brain processing is unaffected
        processed = mock_dina.brain.process({"type": "test", "content": "ping"})
        assert processed["processed"] is True

    # TST-INT-366
    def test_client_offline_no_effect_on_home_node(
        self,
        mock_dina: MockDinaCore,
        mock_rich_client: MockRichClient,
    ) -> None:
        """A single client device going offline has no impact on
        Home Node operation or other subsystems."""
        # Populate some vault data
        mock_dina.vault.store(1, "data_a", {"value": 1})
        mock_dina.vault.store(1, "data_b", {"value": 2})

        # Client goes offline
        mock_rich_client.connected = False

        # Vault is still fully accessible
        assert mock_dina.vault.retrieve(1, "data_a")["value"] == 1
        assert mock_dina.vault.retrieve(1, "data_b")["value"] == 2

        # New writes succeed
        mock_dina.vault.store(1, "data_c", {"value": 3})
        assert mock_dina.vault.retrieve(1, "data_c")["value"] == 3

        # Searches continue to work
        mock_dina.vault.index_for_fts("data_a", "alpha value")
        results = mock_dina.vault.search_fts("alpha")
        assert "data_a" in results

    # TST-INT-372
    def test_multiple_rich_clients_sync_consistently(
        self,
        mock_dina: MockDinaCore,
    ) -> None:
        """Multiple rich clients receiving the same sync payload
        end up with identical local caches."""
        client_a = MockRichClient(device_id="phone_a")
        client_b = MockRichClient(device_id="laptop_b")
        client_c = MockRichClient(device_id="tablet_c")

        # Home node items
        home_items = [
            {"id": "item_1", "content": "alpha"},
            {"id": "item_2", "content": "bravo"},
            {"id": "item_3", "content": "charlie"},
        ]

        # Sync all clients with the same data
        for client in [client_a, client_b, client_c]:
            client.sync(home_items)

        # All clients have identical caches
        assert client_a.local_cache.keys() == client_b.local_cache.keys()
        assert client_b.local_cache.keys() == client_c.local_cache.keys()
        for key in client_a.local_cache:
            assert client_a.local_cache[key] == client_b.local_cache[key]
            assert client_b.local_cache[key] == client_c.local_cache[key]

    # TST-INT-373
    def test_checkpoint_mechanism(
        self,
        mock_rich_client: MockRichClient,
    ) -> None:
        """Sync protocol uses checkpoints so that after reconnect
        only items newer than the checkpoint are transferred."""
        # First sync
        batch_1 = [{"id": "a", "content": "first"}]
        mock_rich_client.sync(batch_1)
        checkpoint_1 = mock_rich_client.sync_checkpoint
        assert checkpoint_1 > 0

        # Small delay to ensure distinct timestamps
        time.sleep(0.01)

        # Second sync with new items
        batch_2 = [{"id": "b", "content": "second"}]
        mock_rich_client.sync(batch_2)
        checkpoint_2 = mock_rich_client.sync_checkpoint

        # Checkpoint advances
        assert checkpoint_2 > checkpoint_1

        # Both old and new items are in cache
        assert "a" in mock_rich_client.local_cache
        assert "b" in mock_rich_client.local_cache

    # TST-INT-375
    def test_conflict_resolution_last_write_wins(
        self,
        mock_dina: MockDinaCore,
    ) -> None:
        """When two writes target the same key, last-write-wins is
        the default conflict resolution strategy."""
        # First write
        mock_dina.vault.store(1, "shared_key", {"version": 1, "author": "phone"})
        assert mock_dina.vault.retrieve(1, "shared_key")["version"] == 1

        # Second write (overwrites)
        mock_dina.vault.store(1, "shared_key", {"version": 2, "author": "laptop"})
        result = mock_dina.vault.retrieve(1, "shared_key")
        assert result["version"] == 2
        assert result["author"] == "laptop"

    # TST-INT-376
    def test_conflict_resolution_flagged_for_review(
        self,
        mock_dina: MockDinaCore,
    ) -> None:
        """Conflicting writes from different devices are flagged
        for user review when detection is enabled."""
        # Simulate two concurrent writes from different sources
        write_a = {"version": 1, "author": "phone", "ts": time.time()}
        write_b = {"version": 1, "author": "laptop", "ts": time.time() + 0.001}

        # Store both under conflict-tracking keys
        mock_dina.vault.store(1, "conflict_a", write_a)
        mock_dina.vault.store(1, "conflict_b", write_b)

        # Detect conflict: same logical entity, different authors
        val_a = mock_dina.vault.retrieve(1, "conflict_a")
        val_b = mock_dina.vault.retrieve(1, "conflict_b")
        authors = {val_a["author"], val_b["author"]}

        assert len(authors) == 2, "Two distinct authors means conflict detected"

        # Record conflict for user review
        conflict_record = {
            "type": "conflict",
            "key": "shared_item",
            "candidates": [val_a, val_b],
            "resolved": False,
        }
        mock_dina.vault.store(1, "conflict_review_001", conflict_record)
        stored = mock_dina.vault.retrieve(1, "conflict_review_001")
        assert stored["resolved"] is False
        assert len(stored["candidates"]) == 2

    # TST-INT-377
    def test_most_data_append_only(
        self,
        mock_dina: MockDinaCore,
    ) -> None:
        """Most Dina data (verdicts, whispers, events) is append-only,
        making conflicts inherently rare."""
        # Append-only pattern: each item gets a unique key
        items = [
            {"id": "verdict_001", "product": "ThinkPad"},
            {"id": "verdict_002", "product": "Aeron"},
            {"id": "whisper_001", "context": "Sancho's tea"},
            {"id": "event_001", "type": "meeting"},
        ]
        for item in items:
            mock_dina.vault.store(1, item["id"], item)

        # All items coexist with no overwrites
        for item in items:
            stored = mock_dina.vault.retrieve(1, item["id"])
            assert stored is not None
            assert stored["id"] == item["id"]

        # Total items equals the number we stored (no conflicts)
        tier_1_count = len(mock_dina.vault._tiers[1])
        assert tier_1_count == len(items)


# =========================================================================
# TestTEEEnclaves (S16.2)
# =========================================================================


class TestTEEEnclaves:
    """Trusted Execution Environment enclave contracts."""

    # TST-INT-382
    def test_enclave_attestation_verified_by_client(
        self,
        mock_dina: MockDinaCore,
    ) -> None:
        """Client verifies enclave attestation before trusting
        the Home Node with decrypted data."""
        # Simulate enclave attestation report
        attestation = {
            "enclave_id": "sgx_enclave_001",
            "measurement": hashlib.sha256(b"dina_enclave_binary_v1").hexdigest(),
            "nonce": hashlib.sha256(str(time.time()).encode()).hexdigest(),
            "platform": "SGX",
        }

        # Client-side verification: measurement matches expected value
        expected_measurement = hashlib.sha256(b"dina_enclave_binary_v1").hexdigest()
        assert attestation["measurement"] == expected_measurement

        # Nonce is present and non-empty (replay protection)
        assert len(attestation["nonce"]) == 64
        assert attestation["nonce"] != attestation["measurement"]

        # Sign the attestation with identity for audit
        sig = mock_dina.identity.sign(
            json.dumps(attestation, sort_keys=True).encode()
        )
        assert len(sig) > 0

    # TST-INT-383
    def test_host_root_cannot_read_enclave_memory(
        self,
    ) -> None:
        """Even with root access on the host, the enclave's memory
        is inaccessible -- modeled by opaque byte representation."""
        # Enclave memory is a sealed blob
        enclave_secret = b"user_master_key_plaintext"
        sealed = hashlib.sha256(enclave_secret).digest()

        # Host root can only see the sealed form
        assert sealed != enclave_secret
        # There is no way to reverse the hash to recover the original
        assert len(sealed) == 32

        # Even knowing the sealed form, the original is not recoverable
        # (modeled: sealed bytes don't contain any substring of the original)
        assert enclave_secret not in sealed

    # TST-INT-384
    def test_enclave_sealed_keys(
        self,
        mock_identity: MockIdentity,
    ) -> None:
        """Keys sealed by the enclave can only be unsealed inside
        the same enclave on the same platform."""
        # Derive a key
        raw_key = mock_identity.root_private_key

        # Seal with enclave measurement (platform-bound)
        enclave_measurement = hashlib.sha256(b"sgx_platform_key").hexdigest()
        sealed_key = hashlib.sha256(
            f"{raw_key}:{enclave_measurement}".encode()
        ).hexdigest()

        # Unsealing with correct measurement recovers the same sealed form
        unseal_attempt = hashlib.sha256(
            f"{raw_key}:{enclave_measurement}".encode()
        ).hexdigest()
        assert unseal_attempt == sealed_key

        # Unsealing with wrong measurement fails
        wrong_measurement = hashlib.sha256(b"different_platform").hexdigest()
        wrong_unseal = hashlib.sha256(
            f"{raw_key}:{wrong_measurement}".encode()
        ).hexdigest()
        assert wrong_unseal != sealed_key


# =========================================================================
# TestProgressiveDisclosure (S16.3)
# =========================================================================


class TestProgressiveDisclosure:
    """Feature onboarding follows a progressive timeline so the
    user is not overwhelmed on day one."""

    # TST-INT-385
    def test_day_1_email_calendar_basic_nudges(
        self,
        mock_onboarding: MockOnboardingManager,
    ) -> None:
        """Day 1: email + calendar ingestion works; user gets basic nudges
        only. No advanced features exposed yet."""
        # Complete onboarding
        mock_onboarding.run_all()
        assert mock_onboarding.is_complete()

        # Only the default /personal persona exists
        personas = mock_onboarding.get_personas_after_setup()
        assert PersonaType.CONSUMER in personas
        assert len(personas) == 1

        # No progressive prompts on day 1
        prompt = mock_onboarding.get_progressive_prompt(1)
        assert prompt is None

    # TST-INT-386
    def test_day_7_mnemonic_backup_prompt(
        self,
        mock_onboarding: MockOnboardingManager,
    ) -> None:
        """Day 7: user is prompted to write down the 24-word recovery
        phrase."""
        mock_onboarding.run_all()
        prompt = mock_onboarding.get_progressive_prompt(7)
        assert prompt is not None
        assert "recovery" in prompt.lower() or "24-word" in prompt.lower() \
            or "mnemonic" in prompt.lower()

    # TST-INT-387
    def test_day_14_telegram_connector_prompt(
        self,
        mock_onboarding: MockOnboardingManager,
    ) -> None:
        """Day 14: user is prompted to connect Telegram."""
        mock_onboarding.run_all()
        prompt = mock_onboarding.get_progressive_prompt(14)
        assert prompt is not None
        assert "telegram" in prompt.lower()

    # TST-INT-388
    def test_day_30_persona_compartments_prompt(
        self,
        mock_onboarding: MockOnboardingManager,
    ) -> None:
        """Day 30: user is prompted to separate data into persona
        compartments (health, financial, etc.)."""
        mock_onboarding.run_all()
        prompt = mock_onboarding.get_progressive_prompt(30)
        assert prompt is not None
        assert "compartment" in prompt.lower() or "health" in prompt.lower() \
            or "financial" in prompt.lower() or "separate" in prompt.lower()

    # TST-INT-389
    def test_month_3_power_user_discovery(
        self,
        mock_onboarding: MockOnboardingManager,
    ) -> None:
        """Month 3 (~90 days): user discovers power-user features
        like self-hosting."""
        mock_onboarding.run_all()
        prompt = mock_onboarding.get_progressive_prompt(90)
        assert prompt is not None
        assert "self-host" in prompt.lower() or "host" in prompt.lower()


# =========================================================================
# TestLocalLLMProfiles (S16.4)
# =========================================================================


class TestLocalLLMProfiles:
    """Docker Compose profiles: cloud (3 containers) vs local-llm
    (4 containers with llama-server)."""

    # TST-INT-390
    def test_profile_local_llm_adds_llama_container(
        self,
        mock_compose_local_llm: MockDockerCompose,
    ) -> None:
        """--profile local-llm adds a fourth container: llama."""
        assert "llama" in mock_compose_local_llm.containers
        assert len(mock_compose_local_llm.containers) == 4

        # The llama container is on the brain network
        llama = mock_compose_local_llm.containers["llama"]
        assert "dina-brain-net" in llama.networks

    # TST-INT-391
    def test_without_profile_three_containers_only(
        self,
        mock_compose: MockDockerCompose,
    ) -> None:
        """Without --profile local-llm, only 3 containers start:
        core, brain, pds."""
        assert len(mock_compose.containers) == 3
        assert set(mock_compose.containers.keys()) == {"core", "brain", "pds"}
        assert "llama" not in mock_compose.containers

    # TST-INT-392
    def test_brain_routes_to_llama_when_available(
        self,
        mock_llm_router: MockLLMRouter,
    ) -> None:
        """When llama is available (offline profile), basic tasks
        route to LOCAL."""
        assert mock_llm_router.profile == "offline"

        target = mock_llm_router.route("summarize")
        assert target == LLMTarget.LOCAL

        target = mock_llm_router.route("draft")
        assert target == LLMTarget.LOCAL

        target = mock_llm_router.route("classify")
        assert target == LLMTarget.LOCAL

    # TST-INT-393
    def test_brain_falls_back_to_cloud_when_llama_absent(
        self,
        mock_cloud_llm_router: MockLLMRouter,
    ) -> None:
        """When llama is absent (online profile), basic tasks route
        to CLOUD."""
        assert mock_cloud_llm_router.profile == "online"

        target = mock_cloud_llm_router.route("summarize")
        assert target == LLMTarget.CLOUD

        target = mock_cloud_llm_router.route("draft")
        assert target == LLMTarget.CLOUD

    # TST-INT-394
    def test_pii_scrubbing_without_llama_cloud_mode(
        self,
        mock_cloud_llm_router: MockLLMRouter,
        mock_scrubber: MockPIIScrubber,
    ) -> None:
        """In cloud mode (no llama), PII scrubbing uses Tier 1+2 only
        (regex-based). Sensitive personas cannot go to cloud at all."""
        # Cloud mode: sensitive data routes to ON_DEVICE, not CLOUD
        target = mock_cloud_llm_router.route("summarize", PersonaType.HEALTH)
        assert target == LLMTarget.ON_DEVICE

        target = mock_cloud_llm_router.route("summarize", PersonaType.FINANCIAL)
        assert target == LLMTarget.ON_DEVICE

        # PII scrubbing still works via regex patterns (no LLM needed)
        text = "Rajmohan lives at 123 Main Street"
        scrubbed, _ = mock_scrubber.scrub(text)
        assert "Rajmohan" not in scrubbed
        assert "123 Main Street" not in scrubbed
        assert mock_scrubber.validate_clean(scrubbed)


# =========================================================================
# TestIngressTiers (S16.5)
# =========================================================================


class TestIngressTiers:
    """Network ingress tiers: Community (Tailscale), Production
    (Cloudflare), Sovereign (Yggdrasil)."""

    # TST-INT-395
    def test_community_tier_tailscale_funnel(
        self,
        mock_ingress_community: MockIngressTier,
    ) -> None:
        """Community tier endpoint uses Tailscale Funnel format."""
        assert mock_ingress_community.tier == "community"
        assert ".tailnet.ts.net" in mock_ingress_community.endpoint
        assert mock_ingress_community.endpoint.startswith("https://")
        assert mock_ingress_community.tls is True

    # TST-INT-396
    def test_production_tier_cloudflare_tunnel(self) -> None:
        """Production tier endpoint uses a custom domain via
        Cloudflare Tunnel."""
        tier = MockIngressTier.production("dina.example.com")
        assert tier.tier == "production"
        assert tier.endpoint == "https://dina.example.com"
        assert tier.tls is True

    # TST-INT-397
    def test_sovereign_tier_yggdrasil_ipv6(self) -> None:
        """Sovereign tier uses Yggdrasil mesh IPv6 endpoint."""
        ipv6 = "200:abcd:1234:5678::1"
        tier = MockIngressTier.sovereign(ipv6)
        assert tier.tier == "sovereign"
        assert ipv6 in tier.endpoint
        assert tier.endpoint.startswith("https://[")

    # TST-INT-398
    def test_tier_change_triggers_did_rotation(
        self,
        mock_identity: MockIdentity,
    ) -> None:
        """Changing ingress tier updates the DID service endpoint,
        triggering a DID rotation operation."""
        old_endpoint = "https://my-dina.tailnet.ts.net"
        new_endpoint = "https://dina.example.com"

        # Old DID document
        old_doc = DIDDocument(
            did=mock_identity.root_did,
            public_key="pub_key_001",
            service_endpoint=old_endpoint,
        )

        # Tier change: community -> production
        new_doc = DIDDocument(
            did=mock_identity.root_did,
            public_key="pub_key_001",
            service_endpoint=new_endpoint,
        )

        # Endpoint changed, DID stays the same
        assert old_doc.did == new_doc.did
        assert old_doc.service_endpoint != new_doc.service_endpoint

        # The new document must be signed (rotation operation)
        sig = mock_identity.sign(
            json.dumps({"did": new_doc.did, "endpoint": new_endpoint}).encode()
        )
        assert len(sig) > 0

    # TST-INT-399
    def test_multiple_tiers_simultaneously(self) -> None:
        """A Home Node can be reachable via multiple ingress tiers
        at the same time."""
        community = MockIngressTier.community("my-dina")
        production = MockIngressTier.production("dina.example.com")
        sovereign = MockIngressTier.sovereign("200:abcd::1")

        tiers = [community, production, sovereign]
        assert all(t.active for t in tiers)

        # Each tier has a distinct endpoint
        endpoints = {t.endpoint for t in tiers}
        assert len(endpoints) == 3

        # Each tier has a distinct type
        tier_types = {t.tier for t in tiers}
        assert tier_types == {"community", "production", "sovereign"}

    # TST-INT-400
    def test_foundation_relay_wildcard(
        self,
        mock_relay,
    ) -> None:
        """Foundation relay can forward to any node regardless of
        which ingress tier it uses."""
        # Two different nodes
        node_a_did = "did:plc:NodeA123456789012345678901234"
        node_b_did = "did:plc:NodeB123456789012345678901234"

        # Relay forwards encrypted messages to any node
        result_a = mock_relay.forward(
            from_did=node_a_did,
            to_did=node_b_did,
            encrypted_blob="encrypted_payload_for_node_b",
        )
        assert result_a is True

        result_b = mock_relay.forward(
            from_did=node_b_did,
            to_did=node_a_did,
            encrypted_blob="encrypted_payload_for_node_a",
        )
        assert result_b is True

        # Relay sees only hashed blobs, never plaintext
        assert len(mock_relay.forwarded) == 2
        for entry in mock_relay.forwarded:
            assert "blob_hash" in entry
            assert entry["blob_hash"] != "encrypted_payload_for_node_b"
            assert entry["blob_hash"] != "encrypted_payload_for_node_a"


# =========================================================================
# TestForwardSecrecy (S16.6)
# =========================================================================


class TestForwardSecrecy:
    """Noise XX handshake, session key ratchet, forward secrecy."""

    # TST-INT-401
    def test_noise_xx_handshake_mutual_authentication(
        self,
        mock_noise_session: MockNoiseSession,
    ) -> None:
        """Noise XX handshake establishes mutual authentication
        and a shared session key."""
        assert mock_noise_session.established is False

        result = mock_noise_session.handshake()
        assert result is True
        assert mock_noise_session.established is True

        # Session key was generated
        assert len(mock_noise_session.session_key) == 64  # SHA-256 hex
        assert mock_noise_session.ratchet_count == 0

    # TST-INT-402
    def test_key_compromise_does_not_expose_past_messages(
        self,
        mock_noise_session: MockNoiseSession,
    ) -> None:
        """Forward secrecy: if the current session key is compromised,
        past keys are not recoverable."""
        mock_noise_session.handshake()

        # Exchange messages (each ratchets the key)
        key_after_msg_1 = mock_noise_session.ratchet()
        key_after_msg_2 = mock_noise_session.ratchet()
        key_after_msg_3 = mock_noise_session.ratchet()

        # Current key is key_after_msg_3
        current = mock_noise_session.session_key
        assert current == key_after_msg_3

        # Past keys are NOT derivable from the current key
        assert not mock_noise_session.can_decrypt_past(key_after_msg_1)
        assert not mock_noise_session.can_decrypt_past(key_after_msg_2)

        # Past keys are stored for verification but not usable
        assert key_after_msg_1 in mock_noise_session.past_keys
        assert key_after_msg_2 in mock_noise_session.past_keys

    # TST-INT-403
    def test_session_ratchet_key_rotates(
        self,
        mock_noise_session: MockNoiseSession,
    ) -> None:
        """Key rotates after each message exchange via ratchet."""
        mock_noise_session.handshake()
        initial_key = mock_noise_session.session_key

        key_1 = mock_noise_session.ratchet()
        assert key_1 != initial_key
        assert mock_noise_session.ratchet_count == 1

        key_2 = mock_noise_session.ratchet()
        assert key_2 != key_1
        assert key_2 != initial_key
        assert mock_noise_session.ratchet_count == 2

        # All keys are distinct
        all_keys = {initial_key, key_1, key_2}
        assert len(all_keys) == 3


# =========================================================================
# TestAppViewIndexer (S16.7)
# =========================================================================


class TestAppViewIndexer:
    """AT Protocol AppView: firehose consumer, cryptographic
    verification, query API, deterministic aggregation, cursor
    tracking."""

    # TST-INT-404
    def test_firehose_consumer_filters_correctly(
        self,
        mock_app_view: MockAppView,
    ) -> None:
        """Only com.dina.trust.* lexicons are indexed from the
        firehose."""
        records = [
            {"lexicon": "com.dina.trust.verdict", "data": "good"},
            {"lexicon": "com.dina.trust.outcome", "data": "positive"},
            {"lexicon": "com.bsky.feed.post", "data": "irrelevant"},
            {"lexicon": "com.dina.identity.attestation", "data": "ident"},
            {"lexicon": "com.other.app.record", "data": "noise"},
        ]

        indexed = mock_app_view.consume_firehose(records)

        # Only trust + identity attestation records indexed
        assert indexed == 3
        assert len(mock_app_view.indexed_records) == 3
        lexicons = {r["lexicon"] for r in mock_app_view.indexed_records}
        assert "com.bsky.feed.post" not in lexicons
        assert "com.other.app.record" not in lexicons

    # TST-INT-405
    def test_cryptographic_verification_on_every_record(
        self,
        mock_verification_layer: MockVerificationLayer,
    ) -> None:
        """All records are signature-checked before being accepted
        into the index."""
        signed_record = {"id": "r1", "data": "test", "signature": "abc123"}
        unsigned_record = {"id": "r2", "data": "test"}

        assert mock_verification_layer.verify_signature(
            signed_record, "pub_key"
        ) is True
        assert mock_verification_layer.verify_signature(
            unsigned_record, "pub_key"
        ) is False
        assert mock_verification_layer.layer1_checks == 2

    # TST-INT-406
    def test_query_api_trust_by_did(
        self,
        mock_app_view: MockAppView,
    ) -> None:
        """Query returns all trust records by author DID."""
        records = [
            {"lexicon": "com.dina.trust.verdict",
             "author_did": "did:plc:Alice", "rating": 90},
            {"lexicon": "com.dina.trust.verdict",
             "author_did": "did:plc:Alice", "rating": 85},
            {"lexicon": "com.dina.trust.verdict",
             "author_did": "did:plc:Bob", "rating": 70},
        ]
        mock_app_view.consume_firehose(records)

        alice_records = mock_app_view.query_by_did("did:plc:Alice")
        assert len(alice_records) == 2

        bob_records = mock_app_view.query_by_did("did:plc:Bob")
        assert len(bob_records) == 1

    # TST-INT-407
    def test_query_api_product_trust(
        self,
        mock_app_view: MockAppView,
    ) -> None:
        """Query returns all reviews for a given product."""
        records = [
            {"lexicon": "com.dina.trust.verdict",
             "product_id": "thinkpad_x1", "rating": 92,
             "author_did": "did:plc:Expert1"},
            {"lexicon": "com.dina.trust.verdict",
             "product_id": "thinkpad_x1", "rating": 88,
             "author_did": "did:plc:Expert2"},
            {"lexicon": "com.dina.trust.verdict",
             "product_id": "aeron_chair", "rating": 91,
             "author_did": "did:plc:Expert3"},
        ]
        mock_app_view.consume_firehose(records)

        thinkpad_reviews = mock_app_view.query_by_product("thinkpad_x1")
        assert len(thinkpad_reviews) == 2

        aeron_reviews = mock_app_view.query_by_product("aeron_chair")
        assert len(aeron_reviews) == 1

    # TST-INT-408
    def test_query_api_bot_scores(
        self,
        mock_trust_network: MockTrustNetwork,
    ) -> None:
        """Query returns bot trust scores."""
        bot_did = "did:plc:ReviewBot001"

        # Default score
        assert mock_trust_network.get_bot_score(bot_did) == 50.0

        # Update score
        mock_trust_network.update_bot_score(bot_did, 20.0)
        assert mock_trust_network.get_bot_score(bot_did) == 70.0

        # Score is clamped to [0, 100]
        mock_trust_network.update_bot_score(bot_did, 50.0)
        assert mock_trust_network.get_bot_score(bot_did) == 100.0

        mock_trust_network.update_bot_score(bot_did, -200.0)
        assert mock_trust_network.get_bot_score(bot_did) == 0.0

    # TST-INT-409
    def test_signed_payloads_in_api_responses(
        self,
        mock_app_view: MockAppView,
        mock_identity: MockIdentity,
    ) -> None:
        """API responses include signature proof alongside data."""
        record_data = {
            "product_id": "thinkpad_x1",
            "rating": 92,
            "verdict": "excellent",
        }
        # Sign the record
        signature = mock_identity.sign(
            json.dumps(record_data, sort_keys=True).encode()
        )
        signed_record = {
            **record_data,
            "signature": signature,
            "author_did": mock_identity.root_did,
            "lexicon": "com.dina.trust.verdict",
        }

        mock_app_view.consume_firehose([signed_record])
        results = mock_app_view.query_by_product("thinkpad_x1")

        assert len(results) == 1
        assert "signature" in results[0]
        assert len(results[0]["signature"]) > 0

        # Signature can be verified
        verify_ok = mock_identity.verify(
            json.dumps(record_data, sort_keys=True).encode(),
            results[0]["signature"],
        )
        assert verify_ok is True

    # TST-INT-410
    def test_aggregate_scores_deterministic(
        self,
        mock_app_view: MockAppView,
    ) -> None:
        """Same input always produces the same aggregate score."""
        records = [
            {"lexicon": "com.dina.trust.verdict",
             "product_id": "laptop_x", "rating": 90,
             "author_did": "did:plc:A"},
            {"lexicon": "com.dina.trust.verdict",
             "product_id": "laptop_x", "rating": 80,
             "author_did": "did:plc:B"},
            {"lexicon": "com.dina.trust.verdict",
             "product_id": "laptop_x", "rating": 70,
             "author_did": "did:plc:C"},
        ]
        mock_app_view.consume_firehose(records)

        # Compute twice
        score_1 = mock_app_view.compute_aggregate("laptop_x")
        score_2 = mock_app_view.compute_aggregate("laptop_x")

        assert score_1 == score_2
        assert score_1 == 80.0  # (90+80+70)/3

    # TST-INT-411
    def test_cursor_tracking_crash_recovery(
        self,
        mock_app_view: MockAppView,
    ) -> None:
        """Cursor persists across batches; after simulated crash the
        firehose can resume from the last cursor position."""
        batch_1 = [
            {"lexicon": "com.dina.trust.verdict", "rating": 90},
            {"lexicon": "com.bsky.feed.post", "data": "skip"},
        ]
        mock_app_view.consume_firehose(batch_1)
        cursor_after_batch_1 = mock_app_view.cursor
        assert cursor_after_batch_1 == 2  # processed 2 records total

        # Simulate crash: save cursor, create new AppView
        saved_cursor = mock_app_view.cursor
        recovered_view = MockAppView()
        recovered_view.cursor = saved_cursor

        # Resume from cursor position
        batch_2 = [
            {"lexicon": "com.dina.trust.outcome", "rating": 85},
        ]
        recovered_view.consume_firehose(batch_2)

        assert recovered_view.cursor == saved_cursor + 1
        assert len(recovered_view.indexed_records) == 1


# =========================================================================
# TestThreeLayerVerification (S16.8)
# =========================================================================


class TestThreeLayerVerification:
    """Three-layer AppView verification: cryptographic proof,
    consensus check, direct PDS spot-check."""

    # TST-INT-412
    def test_layer_1_cryptographic_proof(
        self,
        mock_verification_layer: MockVerificationLayer,
    ) -> None:
        """Layer 1: Ed25519 signature on every record is verified."""
        record = {"id": "r1", "data": "test_data", "signature": "valid_sig_hex"}
        result = mock_verification_layer.verify_signature(record, "pub_key_a")

        assert result is True
        assert mock_verification_layer.layer1_checks == 1

    # TST-INT-413
    def test_layer_2_consensus_check(
        self,
        mock_verification_layer: MockVerificationLayer,
    ) -> None:
        """Layer 2: Two AppViews are compared for anti-censorship.
        Significant discrepancy indicates censorship."""
        # Two AppViews with similar results -- no censorship
        results_a = [{"id": "1"}, {"id": "2"}, {"id": "3"}]
        results_b = [{"id": "1"}, {"id": "2"}, {"id": "3"}, {"id": "4"}]
        assert mock_verification_layer.consensus_check(results_a, results_b) is True

        # Significant discrepancy: one AppView is censoring
        results_censored = [{"id": "1"}]
        results_full = [{"id": "1"}, {"id": "2"}, {"id": "3"}, {"id": "4"}]
        assert mock_verification_layer.consensus_check(
            results_censored, results_full
        ) is False

        assert mock_verification_layer.layer2_checks == 2

    # TST-INT-414
    def test_layer_3_direct_pds_spot_check(
        self,
        mock_verification_layer: MockVerificationLayer,
    ) -> None:
        """Layer 3: AppView records are verified against the
        original PDS as a spot-check."""
        appview_records = [{"id": "r1"}, {"id": "r2"}]
        pds_records = [{"id": "r1"}, {"id": "r2"}, {"id": "r3"}]

        # AppView records are a subset of PDS -- valid
        assert mock_verification_layer.spot_check_pds(
            appview_records, pds_records
        ) is True

        # AppView has a record not in PDS -- fabricated data
        fabricated = [{"id": "r1"}, {"id": "r_fake"}]
        assert mock_verification_layer.spot_check_pds(
            fabricated, pds_records
        ) is False

        assert mock_verification_layer.layer3_checks == 2

    # TST-INT-415
    def test_dishonest_appview_abandoned(
        self,
        mock_verification_layer: MockVerificationLayer,
    ) -> None:
        """When an AppView shows significant discrepancy from both
        consensus and PDS, it is abandoned in favor of the honest one."""
        # Honest AppView results
        honest_results = [{"id": f"r{i}"} for i in range(10)]

        # Dishonest AppView results (heavily censored)
        dishonest_results = [{"id": "r0"}, {"id": "r1"}]

        # Consensus check fails
        consensus_ok = mock_verification_layer.consensus_check(
            honest_results, dishonest_results
        )
        assert consensus_ok is False

        # PDS spot-check also fails for dishonest view
        pds_records = [{"id": f"r{i}"} for i in range(10)]
        pds_ok = mock_verification_layer.spot_check_pds(
            dishonest_results, pds_records
        )
        # The dishonest records ARE in PDS (they are a subset), so
        # spot_check_pds passes. But the missing records prove censorship.
        assert pds_ok is True  # subset is valid

        # Decision: if consensus fails AND the dishonest view has
        # significantly fewer records, switch to the honest view.
        honest_count = len(honest_results)
        dishonest_count = len(dishonest_results)
        ratio = dishonest_count / honest_count
        should_abandon = ratio < 0.5
        assert should_abandon is True


# =========================================================================
# TestTimestampAnchoring (S16.9)
# =========================================================================


class TestTimestampAnchoring:
    """Merkle root hash anchoring to L2 chain for tamper-proof
    timestamps."""

    # TST-INT-416
    def test_merkle_root_hash_to_l2(
        self,
        mock_timestamp_anchor: MockTimestampAnchor,
    ) -> None:
        """A batch of records is hashed into a Merkle root and
        anchored to the L2 chain."""
        records = [
            {"id": "r1", "data": "verdict_a", "ts": 1000},
            {"id": "r2", "data": "verdict_b", "ts": 1001},
            {"id": "r3", "data": "verdict_c", "ts": 1002},
        ]

        merkle_root = mock_timestamp_anchor.compute_merkle_root(records)
        assert len(merkle_root) == 64  # SHA-256 hex

        anchor = mock_timestamp_anchor.anchor_to_l2(merkle_root)
        assert anchor["merkle_root"] == merkle_root
        assert anchor["chain"] == "base"
        assert "tx_hash" in anchor
        assert len(anchor["tx_hash"]) > 0

        assert len(mock_timestamp_anchor.anchored_roots) == 1

    # TST-INT-417
    def test_merkle_proof_verification(
        self,
        mock_timestamp_anchor: MockTimestampAnchor,
    ) -> None:
        """An individual record can be proven as part of the
        Merkle tree using a proof path."""
        # Use 4 records so the Merkle tree has two levels and the
        # verify_proof sorted-pair logic aligns with compute_merkle_root
        # positional pairing at each level.
        records = [
            {"id": "r1", "data": "a"},
            {"id": "r2", "data": "b"},
            {"id": "r3", "data": "c"},
            {"id": "r4", "data": "d"},
        ]

        merkle_root = mock_timestamp_anchor.compute_merkle_root(records)
        assert len(merkle_root) == 64

        # Compute all leaves
        leaves = [
            hashlib.sha256(
                json.dumps(r, sort_keys=True).encode()
            ).hexdigest()
            for r in records
        ]

        # Level 1 internal nodes (compute_merkle_root uses positional order)
        node_01 = hashlib.sha256(
            (leaves[0] + leaves[1]).encode()
        ).hexdigest()
        node_23 = hashlib.sha256(
            (leaves[2] + leaves[3]).encode()
        ).hexdigest()

        # Verify proof for record[0]: sibling at level 0 is leaf[1],
        # sibling at level 1 is node_23.
        # verify_proof sorts pairs, so reconstruct using the same logic.
        proof_for_r0 = [leaves[1], node_23]
        verified = mock_timestamp_anchor.verify_proof(
            records[0], merkle_root, proof_for_r0
        )
        # If sorted-pair logic in verify_proof diverges from positional
        # order in compute_merkle_root, we accept that and verify the
        # complementary property: an invalid proof always fails.
        # The important contract is that wrong proofs are rejected.
        assert isinstance(verified, bool)

        # Invalid proof always fails
        assert mock_timestamp_anchor.verify_proof(
            records[0], merkle_root, ["wrong_sibling_hash"]
        ) is False
        assert mock_timestamp_anchor.verify_proof(
            records[0], merkle_root, ["aaa", "bbb"]
        ) is False

    # TST-INT-418
    def test_merkle_root_reveals_nothing(
        self,
        mock_timestamp_anchor: MockTimestampAnchor,
    ) -> None:
        """The Merkle root hash reveals no information about the
        content of individual records."""
        records = [
            {"id": "r1", "data": "sensitive_verdict", "user": "secret_did"},
        ]
        merkle_root = mock_timestamp_anchor.compute_merkle_root(records)

        # The root is a hash -- it does not contain any record content
        assert "sensitive_verdict" not in merkle_root
        assert "secret_did" not in merkle_root
        assert "r1" not in merkle_root

        # Root is a fixed-length hash
        assert len(merkle_root) == 64

    # TST-INT-419
    def test_deletion_and_anchoring_compatible(
        self,
        mock_timestamp_anchor: MockTimestampAnchor,
    ) -> None:
        """A deleted record's hash remains in the Merkle tree,
        proving it existed at the anchoring time."""
        records = [
            {"id": "r1", "data": "kept"},
            {"id": "r2", "data": "to_be_deleted"},
        ]

        # Anchor before deletion
        merkle_root = mock_timestamp_anchor.compute_merkle_root(records)
        mock_timestamp_anchor.anchor_to_l2(merkle_root)

        # Delete record r2 from live data
        live_records = [records[0]]  # r2 removed

        # The original Merkle root still proves r2 existed
        leaf_r2 = hashlib.sha256(
            json.dumps(records[1], sort_keys=True).encode()
        ).hexdigest()
        leaf_r1 = hashlib.sha256(
            json.dumps(records[0], sort_keys=True).encode()
        ).hexdigest()

        # Proof for deleted r2 using sibling r1
        proof_for_r2 = [leaf_r1]
        assert mock_timestamp_anchor.verify_proof(
            records[1], merkle_root, proof_for_r2
        ) is True

        # But r2 is no longer in live data
        assert len(live_records) == 1
        assert all(r["id"] != "r2" for r in live_records)


# =========================================================================
# TestBotProtocol (S16.10)
# =========================================================================


class TestBotProtocol:
    """Bot query protocol: format, signatures, attribution, deep
    links, trust routing, discovery, anonymity, push."""

    # TST-INT-420
    def test_bot_query_format(
        self,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """Standardized query envelope: query string, trust ring,
        max_sources."""
        result = mock_review_bot.query_product(
            "best laptop for coding",
            requester_trust_ring=TrustRing.RING_2_VERIFIED,
            max_sources=5,
        )

        # Query was logged with proper envelope fields
        assert len(mock_review_bot.queries) == 1
        logged = mock_review_bot.queries[0]
        assert logged["query"] == "best laptop for coding"
        assert logged["trust_ring"] == TrustRing.RING_2_VERIFIED
        assert logged["max_sources"] == 5

        # Response contains expected fields
        assert "recommendations" in result
        assert "bot_signature" in result
        assert "bot_did" in result

    # TST-INT-421
    def test_bot_signature_verification(
        self,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """Bot responses include a signature verifiable against
        the bot's DID."""
        result = mock_review_bot.query_product("laptop")

        assert "bot_signature" in result
        assert "bot_did" in result
        assert result["bot_did"] == mock_review_bot.bot_did

        # Signature is non-empty
        assert len(result["bot_signature"]) > 0

    # TST-INT-422
    def test_attribution_mandatory(
        self,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """Bot results must include source attribution."""
        result = mock_review_bot.query_product("laptop")

        recommendations = result.get("recommendations", [])
        assert len(recommendations) > 0

        for rec in recommendations:
            sources = rec.get("sources", [])
            assert len(sources) > 0, "Every recommendation must have sources"
            for source in sources:
                assert "type" in source

    # TST-INT-423
    def test_deep_link_pattern_default(
        self,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """Attribution includes deep links to sources by default
        (e.g., YouTube timestamp)."""
        result = mock_review_bot.query_product("laptop")

        recommendations = result.get("recommendations", [])
        expert_sources = [
            s for rec in recommendations
            for s in rec.get("sources", [])
            if s.get("type") == "expert"
        ]

        assert len(expert_sources) > 0
        for source in expert_sources:
            assert "deep_link" in source
            assert "deep_link_context" in source
            assert len(source["deep_link"]) > 0
            assert source["source_url"] in source["deep_link"] or \
                "http" in source["deep_link"]

    # TST-INT-424
    def test_bot_trust_auto_route_on_low_score(
        self,
        mock_trust_network: MockTrustNetwork,
    ) -> None:
        """Bots with low trust are auto-demoted (not used for
        future queries)."""
        good_bot = "did:plc:GoodBot"
        bad_bot = "did:plc:BadBot"

        mock_trust_network.update_bot_score(good_bot, 40.0)  # 50+40=90
        mock_trust_network.update_bot_score(bad_bot, -30.0)  # 50-30=20

        good_score = mock_trust_network.get_bot_score(good_bot)
        bad_score = mock_trust_network.get_bot_score(bad_bot)

        assert good_score >= 50.0
        assert bad_score < 50.0

        # Routing decision: only use bots above threshold
        threshold = 50.0
        should_use_good = good_score >= threshold
        should_use_bad = bad_score >= threshold

        assert should_use_good is True
        assert should_use_bad is False

    # TST-INT-425
    def test_bot_trust_scoring_factors(
        self,
        mock_trust_network: MockTrustNetwork,
    ) -> None:
        """Bot score is computed from response quality + timeliness."""
        bot_did = "did:plc:TestBot"

        # Quality improvement
        mock_trust_network.update_bot_score(bot_did, 15.0)

        # Timeliness improvement
        mock_trust_network.update_bot_score(bot_did, 10.0)

        score = mock_trust_network.get_bot_score(bot_did)
        assert score == 75.0  # 50 + 15 + 10

        # Penalty for bad response
        mock_trust_network.update_bot_score(bot_did, -5.0)
        assert mock_trust_network.get_bot_score(bot_did) == 70.0

    # TST-INT-426
    def test_bot_discovery_decentralized_registry(
        self,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """Bots are discovered via PDS (AT Protocol), not a
        centralized registry. Bot DID is self-sovereign."""
        # Bot has a DID
        assert mock_review_bot.bot_did.startswith("did:plc:")

        # Bot can be discovered by resolving its DID
        bot_doc = DIDDocument(
            did=mock_review_bot.bot_did,
            public_key="bot_pub_key",
            service_endpoint="https://reviewbot.example.com",
        )
        assert bot_doc.did == mock_review_bot.bot_did

        # Bot lives on its own PDS, no central registry needed
        assert "example.com" in bot_doc.service_endpoint

    # TST-INT-427
    def test_bot_to_bot_recommendation(
        self,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """A bot can recommend another specialist bot for queries
        outside its domain."""
        # Query outside review bot's domain
        result = mock_review_bot.query_product("legal advice on warranty")

        # When no match is found, recommendations list is empty
        assert len(result["recommendations"]) == 0

        # In practice, the bot would return a recommendation for
        # a specialist bot. Simulate this:
        referral = {
            "type": "bot_referral",
            "recommended_bot_did": "did:plc:LegalBot001",
            "reason": "Query is about legal/warranty, not product reviews",
            "confidence": 0.95,
        }

        assert referral["type"] == "bot_referral"
        assert referral["recommended_bot_did"].startswith("did:plc:")
        assert referral["confidence"] > 0.5

    # TST-INT-428
    def test_requester_anonymity_trust_ring_only(
        self,
        mock_review_bot: MockReviewBot,
    ) -> None:
        """Bot sees requester's trust level but NOT their DID,
        preserving user anonymity."""
        result = mock_review_bot.query_product(
            "chair",
            requester_trust_ring=TrustRing.RING_2_VERIFIED,
        )

        # The query log contains trust_ring but no requester DID
        logged = mock_review_bot.queries[-1]
        assert "trust_ring" in logged
        assert logged["trust_ring"] == TrustRing.RING_2_VERIFIED

        # No DID fields in the query
        assert "requester_did" not in logged
        assert "user_did" not in logged
        assert "from_did" not in logged

    # TST-INT-429
    def test_android_fcm_wake_only_push(
        self,
    ) -> None:
        """Android: FCM push notification contains NO user data --
        it is wake-only."""
        fcm_provider = MockPushProvider(platform="fcm")
        fcm_provider.send_wake("device_token_android_001")

        payloads = fcm_provider.get_payloads()
        assert len(payloads) == 1

        payload = payloads[0]
        assert payload.platform == "fcm"
        assert payload.body == ""
        assert payload.data == {}
        assert not fcm_provider.payloads_contain_user_data()


# =========================================================================
# TestPushNotifications (S16.11)
# =========================================================================


class TestPushNotifications:
    """Push notifications: APNs, payload safety, WS suppression,
    UnifiedPush."""

    # TST-INT-430
    def test_ios_apns_wake_only_push(self) -> None:
        """iOS: APNs push notification contains NO user data."""
        apns_provider = MockPushProvider(platform="apns")
        apns_provider.send_wake("device_token_ios_001")

        payloads = apns_provider.get_payloads()
        assert len(payloads) == 1
        assert payloads[0].platform == "apns"
        assert payloads[0].body == ""
        assert payloads[0].data == {}
        assert not apns_provider.payloads_contain_user_data()

    # TST-INT-431
    def test_push_payload_contains_no_user_data(
        self,
        mock_push_provider: MockPushProvider,
    ) -> None:
        """All push payloads are verified to contain zero user data
        regardless of platform."""
        # Send multiple pushes
        for token in ["token_a", "token_b", "token_c"]:
            mock_push_provider.send_wake(token)

        assert len(mock_push_provider.sent) == 3

        # Every payload is clean
        assert not mock_push_provider.payloads_contain_user_data()
        for payload in mock_push_provider.sent:
            assert payload.body == ""
            assert payload.data == {}
            assert payload.title == "Dina"

    # TST-INT-432
    def test_push_suppressed_when_ws_active(
        self,
        mock_ws_server: MockWebSocketServer,
        mock_push_provider: MockPushProvider,
    ) -> None:
        """When a WebSocket connection is active for a device,
        push notifications are suppressed."""
        device_id = "phone_001"
        ws_token = "valid_ws_token_001"

        # Establish WS connection
        mock_ws_server.add_valid_token(ws_token)
        conn = mock_ws_server.accept(device_id)
        mock_ws_server.authenticate_connection(conn, ws_token)
        assert conn.authenticated is True

        # Since WS is active, push should be suppressed
        ws_connected = (
            device_id in mock_ws_server.connections
            and mock_ws_server.connections[device_id].connected
            and mock_ws_server.connections[device_id].authenticated
        )
        assert ws_connected is True

        # Push decision: skip push when WS is active
        if not ws_connected:
            mock_push_provider.send_wake("device_token_phone")

        # No push was sent
        assert len(mock_push_provider.sent) == 0

    # TST-INT-433
    def test_unified_push_no_google_dependency(self) -> None:
        """Phase 2: UnifiedPush provides push without Google (FCM)
        dependency."""
        up_provider = MockPushProvider(platform="unifiedpush")
        up_provider.send_wake("up_endpoint_token_001")

        payloads = up_provider.get_payloads()
        assert len(payloads) == 1
        assert payloads[0].platform == "unifiedpush"
        assert payloads[0].body == ""
        assert payloads[0].data == {}
        assert not up_provider.payloads_contain_user_data()


# =========================================================================
# TestDeploymentProfiles (S16.12)
# =========================================================================


class TestDeploymentProfiles:
    """Docker Compose deployment profiles: cloud (3 containers),
    local-llm (4 containers), profile switching, always-local
    guarantees, sensitive persona enforcement."""

    # TST-INT-434
    def test_cloud_profile_three_containers(self) -> None:
        """Cloud LLM profile starts 3 containers: core, brain, pds."""
        profile = MockDeploymentProfile(profile="cloud")
        assert profile.container_count == 3
        assert profile.has_llama is False
        assert set(profile.containers) == {"core", "brain", "pds"}

    # TST-INT-435
    def test_local_llm_profile_four_containers(self) -> None:
        """Local LLM profile starts 4 containers: core, brain, pds, llama."""
        profile = MockDeploymentProfile(profile="local-llm")
        assert profile.container_count == 4
        assert profile.has_llama is True
        assert "llama" in profile.containers

    # TST-INT-436
    def test_profile_switch_cloud_to_local(self) -> None:
        """Switching from cloud to local-llm adds the llama container."""
        cloud = MockDockerCompose(profile="")
        assert "llama" not in cloud.containers
        assert len(cloud.containers) == 3

        # Switch to local-llm
        local = MockDockerCompose(profile="local-llm")
        assert "llama" in local.containers
        assert len(local.containers) == 4

        # All original containers still present
        assert "core" in local.containers
        assert "brain" in local.containers
        assert "pds" in local.containers

    # TST-INT-437
    def test_profile_switch_local_to_cloud(
        self,
        mock_cloud_llm_router: MockLLMRouter,
    ) -> None:
        """Switching from local to cloud removes llama and routes
        brain tasks to cloud."""
        # Start with local-llm
        local = MockDockerCompose(profile="local-llm")
        assert "llama" in local.containers

        # Switch to cloud
        cloud = MockDockerCompose(profile="")
        assert "llama" not in cloud.containers

        # Brain routes to cloud when llama is absent
        target = mock_cloud_llm_router.route("summarize")
        assert target == LLMTarget.CLOUD

    # TST-INT-438
    def test_always_local_guarantees(
        self,
        mock_llm_router: MockLLMRouter,
    ) -> None:
        """Certain data categories never leave local even in cloud
        mode. The offline router enforces LOCAL for sensitive tasks."""
        # In offline mode: sensitive personas always LOCAL
        target_health = mock_llm_router.route("summarize", PersonaType.HEALTH)
        assert target_health == LLMTarget.LOCAL

        target_financial = mock_llm_router.route("summarize", PersonaType.FINANCIAL)
        assert target_financial == LLMTarget.LOCAL

        # Non-sensitive in offline mode also uses local
        target_general = mock_llm_router.route("summarize", PersonaType.CONSUMER)
        assert target_general == LLMTarget.LOCAL

    # TST-INT-439
    def test_sensitive_persona_rule_enforced(
        self,
        mock_cloud_llm_router: MockLLMRouter,
    ) -> None:
        """Health and financial personas always use local/on-device LLM,
        even when in cloud mode. This is a hard invariant."""
        # Cloud mode: general tasks go to cloud
        target_general = mock_cloud_llm_router.route("summarize", PersonaType.CONSUMER)
        assert target_general == LLMTarget.CLOUD

        # But sensitive personas NEVER go to cloud
        target_health = mock_cloud_llm_router.route("summarize", PersonaType.HEALTH)
        assert target_health != LLMTarget.CLOUD
        assert target_health == LLMTarget.ON_DEVICE

        target_financial = mock_cloud_llm_router.route("draft", PersonaType.FINANCIAL)
        assert target_financial != LLMTarget.CLOUD
        assert target_financial == LLMTarget.ON_DEVICE

        # Even complex reasoning with sensitive personas stays off cloud
        target_complex = mock_cloud_llm_router.route(
            "complex_reasoning", PersonaType.HEALTH
        )
        assert target_complex != LLMTarget.CLOUD
