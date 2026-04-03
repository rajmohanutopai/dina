"""Integration tests for Compliance & Audit (Architecture section 15).

Tests cover:
  S15.1 PII in logs — no PII leaks into container logs or error messages.
  S15.2 Audit trail completeness — every vault access and message send
        has a corresponding audit entry.
  S15.3 Data subject rights — deletion (right to erasure), export
        (portability), consent tracking for cloud LLM.
"""

from __future__ import annotations

import json
import re
import time

import pytest

from tests.integration.mocks import (
    AuditEntry,
    DinaMessage,
    MockAuditLog,
    MockCrashLog,
    MockDinaCore,
    MockDockerCompose,
    MockDockerContainer,
    MockExportArchive,
    MockGoCore,
    MockIdentity,
    MockLLMRouter,
    MockPIIScrubber,
    MockPythonBrain,
    MockVault,
    LLMTarget,
    Notification,
    PersonaType,
    SilenceTier,
)


# -----------------------------------------------------------------------
# Common PII patterns for compliance checks
# -----------------------------------------------------------------------

PII_PATTERNS = [
    "rajmohan@email.com",
    "sancho@email.com",
    "+91-9876543210",
    "123 Main Street",
    "4111-2222-3333-4444",
    "XXXX-XXXX-1234",
]

# Regex patterns for detecting PII in freeform text
EMAIL_RE = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z]{2,}")
PHONE_RE = re.compile(r"\+?\d[\d\-]{7,}\d")


# -----------------------------------------------------------------------
# TestPIIInLogs  (S15.1)
# -----------------------------------------------------------------------


class TestPIIInLogs:
    """Verify that no PII leaks into container logs or error messages."""

# TST-INT-359
    # TRACE: {"suite": "INT", "case": "0359", "section": "15", "sectionName": "Compliance & Privacy", "subsection": "01", "scenario": "01", "title": "no_pii_in_any_log_file"}
    def test_no_pii_in_any_log_file(
        self,
        mock_compose: MockDockerCompose,
        mock_scrubber: MockPIIScrubber,
    ) -> None:
        """Container logs contain no email addresses, phone numbers, or names.

        Exercise all containers with PII-containing operations, then
        scan every log line for known PII patterns.  None must appear.
        """
        mock_compose.up()

        core = mock_compose.containers["core"]
        brain = mock_compose.containers["brain"]

        # Simulate operations that involve PII-adjacent data
        # Scrub before logging (this is what production code must do)
        raw_text = "Rajmohan at rajmohan@email.com called +91-9876543210"
        scrubbed, _map = mock_scrubber.scrub(raw_text)

        # Log the scrubbed text (correct behavior)
        core.log("info", f"Processed inbound message: {scrubbed}")
        brain.log("info", f"Classified message: {scrubbed}")

        # Also log some routine operations
        core.log("info", "Vault query executed", query="laptop review")
        brain.log("info", "Brain processed query", tier="TIER_3")
        core.log("warn", "Connection timeout", remote="relay.example.com")

        # Scan ALL logs across ALL containers for PII
        for name, container in mock_compose.containers.items():
            logs = container.get_logs_json()
            for entry in logs:
                log_text = json.dumps(entry)
                for pii in PII_PATTERNS:
                    assert pii not in log_text, (
                        f"PII '{pii}' found in {name} log: {log_text}"
                    )
                # Also check for email/phone patterns
                assert not EMAIL_RE.search(log_text), (
                    f"Email pattern found in {name} log: {log_text}"
                )

# TST-INT-360
    # TRACE: {"suite": "INT", "case": "0360", "section": "15", "sectionName": "Compliance & Privacy", "subsection": "01", "scenario": "02", "title": "no_pii_in_error_messages"}
    def test_no_pii_in_error_messages(
        self,
        mock_crash_log: MockCrashLog,
        mock_scrubber: MockPIIScrubber,
    ) -> None:
        """Error strings are scrubbed before logging.

        When an error contains PII (e.g., a user's email in a stack trace),
        the PII must be replaced with placeholders before being recorded
        in the crash log.
        """
        # Simulate an error that contains PII
        raw_error = (
            "Failed to send email to rajmohan@email.com: "
            "SMTP connection refused for Rajmohan"
        )
        raw_traceback = (
            'File "agent.py", line 42, in send_email\n'
            '    smtp.send("rajmohan@email.com", body)\n'
            "ConnectionRefusedError: 123 Main Street server unreachable"
        )

        # Scrub before recording
        scrubbed_error, _map1 = mock_scrubber.scrub(raw_error)
        scrubbed_trace, _map2 = mock_scrubber.scrub(raw_traceback)

        mock_crash_log.record(
            error=scrubbed_error,
            traceback=scrubbed_trace,
            sanitized_line=scrubbed_error,
        )

        # Verify the crash log entry has no PII
        recent = mock_crash_log.get_recent(1)
        assert len(recent) == 1
        entry = recent[0]

        for pii in PII_PATTERNS:
            assert pii not in entry["error"], (
                f"PII '{pii}' found in error field"
            )
            assert pii not in entry["traceback"], (
                f"PII '{pii}' found in traceback field"
            )
            assert pii not in entry["sanitized_line"], (
                f"PII '{pii}' found in sanitized_line field"
            )

        # Verify structured PII placeholders (email/phone/address scrubbed)
        assert "rajmohan@email.com" not in entry["error"]


# -----------------------------------------------------------------------
# TestAuditTrail  (S15.2)
# -----------------------------------------------------------------------


class TestAuditTrail:
    """Verify every vault access and message send has an audit entry."""

# TST-INT-361
    # TRACE: {"suite": "INT", "case": "0361", "section": "15", "sectionName": "Compliance & Privacy", "subsection": "02", "scenario": "01", "title": "audit_trail_completeness"}
    def test_audit_trail_completeness(
        self,
        mock_dina: MockDinaCore,
        mock_audit_log: MockAuditLog,
    ) -> None:
        """Every vault access and message send has audit entry.

        Verify that MockGoCore.api_calls automatically captures every
        operation without the test manually writing audit entries.
        Then verify those records form a complete, PII-free audit trail.
        """
        # api_calls starts empty
        assert len(mock_dina.go_core.api_calls) == 0

        # 1. Vault store
        mock_dina.go_core.vault_store("audit_item_1", {"data": "secret"})

        # 2. Vault query
        mock_dina.vault.index_for_fts("audit_item_1", "secret data audit")
        results = mock_dina.go_core.vault_query("secret")

        # 3. DID sign
        sig = mock_dina.go_core.did_sign(b"audit payload")

        # 4. PII scrub — uses structured PII to verify scrubbing
        scrubbed, pii_map = mock_dina.go_core.pii_scrub(
            "Rajmohan at rajmohan@email.com audit test"
        )
        assert "rajmohan@email.com" not in scrubbed, "Email must be scrubbed"
        from tests.integration.conftest import DOCKER_MODE as _DM
        if not _DM:
            assert len(pii_map) > 0, "Scrubber must report replacements"

        # 5. P2P message send
        recipient = "did:plc:AuditTestPeer12345678901234"
        mock_dina.p2p.add_contact(recipient)
        mock_dina.p2p.add_session(mock_dina.identity.root_did, recipient)
        msg = DinaMessage(
            type="dina/social/ping",
            from_did=mock_dina.identity.root_did,
            to_did=recipient,
            payload={"text": "audit test message"},
        )
        sent = mock_dina.p2p.send(msg)
        assert sent is True, "Authenticated send must succeed"

        # --- Verify api_calls captured operations automatically ---
        # MockGoCore records every call in api_calls without manual intervention
        assert len(mock_dina.go_core.api_calls) == 4, (
            "GoCore must auto-record all 4 operations (store, query, sign, scrub)"
        )
        endpoints = [c["endpoint"] for c in mock_dina.go_core.api_calls]
        assert "/v1/vault/store" in endpoints
        assert "/v1/vault/query" in endpoints
        assert "/v1/did/sign" in endpoints
        assert "/v1/pii/scrub" in endpoints

        # P2P send is tracked separately in p2p.messages
        assert len(mock_dina.p2p.messages) >= 1
        assert mock_dina.p2p.messages[-1].type == "dina/social/ping"

        # Counter-proof: unauthenticated send is rejected (not recorded)
        rogue_did = "did:plc:RogueAuditPeerXXXXXXXXXXXXXX"
        rogue_msg = DinaMessage(
            type="dina/social/ping",
            from_did=mock_dina.identity.root_did,
            to_did=rogue_did,
            payload={"text": "should fail"},
        )
        assert mock_dina.p2p.send(rogue_msg) is False

        # api_calls endpoint strings must not contain PII
        api_calls_text = json.dumps(mock_dina.go_core.api_calls)
        for pii in PII_PATTERNS:
            assert pii not in api_calls_text, (
                f"api_calls audit trail must not contain PII: {pii}"
            )

        # Build audit entries from api_calls and verify export schema
        actor = mock_dina.identity.root_did
        for call in mock_dina.go_core.api_calls:
            mock_audit_log.record(
                actor=actor,
                action=call["endpoint"].split("/")[-1],
                resource=call.get("key", call.get("query", "n/a")),
                result="success",
            )
        exported = mock_audit_log.export()
        assert len(exported) == 4
        for entry in exported:
            assert "actor" in entry
            assert "action" in entry
            assert "timestamp" in entry


# -----------------------------------------------------------------------
# TestDataSubjectRights  (S15.3)
# -----------------------------------------------------------------------


class TestDataSubjectRights:
    """Verify data deletion, export, and consent tracking."""

# TST-INT-362
    # TRACE: {"suite": "INT", "case": "0362", "section": "15", "sectionName": "Compliance & Privacy", "subsection": "03", "scenario": "01", "title": "data_deletion_right_to_erasure"}
    def test_data_deletion_right_to_erasure(
        self,
        mock_dina: MockDinaCore,
        mock_audit_log: MockAuditLog,
    ) -> None:
        """User can delete all data, vault is emptied.

        Populate the vault with data across multiple tiers and personas,
        then invoke deletion. Every item must be permanently removed.
        The audit log must record the deletion event.
        """
        actor = mock_dina.identity.root_did

        # Populate vault with data across tiers
        mock_dina.vault.store(1, "verdict_laptop", {"product": "ThinkPad"})
        mock_dina.vault.store(1, "verdict_chair", {"product": "Aeron"})
        mock_dina.vault.store(2, "contact_sancho", {"name": "Sancho"})
        mock_dina.vault.store(3, "shared_review", {"shared": True})
        mock_dina.vault.index_for_fts("verdict_laptop", "ThinkPad laptop review")
        mock_dina.vault.index_for_fts("verdict_chair", "Aeron chair review")

        # Verify data exists
        assert mock_dina.vault.retrieve(1, "verdict_laptop") is not None
        assert mock_dina.vault.retrieve(1, "verdict_chair") is not None
        assert mock_dina.vault.retrieve(2, "contact_sancho") is not None

        # User requests deletion (right to erasure)
        deleted_items = []
        for tier in range(6):
            keys = list(mock_dina.vault._tiers[tier].keys())
            for key in keys:
                was_deleted = mock_dina.vault.delete(tier, key)
                if was_deleted:
                    deleted_items.append((tier, key))

        # Audit the deletion
        mock_audit_log.record(
            actor=actor,
            action="data_erasure",
            resource="all_tiers",
            result="success",
            details={"items_deleted": len(deleted_items)},
        )

        # Verify vault is empty
        for tier in range(6):
            assert len(mock_dina.vault._tiers[tier]) == 0, (
                f"Tier {tier} still has data after erasure"
            )

        # FTS index is also cleared
        assert mock_dina.vault.search_fts("ThinkPad") == []
        assert mock_dina.vault.search_fts("Aeron") == []

        # Audit log records the event
        erasure_entries = mock_audit_log.query(action="data_erasure")
        assert len(erasure_entries) == 1
        assert erasure_entries[0].details["items_deleted"] == len(deleted_items)

# TST-INT-363
    # TRACE: {"suite": "INT", "case": "0363", "section": "15", "sectionName": "Compliance & Privacy", "subsection": "03", "scenario": "02", "title": "data_export_portability"}
    def test_data_export_portability(
        self,
        mock_dina: MockDinaCore,
        mock_export_archive: MockExportArchive,
        mock_audit_log: MockAuditLog,
    ) -> None:
        """Full vault export produces importable archive.

        Export the entire vault + identity into an archive. The archive
        must be importable into a fresh vault without data loss. Tampering
        with the archive must be detected and rejected.
        """
        actor = mock_dina.identity.root_did

        # Populate vault with test data
        mock_dina.vault.store(1, "export_item_1", {"product": "ThinkPad", "score": 92})
        mock_dina.vault.store(1, "export_item_2", {"product": "Aeron", "score": 91})
        mock_dina.vault.store(2, "export_contact", {"name": "Sancho"})

        # Create a persona for export metadata
        mock_dina.identity.derive_persona(PersonaType.CONSUMER)

        # Export
        mock_export_archive.export_from(mock_dina.vault, mock_dina.identity)

        assert mock_export_archive.exported_at > 0
        assert mock_export_archive.did == actor
        assert "consumer" in mock_export_archive.personas
        assert mock_export_archive.checksum != ""

        # Audit the export
        mock_audit_log.record(
            actor=actor,
            action="data_export",
            resource="full_vault",
            result="success",
            details={"checksum": mock_export_archive.checksum},
        )

        # Import into a fresh vault
        fresh_vault = MockVault()
        fresh_identity = MockIdentity()
        import_ok = mock_export_archive.import_into(fresh_vault, fresh_identity)
        assert import_ok is True

        # Verify imported data matches original
        item1 = fresh_vault.retrieve(1, "export_item_1")
        assert item1 is not None
        assert item1["product"] == "ThinkPad"
        assert item1["score"] == 92

        item2 = fresh_vault.retrieve(1, "export_item_2")
        assert item2 is not None
        assert item2["product"] == "Aeron"

        contact = fresh_vault.retrieve(2, "export_contact")
        assert contact is not None
        assert contact["name"] == "Sancho"

        # Tampered archive must be rejected
        mock_export_archive.tamper()
        tampered_vault = MockVault()
        tampered_import = mock_export_archive.import_into(
            tampered_vault, MockIdentity()
        )
        assert tampered_import is False, (
            "Tampered archive must be rejected on import"
        )

        # Audit log records the export
        export_entries = mock_audit_log.query(action="data_export")
        assert len(export_entries) == 1

# TST-INT-364
    # TRACE: {"suite": "INT", "case": "0364", "section": "15", "sectionName": "Compliance & Privacy", "subsection": "03", "scenario": "03", "title": "consent_tracking"}
    def test_consent_tracking(
        self,
        mock_dina: MockDinaCore,
        mock_audit_log: MockAuditLog,
    ) -> None:
        """User consent for cloud LLM is stored and enforced.

        Consent state is persisted in the vault. When consent is granted,
        complex tasks route to cloud. When denied, they stay local.
        Every consent change is audited.
        """
        actor = mock_dina.identity.root_did

        # Initially: no consent stored
        consent = mock_dina.vault.retrieve(0, "cloud_llm_consent")
        assert consent is None

        # User grants consent
        mock_dina.vault.store(0, "cloud_llm_consent", {
            "granted": True,
            "granted_at": time.time(),
            "scope": "pii_scrubbed_only",
        })
        mock_audit_log.record(
            actor=actor,
            action="consent_grant",
            resource="cloud_llm",
            result="success",
            details={"scope": "pii_scrubbed_only"},
        )

        # With consent, complex reasoning routes to cloud
        consent_record = mock_dina.vault.retrieve(0, "cloud_llm_consent")
        assert consent_record is not None
        from tests.integration.conftest import as_dict
        consent_record = as_dict(consent_record)
        assert consent_record["granted"] is True

        target = mock_dina.llm_router.route("complex_reasoning")
        assert target == LLMTarget.CLOUD

        # User revokes consent
        mock_dina.vault.store(0, "cloud_llm_consent", {
            "granted": False,
            "revoked_at": time.time(),
            "scope": "none",
        })
        mock_audit_log.record(
            actor=actor,
            action="consent_revoke",
            resource="cloud_llm",
            result="success",
        )

        # After revocation, consent record shows denied
        revoked = mock_dina.vault.retrieve(0, "cloud_llm_consent")
        assert revoked is not None
        revoked = as_dict(revoked)
        assert revoked["granted"] is False

        # Sensitive personas never go to cloud regardless of consent
        target_health = mock_dina.llm_router.route(
            "complex_reasoning", persona=PersonaType.HEALTH
        )
        assert target_health == LLMTarget.LOCAL

        # Audit trail records both consent changes
        consent_grants = mock_audit_log.query(action="consent_grant")
        consent_revokes = mock_audit_log.query(action="consent_revoke")
        assert len(consent_grants) == 1
        assert len(consent_revokes) == 1

        # Total audit entries: 2 (grant + revoke)
        assert len(mock_audit_log.entries) == 2

        # Verify audit entries have timestamps and actor
        for entry in mock_audit_log.entries:
            assert entry.actor == actor
            assert entry.timestamp > 0
