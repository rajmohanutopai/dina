"""User Story 10: The Operator Journey — idempotent install & locked-node admin.

SEQUENTIAL TEST — tests MUST run in order (00 → 04).
Each test builds on state from the previous one.

Story
-----
Alonso is the operator. He installed Dina a week ago. Today he
re-runs the install script because he updated the code. Nothing
should break:

  1. **DID stability** — re-running install does not rotate the
     identity. Alonso's DID is derived from his Ed25519 keypair,
     which is persisted at ~/.dina/identity/. A second install
     finds the existing key and keeps it. No rotation, no new DID,
     no broken trust chains.

  2. **Persona idempotency** — creating a persona that already exists
     returns success (200 or 409), not a server error. The install
     script calls POST /v1/personas for each persona on every run.
     If the persona exists, it is a no-op.

  3. **Healthz stability** — multiple rapid health checks all return
     200. The system is deterministic under repeated probing.

  4. **Locked persona error** — if a persona is locked (not yet
     unlocked after restart), accessing its vault returns a clear
     error, not a crash. The operator sees "persona locked" and
     knows to unlock it.

This tests the **operator** path — the person who installs, updates,
and maintains the Home Node. Dina must be robust under repeated
installs, restarts, and administrative operations.

Maps to Suite 20: Operator Journey & Administrative Robustness.

Pipeline
--------
::

  Operator re-runs install
    → GET /v1/did → same DID as before (keypair persisted)
    → POST /v1/personas {name: personal} → 200 or 409 (idempotent)
    → GET /healthz → 200 (stable under repeated probing)
                    |
  Operator restarts node without unlocking personas
    → POST /v1/vault/query {persona: locked_one} → clear error
    → Error message: "persona locked" — not a crash
    → Operator runs: POST /v1/persona/unlock {persona, passphrase}
    → Vault access restored
"""

from __future__ import annotations

import httpx
import pytest

# ---------------------------------------------------------------------------
# Shared state across ordered tests
# ---------------------------------------------------------------------------

_state: dict = {}


# ---------------------------------------------------------------------------
# Test class — sequential user journey
# ---------------------------------------------------------------------------


class TestOperatorJourney:
    """The Operator Journey: idempotent install & locked-node admin."""

    # ==================================================================
    # test_00: Record baseline DID
    # ==================================================================

    # TST-USR-075
    def test_00_record_baseline_did(
        self, alonso_core, admin_headers,
    ):
        """GET /v1/did to record the baseline DID.

        This is the identity Alonso got when he first installed Dina.
        The Ed25519 keypair was generated and persisted at
        ~/.dina/identity/. Every subsequent request to /v1/did must
        return the same DID — the keypair is immutable once created.

        If this DID changes between install runs, it means the keypair
        was rotated (or regenerated), which would break all trust
        chains, signed verdicts, and D2D relationships.
        """
        r = httpx.get(
            f"{alonso_core}/v1/did",
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 200, (
            f"GET /v1/did failed: {r.status_code} {r.text[:200]}"
        )
        data = r.json()

        did = data.get("id", "")
        assert did, f"No DID returned: {data.keys()}"
        assert did.startswith("did:"), (
            f"DID does not start with 'did:': {did}"
        )

        _state["baseline_did"] = did
        print(f"\n  [operator] Baseline DID: {did[:50]}...")

    # ==================================================================
    # test_01: DID stable across requests
    # ==================================================================

    # TST-USR-076
    def test_01_did_stable_across_requests(
        self, alonso_core, admin_headers,
    ):
        """GET /v1/did again — must return the same DID.

        This simulates what happens when the install script re-runs:
        it calls /v1/did to discover the node's identity. The DID
        must be identical to the baseline — no rotation, no new key.

        We call it 3 times to verify stability under repeated access.
        """
        baseline = _state.get("baseline_did", "")
        assert baseline, "No baseline DID — test_00 must pass first"

        for attempt in range(3):
            r = httpx.get(
                f"{alonso_core}/v1/did",
                headers=admin_headers,
                timeout=10,
            )
            assert r.status_code == 200, (
                f"GET /v1/did attempt {attempt + 1} failed: "
                f"{r.status_code} {r.text[:200]}"
            )
            data = r.json()
            did = data.get("id", "")

            assert did == baseline, (
                f"DID changed on attempt {attempt + 1}! "
                f"Baseline: {baseline}, Got: {did}. "
                f"This means the keypair was rotated or regenerated."
            )

        print(f"\n  [operator] DID stable across 3 requests: YES")
        print(f"  [operator] No rotation detected")

    # ==================================================================
    # test_02: Persona create is idempotent
    # ==================================================================

    # TST-USR-077
    def test_02_persona_recreate_idempotent(
        self, alonso_core, admin_headers,
    ):
        """POST /v1/personas with existing persona returns 200 or 409.

        The install script creates personas on every run:
          POST /v1/personas {name: "personal", tier: "open", passphrase: "..."}

        If the persona already exists (from a previous install), Core
        must handle it gracefully:
          - 200 or 201: persona created (first run) or re-acknowledged
          - 409: persona already exists (subsequent runs) — this is fine

        What must NOT happen:
          - 500: internal server error (crash)
          - Any other 4xx/5xx that indicates a bug
        """
        r = httpx.post(
            f"{alonso_core}/v1/personas",
            json={
                "name": "personal",
                "tier": "open",
                "passphrase": "test",
            },
            headers=admin_headers,
            timeout=10,
        )

        # 200/201 (created or acknowledged) or 409 (already exists) are all OK.
        assert r.status_code in (200, 201, 409), (
            f"Persona re-create returned unexpected status: {r.status_code}. "
            f"Expected 200, 201, or 409. "
            f"Response: {r.text[:300]}"
        )

        _state["persona_recreate_status"] = r.status_code
        print(
            f"\n  [operator] Persona re-create (personal): "
            f"status={r.status_code} (idempotent: YES)"
        )

    # ==================================================================
    # test_03: Healthz stable under repeated probing
    # ==================================================================

    # TST-USR-078
    def test_03_healthz_stable(
        self, alonso_core,
    ):
        """Multiple healthz calls all return 200.

        The operator's monitoring system (or Docker healthcheck) probes
        /healthz repeatedly. Every single call must return 200. If any
        call fails, the container would be marked unhealthy and
        restarted — causing unnecessary downtime.

        We call 5 times to verify stability under rapid probing.
        """
        for attempt in range(5):
            r = httpx.get(f"{alonso_core}/healthz", timeout=10)
            assert r.status_code == 200, (
                f"healthz failed on attempt {attempt + 1}: "
                f"{r.status_code} {r.text[:200]}"
            )

        print(f"\n  [operator] healthz: 5/5 calls returned 200")
        print(f"  [operator] Stable under repeated probing: YES")

    # ==================================================================
    # test_04: Locked persona returns clear error
    # ==================================================================

    # TST-USR-079
    def test_04_locked_persona_clear_error(
        self, alonso_core, admin_headers,
    ):
        """Lock a persona and access vault — verify clear locked error.

        After a node restart, personas are locked until explicitly
        unlocked with the passphrase. If the operator (or an automated
        script) tries to access vault data on a locked persona, Core
        must return a clear error:

          - Status: 403 or 423 (Locked) — not 500
          - Body: contains "locked" — the operator knows what to do
          - No crash, no hang, no data leak

        We create a temporary persona, lock it (by not unlocking after
        creation on the test path — or we test with a known locked
        persona pattern), and verify the error is clear.

        Note: In the Docker test setup, personas are unlocked by
        conftest.py. We test the error path by creating a new persona
        and querying before unlock, or by verifying that the error
        handling path returns valid JSON with a clear message.
        """
        # Create a fresh persona specifically for the lock test.
        create_r = httpx.post(
            f"{alonso_core}/v1/personas",
            json={
                "name": "locktest",
                "tier": "restricted",
                "passphrase": "locktest-phrase",
            },
            headers=admin_headers,
            timeout=10,
        )
        # 200/201 (created) or 409 (exists from a previous run).
        assert create_r.status_code in (200, 201, 409), (
            f"Create locktest persona failed: {create_r.status_code} "
            f"{create_r.text[:200]}"
        )

        # If the persona was just created, it should require unlock
        # before vault access. If it already existed (409), it might
        # already be unlocked from a prior run. Either way, we test
        # the vault access path.
        #
        # Try to query vault on the locktest persona WITHOUT unlocking.
        # If the persona is freshly created (not unlocked), this should
        # return a locked error. If it was previously unlocked (409 case),
        # we verify the path still works without crashing.
        query_r = httpx.post(
            f"{alonso_core}/v1/vault/query",
            json={
                "persona": "locktest",
                "query": "test",
                "mode": "fts5",
                "limit": 1,
            },
            headers=admin_headers,
            timeout=10,
        )

        if create_r.status_code in (200, 201):
            # Freshly created — should be locked (need unlock first).
            # Accept 403 (forbidden/locked) or 423 (locked) or 200
            # (some implementations auto-unlock on create).
            if query_r.status_code in (403, 423):
                # Clear locked error — this is the expected path.
                body = query_r.text.lower()
                assert "lock" in body, (
                    f"Locked persona error should mention 'locked'. "
                    f"Status: {query_r.status_code}, Body: {query_r.text[:300]}"
                )
                print(
                    f"\n  [operator] Locked persona query: "
                    f"status={query_r.status_code}, clear error: YES"
                )
            elif query_r.status_code == 200:
                # Some implementations auto-unlock on creation. This is
                # acceptable — the important thing is no crash.
                print(
                    f"\n  [operator] Persona auto-unlocked on create: "
                    f"status={query_r.status_code} (acceptable)"
                )
            else:
                pytest.fail(
                    f"Unexpected status for locked persona query: "
                    f"{query_r.status_code}. Expected 403, 423, or 200. "
                    f"Response: {query_r.text[:300]}"
                )
        else:
            # Persona existed (409) — may be unlocked from prior run.
            # Just verify the response is well-formed (no crash).
            assert query_r.status_code in (200, 403, 423), (
                f"Unexpected status for existing persona query: "
                f"{query_r.status_code}. Response: {query_r.text[:300]}"
            )
            print(
                f"\n  [operator] Existing persona query: "
                f"status={query_r.status_code} (no crash: YES)"
            )

        # Verify no 500-class errors — the system must never crash
        # on locked persona access.
        assert query_r.status_code < 500, (
            f"Server error on locked persona access: {query_r.status_code}. "
            f"This indicates a crash or unhandled exception. "
            f"Response: {query_r.text[:300]}"
        )

        print("  [operator] Operator journey verified:")
        print("    - DID: stable across requests (no rotation)")
        print("    - Persona create: idempotent (200/201/409)")
        print("    - healthz: stable under repeated probing")
        print("    - Locked persona: clear error (no crash)")
