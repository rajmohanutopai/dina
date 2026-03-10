"""User Story 06: License Renewal — the Agent Safety Layer.

SEQUENTIAL TEST — tests MUST run in order (00 → 09).
Each test builds on state from the previous one.

Story
-----
Alonso uploads a driving license scan. Dina:

  1. **Ingestion (LLM):** Extracts structured fields (license number,
     holder name, expiry date, vehicle class, issuing RTO) with
     per-field confidence scores. PII stays in vault metadata only.

  2. **Monitoring (deterministic):** A scheduled reminder fires 30 days
     before expiry. No LLM — just a database query (the Deterministic
     Sandwich).

  3. **Notification (LLM):** Brain composes a contextual message using
     vault context — not just "license expires April 15" but
     "Your nearest RTO is Bangalore East. Last time it took 2 weeks."

  4. **Delegation (LLM + safety):** Brain generates a strict JSON
     DelegationRequest for an external RTO_Bot. Guardian validates
     PII enforcement and flags it for human review — the agent never
     holds your keys.

Why Dina is unique
------------------
No other system enforces the Agent Safety Layer. Autonomous agents
today operate without oversight — leaking credentials, accepting
commands from anyone, acting without guardrails. Dina is the safety
layer: submit intent before acting, approve before sharing data.

Pipeline
--------
::

  User uploads license scan
    → PII scrubber runs BEFORE LLM (raw PII never leaves Home Node)
    → Brain LLM extracts: license#, name, expiry, class, RTO
    → Confidence gate: only schedule reminder if expiry ≥ 0.95
    → Core stores: document + temporal reminder
                    ↓ (30 days before expiry)
  Core reminder loop fires (no LLM — deterministic)
    → Brain queries vault for personal context
    → PII scrubber runs BEFORE LLM (vault metadata scrubbed)
    → LLM composes contextual notification
                    ↓
  Brain generates DelegationRequest (strict JSON)
    → Guardian validates: PII not in permitted_fields or data_payload
    → Guardian: share_data → HIGH risk → flag_for_review
    → Human approves before any data leaves Home Node
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timedelta

import httpx
import pytest

# ---------------------------------------------------------------------------
# Shared state across ordered tests
# ---------------------------------------------------------------------------

_state: dict = {}

# The license document text (simulated OCR output).
LICENSE_TEXT = (
    "UNION OF INDIA — DRIVING LICENSE\n"
    "DL No: KA-01-2020-1234567\n"
    "Name: Alonso Quixano\n"
    "Date of Birth: 15-03-1985\n"
    "Valid Till: 15-04-2026\n"
    "Vehicle Class: LMV-NT\n"
    "Issuing Authority: RTO Bangalore East\n"
    "Address: 42 Windmill Street, Bangalore 560001"
)


# ---------------------------------------------------------------------------
# Test class — sequential user journey
# ---------------------------------------------------------------------------


class TestLicenseRenewal:
    """License Renewal: the Agent Safety Layer + Deterministic Sandwich."""

    # ==================================================================
    # test_00: Store personal context in vault
    # ==================================================================

    # TST-USR-050
    def test_00_store_personal_context(
        self, alonso_core, admin_headers, brain_headers,
    ):
        """Seed vault with personal context that Brain will use later.

        Items stored (PascalCase field names to match Go struct):
          - note: Home address is Bangalore East
          - finance_context: Vehicle insurance with ICICI Lombard
          - note: Last license renewal took 2 weeks at RTO Bangalore East
        """
        items = [
            {
                "Type": "note",
                "Source": "personal",
                "Summary": "Home address is 42 Windmill Street, Bangalore East 560001",
                "BodyText": "Primary residence in Bangalore East. Nearest RTO is RTO Bangalore East.",
            },
            {
                "Type": "finance_context",
                "Source": "insurance",
                "Summary": "Vehicle insurance with ICICI Lombard, policy #INS-12345",
                "BodyText": (
                    "Motor vehicle insurance active with ICICI Lombard. "
                    "Policy number INS-12345. Covers LMV-NT class. "
                    "Renewal due alongside driving license."
                ),
            },
            {
                "Type": "note",
                "Source": "personal",
                "Summary": "Last license renewal took 2 weeks at RTO Bangalore East",
                "BodyText": (
                    "Previous driving license renewal completed in 2020. "
                    "Process took approximately 2 weeks from application to receipt. "
                    "Required documents: old license, address proof, medical certificate."
                ),
            },
        ]

        stored_ids = []
        for item in items:
            r = httpx.post(
                f"{alonso_core}/v1/vault/store",
                json={"persona": "personal", "item": item},
                headers=admin_headers,
                timeout=10,
            )
            assert r.status_code in (200, 201), f"Store failed: {r.status_code} {r.text[:200]}"
            stored_ids.append(r.json().get("id", ""))

        _state["context_ids"] = stored_ids
        assert len(stored_ids) == 3

    # ==================================================================
    # test_01: Brain extracts license data (LLM)
    # ==================================================================

    # TST-USR-051
    @pytest.mark.skipif(
        not os.environ.get("GOOGLE_API_KEY"),
        reason="GOOGLE_API_KEY not set — skipping LLM extraction test",
    )
    def test_01_brain_extracts_license_data(
        self, alonso_brain, brain_headers,
    ):
        """Send document text to Brain → LLM extracts structured fields.

        Verifies:
          - Per-field confidence scores returned
          - Document + reminder stored in vault
          - License number flagged as PII
          - Brain successfully created a Core reminder (auth works)
        """
        r = httpx.post(
            f"{alonso_brain}/api/v1/process",
            json={
                "type": "document_ingest",
                "body": LICENSE_TEXT,
                "persona_id": "personal",
                "source": "document_scan",
            },
            headers=brain_headers,
            timeout=60,
        )
        assert r.status_code == 200, f"Ingest failed: {r.status_code} {r.text[:300]}"

        data = r.json()
        assert data.get("action") == "document_ingested", f"Unexpected action: {data}"

        response = data.get("response", {})
        fields = response.get("extracted_fields", {})
        vault_items = response.get("vault_items", {})
        reminder_id = response.get("reminder_id", "")

        # Store for subsequent tests.
        _state["extraction"] = fields
        _state["doc_id"] = vault_items.get("document_id", "")
        _state["reminder_vault_id"] = vault_items.get("reminder_vault_id", "")
        _state["reminder_id"] = reminder_id
        _state["llm_ingestion_ran"] = True

        # Verify fields were extracted.
        assert "expiry_date" in fields, f"Missing expiry_date in: {fields.keys()}"
        assert "license_number" in fields, f"Missing license_number in: {fields.keys()}"

        # Verify PII was flagged (all PII fields, not just license_number).
        pii = response.get("pii_scrubbed", [])
        assert "license_number" in pii, f"License number not flagged as PII: {pii}"

        # Fix 4: Brain MUST have created the reminder via Core.
        # If this is empty, the Brain→Core auth path is broken.
        assert reminder_id, (
            "Brain did not create a reminder — check that /v1/reminder "
            "is in the brain token allowlist (auth.go)"
        )

    # ==================================================================
    # test_02: Verify document + reminder in vault
    # ==================================================================

    # TST-USR-052
    def test_02_verify_vault_entries(
        self, alonso_core, admin_headers,
    ):
        """Verify both vault items were created correctly.

        If LLM test (01) was skipped, creates entries directly.
        """
        # Fallback: if LLM test was skipped, create entries directly.
        if not _state.get("llm_ingestion_ran"):
            doc_id = f"doc-{uuid.uuid4().hex[:12]}"
            r = httpx.post(
                f"{alonso_core}/v1/vault/store",
                json={
                    "persona": "personal",
                    "item": {
                        "id": doc_id,
                        "Type": "document",
                        "Source": "document_scan",
                        "Summary": "Driving License Document",
                        "BodyText": (
                            LICENSE_TEXT
                            .replace("KA-01-2020-1234567", "[LICENSE_NUMBER]")
                            .replace("Alonso Quixano", "[HOLDER_NAME]")
                            .replace("15-03-1985", "[DATE_OF_BIRTH]")
                            .replace("42 Windmill Street, Bangalore 560001", "[ADDRESS]")
                        ),
                        "Metadata": json.dumps({
                            "document_type": "driving_license",
                            "extracted_fields": {
                                "license_number": {"value": "KA-01-2020-1234567", "confidence": 0.99},
                                "holder_name": {"value": "Alonso Quixano", "confidence": 0.98},
                                "expiry_date": {"value": "2026-04-15", "confidence": 0.99},
                                "vehicle_class": {"value": "LMV-NT", "confidence": 0.98},
                                "issuing_rto": {"value": "RTO Bangalore East", "confidence": 0.96},
                                "address": {"value": "42 Windmill Street, Bangalore 560001", "confidence": 0.95},
                            },
                            "license_number": "KA-01-2020-1234567",
                        }),
                    },
                },
                headers=admin_headers,
                timeout=10,
            )
            assert r.status_code in (200, 201)

            reminder_vault_id = f"evt-{uuid.uuid4().hex[:12]}"
            r2 = httpx.post(
                f"{alonso_core}/v1/vault/store",
                json={
                    "persona": "personal",
                    "item": {
                        "id": reminder_vault_id,
                        "Type": "event",
                        "Source": "reminder_system",
                        "Summary": "License renewal due - 2026-04-15",
                        "BodyText": f"Driving license expires 2026-04-15. Document ID: {doc_id}",
                        "Metadata": json.dumps({
                            "trigger_date": "2026-04-15",
                            "document_id": doc_id,
                            "reminder_type": "license_expiry",
                        }),
                    },
                },
                headers=admin_headers,
                timeout=10,
            )
            assert r2.status_code in (200, 201)

            _state["doc_id"] = doc_id
            _state["reminder_vault_id"] = reminder_vault_id
            _state["extraction"] = {
                "license_number": {"value": "KA-01-2020-1234567", "confidence": 0.99},
                "holder_name": {"value": "Alonso Quixano", "confidence": 0.98},
                "expiry_date": {"value": "2026-04-15", "confidence": 0.99},
                "vehicle_class": {"value": "LMV-NT", "confidence": 0.98},
                "issuing_rto": {"value": "RTO Bangalore East", "confidence": 0.96},
                "address": {"value": "42 Windmill Street, Bangalore 560001", "confidence": 0.95},
            }

        # Verify document item exists.
        doc_id = _state.get("doc_id", "")
        assert doc_id, "No document ID in state"

        r = httpx.get(
            f"{alonso_core}/v1/vault/item/{doc_id}?persona=personal",
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 200, f"Doc fetch failed: {r.status_code} {r.text[:200]}"

        doc = r.json()
        assert doc.get("Type") == "document" or doc.get("type") == "document"

        # Verify reminder vault entry exists.
        reminder_vault_id = _state.get("reminder_vault_id", "")
        if reminder_vault_id:
            r2 = httpx.get(
                f"{alonso_core}/v1/vault/item/{reminder_vault_id}?persona=personal",
                headers=admin_headers,
                timeout=10,
            )
            assert r2.status_code == 200, f"Reminder entry fetch failed: {r2.status_code}"

    # ==================================================================
    # test_03: Verify confidence scores
    # ==================================================================

    # TST-USR-053
    def test_03_verify_confidence_scores(self):
        """Check that critical fields have high confidence.

        Critical fields: license_number, expiry_date (≥ 0.95).
        """
        fields = _state.get("extraction", {})
        assert fields, "No extraction results in state"

        for critical_field in ("license_number", "expiry_date"):
            field_data = fields.get(critical_field, {})
            confidence = field_data.get("confidence", 0)
            assert confidence >= 0.95, (
                f"{critical_field} confidence {confidence} < 0.95"
            )

        # Non-critical fields should also have reasonable confidence.
        for field_name in ("holder_name", "vehicle_class", "issuing_rto"):
            field_data = fields.get(field_name, {})
            confidence = field_data.get("confidence", 0)
            assert confidence >= 0.80, (
                f"{field_name} confidence {confidence} < 0.80"
            )

    # ==================================================================
    # test_04: Verify PII not in searchable fields
    # ==================================================================

    # TST-USR-054
    def test_04_verify_pii_not_in_searchable_fields(
        self, alonso_core, admin_headers,
    ):
        """ALL PII must be in metadata only, NOT in summary/body.

        Checks license number, holder name, and date of birth.
        The PII scrubber ensures sensitive data stays vault-only.
        """
        doc_id = _state.get("doc_id", "")
        assert doc_id, "No document ID in state"

        r = httpx.get(
            f"{alonso_core}/v1/vault/item/{doc_id}?persona=personal",
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 200

        doc = r.json()
        summary = doc.get("Summary", "") or doc.get("summary", "")
        body = doc.get("BodyText", "") or doc.get("body_text", "")
        metadata = doc.get("Metadata", "") or doc.get("metadata", "")

        # License number MUST NOT appear in searchable text.
        license_num = "KA-01-2020-1234567"
        assert license_num not in summary, (
            f"License number found in summary: {summary}"
        )
        assert license_num not in body, (
            f"License number found in body text"
        )

        # License number MUST be in metadata (vault-only).
        assert license_num in metadata, (
            f"License number not found in metadata"
        )

        # Holder name MUST NOT appear in summary (Fix 6).
        holder_name = "Alonso Quixano"
        assert holder_name not in summary, (
            f"Holder name found in summary: {summary}"
        )

        # Holder name MUST NOT appear in body text.
        assert holder_name not in body, (
            f"Holder name found in body text"
        )

        # Address MUST NOT appear in searchable text.
        address = "42 Windmill Street, Bangalore 560001"
        assert address not in summary, (
            f"Address found in summary: {summary}"
        )
        assert address not in body, (
            f"Address found in body text"
        )

    # ==================================================================
    # test_05: Store/verify reminder in Core
    # ==================================================================

    # TST-USR-055
    def test_05_store_and_verify_reminder(
        self, alonso_core, admin_headers,
    ):
        """Verify the reminder exists in Core's scheduler.

        If LLM ingestion ran, the Brain MUST have created it (Fix 4).
        If LLM was skipped, create the reminder directly.
        """
        if _state.get("llm_ingestion_ran"):
            # Brain ran — the reminder must exist.  Don't fall back.
            reminder_id = _state.get("reminder_id", "")
            assert reminder_id, (
                "LLM ingestion ran but no reminder was created — "
                "the Brain→Core reminder path is broken"
            )
        else:
            # LLM was skipped — create reminder directly.
            reminder_id = _state.get("reminder_id", "")
            if not reminder_id:
                trigger_dt = datetime(2026, 3, 16, 0, 0, 0)
                trigger_at = int(trigger_dt.timestamp())

                doc_id = _state.get("doc_id", "")
                r = httpx.post(
                    f"{alonso_core}/v1/reminder",
                    json={
                        "type": "license_expiry",
                        "message": "Driving license expires 2026-04-15",
                        "trigger_at": trigger_at,
                        "metadata": json.dumps({
                            "vault_item_id": doc_id,
                            "persona": "personal",
                            "expiry_date": "2026-04-15",
                        }),
                    },
                    headers=admin_headers,
                    timeout=10,
                )
                assert r.status_code == 201, (
                    f"Store reminder failed: {r.status_code} {r.text[:200]}"
                )
                reminder_id = r.json().get("id", "")
                _state["reminder_id"] = reminder_id

        assert reminder_id, "No reminder ID"

        # Verify it appears in the pending list.
        r = httpx.get(
            f"{alonso_core}/v1/reminders/pending",
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 200

        pending = r.json().get("reminders", [])
        found = any(
            rem.get("ID") == reminder_id or rem.get("id") == reminder_id
            for rem in pending
        )
        assert found, (
            f"Reminder {reminder_id} not found in pending list: "
            f"{[r.get('ID', r.get('id')) for r in pending]}"
        )

    # ==================================================================
    # test_06: Fire reminder → contextual notification (LLM)
    # ==================================================================

    # TST-USR-056
    @pytest.mark.skipif(
        not os.environ.get("GOOGLE_API_KEY"),
        reason="GOOGLE_API_KEY not set — skipping LLM notification test",
    )
    def test_06_reminder_fires_contextual_notification(
        self, alonso_core, alonso_brain, admin_headers, brain_headers,
    ):
        """Fire the reminder → Brain queries vault → LLM composes notification.

        Uses POST /v1/reminder/fire (test-only) for deterministic timing.

        The notification must reference vault context — not be a generic alarm.
        """
        reminder_id = _state.get("reminder_id", "")
        assert reminder_id, "No reminder ID — test_05 must run first"

        # Fire the reminder via the test-only endpoint.
        r = httpx.post(
            f"{alonso_core}/v1/reminder/fire",
            json={"reminder_id": reminder_id},
            headers=admin_headers,
            timeout=60,
        )
        assert r.status_code == 200, f"Fire failed: {r.status_code} {r.text[:300]}"

        # The fire endpoint doesn't return Brain's full response,
        # so we also call Brain directly with the same event.
        doc_id = _state.get("doc_id", "")
        r2 = httpx.post(
            f"{alonso_brain}/api/v1/process",
            json={
                "type": "reminder_fired",
                "body": json.dumps({
                    "reminder_id": reminder_id,
                    "reminder_type": "license_expiry",
                    "message": "Driving license expires 2026-04-15",
                    "metadata": json.dumps({
                        "vault_item_id": doc_id,
                        "persona": "personal",
                        "expiry_date": "2026-04-15",
                    }),
                }),
                "source": "reminder_system",
            },
            headers=brain_headers,
            timeout=60,
        )
        assert r2.status_code == 200, f"Process failed: {r2.status_code} {r2.text[:300]}"

        data = r2.json()
        response = data.get("response", {})
        notification = response.get("notification_text", "")

        _state["notification_text"] = notification
        _state["llm_notification_ran"] = True

        # Basic sanity: notification should be non-empty and substantive.
        assert len(notification) > 50, (
            f"Notification too short ({len(notification)} chars): {notification}"
        )

    # ==================================================================
    # test_07: Verify notification has vault context
    # ==================================================================

    # TST-USR-057
    def test_07_verify_notification_context(self):
        """The notification must reference personal context, not be generic.

        Must mention at least 2 of:
          - "April 15" or "2026-04-15" (specific date)
          - "Bangalore" or "RTO" (location from vault)
          - "ICICI" or "insurance" (finance context from vault)
          - "2 weeks" or "two weeks" (previous renewal experience)
        """
        notification = _state.get("notification_text", "")

        if not _state.get("llm_notification_ran"):
            pytest.skip("LLM notification test did not run")

        signals = {
            "date": any(s in notification.lower() for s in ["april 15", "2026-04-15", "april"]),
            "location": any(s in notification.lower() for s in ["bangalore", "rto"]),
            "insurance": any(s in notification.lower() for s in ["icici", "insurance"]),
            "duration": any(s in notification.lower() for s in ["2 week", "two week", "14 day"]),
        }

        matched = sum(1 for v in signals.values() if v)
        assert matched >= 2, (
            f"Notification lacks vault context (only {matched}/4 signals matched).\n"
            f"Signals: {signals}\n"
            f"Notification: {notification}"
        )

    # ==================================================================
    # test_08: Delegation — LLM generation + Guardian enforcement
    # ==================================================================

    # TST-USR-058
    @pytest.mark.skipif(
        not os.environ.get("GOOGLE_API_KEY"),
        reason="GOOGLE_API_KEY not set — skipping LLM delegation test",
    )
    def test_08_delegation_request_with_enforcement(
        self, alonso_brain, brain_signer,
    ):
        """LLM generates a DelegationRequest, then Guardian enforces it.

        Two-phase test:
          Phase A: LLM generates strict JSON delegation via /v1/reason
          Phase B: Submit delegation to Guardian via /v1/process with
                   type=delegation_request — Guardian validates PII
                   enforcement and risk-classifies as HIGH.
        """
        # Phase A: LLM generates the delegation JSON.
        delegation_prompt = (
            "You are Dina, a sovereign personal AI. Generate a strict JSON "
            "DelegationRequest to share driving license renewal information "
            "with an external RTO_Bot agent.\n\n"
            "The user's driving license details:\n"
            "  - License number: KA-01-2020-1234567 (PII — do NOT share)\n"
            "  - Holder name: Alonso Quixano (PII — do NOT share)\n"
            "  - Expiry date: 2026-04-15 (safe to share)\n"
            "  - Vehicle class: LMV-NT (safe to share)\n"
            "  - Issuing RTO: RTO Bangalore East (safe to share)\n"
            "  - Date of birth: 1985-03-15 (PII — do NOT share)\n\n"
            "Respond with ONLY valid JSON in this exact schema:\n"
            "{\n"
            '  "delegation_id": "del-<uuid>",\n'
            '  "agent_did": "did:plc:rto_bot",\n'
            '  "agent_name": "RTO_Bot",\n'
            '  "action": "share_data",\n'
            '  "purpose": "<why sharing>",\n'
            '  "permitted_fields": ["<fields safe to share>"],\n'
            '  "denied_fields": ["<PII fields that stay in vault>"],\n'
            '  "data_payload": {"<only permitted field values>"},\n'
            '  "constraints": {"max_ttl_seconds": 3600, "no_storage": true, "no_forwarding": true},\n'
            '  "risk_level": "MODERATE"\n'
            "}\n\n"
            "CRITICAL: license_number, holder_name, and date_of_birth must be in "
            "denied_fields and must NOT appear in data_payload or permitted_fields."
        )

        r = brain_signer.post(
            f"{alonso_brain}/api/v1/reason",
            json={
                "prompt": delegation_prompt,
                "persona_tier": "open",
                "skip_vault_enrichment": True,
            },
            timeout=60,
        )
        assert r.status_code == 200, f"Reason failed: {r.status_code} {r.text[:300]}"

        content = r.json().get("content", "")

        # Parse JSON from response (strip markdown fences if present).
        json_text = content.strip()
        if json_text.startswith("```"):
            lines = json_text.split("\n")
            lines = [l for l in lines if not l.strip().startswith("```")]
            json_text = "\n".join(lines)

        delegation = json.loads(json_text)
        _state["delegation"] = delegation

        # Basic LLM-generated schema checks.
        assert delegation.get("action") == "share_data", (
            f"Expected action=share_data, got: {delegation.get('action')}"
        )

        # PII must NOT be in permitted_fields or data_payload.
        permitted = delegation.get("permitted_fields", [])
        denied = delegation.get("denied_fields", [])
        payload = delegation.get("data_payload", {})

        pii_fields = {"license_number", "holder_name", "date_of_birth"}
        for pii_field in pii_fields:
            assert pii_field not in permitted, (
                f"PII field '{pii_field}' found in permitted_fields"
            )
            assert pii_field not in payload, (
                f"PII field '{pii_field}' found in data_payload"
            )

        # PII fields should be in denied_fields.
        denied_lower = {d.lower() for d in denied}
        for pii_field in pii_fields:
            assert pii_field.lower() in denied_lower, (
                f"PII field '{pii_field}' not in denied_fields: {denied}"
            )

        # Constraints should enforce safety.
        constraints = delegation.get("constraints", {})
        assert constraints.get("no_storage") is True, "no_storage must be true"
        assert constraints.get("no_forwarding") is True, "no_forwarding must be true"

        # Phase B: Submit to Guardian for enforcement.
        r2 = brain_signer.post(
            f"{alonso_brain}/api/v1/process",
            json={
                "type": "delegation_request",
                "payload": delegation,
                "trust_level": "verified",
            },
            timeout=15,
        )
        assert r2.status_code == 200, (
            f"Delegation enforcement failed: {r2.status_code} {r2.text[:300]}"
        )

        data = r2.json()

        # Guardian must validate the schema (PII clean).
        assert data.get("action") == "flag_for_review", (
            f"Expected flag_for_review, got: {data.get('action')}"
        )
        assert data.get("risk") in ("HIGH", "high"), (
            f"Expected risk=HIGH, got: {data.get('risk')}"
        )
        assert data.get("approved") is False, (
            f"Expected approved=False, got: {data.get('approved')}"
        )

    # ==================================================================
    # test_09: Guardian reviews delegation intent
    # ==================================================================

    # TST-USR-059
    def test_09_guardian_reviews_delegation(
        self, alonso_brain, brain_headers,
    ):
        """Guardian classifies share_data as HIGH risk → flag_for_review.

        The agent never holds your Home Node or vault keys, never sees your full history.
        Guardian ensures the human approves before data leaves the node.
        """
        r = httpx.post(
            f"{alonso_brain}/api/v1/process",
            json={
                "type": "agent_intent",
                "agent_did": "did:plc:rto_bot",
                "action": "share_data",
                "target": "RTO_Bot",
                "trust_level": "verified",
                "risk_level": "MODERATE",
            },
            headers=brain_headers,
            timeout=15,
        )
        assert r.status_code == 200, f"Intent review failed: {r.status_code} {r.text[:300]}"

        data = r.json()

        # share_data is in _HIGH_ACTIONS → flag_for_review.
        assert data.get("action") == "flag_for_review", (
            f"Expected flag_for_review, got: {data.get('action')}"
        )
        assert data.get("risk") in ("HIGH", "high"), (
            f"Expected risk=HIGH, got: {data.get('risk')}"
        )
        assert data.get("approved") is False, (
            f"Expected approved=False, got: {data.get('approved')}"
        )
        assert data.get("requires_approval") is True, (
            f"Expected requires_approval=True, got: {data.get('requires_approval')}"
        )
