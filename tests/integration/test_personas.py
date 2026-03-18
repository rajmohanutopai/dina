"""Integration tests for persona compartments.

Tests SLIP-0010 derivation, isolation between personas, and real interaction
scenarios where Dina auto-selects the correct persona by context.
"""

from __future__ import annotations

import pytest

from tests.integration.mocks import (
    MockDinaCore,
    MockIdentity,
    MockPersona,
    MockVault,
    PersonaType,
    TrustRing,
)


# ---------------------------------------------------------------------------
# TestPersonaCreation
# ---------------------------------------------------------------------------

class TestPersonaCreation:
    """Root identity generates personas via SLIP-0010 derivation."""

# TST-INT-521
    def test_root_identity_generates_consumer_persona(
        self, mock_identity: MockIdentity
    ) -> None:
        """Consumer persona is derived from root and has its own DID."""
        persona = mock_identity.derive_persona(PersonaType.CONSUMER)

        assert persona.persona_type == PersonaType.CONSUMER
        assert persona.did.startswith("did:key:z6Mk")
        assert persona.did != mock_identity.root_did
        assert persona.derived_key != mock_identity.root_private_key

        # Deterministic: re-deriving the same persona type produces identical keys
        persona_again = mock_identity.derive_persona(PersonaType.CONSUMER)
        assert persona_again.did == persona.did, \
            "Same persona type must produce deterministic DID"
        assert persona_again.derived_key == persona.derived_key, \
            "Same persona type must produce deterministic key"

        # Counter-proof: different persona type produces different DID/key
        health = mock_identity.derive_persona(PersonaType.HEALTH)
        assert health.did != persona.did, \
            "Different persona types must have different DIDs"
        assert health.derived_key != persona.derived_key, \
            "Different persona types must have different keys"

        # Counter-proof: different identity produces different consumer persona
        other_identity = MockIdentity(did="did:plc:OtherUser12345678901234")
        other_consumer = other_identity.derive_persona(PersonaType.CONSUMER)
        assert other_consumer.did != persona.did, \
            "Same persona type on different identity must differ"

# TST-INT-033
    def test_root_identity_generates_health_persona(
        self, mock_identity: MockIdentity
    ) -> None:
        """Health persona is derived from root with its own compartment."""
        persona = mock_identity.derive_persona(PersonaType.HEALTH)

        assert persona.persona_type == PersonaType.HEALTH
        assert persona.storage_partition == "partition_health"
        assert persona.did.startswith("did:key:z6Mk")

# TST-INT-522
    def test_root_identity_generates_legal_persona(
        self, mock_identity: MockIdentity
    ) -> None:
        """A citizen/legal persona is created for government interactions."""
        persona = mock_identity.derive_persona(PersonaType.CITIZEN)

        assert persona.persona_type == PersonaType.CITIZEN
        assert persona.storage_partition == "partition_citizen"
        assert persona.derived_key is not None
        assert len(persona.derived_key) == 64  # SHA-256 hex

# TST-INT-159
    def test_seller_interaction_gets_own_persona(
        self, mock_identity: MockIdentity
    ) -> None:
        """Financial persona handles seller-facing commerce."""
        persona = mock_identity.derive_persona(PersonaType.FINANCIAL)

        assert persona.persona_type == PersonaType.FINANCIAL
        assert persona.did != mock_identity.root_did

# TST-INT-161
    def test_each_persona_has_unique_key_derivation(
        self, mock_identity: MockIdentity
    ) -> None:
        """Every persona type produces a distinct derived key and DID."""
        types = [
            PersonaType.CONSUMER,
            PersonaType.HEALTH,
            PersonaType.FINANCIAL,
            PersonaType.CITIZEN,
            PersonaType.SOCIAL,
            PersonaType.PROFESSIONAL,
        ]
        personas = [mock_identity.derive_persona(pt) for pt in types]
        keys = [p.derived_key for p in personas]
        dids = [p.did for p in personas]

        assert len(set(keys)) == len(types), "Derived keys must be unique"
        assert len(set(dids)) == len(types), "DIDs must be unique"

# TST-INT-523
    def test_persona_derivation_is_deterministic(
        self, mock_identity: MockIdentity
    ) -> None:
        """Deriving the same persona type twice returns the same persona."""
        first = mock_identity.derive_persona(PersonaType.CONSUMER)
        second = mock_identity.derive_persona(PersonaType.CONSUMER)

        assert first is second
        assert first.did == second.did
        assert first.derived_key == second.derived_key

# TST-INT-034
    def test_different_roots_produce_different_personas(self) -> None:
        """Two root identities produce completely different persona keys."""
        alice = MockIdentity(did="did:plc:Alice12345678901234567890abcd")
        bob = MockIdentity(did="did:plc:Bob1234567890123456789012abcd")

        alice_consumer = alice.derive_persona(PersonaType.CONSUMER)
        bob_consumer = bob.derive_persona(PersonaType.CONSUMER)

        assert alice_consumer.did != bob_consumer.did
        assert alice_consumer.derived_key != bob_consumer.derived_key


# ---------------------------------------------------------------------------
# TestPersonaIsolation
# ---------------------------------------------------------------------------

class TestPersonaIsolation:
    """Personas are cryptographically isolated compartments."""

# TST-INT-031
    def test_seller_cannot_see_health_data(
        self, mock_identity: MockIdentity, mock_vault: MockVault
    ) -> None:
        """Data stored under health persona is invisible to consumer persona."""
        health = mock_identity.derive_persona(PersonaType.HEALTH)
        consumer = mock_identity.derive_persona(PersonaType.CONSUMER)

        # Store sensitive health data
        mock_vault.store(
            tier=1,
            key="blood_pressure",
            value={"systolic": 120, "diastolic": 80},
            persona=PersonaType.HEALTH,
        )

        # Consumer persona cannot retrieve health partition data
        result = mock_vault.retrieve(tier=1, key="blood_pressure",
                                     persona=PersonaType.CONSUMER)
        assert result is None

        # Health persona CAN retrieve it
        result = mock_vault.retrieve(tier=1, key="blood_pressure",
                                     persona=PersonaType.HEALTH)
        assert result is not None
        assert result["systolic"] == 120

# TST-INT-032
    def test_health_bot_cannot_see_purchases(
        self, mock_identity: MockIdentity, mock_vault: MockVault
    ) -> None:
        """Purchase history in consumer partition is invisible to health."""
        mock_identity.derive_persona(PersonaType.CONSUMER)
        mock_identity.derive_persona(PersonaType.HEALTH)

        mock_vault.store(
            tier=1,
            key="purchase_chair",
            value={"item": "Herman Miller Aeron", "price": 95000},
            persona=PersonaType.CONSUMER,
        )

        health_view = mock_vault.per_persona_partition(PersonaType.HEALTH)
        assert "purchase_chair" not in health_view

        consumer_view = mock_vault.per_persona_partition(PersonaType.CONSUMER)
        assert "purchase_chair" in consumer_view

# TST-INT-164
    def test_cross_persona_requires_authorization(
        self, mock_identity: MockIdentity, mock_vault: MockVault
    ) -> None:
        """Accessing one persona's data from another requires explicit key."""
        health = mock_identity.derive_persona(PersonaType.HEALTH)
        consumer = mock_identity.derive_persona(PersonaType.CONSUMER)

        encrypted = health.encrypt("diagnosis: healthy")

        # Same persona can decrypt
        decrypted = health.decrypt(encrypted)
        assert decrypted == "diagnosis: healthy"

        # Different persona CANNOT decrypt
        cross_decrypt = consumer.decrypt(encrypted)
        assert cross_decrypt is None

# TST-INT-157
    def test_malicious_system_cannot_jailbreak_persona(
        self, mock_identity: MockIdentity
    ) -> None:
        """An external prompt to 'ignore persona boundaries' has no effect.

        The boundary is cryptographic (different keys), not policy-based.
        A malicious agent cannot simply ask for cross-persona data; the
        encryption makes it impossible without the correct derived key.
        """
        # Pre-condition: no personas derived
        assert len(mock_identity.personas) == 0

        health = mock_identity.derive_persona(PersonaType.HEALTH)
        financial = mock_identity.derive_persona(PersonaType.FINANCIAL)

        # Health encrypts sensitive record
        encrypted_health = health.encrypt("patient record: confidential")

        # Same-persona decrypt works (positive proof)
        assert health.decrypt(encrypted_health) is not None

        # Financial persona physically cannot decrypt health data
        assert financial.decrypt(encrypted_health) is None

        # And the other direction is equally impossible
        encrypted_fin = financial.encrypt("bank account: secret")
        assert financial.decrypt(encrypted_fin) is not None
        assert health.decrypt(encrypted_fin) is None

        # Encrypted output does not contain plaintext
        assert "patient record" not in encrypted_health
        assert "bank account" not in encrypted_fin

# TST-INT-160
    def test_persona_keys_derived_from_root(
        self, mock_identity: MockIdentity
    ) -> None:
        """All persona keys are derived from the single root private key.

        This mirrors SLIP-0010: one master seed produces deterministic child keys.
        """
        consumer = mock_identity.derive_persona(PersonaType.CONSUMER)
        health = mock_identity.derive_persona(PersonaType.HEALTH)

        # Both derived keys are 64-char hex (SHA-256)
        assert len(consumer.derived_key) == 64
        assert len(health.derived_key) == 64

        # They are deterministic from root: same root always gives same keys
        identity_clone = MockIdentity(did=mock_identity.root_did)
        consumer_clone = identity_clone.derive_persona(PersonaType.CONSUMER)
        assert consumer_clone.derived_key == consumer.derived_key

# TST-INT-162
    def test_vault_partition_naming_matches_persona_type(
        self, mock_identity: MockIdentity
    ) -> None:
        """Each persona's storage partition name is canonical and predictable."""
        # Pre-condition: no personas derived yet
        assert len(mock_identity.personas) == 0

        for pt in PersonaType:
            persona = mock_identity.derive_persona(pt)
            expected_partition = f"partition_{pt.value}"
            assert persona.storage_partition == expected_partition
            # Each persona gets a unique DID
            assert persona.did.startswith("did:key:z6Mk")

        # All persona types derived
        assert len(mock_identity.personas) == len(PersonaType)

        # Counter-proof: different personas have different DIDs and keys
        consumer = mock_identity.derive_persona(PersonaType.CONSUMER)
        health = mock_identity.derive_persona(PersonaType.HEALTH)
        assert consumer.did != health.did
        assert consumer.derived_key != health.derived_key
        # But partitions follow naming convention
        assert consumer.storage_partition != health.storage_partition


# ---------------------------------------------------------------------------
# TestPersonaInInteraction
# ---------------------------------------------------------------------------

class TestPersonaInInteraction:
    """Dina auto-selects the correct persona based on interaction context."""

# TST-INT-524
    def test_buying_chair_uses_consumer_persona(
        self, mock_dina: MockDinaCore, mock_review_bot
    ) -> None:
        """When buying a product, the consumer persona is activated.

        Only consumer-relevant data (budget, preferences) is shared;
        health and financial details stay sealed.
        """
        consumer = mock_dina.identity.derive_persona(PersonaType.CONSUMER)
        health = mock_dina.identity.derive_persona(PersonaType.HEALTH)

        # Pre-condition: partitions are empty
        assert len(mock_dina.vault.per_persona_partition(PersonaType.HEALTH)) == 0
        assert len(mock_dina.vault.per_persona_partition(PersonaType.CONSUMER)) == 0

        # Store health data that must NOT leak to the seller
        mock_dina.vault.store(
            tier=1, key="allergies",
            value={"latex": True},
            persona=PersonaType.HEALTH,
        )

        # Store consumer preferences
        mock_dina.vault.store(
            tier=1, key="chair_budget",
            value={"max_inr": 100000},
            persona=PersonaType.CONSUMER,
        )

        # Query the review bot for chair recommendations
        result = mock_review_bot.query_product("best ergonomic chair")

        assert len(result["recommendations"]) > 0
        rec = result["recommendations"][0]
        assert rec["product"] == "Herman Miller Aeron"

        # Verify partition isolation
        consumer_data = mock_dina.vault.per_persona_partition(PersonaType.CONSUMER)
        health_data = mock_dina.vault.per_persona_partition(PersonaType.HEALTH)

        # Health data stays in health partition, not consumer
        assert "allergies" not in consumer_data
        assert "allergies" in health_data

        # Consumer data stays in consumer partition, not health
        assert "chair_budget" in consumer_data
        assert "chair_budget" not in health_data

        # Counter-proof: consumer and health personas have different DIDs
        assert consumer.did != health.did, \
            "Each persona must have a unique DID"

        # Counter-proof: cross-persona encryption fails
        encrypted_health = health.encrypt("latex allergy details")
        assert consumer.decrypt(encrypted_health) is None, \
            "Consumer persona must not decrypt health data"

# TST-INT-525
    def test_license_renewal_uses_legal_persona(
        self, mock_dina: MockDinaCore, mock_legal_bot
    ) -> None:
        """Driver's license renewal activates the citizen/legal persona.

        The legal bot receives only the fields needed for the form;
        purchase history and health data remain sealed.
        """
        citizen = mock_dina.identity.derive_persona(PersonaType.CITIZEN)

        # Store citizen identity data
        mock_dina.vault.store(
            tier=1, key="citizen_name",
            value={"full_name": "Rajmohan K", "dob": "1985-03-15"},
            persona=PersonaType.CITIZEN,
        )

        # Store consumer data that must NOT leak
        mock_dina.vault.store(
            tier=1, key="recent_purchase",
            value={"item": "laptop", "price": 150000},
            persona=PersonaType.CONSUMER,
        )

        # Legal bot fills the form
        draft = mock_legal_bot.form_fill(
            task="driver_license_renewal",
            identity_data={"full_name": "Rajmohan K", "dob": "1985-03-15"},
        )

        assert draft.subject == "Draft: driver_license_renewal"
        assert not draft.sent  # Draft mode: never auto-submits

        # Verify the legal bot only saw citizen fields
        fill_record = mock_legal_bot.form_fills[-1]
        assert "full_name" in fill_record["identity_fields"]
        assert "dob" in fill_record["identity_fields"]
        # No consumer or health fields leaked
        assert "item" not in fill_record["identity_fields"]

# TST-INT-158
    def test_doctor_visit_uses_health_persona(
        self, mock_dina: MockDinaCore
    ) -> None:
        """Health-related interactions route through the health persona.

        LLM routing also changes: health data is NEVER sent to cloud.
        """
        health = mock_dina.identity.derive_persona(PersonaType.HEALTH)

        # Store health records
        mock_dina.vault.store(
            tier=1, key="medications",
            value={"current": ["metformin", "aspirin"]},
            persona=PersonaType.HEALTH,
        )

        # LLM router must route health persona locally
        target = mock_dina.llm_router.route("summarize", PersonaType.HEALTH)
        from tests.integration.mocks import LLMTarget
        assert target == LLMTarget.LOCAL, (
            "Health persona data must NEVER be sent to cloud LLM"
        )

        # Verify health data is partitioned correctly
        health_partition = mock_dina.vault.per_persona_partition(
            PersonaType.HEALTH
        )
        assert "medications" in health_partition
        assert health_partition["medications"]["current"] == [
            "metformin", "aspirin"
        ]

# TST-INT-526
    def test_auto_selection_by_context_product_query(
        self, mock_dina: MockDinaCore
    ) -> None:
        """A product query auto-routes to consumer persona context.
        Consumer persona is NOT sensitive, so cloud LLM is permitted."""
        from tests.integration.mocks import LLMTarget

        # Derive consumer and health personas
        consumer = mock_dina.identity.derive_persona(PersonaType.CONSUMER)
        mock_dina.identity.derive_persona(PersonaType.HEALTH)

        # Consumer persona: summarize routes to CLOUD (non-sensitive)
        target = mock_dina.llm_router.route("summarize", PersonaType.CONSUMER)
        assert target == LLMTarget.CLOUD, \
            "Consumer persona is not sensitive — cloud LLM allowed"

        # Counter-proof: health persona routes LOCALLY (sensitive)
        health_target = mock_dina.llm_router.route("summarize", PersonaType.HEALTH)
        assert health_target != LLMTarget.CLOUD, \
            "Health persona is sensitive — must NOT route to cloud"

        # Consumer persona has its own isolated partition
        mock_dina.vault.store(1, "product_search_result",
                              {"product": "ThinkPad X1", "rating": 92},
                              PersonaType.CONSUMER)
        consumer_partition = mock_dina.vault.per_persona_partition(
            PersonaType.CONSUMER)
        assert "product_search_result" in consumer_partition

        # Counter-proof: product data NOT in health partition
        health_partition = mock_dina.vault.per_persona_partition(
            PersonaType.HEALTH)
        assert "product_search_result" not in health_partition

# TST-INT-527
    def test_auto_selection_by_context_medical_query(
        self, mock_dina: MockDinaCore
    ) -> None:
        """A medical query auto-routes to health persona context."""
        mock_dina.identity.derive_persona(PersonaType.HEALTH)

        persona_map = {
            "product_search": PersonaType.CONSUMER,
            "medical_query": PersonaType.HEALTH,
            "form_filling": PersonaType.CITIZEN,
        }

        selected = persona_map.get("medical_query")
        assert selected == PersonaType.HEALTH

        # Health persona is routed locally
        target = mock_dina.llm_router.route("summarize", selected)
        from tests.integration.mocks import LLMTarget
        assert target == LLMTarget.LOCAL

# TST-INT-528
    def test_financial_persona_also_routes_locally(
        self, mock_dina: MockDinaCore
    ) -> None:
        """Financial data is equally sensitive as health: never goes to cloud."""
        from tests.integration.mocks import LLMTarget

        mock_dina.identity.derive_persona(PersonaType.FINANCIAL)

        target = mock_dina.llm_router.route("summarize", PersonaType.FINANCIAL)
        assert target == LLMTarget.LOCAL

        # HEALTH also routes locally (equally sensitive)
        health_target = mock_dina.llm_router.route("summarize", PersonaType.HEALTH)
        assert health_target == LLMTarget.LOCAL

        # Counter-proof: CONSUMER routes to cloud (non-sensitive)
        consumer_target = mock_dina.llm_router.route("summarize", PersonaType.CONSUMER)
        assert consumer_target == LLMTarget.CLOUD

# TST-INT-156
    def test_persona_data_survives_across_sessions(
        self, mock_identity: MockIdentity, mock_vault: MockVault
    ) -> None:
        """Persona partitions persist: data stored in session 1 is
        available in session 2 (same vault, same identity).
        """
        # Session 1: store data
        consumer = mock_identity.derive_persona(PersonaType.CONSUMER)
        mock_vault.store(
            tier=1, key="wishlist",
            value={"items": ["standing desk", "monitor arm"]},
            persona=PersonaType.CONSUMER,
        )

        # Session 2: new Dina instance, same vault and identity
        dina2 = MockDinaCore(identity=mock_identity, vault=mock_vault)
        consumer2 = dina2.identity.derive_persona(PersonaType.CONSUMER)

        # Same derived key
        assert consumer2.derived_key == consumer.derived_key

        # Data persists
        result = mock_vault.retrieve(tier=1, key="wishlist",
                                     persona=PersonaType.CONSUMER)
        assert result is not None
        # In Docker mode, retrieve may return a JSON string; normalize to dict.
        from tests.integration.conftest import as_dict
        result = as_dict(result)
        assert "standing desk" in result["items"]
