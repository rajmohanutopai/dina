"""User Story 08: Moving Dina to a New Machine — data portability & DID stability.

SEQUENTIAL TEST — tests MUST run in order (00 → 07).
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
  4. The same master seed on a new machine produces the same DID —
     identity survives machine changes via deterministic derivation.
  5. The /v1/export and /v1/import API endpoints must be wired and
     functional — not dead 501 stubs.

In this test we use the two-node Docker setup:
  - Node A = Alonso's Core (the old machine)
  - Node B = Sancho's Core (simulating a new machine)

We verify:
  - Data stored on Node A is queryable (export path works).
  - Each node has a stable, valid DID.
  - Node B can independently store and query vault data.
  - DIDs are different between nodes (each has its own keypair).
  - Seed-based DID derivation: same seed → same DID (SLIP-0010 proof).
  - POST /v1/export creates a real encrypted archive.
  - Archive transfers between containers (docker cp).
  - POST /v1/import restores files, reports persona count and repair flag.
  - Node B restarted with same seed can unlock and query restored data.

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
  Seed-based DID proof:
    → Known seed (Docker test seed) → SLIP-0010 m/9999'/0'/0'
    → Ed25519 public key → did:plc derivation
    → Must match Node A's actual DID from GET /v1/did
                    |
  Full migration roundtrip:
    → Lock personas on Node A → POST /v1/export → encrypted archive
    → docker cp archive: Node A → host → Node B
    → Lock personas on Node B → POST /v1/import → files restored
    → Unlock with wrong seed → FAILS (crypto binding proof)
    → Restart Node B with Alonso's seed (same recovery phrase)
    → Unlock personas on Node B (same seed → same DEK → succeeds)
    → POST /v1/vault/query on Node B → original data is there
"""

from __future__ import annotations

import hashlib
import hmac
import json
import struct

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
                json={"persona": "general", "item": item},
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
                "persona": "general",
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
                "persona": "general",
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
                "persona": "general",
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

    # ==================================================================
    # test_05: Seed-based DID derivation — same seed → same DID
    # ==================================================================

    # TST-USR-070
    def test_05_seed_based_did_derivation(
        self, alonso_core, admin_headers,
    ):
        """Same master seed deterministically produces the same DID.

        This is the critical portability proof.  When Alonso moves to a
        new machine, he carries his BIP-39 mnemonic (24 words).  The new
        machine derives the same Ed25519 keypair from the same seed via
        SLIP-0010 at path m/9999'/0'/0', which produces the same DID.

        The test:
          1. Takes Alonso's known Docker test seed (0x00...01).
          2. Derives the Ed25519 public key via SLIP-0010 in pure Python.
          3. Computes did:plc from SHA-256(pubkey)[:16] via base58btc.
          4. Compares with Node A's actual DID from GET /v1/did.

        If this passes, it proves that identity survives machine changes.
        The seed IS the identity — carry the seed, carry the DID.
        """
        # --- SLIP-0010 derivation in pure Python ---

        # Alonso's Docker test seed (from docker-compose-system.yml).
        seed = bytes.fromhex(
            "0000000000000000000000000000000000000000000000000000000000000001"
        )
        assert len(seed) == 32, f"Seed must be 32 bytes, got {len(seed)}"

        def slip0010_master(seed_bytes: bytes) -> tuple[bytes, bytes]:
            """SLIP-0010 master key: HMAC-SHA512(key='ed25519 seed', msg=seed)."""
            I = hmac.new(b"ed25519 seed", seed_bytes, hashlib.sha512).digest()
            return I[:32], I[32:]  # (key, chain_code)

        def slip0010_child(
            parent_key: bytes, parent_chain: bytes, index: int,
        ) -> tuple[bytes, bytes]:
            """SLIP-0010 hardened child derivation."""
            # data = 0x00 || parent_key || index (4 bytes big-endian)
            data = b"\x00" + parent_key + struct.pack(">I", index)
            I = hmac.new(parent_chain, data, hashlib.sha512).digest()
            return I[:32], I[32:]

        # Hardened offset.
        HARDENED = 0x80000000

        # Derive path m/9999'/0'/0' (root identity signing key).
        key, chain = slip0010_master(seed)
        key, chain = slip0010_child(key, chain, 9999 + HARDENED)
        key, chain = slip0010_child(key, chain, 0 + HARDENED)
        key, chain = slip0010_child(key, chain, 0 + HARDENED)

        # Generate Ed25519 public key from derived 32-byte seed.
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey,
        )
        from cryptography.hazmat.primitives.serialization import (
            Encoding,
            PublicFormat,
        )

        priv_key = Ed25519PrivateKey.from_private_bytes(key)
        pub_key = priv_key.public_key().public_bytes(
            Encoding.Raw, PublicFormat.Raw,
        )
        assert len(pub_key) == 32, f"Ed25519 pubkey must be 32 bytes, got {len(pub_key)}"

        # --- DID derivation: did:plc:<base58btc(sha256(pubkey)[:16])> ---

        pub_hash = hashlib.sha256(pub_key).digest()
        plc_bytes = pub_hash[:16]

        # Base58btc encoding (Bitcoin alphabet).
        ALPHABET = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

        def base58btc_encode(data: bytes) -> str:
            # Count leading zero bytes.
            leading_zeros = 0
            for b in data:
                if b != 0:
                    break
                leading_zeros += 1

            # Convert to big integer and encode.
            num = int.from_bytes(data, "big")
            encoded = []
            while num > 0:
                num, remainder = divmod(num, 58)
                encoded.append(ALPHABET[remainder:remainder + 1])
            encoded.reverse()

            # Prepend '1' for each leading zero byte.
            return (b"1" * leading_zeros + b"".join(encoded)).decode("ascii")

        derived_did = "did:plc:" + base58btc_encode(plc_bytes)

        # --- Compare with actual DID from Node A ---

        did_a = _state.get("node_a_did", "")
        assert did_a, "Node A DID not recorded — test_01 must pass first"

        assert derived_did == did_a, (
            f"Seed-based DID derivation does not match Node A's actual DID.\n"
            f"  Derived from seed: {derived_did}\n"
            f"  Actual from API:   {did_a}\n"
            f"  Seed: 0x{'00' * 31}01\n"
            f"  Path: m/9999'/0'/0'\n"
            f"This means the DID would NOT survive a machine migration with\n"
            f"the same seed. Either the derivation path is wrong or Core\n"
            f"uses a different DID creation method than local did:plc."
        )

        _state["derived_did"] = derived_did
        print(f"\n  [migrate] Seed-based DID derivation: MATCH")
        print(f"  [migrate]   Derived: {derived_did}")
        print(f"  [migrate]   Actual:  {did_a}")
        print(f"  [migrate]   Proof: same seed → same DID across machines")

    # ==================================================================
    # test_06: Export creates a real encrypted archive
    # ==================================================================

    # TST-USR-071
    def test_06_export_creates_archive(
        self, alonso_core, admin_headers,
    ):
        """POST /v1/export creates a real encrypted archive from vault data.

        This is the first half of the migration story.  Alonso's laptop
        is dying — he needs to export everything before it's too late.

        Steps:
          1. Input validation: missing passphrase → 400.
          2. Safety check: export with personas open → MigrationService
             rejects (proves endpoint is wired, not a 501 stub).
          3. Lock all personas via POST /v1/persona/lock.
          4. POST /v1/export → 200 + archive_path.
          5. Unlock all personas (restore state).
        """
        # 1. Input validation: missing passphrase → 400.
        r = httpx.post(
            f"{alonso_core}/v1/export",
            json={"dest_path": "migration-test"},
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 400, (
            f"Expected 400 for missing passphrase, got {r.status_code}: "
            f"{r.text[:200]}"
        )
        assert "passphrase" in r.json().get("error", "").lower()
        print("\n  [migrate] Input validation (no passphrase): 400 ✓")

        # 2. Safety check: personas open → MigrationService rejects.
        r2 = httpx.post(
            f"{alonso_core}/v1/export",
            json={"passphrase": "migration-pass", "dest_path": "migration-test"},
            headers=admin_headers,
            timeout=10,
        )
        assert r2.status_code not in (501, 404), (
            f"Export endpoint returned {r2.status_code} — still a stub? "
            f"{r2.text[:200]}"
        )
        assert r2.status_code == 500
        assert "persona" in r2.json().get("error", "").lower()
        print("  [migrate] Safety check (personas open): blocked ✓")

        # 3. Lock lockable personas before export.
        # Default/standard personas cannot be locked (always open by design).
        # Only sensitive and locked tier personas need explicit locking.
        for persona in ["health"]:
            r = httpx.post(
                f"{alonso_core}/v1/persona/lock",
                json={"persona": persona},
                headers=admin_headers,
                timeout=10,
            )
            assert r.status_code == 200, (
                f"Failed to lock {persona}: {r.status_code} {r.text[:200]}"
            )
        print("  [migrate] Locked sensitive personas on Node A ✓")

        # 4. Export — create real encrypted archive.
        # Wrapped in try/finally so personas are ALWAYS unlocked even if export fails.
        try:
            r3 = httpx.post(
                f"{alonso_core}/v1/export",
                json={
                    "passphrase": "migration-pass",
                    "dest_path": "migration-test",
                },
                headers=admin_headers,
                timeout=30,
            )
            assert r3.status_code == 200, (
                f"Export failed: {r3.status_code} {r3.text[:200]}"
            )
            data = r3.json()
            archive_path = data.get("archive_path", "")
            assert archive_path, f"No archive_path in response: {data}"
            assert archive_path.endswith(".dina"), (
                f"Archive should be a .dina file: {archive_path}"
            )

            _state["archive_path"] = archive_path
            _state["export_passphrase"] = "migration-pass"
            print(f"  [migrate] Archive created: {archive_path}")
        finally:
            # 5. Unlock all personas — restore state regardless of export outcome.
            for persona in ["general", "consumer", "health"]:
                httpx.post(
                    f"{alonso_core}/v1/persona/unlock",
                    json={"persona": persona, "passphrase": "test"},
                    headers=admin_headers,
                    timeout=10,
                )
            print("  [migrate] Unlocked all personas on Node A ✓")

    # ==================================================================
    # test_07: Full migration roundtrip — export, transfer, import, verify
    # ==================================================================

    # TST-USR-072
    def test_07_migration_roundtrip(
        self, alonso_core, sancho_core, admin_headers, system_services,
    ):
        """Full migration roundtrip: export → transfer → import → query.

        This is the actual user story.  Alonso's laptop is dying.  He
        exports his vault, carries the encrypted archive to a brand-new
        machine, enters his recovery phrase (same seed), imports, and
        queries his data.

        The proof happens entirely on Node B:
          1. Transfer the archive from Node A → Node B (docker cp).
          2. Lock personas → import on Node B → verify result.
          3. Try to unlock with wrong seed → fails (crypto binding).
          4. Verify Node A data is intact (export non-destructive).
          5. Restart Node B with Alonso's seed (simulates entering
             the recovery phrase on the new machine).
          6. Unlock personas on Node B with same DEK → succeeds.
          7. GET /v1/did on Node B == Node A's DID (identity continuity).
          8. Query vault → original data is there.

        This is the single strongest end-to-end identity-migration
        claim: a fresh node running with the same seed can import
        and then query restored data as the migrated identity, and
        its live DID matches the original.  The wrong-seed failure
        in step 3 proves the vault is cryptographically bound —
        possession of the seed is required.
        """
        import os
        import subprocess
        import tempfile
        import time
        from pathlib import Path

        archive_path = _state.get("archive_path")
        assert archive_path, "No archive_path — test_06 must pass first"
        passphrase = _state.get("export_passphrase")

        # test file is at tests/system/user_stories/ — 4 levels to repo root.
        project_root = Path(__file__).resolve().parent.parent.parent.parent
        compose_file = str(project_root / "docker-compose-system.yml")

        # ── Step 1: Transfer archive from Node A to Node B ──────────
        with tempfile.NamedTemporaryFile(suffix=".dina", delete=False) as tmp:
            host_path = tmp.name

        try:
            result = system_services._compose(
                "cp", f"core-alonso:{archive_path}", host_path,
            )
            assert result.returncode == 0, (
                f"docker cp from Node A failed: {result.stderr[:300]}"
            )

            node_b_archive = "/tmp/imported-archive.dina"
            result = system_services._compose(
                "cp", host_path, f"core-sancho:{node_b_archive}",
            )
            assert result.returncode == 0, (
                f"docker cp to Node B failed: {result.stderr[:300]}"
            )
            # Fix permissions — docker cp creates files as root,
            # but dina-core runs as uid 10001 (dina user).
            system_services._compose(
                "exec", "-T", "core-sancho",
                "chmod", "644", node_b_archive,
            )
        finally:
            try:
                os.unlink(host_path)
            except OSError:
                pass

        print("\n  [migrate] Archive transferred: Node A → host → Node B ✓")

        # ── Step 2: Lock lockable personas on Node B → import ─────────
        # Default/standard cannot be locked. Only lock sensitive/locked.
        for persona in ["health"]:
            r = httpx.post(
                f"{sancho_core}/v1/persona/lock",
                json={"persona": persona},
                headers=admin_headers,
                timeout=10,
            )
            assert r.status_code == 200, (
                f"Failed to lock {persona} on Node B: "
                f"{r.status_code} {r.text[:200]}"
            )
        print("  [migrate] Locked sensitive personas on Node B ✓")

        r = httpx.post(
            f"{sancho_core}/v1/import",
            json={
                "archive_path": node_b_archive,
                "passphrase": passphrase,
                "force": True,
            },
            headers=admin_headers,
            timeout=30,
        )
        assert r.status_code == 200, (
            f"Import on Node B failed: {r.status_code} {r.text[:200]}"
        )
        import_result = r.json()

        files_restored = import_result.get("files_restored", 0)
        persona_count = import_result.get("persona_count", 0)

        assert files_restored >= 2, (
            f"Expected at least 2 files restored "
            f"(identity.sqlite + persona), got {files_restored}. "
            f"Full result: {import_result}"
        )
        assert persona_count >= 1, (
            f"Expected at least 1 persona restored, got {persona_count}. "
            f"Full result: {import_result}"
        )
        assert import_result.get("requires_repair") is True, (
            f"Expected requires_repair=true after import (devices must "
            f"re-pair), got: {import_result.get('requires_repair')}"
        )
        assert import_result.get("requires_restart") is True, (
            f"Expected requires_restart=true after import (identity DB "
            f"was closed for safe overwrite, process must restart), "
            f"got: {import_result.get('requires_restart')}"
        )
        print(
            f"  [migrate] Import on Node B: {files_restored} files, "
            f"{persona_count} personas, requires_repair=true, "
            f"requires_restart=true ✓"
        )

        # ── Step 3: Wrong seed cannot unlock imported vault ──────────
        # Node B still has Sancho's seed (0x...02).  The imported vault
        # files are encrypted with Alonso's DEK (derived from 0x...01).
        # Unlocking with the wrong seed must fail — this proves the
        # vault is cryptographically bound to the master seed.
        r = httpx.post(
            f"{sancho_core}/v1/persona/unlock",
            json={"persona": "general", "passphrase": "test"},
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code != 200, (
            f"Unlock with WRONG seed should have failed but returned "
            f"200 — vault is not cryptographically bound to the seed!"
        )
        print(
            f"  [migrate] Wrong seed → unlock failed "
            f"({r.status_code}): crypto binding ✓"
        )

        # ── Step 4: Verify Node A data is intact ────────────────────
        r = httpx.post(
            f"{alonso_core}/v1/vault/query",
            json={
                "persona": "general",
                "query": "migration test portability",
                "mode": "fts5",
                "limit": 10,
            },
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 200, (
            f"Node A query failed after export: "
            f"{r.status_code} {r.text[:200]}"
        )
        items_a = r.json().get("items", [])
        assert len(items_a) >= 1, (
            f"Node A lost data after export — expected at least 1 item, "
            f"got {len(items_a)}"
        )
        print(
            f"  [migrate] Node A data intact: {len(items_a)} items ✓"
        )

        # ── Step 5: Restart Node B with correct seed ─────────────────
        # This simulates "new machine, same recovery phrase."
        # Same seed → same SLIP-0010 keys → same DEK → SQLCipher opens.
        alonso_seed = (
            "00000000000000000000000000000000"
            "00000000000000000000000000000001"
        )

        override_path = os.path.join(
            tempfile.gettempdir(), "dina-migration-override.yml",
        )
        with open(override_path, "w") as f:
            f.write(
                "services:\n"
                "  core-sancho:\n"
                "    environment:\n"
                f'      DINA_MASTER_SEED: "{alonso_seed}"\n'
            )

        try:
            # Stop core-sancho.
            subprocess.run(
                ["docker", "compose", "-f", compose_file,
                 "stop", "core-sancho"],
                capture_output=True, text=True, timeout=60,
                cwd=str(project_root),
            )

            # Restart with Alonso's seed.
            result = subprocess.run(
                ["docker", "compose",
                 "-f", compose_file, "-f", override_path,
                 "up", "-d", "core-sancho"],
                capture_output=True, text=True, timeout=120,
                cwd=str(project_root),
            )
            assert result.returncode == 0, (
                f"Restart Node B with Alonso's seed failed: "
                f"{result.stderr[:300]}"
            )
            print("  [migrate] Node B restarted with Alonso's seed ✓")

            # Wait for Node B to become healthy.
            healthy = False
            for _ in range(40):
                try:
                    r = httpx.get(
                        f"{sancho_core}/healthz", timeout=3,
                    )
                    if r.status_code == 200:
                        healthy = True
                        break
                except Exception:
                    pass
                time.sleep(3)
            if not healthy:
                # Capture container logs for debugging.
                logs = subprocess.run(
                    ["docker", "compose", "-f", compose_file,
                     "logs", "--tail=30", "core-sancho"],
                    capture_output=True, text=True, timeout=10,
                    cwd=str(project_root),
                )
                assert False, (
                    f"Node B did not become healthy after restart.\n"
                    f"core-sancho logs:\n{logs.stdout[-1000:]}"
                )
            print("  [migrate] Node B healthy with same seed ✓")

            # ── Step 6: Unlock personas on Node B ───────────────────
            # Same seed → same DEK → imported SQLCipher files decrypt.
            for persona in ["general", "consumer", "health"]:
                r = httpx.post(
                    f"{sancho_core}/v1/persona/unlock",
                    json={"persona": persona, "passphrase": "test"},
                    headers=admin_headers,
                    timeout=10,
                )
                assert r.status_code == 200, (
                    f"Failed to unlock {persona} on Node B "
                    f"(same seed): {r.status_code} {r.text[:200]}"
                )
            print("  [migrate] Unlocked personas on Node B ✓")

            # ── Step 7: Verify Node B's live DID is Alonso's ───────
            # Same seed → same SLIP-0010 derivation → same DID.
            # This proves full identity continuity on the new machine.
            did_a = _state.get("node_a_did", "")
            assert did_a, "Node A DID not recorded — test_01 must pass first"

            r = httpx.get(
                f"{sancho_core}/v1/did",
                headers=admin_headers,
                timeout=10,
            )
            assert r.status_code == 200, (
                f"GET /v1/did on Node B (same seed) failed: "
                f"{r.status_code} {r.text[:200]}"
            )
            did_b_after = r.json().get("id", "")
            assert did_b_after == did_a, (
                f"Node B's DID after same-seed restart does not match "
                f"Node A's DID.\n"
                f"  Node A DID: {did_a}\n"
                f"  Node B DID: {did_b_after}\n"
                f"Identity continuity FAILED — the new machine did not "
                f"come up as Alonso."
            )
            print(
                f"  [migrate] Node B DID == Node A DID: "
                f"{did_b_after[:40]}... ✓"
            )

            # ── Step 8: Query vault on Node B ───────────────────────
            # The original data from test_00 must be queryable on the
            # new machine.  This is the strongest migration proof.
            r = httpx.post(
                f"{sancho_core}/v1/vault/query",
                json={
                    "persona": "general",
                    "query": "migration test portability",
                    "mode": "fts5",
                    "limit": 10,
                },
                headers=admin_headers,
                timeout=10,
            )
            assert r.status_code == 200, (
                f"Post-import query on Node B failed: "
                f"{r.status_code} {r.text[:200]}"
            )
            items = r.json().get("items", [])
            assert len(items) >= 1, (
                f"Data not found on Node B after migration — "
                f"expected at least 1 item, got {len(items)}"
            )

            all_text = " ".join(
                str(item.get("Summary", "")) + " "
                + str(item.get("BodyText", ""))
                for item in items
            )
            has_marker = (
                "portability" in all_text.lower()
                or "migration test" in all_text.lower()
            )
            assert has_marker, (
                f"Portability markers not found on Node B after "
                f"migration. Summaries: "
                f"{[i.get('Summary', '')[:50] for i in items]}"
            )

            print(
                f"  [migrate] Node B vault query: {len(items)} items "
                f"with portability markers ✓"
            )

        finally:
            # ── Cleanup: restore Node B to original config ──────────
            # Stop core-sancho (still running with Alonso's seed).
            stop_result = subprocess.run(
                ["docker", "compose", "-f", compose_file,
                 "stop", "core-sancho"],
                capture_output=True, text=True, timeout=60,
                cwd=str(project_root),
            )
            assert stop_result.returncode == 0, (
                f"Cleanup: failed to stop core-sancho: "
                f"{stop_result.stderr[:300]}"
            )

            # Delete imported vault files so restart with Sancho's
            # original seed can create fresh databases with the
            # correct DEK.  The import replaced all .sqlite files
            # with Alonso's versions — Sancho's DEK can't open them.
            subprocess.run(
                ["docker", "compose", "-f", compose_file,
                 "run", "--rm", "--no-deps", "-T",
                 "--entrypoint", "sh", "core-sancho",
                 "-c", "rm -f /data/vault/*.sqlite*"],
                capture_output=True, text=True, timeout=30,
                cwd=str(project_root),
            )

            # Restart WITHOUT the override → original Sancho seed.
            up_result = subprocess.run(
                ["docker", "compose", "-f", compose_file,
                 "up", "-d", "core-sancho"],
                capture_output=True, text=True, timeout=120,
                cwd=str(project_root),
            )
            assert up_result.returncode == 0, (
                f"Cleanup: failed to restart core-sancho: "
                f"{up_result.stderr[:300]}"
            )

            # Wait for health and assert it comes back.
            healthy = False
            for _ in range(30):
                try:
                    r = httpx.get(f"{sancho_core}/healthz", timeout=3)
                    if r.status_code == 200:
                        healthy = True
                        break
                except Exception:
                    pass
                time.sleep(3)
            assert healthy, (
                "Cleanup: Node B did not become healthy after "
                "restoring original config"
            )

            # Re-create and unlock personas on Node B so later
            # stories in the same session start clean.
            for persona in ["general", "consumer", "health"]:
                try:
                    httpx.post(
                        f"{sancho_core}/v1/personas",
                        json={
                            "name": persona,
                            "tier": (
                                "sensitive" if persona == "health"
                                else "default" if persona == "general"
                                else "standard"
                            ),
                            "passphrase": "test",
                        },
                        headers=admin_headers,
                        timeout=10,
                    )
                except Exception:
                    pass
                try:
                    httpx.post(
                        f"{sancho_core}/v1/persona/unlock",
                        json={
                            "persona": persona,
                            "passphrase": "test",
                        },
                        headers=admin_headers,
                        timeout=10,
                    )
                except Exception:
                    pass

            try:
                os.unlink(override_path)
            except OSError:
                pass
            print("  [migrate] Cleanup: Node B restored to original ✓")

        print("  [migrate] ──────────────────────────────────────────")
        print("  [migrate] Full migration roundtrip PASSED:")
        print("    1. Export on Node A  → real encrypted archive")
        print("    2. Transfer          → archive carried to Node B")
        print(
            f"    3. Import on Node B  → {files_restored} files, "
            f"{persona_count} personas restored"
        )
        print("    4. Wrong seed on B   → unlock FAILS (crypto binding)")
        print("    5. Node A intact     → export is non-destructive")
        print("    6. Same seed on B    → unlock succeeds (same DEK)")
        print("    7. Node B DID        → matches Node A (identity continuity)")
        print("    8. Query on Node B   → original data is there")
        print("    The new machine IS Alonso — same DID, same vault.")
        print("    Without the seed, nobody can read the vault.")
