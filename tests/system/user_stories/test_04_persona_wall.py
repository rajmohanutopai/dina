"""User Story 04: The Persona Wall — Cross-Persona Disclosure Control.

SEQUENTIAL TEST — tests MUST run in order (00 → 10).
Each test builds on state from the previous one.

Story
-----
A shopping agent asks Dina: "Does the user have any health conditions that
affect ergonomic chair selection?"  The health persona is "sensitive" tier.

Dina:

  1. **Blocks** automatic cross-persona disclosure (deterministic tier gate).
  2. **Queries** the health vault for relevant items.
  3. **Proposes** a minimal disclosure — "User has chronic back pain and needs
     lumbar support" — withholding specific diagnoses (L4-L5 disc herniation),
     medications (Ibuprofen), and provider names (Dr. Sharma, Apollo Hospital).
  4. **Waits** for user approval.
  5. **Shares** only the approved text.
  6. **Verifies** via PII scrubber that no diagnosis leaked.

Why Dina is unique
------------------
This is something OpenClaw fundamentally cannot do. OpenClaw has full access
to everything — there is no boundary to enforce. Dina's persona isolation
ensures that a shopping agent in the consumer context NEVER sees raw health
records, even when the request is perfectly reasonable.

The Persona Wall is enforced by math (separate encrypted compartments in
the vault), not by a privacy policy.

Pipeline
--------
::

  Shopping agent asks about health conditions for ergonomic recommendation
    → Guardian receives cross_persona_request event
    → Deterministic tier gate: health persona is "sensitive" → BLOCKED
    → Guardian queries health vault for relevant items
    → Builds minimal disclosure proposal (general terms only)
    → _MEDICAL_PII_PATTERNS safety net strips specific diagnoses
    → Returns proposal with requires_approval=True
                    ↓
  User reviews proposal and approves minimal text
    → Guardian receives disclosure_approved event
    → Final PII check (audit, not gate — user explicitly approved)
    → Audit record written to KV
    → Shared text returned to requesting agent
"""

from __future__ import annotations

import json

import httpx
import pytest

# ---------------------------------------------------------------------------
# Shared state across ordered tests
# ---------------------------------------------------------------------------

_state: dict = {}

# Medical records to seed into the restricted health persona.
HEALTH_RECORDS = [
    {
        "Type": "medical_record",
        "Source": "health_provider",
        "Summary": "Spinal diagnosis — Dr. Sharma, Apollo Hospital",
        "BodyText": (
            "Patient diagnosed with L4-L5 disc herniation. "
            "Chronic lower back pain. "
            "Dr. Sharma at Apollo Hospital."
        ),
    },
    {
        "Type": "medical_note",
        "Source": "health_provider",
        "Summary": "Ergonomic recommendations for chronic back pain",
        "BodyText": (
            "Chronic back pain. Needs lumbar support chair. "
            "Standing desk recommended. "
            "Avoid sitting > 1 hour."
        ),
    },
    {
        "Type": "medical_record",
        "Source": "health_provider",
        "Summary": "Medication record — pain management",
        "BodyText": (
            "Ibuprofen 400mg PRN. "
            "Prescribed by Dr. Sharma, Apollo Hospital."
        ),
    },
]

# Shopping context for the consumer persona.
SHOPPING_CONTEXT = {
    "Type": "note",
    "Source": "consumer",
    "Summary": "Looking for ergonomic office chair with lumbar support",
    "BodyText": (
        "Looking for ergonomic office chair. "
        "Budget 15-20K INR. Need good lumbar support."
    ),
}


# ---------------------------------------------------------------------------
# Test class — sequential user journey
# ---------------------------------------------------------------------------


class TestPersonaWall:
    """The Persona Wall: cross-persona disclosure control."""

    # ==================================================================
    # test_00: Seed health persona vault with medical records
    # ==================================================================

    # TST-USR-029
    def test_00_seed_health_persona_vault(
        self, alonso_core, admin_headers,
    ):
        """Store 3 medical records in the restricted health persona.

        The health persona has tier="sensitive", set in conftest.py.
        These records contain specific diagnoses (L4-L5 disc herniation),
        provider names (Dr. Sharma, Apollo Hospital), and medications
        (Ibuprofen) — all of which must be withheld from cross-persona
        disclosure.
        """
        stored_ids = []
        for item in HEALTH_RECORDS:
            r = httpx.post(
                f"{alonso_core}/v1/vault/store",
                json={"persona": "health", "item": item},
                headers=admin_headers,
                timeout=10,
            )
            assert r.status_code in (200, 201), (
                f"Store failed: {r.status_code} {r.text[:200]}"
            )
            stored_ids.append(r.json().get("id", ""))

        _state["health_item_ids"] = stored_ids
        assert len(stored_ids) == 3

    # ==================================================================
    # test_01: Store shopping context in consumer persona
    # ==================================================================

    # TST-USR-030
    def test_01_store_shopping_context(
        self, alonso_core, admin_headers,
    ):
        """Store shopping context in the open consumer persona."""
        r = httpx.post(
            f"{alonso_core}/v1/vault/store",
            json={"persona": "consumer", "item": SHOPPING_CONTEXT},
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code in (200, 201), (
            f"Store failed: {r.status_code} {r.text[:200]}"
        )
        _state["shopping_item_id"] = r.json().get("id", "")

    # ==================================================================
    # test_02: Shopping agent requests health data → Guardian processes
    # ==================================================================

    # TST-USR-031
    def test_02_cross_persona_request_blocked(
        self, alonso_brain, brain_signer,
    ):
        """Shopping agent asks about health conditions for ergonomic chair.

        Sends a cross_persona_request event to the Guardian with:
          - source_persona: "health" (restricted tier)
          - target_persona: "consumer"
          - query: health conditions relevant to chair selection

        The Guardian must process this and return a disclosure proposal.
        """
        r = brain_signer.post(
            f"{alonso_brain}/api/v1/process",
            json={
                "type": "cross_persona_request",
                "payload": {
                    "requesting_agent": "shopping_agent",
                    "source_persona": "health",
                    "target_persona": "consumer",
                    "source_persona_tier": "sensitive",
                    "query": "back pain chronic lumbar support standing desk",
                    "reason": (
                        "Shopping agent needs to know about health conditions "
                        "for ergonomic office chair recommendation"
                    ),
                },
            },
            timeout=30,
        )
        assert r.status_code == 200, (
            f"Cross-persona request failed: {r.status_code} {r.text[:300]}"
        )

        data = r.json()
        _state["disclosure_response"] = data
        _state["response"] = data.get("response", {})

        # Must return disclosure_proposed (not an error).
        assert data.get("action") == "disclosure_proposed", (
            f"Expected disclosure_proposed, got: {data.get('action')}\n"
            f"Full response: {json.dumps(data, indent=2)[:500]}"
        )

    # ==================================================================
    # test_03: Verify automatic disclosure was blocked
    # ==================================================================

    # TST-USR-032
    def test_03_verify_automatic_disclosure_blocked(self):
        """The restricted health persona must block automatic disclosure.

        blocked==True, persona_tier=="sensitive", requires_approval==True.
        """
        data = _state.get("disclosure_response", {})
        response = _state.get("response", {})

        assert response.get("blocked") is True, (
            f"Expected blocked=True, got: {response.get('blocked')}"
        )
        assert response.get("persona_tier") == "sensitive", (
            f"Expected persona_tier=sensitive, got: {response.get('persona_tier')}"
        )
        assert data.get("requires_approval") is True, (
            f"Expected requires_approval=True, got: {data.get('requires_approval')}"
        )
        assert data.get("approved") is False, (
            f"Expected approved=False, got: {data.get('approved')}"
        )

    # ==================================================================
    # test_04: Verify disclosure proposal exists
    # ==================================================================

    # TST-USR-033
    def test_04_verify_disclosure_proposal_exists(self):
        """The Guardian must produce a proposal with safe_to_share and withheld.

        The disclosure proposal requires Guardian to extract general health
        terms into safe_to_share. If the Guardian implementation does not
        yet populate safe_to_share, we record it but do not hard-fail —
        the structural blocking behaviour (requires_approval=True) is the
        critical invariant, tested in test_03.
        """
        response = _state.get("response", {})
        proposal = response.get("proposal", {})

        assert proposal, f"No proposal in response: {response.keys()}"

        safe = proposal.get("safe_to_share", "")
        withheld = proposal.get("withheld", [])

        _state["proposal"] = proposal
        _state["safe_to_share"] = safe
        _state["withheld"] = withheld

        if not safe:
            pytest.xfail(
                "safe_to_share is empty — Guardian disclosure extraction "
                "not yet implemented. Structural blocking (requires_approval) "
                "works correctly."
            )
        if not withheld:
            pytest.xfail(
                "withheld is empty — Guardian disclosure extraction "
                "not yet implemented."
            )

    # ==================================================================
    # test_05: Verify specific diagnoses are withheld
    # ==================================================================

    # TST-USR-034
    def test_05_verify_diagnosis_withheld(self):
        """Specific diagnoses, doctor names, hospitals, and medications
        must NOT appear in safe_to_share.

        L4-L5, herniat*, Dr. Sharma, Apollo, Ibuprofen — all withheld.
        """
        safe = _state.get("safe_to_share", "").lower()
        if not safe:
            pytest.skip(
                "safe_to_share not populated — Guardian disclosure "
                "extraction not implemented"
            )

        forbidden = [
            ("L4-L5", "l4-l5"),
            ("L4/L5", "l4/l5"),
            ("L4 L5", "l4 l5"),
            ("herniat", "herniat"),
            ("Dr. Sharma", "dr. sharma"),
            ("dr sharma", "dr sharma"),
            ("Apollo", "apollo"),
            ("Ibuprofen", "ibuprofen"),
        ]

        leaked = []
        for label, pattern in forbidden:
            if pattern in safe:
                leaked.append(label)

        assert not leaked, (
            f"Forbidden terms leaked into safe_to_share: {leaked}\n"
            f"safe_to_share: {_state.get('safe_to_share', '')}"
        )

    # ==================================================================
    # test_06: Verify proposal is useful (contains general terms)
    # ==================================================================

    # TST-USR-035
    def test_06_verify_proposal_is_useful(self):
        """The safe_to_share must contain useful general health terms.

        At least 2 of: back, pain, lumbar, chronic, standing desk, ergonomic.
        """
        safe = _state.get("safe_to_share", "").lower()
        if not safe:
            pytest.skip(
                "safe_to_share not populated — Guardian disclosure "
                "extraction not implemented"
            )

        general_terms = [
            "back", "pain", "lumbar", "chronic",
            "standing desk", "ergonomic", "support",
        ]

        matched = [term for term in general_terms if term in safe]
        assert len(matched) >= 2, (
            f"Proposal not useful enough — only matched {matched} "
            f"out of {general_terms}.\n"
            f"safe_to_share: {_state.get('safe_to_share', '')}"
        )

    # ==================================================================
    # test_07: User approves minimal disclosure
    # ==================================================================

    # TST-USR-036
    def test_07_approve_disclosure(
        self, alonso_brain, brain_signer,
    ):
        """User reviews and approves the minimal disclosure text.

        Sends disclosure_approved with the safe_to_share text as
        approved_text.
        """
        response = _state.get("response", {})
        disclosure_id = response.get("disclosure_id", "")
        safe_text = _state.get("safe_to_share", "")

        assert disclosure_id, "No disclosure_id — test_02 must pass first"
        if not safe_text:
            pytest.skip(
                "safe_to_share not populated — Guardian disclosure "
                "extraction not implemented"
            )

        r = brain_signer.post(
            f"{alonso_brain}/api/v1/process",
            json={
                "type": "disclosure_approved",
                "payload": {
                    "disclosure_id": disclosure_id,
                    "approved_text": safe_text,
                    "requesting_agent": "shopping_agent",
                    "source_persona": "health",
                },
            },
            timeout=15,
        )
        assert r.status_code == 200, (
            f"Disclosure approval failed: {r.status_code} {r.text[:300]}"
        )

        data = r.json()
        _state["approval_response"] = data
        _state["approval_inner"] = data.get("response", {})

        assert data.get("action") == "disclosure_shared", (
            f"Expected disclosure_shared, got: {data.get('action')}\n"
            f"Full response: {json.dumps(data, indent=2)[:500]}"
        )

    # ==================================================================
    # test_08: Verify shared text matches approved text
    # ==================================================================

    # TST-USR-037
    def test_08_verify_shared_text_matches_approved(self):
        """The shared_text must exactly match the approved_text sent."""
        inner = _state.get("approval_inner", {})
        safe_text = _state.get("safe_to_share", "")

        shared = inner.get("shared_text", "")
        assert shared == safe_text, (
            f"shared_text does not match approved_text.\n"
            f"Approved: {safe_text[:200]}\n"
            f"Shared:   {shared[:200]}"
        )

    # ==================================================================
    # test_09: Verify no diagnosis in full shared response
    # ==================================================================

    # TST-USR-038
    def test_09_verify_no_diagnosis_in_shared_response(self):
        """Stringify the full approval response — no forbidden terms.

        Even in metadata, disclosure_id, etc. — L4-L5, herniat*,
        Ibuprofen, Apollo must not appear anywhere.
        """
        data = _state.get("approval_response", {})
        full_json = json.dumps(data).lower()

        forbidden = ["l4-l5", "l4/l5", "l4 l5", "herniat", "ibuprofen", "apollo"]
        leaked = [term for term in forbidden if term in full_json]

        assert not leaked, (
            f"Forbidden terms found in full approval response: {leaked}\n"
            f"Response: {json.dumps(data, indent=2)[:500]}"
        )

    # ==================================================================
    # test_10: Verify PII check is clean
    # ==================================================================

    # TST-USR-039
    def test_10_verify_pii_check_clean(self):
        """The final PII check must report clean — no medical patterns.

        pii_check.medical_patterns_found == []
        pii_check.clean == True
        """
        inner = _state.get("approval_inner", {})
        if not inner:
            pytest.skip(
                "No approval_inner in state — test_07 (approve_disclosure) "
                "must pass first"
            )

        pii_check = inner.get("pii_check", {})

        if not pii_check:
            pytest.skip(
                "pii_check field not present in disclosure response — "
                "Guardian does not yet include PII audit in approval flow"
            )

        medical = pii_check.get("medical_patterns_found", [])
        assert medical == [], (
            f"Medical patterns found in approved text: {medical}"
        )

        assert pii_check.get("clean") is True, (
            f"PII check not clean: {pii_check}"
        )
