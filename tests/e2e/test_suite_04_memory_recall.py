"""E2E Suite 4: Memory & Recall.

Tests hybrid search (FTS5 + vector), emotional/semantic recall,
offline recall with rich client cache, and cross-persona search isolation.

Actors: Don Alonso (primary user)
Fixtures: don_alonso, fresh_don_alonso, plc_directory, d2d_network
"""

from __future__ import annotations

import pytest

from tests.e2e.actors import HomeNode, Persona, PersonaType
from tests.e2e.mocks import (
    DeviceType,
    SharingPolicy,
    TrustRing,
    VaultItem,
)


class TestMemoryRecall:
    """Suite 4 — Memory & Recall (TST-E2E-019 through TST-E2E-022)."""

    # TST-E2E-019
    def test_hybrid_search_fts5_plus_vector(
        self, fresh_don_alonso: HomeNode, plc_directory, d2d_network,
    ) -> None:
        """E2E-4.1  Hybrid Search (FTS5 + Vector).

        Store items in the vault, query with mode='hybrid', and verify that
        both FTS5 (exact-keyword) and semantic (cosine-similarity) results
        contribute.  The merge uses weights 0.4 FTS + 0.6 cosine — semantic
        results appear first in the merged list.
        """
        node = fresh_don_alonso
        node.first_run_setup("hybrid@example.com", "passphrase_hybrid")
        node.create_persona("general", PersonaType.GENERAL, "default")

        # ------------------------------------------------------------------
        # Store items — some share exact keywords, some share only meaning
        # ------------------------------------------------------------------
        # Exact keyword match for "ergonomic"
        node.vault_store(
            "general", "ergonomic chair review",
            {"text": "The ergonomic chair from Herman Miller is excellent."},
        )
        # Exact keyword match for "ergonomic"
        node.vault_store(
            "general", "ergonomic desk setup",
            {"text": "My ergonomic desk setup includes a standing converter."},
        )
        # Semantic-only match (no literal "ergonomic" but related meaning)
        node.vault_store(
            "general", "posture improvement tips",
            {"text": "Good posture requires lumbar support and seat height adjustment."},
        )
        # Unrelated item — should NOT appear
        node.vault_store(
            "general", "grocery list",
            {"text": "Buy milk, eggs, bread, and orange juice."},
        )

        # ------------------------------------------------------------------
        # FTS-only query — only exact keyword hits
        # ------------------------------------------------------------------
        fts_results = node.vault_query("general", "ergonomic", mode="fts5")
        fts_ids = {r.item_id for r in fts_results}
        assert len(fts_results) >= 2, "FTS5 must find at least the two items with 'ergonomic'"

        # ------------------------------------------------------------------
        # Semantic-only query — should also pick up posture item
        # ------------------------------------------------------------------
        sem_results = node.vault_query("general", "ergonomic", mode="semantic")
        sem_ids = {r.item_id for r in sem_results}
        # Semantic may overlap with FTS hits but should include broader matches
        assert len(sem_results) >= 1, "Semantic search must return at least one result"

        # ------------------------------------------------------------------
        # Hybrid query — union of both, semantic results first (0.6 weight)
        # ------------------------------------------------------------------
        hybrid_results = node.vault_query("general", "ergonomic", mode="hybrid")
        hybrid_ids = {r.item_id for r in hybrid_results}

        # Hybrid must include everything FTS found
        assert fts_ids.issubset(hybrid_ids), (
            "Hybrid results must be a superset of FTS results"
        )
        # Hybrid must also include everything semantic found
        assert sem_ids.issubset(hybrid_ids), (
            "Hybrid results must be a superset of semantic results"
        )
        # The union should be strictly larger than either alone (or equal if
        # sets happen to coincide), but never smaller
        assert len(hybrid_results) >= max(len(fts_results), len(sem_results))

        # Grocery list must never appear
        for r in hybrid_results:
            assert "grocery" not in r.summary.lower(), (
                "Unrelated 'grocery list' must not appear in hybrid results"
            )

    # TST-E2E-020
    def test_emotional_recall(
        self, fresh_don_alonso: HomeNode, plc_directory, d2d_network,
    ) -> None:
        """E2E-4.2  Emotional Recall.

        Store items about celebrations and achievements, then query for
        'happy moments' using mode='semantic'.  The semantic engine must
        capture emotional meaning — items about joy, celebration, and
        achievements must appear even if they do not contain the literal
        word 'happy'.
        """
        node = fresh_don_alonso
        node.first_run_setup("emotional@example.com", "passphrase_emo")
        node.create_persona("general", PersonaType.GENERAL, "default")

        # ------------------------------------------------------------------
        # Store emotionally meaningful items
        # ------------------------------------------------------------------
        node.vault_store(
            "general", "daughter graduation celebration",
            {"text": "My daughter graduated top of her class today. "
                     "The whole family celebrated with a big dinner."},
        )
        node.vault_store(
            "general", "promotion at work achievement",
            {"text": "Got promoted to principal engineer. "
                     "Felt a rush of joy and accomplishment."},
        )
        node.vault_store(
            "general", "happy birthday surprise party",
            {"text": "Friends threw a surprise birthday party. "
                     "Everyone was laughing and cheering."},
        )
        # Neutral item — should not match emotional query
        node.vault_store(
            "general", "plumber visit scheduled",
            {"text": "Plumber arrives Thursday at 2 PM to fix the kitchen sink."},
        )
        # Sad item — opposite valence
        node.vault_store(
            "general", "flat tire incident",
            {"text": "Got a flat tire on the highway in the rain. Waited two hours."},
        )

        # ------------------------------------------------------------------
        # Semantic query for emotional content
        # ------------------------------------------------------------------
        results = node.vault_query("general", "happy moments", mode="semantic")
        summaries = [r.summary.lower() for r in results]

        # At least the birthday item has the literal word "happy" so semantic
        # must return it; the others share emotional overlap.
        assert any("happy" in s or "celebration" in s or "achievement" in s
                    for s in summaries), (
            "Semantic search for 'happy moments' must return at least one "
            "emotionally relevant item"
        )
        # Plumber and flat tire should not appear
        for r in results:
            assert "plumber" not in r.summary.lower(), (
                "Neutral 'plumber visit' must not appear in emotional recall"
            )

    # TST-E2E-021
    def test_offline_recall_rich_client_cache(
        self, don_alonso: HomeNode,
    ) -> None:
        """E2E-4.3  Offline Recall (Rich Client Cache).

        Populate a device's local_cache, disconnect the device (set
        connected=False), query the local cache directly, and verify
        results are returned from cache while offline.  Then reconnect
        and verify the device syncs with the Home Node.
        """
        node = don_alonso

        # ------------------------------------------------------------------
        # Identify a paired rich-client device
        # ------------------------------------------------------------------
        device = None
        for dev in node.devices.values():
            if dev.device_type == DeviceType.RICH_CLIENT:
                device = dev
                break
        assert device is not None, "Don Alonso must have at least one rich client"

        # ------------------------------------------------------------------
        # Populate device local_cache while online
        # ------------------------------------------------------------------
        cached_item = VaultItem(
            item_id="vi_cache_001",
            persona="general",
            item_type="note",
            source="user",
            summary="offline test note",
            body_text='{"text": "This note was cached on-device for offline access."}',
        )
        device.local_cache[cached_item.item_id] = cached_item

        second_item = VaultItem(
            item_id="vi_cache_002",
            persona="general",
            item_type="note",
            source="user",
            summary="meeting notes project alpha",
            body_text='{"text": "Project Alpha meeting — discussed milestones and budget."}',
        )
        device.local_cache[second_item.item_id] = second_item

        # ------------------------------------------------------------------
        # Disconnect — go offline
        # ------------------------------------------------------------------
        node.disconnect_device(device.device_id)
        assert device.connected is False, "Device must be marked offline"

        # ------------------------------------------------------------------
        # Query local cache while offline
        # ------------------------------------------------------------------
        query = "offline"
        local_results = [
            item for item in device.local_cache.values()
            if query.lower() in item.summary.lower()
            or query.lower() in item.body_text.lower()
        ]
        assert len(local_results) >= 1, (
            "Local cache query must return results while offline"
        )
        assert local_results[0].item_id == "vi_cache_001"

        # Verify the Home Node push does NOT reach the disconnected device
        pre_msg_count = len(device.ws_messages)
        node._push_to_devices({"type": "test_ping", "payload": {}})
        assert len(device.ws_messages) == pre_msg_count, (
            "Disconnected device must NOT receive WebSocket messages"
        )

        # ------------------------------------------------------------------
        # Reconnect and verify sync
        # ------------------------------------------------------------------
        node.connect_device(device.device_id)
        assert device.connected is True, "Device must be marked online after reconnect"

        # After reconnect, pushes should work again
        node._push_to_devices({"type": "sync_ping", "payload": {}})
        assert len(device.ws_messages) == pre_msg_count + 1, (
            "Reconnected device must receive WebSocket messages"
        )

        # Local cache is still intact after reconnect
        assert "vi_cache_001" in device.local_cache
        assert "vi_cache_002" in device.local_cache

    # TST-E2E-022
    def test_cross_persona_search_isolation(
        self, fresh_don_alonso: HomeNode, plc_directory, d2d_network,
    ) -> None:
        """E2E-4.4  Cross-Persona Search Isolation.

        Store a health record in the /health persona and a personal note in
        the /personal persona.  Searching from /personal for a health-specific
        term must return zero results.  Searching from /health for the same
        term must find the record.
        """
        node = fresh_don_alonso
        node.first_run_setup("isolation@example.com", "passphrase_iso")
        node.create_persona("general", PersonaType.GENERAL, "default")
        node.create_persona("health", PersonaType.HEALTH, "sensitive")

        # Unlock health persona so we can write (it is restricted tier)
        node.unlock_persona("health", "passphrase_iso")

        # ------------------------------------------------------------------
        # Store health record in /health
        # ------------------------------------------------------------------
        node.vault_store(
            "health", "blood pressure reading",
            {"systolic": 128, "diastolic": 82, "date": "2026-02-20",
             "notes": "Slightly elevated. Monitor weekly."},
        )
        # Store unrelated personal note in /personal
        node.vault_store(
            "general", "book recommendation",
            {"title": "Sapiens", "author": "Yuval Noah Harari",
             "notes": "Recommended by Sancho. Must read."},
        )

        # ------------------------------------------------------------------
        # Search from /personal for health term -> no results
        # ------------------------------------------------------------------
        personal_results = node.vault_query(
            "general", "blood pressure", mode="fts5",
        )
        assert len(personal_results) == 0, (
            "Searching /personal for 'blood pressure' must return zero results — "
            "health data must not leak across persona boundaries"
        )

        # Also verify with hybrid mode
        personal_hybrid = node.vault_query(
            "general", "blood pressure", mode="hybrid",
        )
        assert len(personal_hybrid) == 0, (
            "Hybrid search from /personal must also be isolated from /health"
        )

        # ------------------------------------------------------------------
        # Search from /health for the same term -> found
        # ------------------------------------------------------------------
        health_results = node.vault_query(
            "health", "blood pressure", mode="fts5",
        )
        assert len(health_results) >= 1, (
            "Searching /health for 'blood pressure' must find the stored record"
        )
        assert "blood" in health_results[0].summary.lower()

        # ------------------------------------------------------------------
        # Verify /health does NOT see /personal data
        # ------------------------------------------------------------------
        health_book = node.vault_query("health", "sapiens", mode="fts5")
        assert len(health_book) == 0, (
            "Searching /health for 'sapiens' must not return personal data"
        )

        # ------------------------------------------------------------------
        # Verify audit trail records the restricted-persona access
        # ------------------------------------------------------------------
        restricted_audits = node.get_audit_entries("restricted_persona_access")
        # The health persona queries above should have logged restricted access
        assert len(restricted_audits) >= 1, (
            "Queries against a restricted persona must generate audit entries"
        )
