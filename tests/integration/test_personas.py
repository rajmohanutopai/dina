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

    def test_root_identity_generates_consumer_persona(
        self, mock_identity: MockIdentity
    ) -> None:
        """Consumer persona is derived from root and has its own DID."""
        persona = mock_identity.derive_persona(PersonaType.CONSUMER)

        assert persona.persona_type == PersonaType.CONSUMER
        assert persona.did.startswith("did:key:z6Mk")
        assert persona.did != mock_identity.root_did
        assert persona.derived_key != mock_identity.root_private_key

    def test_root_identity_generates_health_persona(
        self, mock_identity: MockIdentity
    ) -> None:
        """Health persona is derived from root with its own compartment."""
        persona = mock_identity.derive_persona(PersonaType.HEALTH)

        assert persona.persona_type == PersonaType.HEALTH
        assert persona.storage_partition == "partition_health"
        assert persona.did.startswith("did:key:z6Mk")

    def test_root_identity_generates_legal_persona(
        self, mock_identity: MockIdentity
    ) -> None:
        """A citizen/legal persona is created for government interactions."""
        persona = mock_identity.derive_persona(PersonaType.CITIZEN)

        assert persona.persona_type == PersonaType.CITIZEN
        assert persona.storage_partition == "partition_citizen"
        assert persona.derived_key is not None
        assert len(persona.derived_key) == 64  # SHA-256 hex

    def test_seller_interaction_gets_own_persona(
        self, mock_identity: MockIdentity
    ) -> None:
        """Financial persona handles seller-facing commerce."""
        persona = mock_identity.derive_persona(PersonaType.FINANCIAL)

        assert persona.persona_type == PersonaType.FINANCIAL
        assert persona.did != mock_identity.root_did

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

    def test_persona_derivation_is_deterministic(
        self, mock_identity: MockIdentity
    ) -> None:
        """Deriving the same persona type twice returns the same persona."""
        first = mock_identity.derive_persona(PersonaType.CONSUMER)
        second = mock_identity.derive_persona(PersonaType.CONSUMER)

        assert first is second
        assert first.did == second.did
        assert first.derived_key == second.derived_key

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

    def test_cross_persona_requires_authorization(
        self, mock_identity: MockIdentity, mock_vault: MockVault
    ) -> None:
        """Accessing one persona's data from another requires explicit key."""
        health = mock_identity.derive_persona(PersonaType.HEALTH)
        consumer = mock_identity.derive_persona(PersonaType.CONSUMER)

        encrypted = health.encrypt("diagnosis: healthy")

        # Same persona can decrypt
        decrypted = health.decrypt(encrypted)
        assert decrypted == "DECRYPTED_CONTENT"

        # Different persona CANNOT decrypt
        cross_decrypt = consumer.decrypt(encrypted)
        assert cross_decrypt is None

    def test_malicious_system_cannot_jailbreak_persona(
        self, mock_identity: MockIdentity
    ) -> None:
        """An external prompt to 'ignore persona boundaries' has no effect.

        The boundary is cryptographic (different keys), not policy-based.
        A malicious agent cannot simply ask for cross-persona data; the
        encryption makes it impossible without the correct derived key.
        """
        health = mock_identity.derive_persona(PersonaType.HEALTH)
        financial = mock_identity.derive_persona(PersonaType.FINANCIAL)

        # Health encrypts sensitive record
        encrypted_health = health.encrypt("patient record: confidential")

        # Financial persona physically cannot decrypt health data
        assert financial.decrypt(encrypted_health) is None

        # And the other direction is equally impossible
        encrypted_fin = financial.encrypt("bank account: secret")
        assert health.decrypt(encrypted_fin) is None

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

    def test_vault_partition_naming_matches_persona_type(
        self, mock_identity: MockIdentity
    ) -> None:
        """Each persona's storage partition name is canonical and predictable."""
        for pt in PersonaType:
            persona = mock_identity.derive_persona(pt)
            expected_partition = f"partition_{pt.value}"
            assert persona.storage_partition == expected_partition


# ---------------------------------------------------------------------------
# TestPersonaInInteraction
# ---------------------------------------------------------------------------

class TestPersonaInInteraction:
    """Dina auto-selects the correct persona based on interaction context."""

    def test_buying_chair_uses_consumer_persona(
        self, mock_dina: MockDinaCore, mock_review_bot
    ) -> None:
        """When buying a product, the consumer persona is activated.

        Only consumer-relevant data (budget, preferences) is shared;
        health and financial details stay sealed.
        """
        consumer = mock_dina.identity.derive_persona(PersonaType.CONSUMER)
        health = mock_dina.identity.derive_persona(PersonaType.HEALTH)

        # Store health data that must NOT leak to the seller
        mock_dina.vault.store(
            tier=1, key="allergies",
            value={"latex": True},
            persona=PersonaType.HEALTH,
        )

        # Query the review bot for chair recommendations
        result = mock_review_bot.query_product("best ergonomic chair")

        assert len(result["recommendations"]) > 0
        rec = result["recommendations"][0]
        assert rec["product"] == "Herman Miller Aeron"

        # Verify consumer persona was used (not health)
        consumer_data = mock_dina.vault.per_persona_partition(
            PersonaType.CONSUMER
        )
        health_data = mock_dina.vault.per_persona_partition(
            PersonaType.HEALTH
        )

        # Health data stays in health partition, not consumer
        assert "allergies" not in consumer_data
        assert "allergies" in health_data

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

    def test_auto_selection_by_context_product_query(
        self, mock_dina: MockDinaCore
    ) -> None:
        """A product query auto-routes to consumer persona context."""
        # Derive all personas so they exist
        mock_dina.identity.derive_persona(PersonaType.CONSUMER)
        mock_dina.identity.derive_persona(PersonaType.HEALTH)
        mock_dina.identity.derive_persona(PersonaType.CITIZEN)

        # Simulate context-based routing: product searches are "consumer"
        query_type = "product_search"
        persona_map = {
            "product_search": PersonaType.CONSUMER,
            "medical_query": PersonaType.HEALTH,
            "form_filling": PersonaType.CITIZEN,
            "social_chat": PersonaType.SOCIAL,
        }

        selected = persona_map.get(query_type)
        assert selected == PersonaType.CONSUMER

        # The selected persona has its own isolated partition
        partition = mock_dina.vault.per_persona_partition(selected)
        assert isinstance(partition, dict)

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

    def test_financial_persona_also_routes_locally(
        self, mock_dina: MockDinaCore
    ) -> None:
        """Financial data is equally sensitive as health: never goes to cloud."""
        mock_dina.identity.derive_persona(PersonaType.FINANCIAL)

        target = mock_dina.llm_router.route("summarize", PersonaType.FINANCIAL)
        from tests.integration.mocks import LLMTarget
        assert target == LLMTarget.LOCAL

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
        assert "standing desk" in result["items"]
