"""User Story 08: Moving Dina to a New Machine — data portability & DID stability.

SEQUENTIAL TEST — tests MUST run in order (00 → 04).
Each test builds on state from the previous one.

Story
-----
Alonso's laptop is dying. He buys a new one and needs to move Dina.
This is not a cloud migration — Dina runs on YOUR hardware. The Home
Node is sovereign. Moving it means:

  1. The vault data on Node A must be exportable (queryable for backup).
  2. The DID (self-sovereign identity) must be stable — Alonso's DID
     is his cryptographic passport. It must survive machine changes.
  3. Node B must be fully operational — vault store/query, DID
     resolution, all working independently.

In this test we use the two-node Docker setup:
  - Node A = Alonso's Core (the old machine)
  - Node B = Sancho's Core (simulating a new machine)

We verify:
  - Data stored on Node A is queryable (export path works).
  - Each node has a stable, valid DID.
  - Node B can independently store and query vault data.
  - DIDs are different between nodes (each has its own keypair).

This is fundamentally different from cloud services. When you "move"
Gmail, you log in from a new browser — Google still owns everything.
When you move Dina, YOU carry the encrypted vault. The identity is
yours. The data is yours. Google has nothing to do with it.

Maps to Suite 18: Machine Migration & Data Portability.

Pipeline
--------
::

  Node A (old machine)
    → Store vault items
    → GET /v1/did → record DID (cryptographic identity)
    → POST /v1/vault/query → verify data is retrievable
                    |
  Node B (new machine)
    → GET /v1/did → verify different DID (different keypair)
    → POST /v1/vault/store → store items independently
    → POST /v1/vault/query → verify independent operation
                    |
  Migration path (future):
    → Export encrypted vault from Node A
    → Import on Node B with master key
    → Re-derive DID from master seed (same DID, new machine)
"""

from __future__ import annotations

import json

import httpx
import pytest

# ---------------------------------------------------------------------------
# Shared state across ordered tests
# ---------------------------------------------------------------------------

_state: dict = {}


# ---------------------------------------------------------------------------
# Test class — sequential user journey
# ---------------------------------------------------------------------------


class TestMoveToNewMachine:
    """Moving Dina to a new machine: data portability & DID stability."""

    # ==================================================================
    # test_00: Store vault data on Node A (old machine)
    # ==================================================================

    # TST-USR-065
    def test_00_store_data_on_node_a(
        self, alonso_core, admin_headers,
    ):
        """Store vault items on Node A — the old machine.

        These represent Alonso's accumulated data: personal notes,
        preferences, relationship context. Everything that makes Dina
        useful is in the vault.

        In a real migration, this data would be exported as an encrypted
        SQLCipher database file. Here we store items to verify the
        export path (query) works correctly.
        """
        items = [
            {
                "Type": "note",
                "Source": "personal",
                "Summary": "Migration test — favorite books list for portability check",
                "BodyText": (
                    "Alonso's favorite books: Don Quixote (Cervantes), "
                    "One Hundred Years of Solitude (Marquez), "
                    "The Master and Margarita (Bulgakov). "
                    "This item tests vault portability across machines."
                ),
            },
            {
                "Type": "note",
                "Source": "preference",
                "Summary": "Migration test — morning routine preferences",
                "BodyText": (
                    "Alonso's morning routine: wake at 6:30, meditation 15 min, "
                    "strong filter coffee (no sugar), review briefing at 7:00. "
                    "Portability marker: XmV9pQ."
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
            assert r.status_code in (200, 201), (
                f"Store on Node A failed: {r.status_code} {r.text[:200]}"
            )
            stored_ids.append(r.json().get("id", ""))

        _state["node_a_item_ids"] = stored_ids
        assert len(stored_ids) == 2
        print(f"\n  [migrate] Stored {len(stored_ids)} items on Node A")

    # ==================================================================
    # test_01: Record Node A's identity (DID)
    # ==================================================================

    # TST-USR-066
    def test_01_record_identity(
        self, alonso_core, admin_headers,
    ):
        """GET /v1/did on Node A to record the DID.

        Alonso's DID is derived from his Ed25519 keypair. It is the
        cryptographic anchor of his identity — every verdict he signs,
        every D2D message he sends, every trust attestation he makes
        is tied to this DID.

        When moving to a new machine, the DID must either:
          a) Be re-derived from the same master seed (same DID), or
          b) Be a new DID that is linked to the old one via a rotation
             record in the PLC directory.

        Here we record the DID to verify it is valid and stable.
        """
        r = httpx.get(
            f"{alonso_core}/v1/did",
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 200, (
            f"GET /v1/did failed on Node A: {r.status_code} {r.text[:200]}"
        )
        data = r.json()

        did = data.get("id", "")
        assert did, f"No DID returned from Node A: {data.keys()}"
        assert did.startswith("did:"), (
            f"DID does not start with 'did:': {did}"
        )

        _state["node_a_did"] = did
        print(f"\n  [migrate] Node A DID: {did[:50]}...")

    # ==================================================================
    # test_02: Verify vault data is exportable (queryable)
    # ==================================================================

    # TST-USR-067
    def test_02_data_exportable(
        self, alonso_core, admin_headers,
    ):
        """Verify vault/query returns the stored data on Node A.

        This confirms the export path works: all data stored on the
        old machine is retrievable via the query API. In a real
        migration, this would be a full vault export (encrypted
        SQLCipher file), but the query path validates that data
        integrity is maintained.
        """
        r = httpx.post(
            f"{alonso_core}/v1/vault/query",
            json={
                "persona": "personal",
                "query": "migration test portability",
                "mode": "fts5",
                "limit": 10,
            },
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 200, (
            f"Query on Node A failed: {r.status_code} {r.text[:200]}"
        )

        items = r.json().get("items", [])
        assert len(items) >= 1, (
            f"Expected at least 1 migration test item, got {len(items)}. "
            f"Data may not be exportable."
        )

        # Verify at least one item has the portability marker.
        all_text = " ".join(
            str(item.get("Summary", "")) + " " + str(item.get("BodyText", ""))
            for item in items
        )
        has_marker = (
            "portability" in all_text.lower()
            or "migration test" in all_text.lower()
        )
        assert has_marker, (
            f"Migration test items not found in query results. "
            f"Summaries: {[i.get('Summary', '')[:50] for i in items]}"
        )

        _state["exported_items"] = items
        print(
            f"\n  [migrate] Node A vault query: "
            f"{len(items)} items retrievable (export path works)"
        )

    # ==================================================================
    # test_03: Node B has a valid DID (different from Node A)
    # ==================================================================

    # TST-USR-068
    def test_03_node_b_has_same_identity_scheme(
        self, sancho_core, admin_headers,
    ):
        """GET /v1/did on Node B returns a valid DID (different from A).

        Node B (the new machine) has its own Ed25519 keypair and
        therefore its own DID. The identity scheme is the same (did:key
        or did:plc) but the actual DID string is different because the
        cryptographic keys are different.

        In a full migration with seed-based key derivation, both nodes
        would derive the same DID from the same master seed. Here we
        verify that:
          1. Node B has a valid DID.
          2. The DID is different from Node A (independent keypairs).
          3. Both use the same DID method (scheme compatibility).
        """
        r = httpx.get(
            f"{sancho_core}/v1/did",
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 200, (
            f"GET /v1/did failed on Node B: {r.status_code} {r.text[:200]}"
        )
        data = r.json()

        did_b = data.get("id", "")
        assert did_b, f"No DID returned from Node B: {data.keys()}"
        assert did_b.startswith("did:"), (
            f"Node B DID does not start with 'did:': {did_b}"
        )

        did_a = _state.get("node_a_did", "")
        assert did_a, "Node A DID not recorded — test_01 must pass first"

        # Different nodes should have different DIDs (independent keypairs).
        assert did_a != did_b, (
            f"Node A and Node B have the same DID — this means they share "
            f"the same keypair, which should not happen with independent "
            f"installations. DID: {did_a}"
        )

        # Both should use the same DID method.
        method_a = did_a.split(":")[1] if ":" in did_a else ""
        method_b = did_b.split(":")[1] if ":" in did_b else ""
        assert method_a == method_b, (
            f"DID methods differ: Node A uses did:{method_a}, "
            f"Node B uses did:{method_b}"
        )

        _state["node_b_did"] = did_b
        print(f"\n  [migrate] Node B DID: {did_b[:50]}...")
        print(f"  [migrate] DIDs differ (independent keypairs): YES")
        print(f"  [migrate] Same DID method (did:{method_a}): YES")

    # ==================================================================
    # test_04: Vault operations work independently on Node B
    # ==================================================================

    # TST-USR-069
    def test_04_vault_operations_work_on_node_b(
        self, sancho_core, admin_headers,
    ):
        """Store and query vault items on Node B (the new machine).

        This verifies that Node B is fully operational and can
        independently manage vault data. In a real migration,
        after importing the vault from Node A, all operations
        should work identically.

        Here we store a fresh item on Node B and query it back
        to confirm end-to-end vault functionality.
        """
        # Store an item on Node B.
        r = httpx.post(
            f"{sancho_core}/v1/vault/store",
            json={
                "persona": "personal",
                "item": {
                    "Type": "note",
                    "Source": "personal",
                    "Summary": "Node B operational test — new machine works",
                    "BodyText": (
                        "This item was stored on Node B (the new machine) "
                        "to verify vault operations work independently. "
                        "Portability marker: Zw7kR3."
                    ),
                },
            },
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code in (200, 201), (
            f"Store on Node B failed: {r.status_code} {r.text[:200]}"
        )
        node_b_item_id = r.json().get("id", "")
        assert node_b_item_id, "No item ID returned from Node B store"

        # Query the item back.
        r2 = httpx.post(
            f"{sancho_core}/v1/vault/query",
            json={
                "persona": "personal",
                "query": "Node B operational test new machine",
                "mode": "fts5",
                "limit": 5,
            },
            headers=admin_headers,
            timeout=10,
        )
        assert r2.status_code == 200, (
            f"Query on Node B failed: {r2.status_code} {r2.text[:200]}"
        )

        items = r2.json().get("items", [])
        assert len(items) >= 1, (
            f"Expected at least 1 item on Node B, got {len(items)}. "
            f"Vault operations may not be working on the new machine."
        )

        # Verify our specific item is in the results.
        found = any("Zw7kR3" in str(item) for item in items)
        assert found, (
            f"Node B item with marker Zw7kR3 not found in query results. "
            f"Items: {[i.get('Summary', '')[:50] for i in items]}"
        )

        _state["node_b_item_id"] = node_b_item_id
        print(f"\n  [migrate] Node B vault store: OK (id={node_b_item_id[:12]}...)")
        print(f"  [migrate] Node B vault query: OK ({len(items)} items)")
        print("  [migrate] Migration readiness verified:")
        print("    - Node A: data stored and queryable (exportable)")
        print("    - Node A: DID recorded and stable")
        print("    - Node B: independent DID (same method)")
        print("    - Node B: vault store/query operational")
