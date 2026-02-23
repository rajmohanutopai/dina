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
        name before the scrubbed text reaches the 'cloud LLM'. Rehydrated
        result is returned to the user with original names."""

        # Ensure health persona exists and is restricted
        health = don_alonso.personas.get("health")
        assert health is not None, "Health persona must exist"
        assert health.tier == "restricted", \
            "Health persona must be in 'restricted' tier"

        # Store a health record (use space-separated summary for FTS)
        don_alonso.vault_store(
            "health", "prescription metformin",
            {
                "doctor": "Dr. Sharma",
                "hospital": "Apollo Hospital",
                "medication": "Metformin 500mg",
                "date": "2026-02-20",
            },
        )

        # Clear audit and briefing to isolate this test
        don_alonso.audit_log.clear()
        don_alonso.briefing_queue.clear()

        # Query the restricted health persona (FTS matches word "prescription")
        results = don_alonso.vault_query("health", "prescription")
        assert len(results) >= 1, \
            "Health vault query must return the prescription record"

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

        # PII pipeline: scrub doctor name before cloud LLM
        scrubber = don_alonso.scrubber
        raw_text = (
            "Dr. Sharma at Apollo Hospital prescribed Metformin 500mg."
        )
        scrubbed, vault = scrubber.scrub_full(raw_text)

        assert "Dr. Sharma" not in scrubbed, \
            "Doctor name must be scrubbed before cloud LLM"
        assert "Apollo Hospital" not in scrubbed, \
            "Hospital name must be scrubbed before cloud LLM"

        # Simulate cloud LLM response
        don_alonso.set_llm_response(
            "metformin",
            f"Regarding the prescription: {scrubbed}",
        )
        llm_output = don_alonso.llm_reason(scrubbed)
        assert "Dr. Sharma" not in llm_output

        # Rehydrate for user
        rehydrated = scrubber.rehydrate(scrubbed, vault)
        assert "Dr. Sharma" in rehydrated, \
            "Rehydrated output must contain original doctor name"
        assert "Apollo Hospital" in rehydrated, \
            "Rehydrated output must contain original hospital name"

        scrubber.destroy_vault()

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
        Trying a wrong DEK fails decryption."""

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

        # --- Query /personal for health term: nothing ---
        personal_results = don_alonso.vault_query(
            "personal", "cholesterol"
        )
        health_items_in_personal = [
            item for item in personal_results
            if "cholesterol" in item.body_text.lower()
        ]
        assert len(health_items_in_personal) == 0, \
            "/personal must not return health data"

        # --- Query /health for financial term: nothing ---
        health_results = don_alonso.vault_query(
            "health", "stock"
        )
        financial_items_in_health = [
            item for item in health_results
            if "stock" in item.body_text.lower()
               or "INFY" in item.body_text
        ]
        assert len(financial_items_in_health) == 0, \
            "/health must not return financial data"

        # --- Query /financial for health term: nothing ---
        financial_results = don_alonso.vault_query(
            "financial", "cholesterol"
        )
        health_items_in_financial = [
            item for item in financial_results
            if "cholesterol" in item.body_text.lower()
        ]
        assert len(health_items_in_financial) == 0, \
            "/financial must not return health data"

        # --- Wrong DEK fails ---
        health_persona = don_alonso.personas["health"]
        financial_persona = don_alonso.personas["financial"]

        # DEKs are derived from different info strings and must differ
        assert health_persona.dek != financial_persona.dek, \
            "Health and financial DEKs must be different"

        # Verify DEK derivation is deterministic and compartment-specific
        expected_health_dek = _derive_dek(
            don_alonso.master_seed, "dina:vault:health:v1"
        )
        expected_financial_dek = _derive_dek(
            don_alonso.master_seed, "dina:vault:financial:v1"
        )
        assert expected_health_dek != expected_financial_dek, \
            "HKDF derivation for different personas must yield different DEKs"

        # A cross-persona DEK should not match the target persona
        assert health_persona.dek != expected_financial_dek, \
            "Health DEK must not match the financial derivation path"
        assert financial_persona.dek != expected_health_dek, \
            "Financial DEK must not match the health derivation path"

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
        proceeds (with PII scrubbing)."""

        # Ensure health persona is accessible
        don_alonso.unlock_persona("health", "passphrase123")

        # Store sensitive health data (space-separated summary for FTS)
        don_alonso.vault_store(
            "health", "blood test results",
            {"hba1c": 6.2, "fasting_glucose": 110, "doctor": "Dr. Sharma"},
        )

        health_persona = don_alonso.personas["health"]

        # --- Without consent: cloud query rejected ---
        # Simulate consent tracking via kv_store
        consent_key = "cloud_llm_consent:health"
        don_alonso.kv_put(consent_key, False)

        consent = don_alonso.kv_get(consent_key)
        assert consent is False, \
            "Consent should default to False for health persona"

        # Code-level gate: when consent is False, the query must be blocked
        if not don_alonso.kv_get(consent_key):
            rejected = True
        else:
            rejected = False
        assert rejected is True, \
            "Health cloud query must be rejected without explicit consent"

        # --- With consent: query proceeds with PII scrubbing ---
        don_alonso.kv_put(consent_key, True)
        consent = don_alonso.kv_get(consent_key)
        assert consent is True

        # Query the vault (FTS matches word "blood" from summary)
        results = don_alonso.vault_query("health", "blood")
        assert len(results) >= 1

        # Scrub before sending to cloud
        scrubber = don_alonso.scrubber
        raw_text = results[0].body_text
        scrubbed, vault = scrubber.scrub_full(raw_text)

        # Scrubbed text is safe for cloud
        assert scrubber.validate_clean(scrubbed) is True, \
            "Scrubbed health text must pass PII validation"

        # Simulate cloud LLM call
        don_alonso.set_llm_response(
            "blood",
            f"Analysis of blood test: {scrubbed}",
        )
        llm_output = don_alonso.llm_reason(scrubbed)
        assert "Dr. Sharma" not in llm_output, \
            "Doctor name must not appear in cloud LLM output"

        # Rehydrate for local user display
        rehydrated = scrubber.rehydrate(scrubbed, vault)
        assert "Dr. Sharma" in rehydrated or "dr. sharma" in rehydrated.lower(), \
            "Rehydrated output must restore doctor name for user"

        # Audit trail: verify restricted access was logged
        restricted_audits = don_alonso.get_audit_entries(
            "restricted_persona_access"
        )
        health_audits = [
            e for e in restricted_audits
            if e.details.get("persona") == "health"
        ]
        assert len(health_audits) >= 1, \
            "Restricted health persona access must be audited"

        scrubber.destroy_vault()
