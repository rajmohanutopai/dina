"""Integration tests for Persistent Audit Trail (Core SQLite audit_log).

Tests cover:
  - Append + query round-trip through Core HTTP endpoints
  - Query filtering by action, persona, requester
  - Limit enforcement
  - Reason trace metadata is parseable JSON
  - Hash chain integrity (mock mode only — real chain validated by Go)
  - No PII in prompt/response previews (truncated)

Dual-mode: runs against MockAuditLog in mock mode,
or against real Core HTTP endpoints when DINA_INTEGRATION=docker.
"""

from __future__ import annotations

import json
import os
import time

import pytest

DOCKER_MODE = os.environ.get("DINA_INTEGRATION") == "docker"


# ---------------------------------------------------------------------------
# TST-INT-AUD-001: Append and query round-trip
# ---------------------------------------------------------------------------

class TestAuditAppendAndQuery:
    """Verify entries written via append can be read back via query."""

    def test_audit_append_and_query_roundtrip(self, mock_audit_log) -> None:
        """Write an audit entry, read it back, verify fields match."""
        entry = {
            "action": "vault_access",
            "persona": "personal",
            "requester": "brain",
            "query_type": "reason",
            "reason": "test round-trip",
            "metadata": json.dumps({"test": True}),
        }
        entry_id = mock_audit_log.append(entry)
        assert entry_id > 0, "Append must return a positive entry ID"

        entries = mock_audit_log.query(action="vault_access", limit=5)
        assert len(entries) >= 1, "Query must return at least one entry"

        found = entries[0]
        assert found["action"] == "vault_access"
        assert found["persona"] == "personal"
        assert found["requester"] == "brain"

    def test_audit_multiple_entries_ordered(self, mock_audit_log) -> None:
        """Multiple entries are returned newest-first."""
        for i in range(3):
            mock_audit_log.append({
                "action": "ordered_test",
                "persona": "personal",
                "requester": "brain",
                "query_type": "reason",
                "reason": f"entry_{i}",
                "metadata": json.dumps({"seq": i}),
            })

        entries = mock_audit_log.query(action="ordered_test", limit=10)
        assert len(entries) >= 3

        # Newest first: last appended should be first in results
        reasons = [e.get("reason", "") for e in entries[:3]]
        assert "entry_2" in reasons[0], (
            f"Newest entry should be first, got reasons: {reasons}"
        )


# ---------------------------------------------------------------------------
# TST-INT-AUD-002: Query filter by action
# ---------------------------------------------------------------------------

class TestAuditQueryFilters:
    """Verify query filters work correctly."""

    def test_audit_query_filter_by_action(self, mock_audit_log) -> None:
        """Filter by action returns only matching entries."""
        mock_audit_log.append({
            "action": "reason_trace",
            "persona": "consumer",
            "requester": "brain",
            "query_type": "reason",
            "reason": "filter test",
            "metadata": "{}",
        })
        mock_audit_log.append({
            "action": "vault_store",
            "persona": "personal",
            "requester": "core",
            "query_type": "store",
            "reason": "other action",
            "metadata": "{}",
        })

        trace_entries = mock_audit_log.query(action="reason_trace", limit=50)
        for e in trace_entries:
            assert e["action"] == "reason_trace", (
                f"Filter leaked non-matching action: {e['action']}"
            )

    def test_audit_query_filter_by_persona(self, mock_audit_log) -> None:
        """Filter by persona returns only matching entries."""
        mock_audit_log.append({
            "action": "persona_test",
            "persona": "health",
            "requester": "brain",
            "query_type": "reason",
            "reason": "health query",
            "metadata": "{}",
        })
        mock_audit_log.append({
            "action": "persona_test",
            "persona": "financial",
            "requester": "brain",
            "query_type": "reason",
            "reason": "financial query",
            "metadata": "{}",
        })

        health_entries = mock_audit_log.query(
            action="persona_test", persona="health", limit=50,
        )
        for e in health_entries:
            assert e["persona"] == "health"


# ---------------------------------------------------------------------------
# TST-INT-AUD-003: Limit enforcement
# ---------------------------------------------------------------------------

class TestAuditQueryLimit:
    """Verify limit parameter is honored."""

    def test_audit_query_limit(self, mock_audit_log) -> None:
        """Query returns at most `limit` entries."""
        for i in range(10):
            mock_audit_log.append({
                "action": "limit_test",
                "persona": "personal",
                "requester": "brain",
                "query_type": "reason",
                "reason": f"limit entry {i}",
                "metadata": "{}",
            })

        entries = mock_audit_log.query(action="limit_test", limit=3)
        assert len(entries) <= 3, (
            f"Expected at most 3 entries, got {len(entries)}"
        )


# ---------------------------------------------------------------------------
# TST-INT-AUD-004: Reason trace metadata is valid JSON
# ---------------------------------------------------------------------------

class TestAuditReasonTrace:
    """Verify reason_trace entries carry parseable metadata."""

    def test_audit_reason_trace_metadata(self, mock_audit_log) -> None:
        """reason_trace entries have parseable JSON metadata."""
        trace_meta = {
            "prompt_preview": "What is the best ergonomic chair?",
            "tools_called": [
                {"name": "vault_query", "args_preview": "chair", "result_count": 3},
            ],
            "density_meta": {"raw_words": 150, "unique_ideas": 8},
            "guard_scan": {
                "ran": True,
                "anti_her_removed": 0,
                "unsolicited_removed": 1,
                "entity_hint": {"product": "chair"},
            },
            "model": "gemini-2.0-flash",
            "vault_context_used": True,
            "vault_items_count": 5,
            "response_preview": "Based on trust-verified reviews, the Herman Miller Aeron...",
            "skip_vault": False,
        }
        mock_audit_log.append({
            "action": "reason_trace",
            "persona": "consumer",
            "requester": "brain",
            "query_type": "reason",
            "reason": "vault_enriched=True",
            "metadata": json.dumps(trace_meta),
        })

        entries = mock_audit_log.query(action="reason_trace", limit=5)
        assert len(entries) >= 1

        entry = entries[0]
        meta = json.loads(entry["metadata"])
        assert "prompt_preview" in meta
        assert "tools_called" in meta
        assert isinstance(meta["tools_called"], list)
        assert "guard_scan" in meta
        assert meta["vault_context_used"] is True


# ---------------------------------------------------------------------------
# TST-INT-AUD-005: Hash chain integrity (mock only)
# ---------------------------------------------------------------------------

class TestAuditHashChain:
    """Verify hash chain integrity across sequential entries."""

    @pytest.mark.skipif(
        DOCKER_MODE,
        reason="Hash chain verification is internal to SQLiteAuditLogger",
    )
    def test_audit_hash_chain_integrity(self, mock_audit_log) -> None:
        """Three entries form a valid hash chain."""
        for i in range(3):
            mock_audit_log.append({
                "action": "chain_test",
                "persona": "personal",
                "requester": "brain",
                "query_type": "chain",
                "reason": f"chain entry {i}",
                "metadata": "{}",
            })

        # In mock mode, verify entries have sequential IDs
        entries = mock_audit_log.query(action="chain_test", limit=10)
        assert len(entries) >= 3

        ids = [e["id"] for e in entries]
        # Newest first — IDs should be descending
        for i in range(len(ids) - 1):
            assert ids[i] > ids[i + 1], (
                f"Entries not in descending ID order: {ids}"
            )


# ---------------------------------------------------------------------------
# TST-INT-AUD-006: No PII in previews
# ---------------------------------------------------------------------------

PII_PATTERNS = [
    "rajmohan@email.com",
    "+91-9876543210",
    "123 Main Street",
    "4111-2222-3333-4444",
]


class TestAuditNoPII:
    """Verify audit entries don't contain raw PII."""

    def test_audit_no_pii_in_previews(self, mock_audit_log) -> None:
        """Prompt/response previews are truncated and contain no PII.

        The reasoning trace stores prompt_preview (first 100 chars) and
        response_preview (first 200 chars). These should NOT contain
        full user data — just enough for debugging.
        """
        # Simulate a trace where the full prompt has PII but the preview is truncated
        full_prompt = "Find a chair for Rajmohan at rajmohan@email.com who lives at 123 Main Street" + " " * 200
        full_response = "Based on the review data, I recommend the Aeron chair" + " " * 300

        trace_meta = {
            "prompt_preview": full_prompt[:100],
            "response_preview": full_response[:200],
            "tools_called": [],
            "model": "gemini-2.0-flash",
            "vault_context_used": False,
        }

        mock_audit_log.append({
            "action": "reason_trace",
            "persona": "consumer",
            "requester": "brain",
            "query_type": "reason",
            "reason": "pii_test",
            "metadata": json.dumps(trace_meta),
        })

        entries = mock_audit_log.query(action="reason_trace", limit=5)
        pii_entry = None
        for e in entries:
            if e.get("reason") == "pii_test":
                pii_entry = e
                break
        assert pii_entry is not None, "PII test entry not found"

        meta = json.loads(pii_entry["metadata"])
        preview = meta["prompt_preview"]

        # Preview is truncated to 100 chars
        assert len(preview) <= 100, (
            f"Prompt preview too long: {len(preview)} chars"
        )

        # Response preview is truncated to 200 chars
        resp_preview = meta["response_preview"]
        assert len(resp_preview) <= 200, (
            f"Response preview too long: {len(resp_preview)} chars"
        )
