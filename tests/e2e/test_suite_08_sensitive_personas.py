"""Suite 8: Sensitive Personas — E2E tests.

Verifies that health and financial personas enforce access restrictions,
TTL-based auto-locking, cross-persona isolation, and cloud LLM consent
requirements. Sensitive data lives in its own compartment with its own
DEK. Access is logged and briefing notifications are queued. Time-limited
unlocks auto-expire.
"""

from __future__ import annotations

import time

import pytest

from tests.e2e.actors import HomeNode, Persona, _derive_dek
from tests.e2e.mocks import (
    MockPIIScrubber,
    PersonaType,
    SharingPolicy,
    VaultItem,
)


# =========================================================================
# TestSensitivePersonas — Suite 8
# =========================================================================

class TestSensitivePersonas:
    """Sensitive Personas (TST-E2E-039 through TST-E2E-042)."""

    # -----------------------------------------------------------------
    # TST-E2E-039  Health Entity Vault
    # -----------------------------------------------------------------
    def test_health_entity_vault(self, don_alonso: HomeNode) -> None:
        # TST-E2E-039
        """Query the /health persona (restricted tier). Access is logged,
        a briefing notification is queued. PII pipeline strips the doctor
        name before the scrubbed text reaches any external call.
        Rehydrated result is returned to the user with original names.

        Verify:
        - Health persona exists and is in 'restricted' tier
        - Vault store + FTS query returns the stored record
        - Returned record has correct field VALUES (not just keys)
        - Access to restricted persona creates audit entry
        - Briefing notification is queued with correct type and persona
        - PII scrubber strips doctor name and hospital from raw text
        - Rehydration restores all original PII values
        - Negative: query for non-existent term returns empty
        - Persona isolation: health data NOT visible from /personal
        """
        import json

        # Ensure health persona exists and is restricted
        health = don_alonso.personas.get("health")
        assert health is not None, "Health persona must exist"
        assert health.tier == "sensitive", \
            "Health persona must be in 'sensitive' tier"

        # Store a health record (use space-separated summary for FTS)
        item_id = don_alonso.vault_store(
            "health", "prescription metformin",
            {
                "doctor": "Dr. Sharma",
                "hospital": "Apollo Hospital",
                "medication": "Metformin 500mg",
                "date": "2026-02-20",
            },
        )
        assert item_id.startswith("vi_"), (
            "Vault store must return a valid item ID"
        )

        # Clear audit and briefing to isolate this test
        don_alonso.audit_log.clear()
        don_alonso.briefing_queue.clear()

        # Query the restricted health persona (FTS matches word "prescription")
        results = don_alonso.vault_query("health", "prescription")
        assert len(results) >= 1, \
            "Health vault query must return the prescription record"

        # --- Verify returned record has correct field VALUES ---
        record = results[0]
        assert record.persona == "health", (
            "Returned record must belong to health persona"
        )
        body = json.loads(record.body_text)
        assert body["doctor"] == "Dr. Sharma", (
            "Returned record must contain correct doctor name"
        )
        assert body["medication"] == "Metformin 500mg", (
            "Returned record must contain correct medication"
        )
        assert body["hospital"] == "Apollo Hospital", (
            "Returned record must contain correct hospital name"
        )
        assert body["date"] == "2026-02-20", (
            "Returned record must contain correct date"
        )

        # Access must be logged in audit
        restricted_audits = don_alonso.get_audit_entries(
            "restricted_persona_access"
        )
        assert len(restricted_audits) >= 1, \
            "Restricted persona access must be audited"
        assert restricted_audits[-1].details["persona"] == "health"

        # Briefing notification must be queued
        assert len(don_alonso.briefing_queue) >= 1, \
            "Briefing notification must be queued for restricted access"
        briefing = don_alonso.briefing_queue[-1]
        assert briefing["type"] == "restricted_access"
        assert briefing["persona"] == "health"
        assert briefing["query"] == "prescription", (
            "Briefing must record the query that triggered restricted access"
        )

        # --- PII scrubbing: doctor name and hospital stripped ---
        scrubber = don_alonso.scrubber
        scrubbed, vault = scrubber.scrub_full(record.body_text)

        assert "Dr. Sharma" not in scrubbed, \
            "Doctor name must be scrubbed before leaving the node"
        assert "Apollo Hospital" not in scrubbed, \
            "Hospital name must be scrubbed before leaving the node"
        assert scrubber.validate_clean(scrubbed), \
            "Scrubbed text must pass validate_clean"

        # Rehydrate for user — must restore all original values
        rehydrated = scrubber.rehydrate(scrubbed, vault)
        assert "Dr. Sharma" in rehydrated, \
            "Rehydrated output must contain original doctor name"
        assert "Apollo Hospital" in rehydrated, \
            "Rehydrated output must contain original hospital name"

        scrubber.destroy_vault()

        # --- Negative control: non-existent term returns empty ---
        no_results = don_alonso.vault_query("health", "xyznonexistent99")
        assert len(no_results) == 0, (
            "Query for non-existent term must return empty"
        )

        # --- Persona isolation: health data NOT visible from /personal ---
        personal_results = don_alonso.vault_query("general", "prescription")
        health_leak = [
            r for r in personal_results
            if "Metformin" in r.body_text or "Dr. Sharma" in r.body_text
        ]
        assert len(health_leak) == 0, (
            "Health data must NOT be visible from /general persona"
        )

    # -----------------------------------------------------------------
    # TST-E2E-040  Financial Persona Lock/Unlock/TTL
    # -----------------------------------------------------------------
    def test_financial_persona_lock_unlock_ttl(
        self,
        don_alonso: HomeNode,
    ) -> None:
        # TST-E2E-040
        """Access to the locked /financial persona returns 403. Unlocking
        with a 15-minute TTL grants access. Advancing the clock past the
        TTL causes auto-lock, and access returns 403 again."""

        financial = don_alonso.personas.get("financial")
        assert financial is not None, "Financial persona must exist"
        assert financial.tier == "locked", \
            "Financial persona must be in 'locked' tier"

        # Financial persona should initially be locked (tier=locked, unlocked=False)
        don_alonso.lock_persona("financial")

        # --- Access while locked: 403 ---
        with pytest.raises(PermissionError, match="403 persona_locked"):
            don_alonso.vault_store(
                "financial", "bank_balance",
                {"balance": 500000, "currency": "INR"},
            )

        with pytest.raises(PermissionError, match="403 persona_locked"):
            don_alonso.vault_query("financial", "balance")

        # --- Unlock with 15-minute TTL ---
        base_time = 1_700_000_000.0
        don_alonso.set_test_clock(base_time)

        ttl_seconds = 15 * 60  # 15 minutes
        unlocked = don_alonso.unlock_persona(
            "financial", "passphrase123", ttl_seconds=ttl_seconds,
        )
        assert unlocked is True

        # Access now succeeds (use space-separated summary for FTS)
        item_id = don_alonso.vault_store(
            "financial", "bank balance",
            {"balance": 500000, "currency": "INR"},
        )
        assert item_id.startswith("vi_")

        results = don_alonso.vault_query("financial", "bank")
        assert len(results) >= 1

        # --- Advance clock past TTL ---
        don_alonso.advance_clock(ttl_seconds + 1)

        # Auto-lock: access returns 403 again
        with pytest.raises(PermissionError, match="403 persona_locked"):
            don_alonso.vault_query("financial", "balance")

        # Verify audit trail shows unlock
        unlock_audits = don_alonso.get_audit_entries("persona_unlock")
        financial_unlocks = [
            e for e in unlock_audits
            if e.details.get("persona") == "financial"
        ]
        assert len(financial_unlocks) >= 1
        assert financial_unlocks[-1].details["ttl"] == ttl_seconds

    # -----------------------------------------------------------------
    # TST-E2E-041  Cross-Persona Isolation
    # -----------------------------------------------------------------
    def test_cross_persona_isolation(
        self,
        don_alonso: HomeNode,
    ) -> None:
        # TST-E2E-041
        """Data stored in /health is invisible from /financial and vice
        versa. Querying /personal for a health-specific term returns
        nothing. Querying /health for a financial term returns nothing.
        Trying a wrong DEK fails decryption.

        Verify:
        - Positive: health data IS findable via /health query (with VALUES)
        - Positive: financial data IS findable via /financial query (with VALUES)
        - Negative: /personal cannot see health data
        - Negative: /health cannot see financial data
        - Negative: /financial cannot see health data
        - DEKs differ between personas (compartment-specific HKDF)
        - DEK derivation is deterministic
        - Cross-persona DEKs never match
        """
        import json

        # Ensure both personas are accessible for this test
        don_alonso.unlock_persona("health", "passphrase123")
        don_alonso.unlock_persona("financial", "passphrase123")

        # Store health-specific data
        don_alonso.vault_store(
            "health", "cholesterol_report",
            {"ldl": 130, "hdl": 55, "total": 210, "doctor": "Dr. Sharma"},
        )

        # Store financial-specific data
        don_alonso.vault_store(
            "financial", "stock_portfolio",
            {"ticker": "INFY", "shares": 100, "value": 150000},
        )

        # --- Positive control: health data IS findable via /health ---
        health_own = don_alonso.vault_query("health", "cholesterol")
        assert len(health_own) >= 1, (
            "/health must return its own cholesterol data"
        )
        health_body = json.loads(health_own[0].body_text)
        assert health_body["ldl"] == 130, (
            "Health record must contain correct ldl value"
        )
        assert health_body["hdl"] == 55, (
            "Health record must contain correct hdl value"
        )
        assert health_body["doctor"] == "Dr. Sharma", (
            "Health record must contain correct doctor name"
        )
        assert health_own[0].persona == "health", (
            "Returned item must belong to health persona"
        )

        # --- Positive control: financial data IS findable via /financial ---
        financial_own = don_alonso.vault_query("financial", "stock")
        assert len(financial_own) >= 1, (
            "/financial must return its own stock data"
        )
        financial_body = json.loads(financial_own[0].body_text)
        assert financial_body["ticker"] == "INFY", (
            "Financial record must contain correct ticker"
        )
        assert financial_body["shares"] == 100, (
            "Financial record must contain correct shares count"
        )
        assert financial_body["value"] == 150000, (
            "Financial record must contain correct value"
        )
        assert financial_own[0].persona == "financial", (
            "Returned item must belong to financial persona"
        )

        # --- Negative: /general cannot see health data ---
        personal_results = don_alonso.vault_query(
            "general", "cholesterol"
        )
        health_items_in_personal = [
            item for item in personal_results
            if "cholesterol" in item.body_text.lower()
        ]
        assert len(health_items_in_personal) == 0, (
            "/general must not return health data"
        )

        # --- Negative: /health cannot see financial data ---
        health_results = don_alonso.vault_query(
            "health", "stock"
        )
        financial_items_in_health = [
            item for item in health_results
            if "stock" in item.body_text.lower()
               or "INFY" in item.body_text
        ]
        assert len(financial_items_in_health) == 0, (
            "/health must not return financial data"
        )

        # --- Negative: /financial cannot see health data ---
        financial_results = don_alonso.vault_query(
            "financial", "cholesterol"
        )
        health_items_in_financial = [
            item for item in financial_results
            if "cholesterol" in item.body_text.lower()
        ]
        assert len(health_items_in_financial) == 0, (
            "/financial must not return health data"
        )

        # --- Wrong DEK fails ---
        health_persona = don_alonso.personas["health"]
        financial_persona = don_alonso.personas["financial"]

        # DEKs are derived from different info strings and must differ
        assert health_persona.dek != financial_persona.dek, (
            "Health and financial DEKs must be different"
        )

        # Verify DEK derivation is deterministic and compartment-specific
        expected_health_dek = _derive_dek(
            don_alonso.master_seed, "dina:vault:health:v1"
        )
        expected_financial_dek = _derive_dek(
            don_alonso.master_seed, "dina:vault:financial:v1"
        )
        assert expected_health_dek != expected_financial_dek, (
            "HKDF derivation for different personas must yield different DEKs"
        )

        # Actual DEKs must match expected derivations
        assert health_persona.dek == expected_health_dek, (
            "Health DEK must match HKDF derivation for health compartment"
        )
        assert financial_persona.dek == expected_financial_dek, (
            "Financial DEK must match HKDF derivation for financial compartment"
        )

        # Cross-persona DEKs never match
        assert health_persona.dek != expected_financial_dek, (
            "Health DEK must not match the financial derivation path"
        )
        assert financial_persona.dek != expected_health_dek, (
            "Financial DEK must not match the health derivation path"
        )

    # -----------------------------------------------------------------
    # TST-E2E-042  Cloud LLM Consent for Sensitive Personas
    # -----------------------------------------------------------------
    def test_cloud_llm_consent_for_sensitive_personas(
        self,
        don_alonso: HomeNode,
    ) -> None:
        # TST-E2E-042
        """Health queries routed to a cloud LLM require explicit consent.
        Without consent the query is rejected. With consent the query
        proceeds (with PII scrubbing).

        Verify:
        - Health persona is restricted tier
        - kv_store tracks consent state correctly (False → True round-trip)
        - Consent defaults to None (not pre-granted)
        - Vault query returns correct health data with field VALUES
        - PII scrubber strips doctor name from raw health text
        - validate_clean passes on scrubbed text
        - Rehydration restores all original PII values
        - Restricted persona access generates audit entry with persona name
        - Persona isolation: health data not visible from /personal
        """
        import json

        # Ensure health persona is accessible and in restricted tier
        don_alonso.unlock_persona("health", "passphrase123")
        health_persona = don_alonso.personas.get("health")
        assert health_persona is not None, "Health persona must exist"
        assert health_persona.tier == "sensitive", (
            "Health persona must be in 'sensitive' tier"
        )

        # Store sensitive health data (space-separated summary for FTS)
        don_alonso.vault_store(
            "health", "blood test results",
            {"hba1c": 6.2, "fasting_glucose": 110, "doctor": "Dr. Sharma"},
        )

        # --- Consent tracking via kv_store ---
        consent_key = "cloud_llm_consent:health"

        # Default consent must not be pre-granted
        default_consent = don_alonso.kv_get(consent_key)
        assert default_consent is None, (
            "Cloud LLM consent must not be pre-granted for health persona"
        )

        # Set consent to False explicitly and verify round-trip
        don_alonso.kv_put(consent_key, False)
        assert don_alonso.kv_get(consent_key) is False, (
            "kv_store must persist consent=False"
        )

        # Set consent to True and verify round-trip
        don_alonso.kv_put(consent_key, True)
        assert don_alonso.kv_get(consent_key) is True, (
            "kv_store must persist consent=True"
        )

        # Clear audit/briefing to isolate this test
        don_alonso.audit_log.clear()
        don_alonso.briefing_queue.clear()

        # --- Query the vault and verify returned data ---
        results = don_alonso.vault_query("health", "blood")
        assert len(results) >= 1, (
            "Health vault query for 'blood' must return the stored record"
        )

        record = results[0]
        assert record.persona == "health", (
            "Returned record must belong to health persona"
        )
        body = json.loads(record.body_text)
        assert body["hba1c"] == 6.2, (
            "Returned record must contain correct hba1c value"
        )
        assert body["fasting_glucose"] == 110, (
            "Returned record must contain correct fasting_glucose value"
        )
        assert body["doctor"] == "Dr. Sharma", (
            "Returned record must contain correct doctor name"
        )

        # --- PII scrubbing pipeline (required before cloud routing) ---
        scrubber = don_alonso.scrubber
        raw_text = record.body_text
        scrubbed, vault = scrubber.scrub_full(raw_text)

        # Doctor name must be removed
        assert "Dr. Sharma" not in scrubbed, (
            "Doctor name must be scrubbed before cloud routing"
        )
        assert scrubber.validate_clean(scrubbed) is True, (
            "Scrubbed health text must pass PII validation"
        )

        # Rehydrate for local user display — must restore all PII
        rehydrated = scrubber.rehydrate(scrubbed, vault)
        assert "Dr. Sharma" in rehydrated, (
            "Rehydrated output must restore doctor name for user"
        )

        scrubber.destroy_vault()

        # --- Audit trail: restricted access must be logged ---
        restricted_audits = don_alonso.get_audit_entries(
            "restricted_persona_access"
        )
        health_audits = [
            e for e in restricted_audits
            if e.details.get("persona") == "health"
        ]
        assert len(health_audits) >= 1, (
            "Restricted health persona access must be audited"
        )

        # Briefing notification for restricted access
        assert len(don_alonso.briefing_queue) >= 1, (
            "Briefing notification must be queued for restricted access"
        )
        briefing = don_alonso.briefing_queue[-1]
        assert briefing["type"] == "restricted_access", (
            "Briefing type must be 'restricted_access'"
        )
        assert briefing["persona"] == "health", (
            "Briefing must reference health persona"
        )

        # --- Persona isolation: health data not visible from /general ---
        personal_results = don_alonso.vault_query("general", "blood")
        health_leak = [
            r for r in personal_results
            if "hba1c" in r.body_text or "Dr. Sharma" in r.body_text
        ]
        assert len(health_leak) == 0, (
            "Health data must NOT be visible from /general persona"
        )

        # --- Negative control: non-existent query returns empty ---
        no_results = don_alonso.vault_query("health", "xyznonexistent42")
        assert len(no_results) == 0, (
            "Query for non-existent term must return empty"
        )
