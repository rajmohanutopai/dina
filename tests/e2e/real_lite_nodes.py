"""RealLiteHomeNode — E2E actor backed by the TypeScript Home Node Lite stack.

Scaffold for task 9.3 (Don Alonso M1 smoke path). Parallels
`real_nodes.py`'s `RealHomeNode` but points at a Lite container pair
(`alonso-lite-core` + `alonso-lite-brain` from the `lite` compose
profile added in task 9.1 iter 62). Same interface as `RealHomeNode`
so smoke tests written against Go's actor fixture can in principle
swap to this one under `DINA_LITE_E2E=docker` (per task 9.2's conftest
branch, iter 55).

**Status: scaffold.** The class is structurally complete but individual
method coverage grows incrementally as migration tasks 9.3 (Don
Alonso), 9.4 (Sancho), 9.5 (ChairMaker), 9.6 (Albert) per-actor smoke
paths land. `healthz` + base-URL management work today; the vault /
persona / DID / PII operations override on top of `HomeNode`'s mock
base exactly like `RealHomeNode` does — swap the URL, keep the mock
state updated in parallel for assertion compatibility.

**M1 scope.** Lite stack ships a single actor at M1 (Don Alonso only,
per the `lite` compose profile from task 9.1). Multi-actor (Sancho /
ChairMaker / Albert) lands with the respective M2/M3 milestones + the
corresponding compose-profile additions.
"""

from __future__ import annotations

from typing import Any

import httpx

class RealLiteHomeNode:
    """HomeNode actor backed by Lite Core + Lite Brain HTTP endpoints.

    Constructor takes base URLs for the Lite containers the actor maps
    to. For the M1 Don Alonso smoke (task 9.3), the compose defaults
    are `http://127.0.0.1:28100` (core) + `http://127.0.0.1:28200`
    (brain) — matching task 8.2's `LiteDockerServices` port offsets.

    Currently overrides `/healthz` only; per-method overrides land with
    each Phase 9 migration task as brain-server routes mature.
    """

    def __init__(
        self,
        *,
        core_url: str,
        brain_url: str,
        client_token: str = "",
    ) -> None:
        self.core_url = core_url.rstrip("/")
        self.brain_url = brain_url.rstrip("/")
        self.client_token = client_token
        self._http = httpx.Client(timeout=5.0)

    def close(self) -> None:
        self._http.close()

    # ------------------------------------------------------------------
    # Overridden endpoints — minimal M1 surface
    # ------------------------------------------------------------------

    def healthz(self) -> bool:
        """Both Core and Brain must report healthy for the actor to be usable."""
        return self.core_healthz() and self.brain_healthz()

    def core_healthz(self) -> bool:
        try:
            return self._http.get(f"{self.core_url}/healthz").is_success
        except httpx.HTTPError:
            return False

    def brain_healthz(self) -> bool:
        try:
            return self._http.get(f"{self.brain_url}/healthz").is_success
        except httpx.HTTPError:
            return False

    # Per-method overrides to be added as Phase 9 migration lands:
    #   vault_store / vault_query / vault_list / vault_delete
    #   did_sign / did_sign_canonical
    #   pii_scrub / pii_rehydrate
    #   persona_status / persona_unlock
    #   notify
    #   memory_toc
    #   ask / reason / process  (Phase 5c brain-server route landing)
    #
    # Each follows the RealHomeNode pattern: httpx call → on-success
    # update mock state in parallel → return mock's return shape so
    # assertion code reads identically against either stack.

    # ------------------------------------------------------------------
    # Dev-helper factory
    # ------------------------------------------------------------------

    @classmethod
    def default_alonso(cls, *, client_token: str = "") -> "RealLiteHomeNode":
        """Construct Alonso-over-Lite with the compose-default ports (task 9.3).

        Matches `alonso-lite-core` + `alonso-lite-brain` from the `lite`
        compose profile (task 9.1, iter 62). Use this in the M1 smoke
        fixture; override constructor args directly for non-default
        port or host overrides.
        """
        return cls(
            core_url="http://127.0.0.1:28100",
            brain_url="http://127.0.0.1:28200",
            client_token=client_token,
        )

    @classmethod
    def default_sancho(cls, *, client_token: str = "") -> "RealLiteHomeNode":
        """Construct Sancho-over-Lite — M2 scaffold (task 9.4).

        Sancho is the "Sancho Moment" scenario actor — a trusted friend
        whose arrival context Dina whispers to the user. The Sancho
        Moment scenario (`test_dina_to_dina.py::TestSanchoArrival`) is
        M2 scope (task 8.9 iter 64 + file-level skip). The Lite
        compose profile from task 9.1 currently ships `alonso-lite-*`
        only; the `sancho-lite-core` + `sancho-lite-brain` entries land
        when the M2 compose profile expansion follows task 9.4's smoke
        path. Port offsets mirror the Go stack's actor-offset pattern:
        next-available +100 from Alonso.
        """
        return cls(
            core_url="http://127.0.0.1:28300",
            brain_url="http://127.0.0.1:28400",
            client_token=client_token,
        )

    @classmethod
    def default_chairmaker(cls, *, client_token: str = "") -> "RealLiteHomeNode":
        """Construct ChairMaker-over-Lite — M3 scaffold (task 9.5).

        ChairMaker is the vendor/seller actor in Dina's open-economy
        scenarios — exercises Trust Network lookups, expert
        attestations, cart handover. Full role requires M3 (trust
        rings + service query + D2D transactions). File-level skips
        applied at `test_trust_network.py` (task 8.20), `test_open_economy.py`
        (task 8.24), `test_cart_handover.py` (task 8.25) — all
        `pending-feature` until M3.

        Port offset +300 from Alonso.
        """
        return cls(
            core_url="http://127.0.0.1:28700",
            brain_url="http://127.0.0.1:28800",
            client_token=client_token,
        )

    @classmethod
    def default_albert(cls, *, client_token: str = "") -> "RealLiteHomeNode":
        """Construct Albert-over-Lite — M2 scaffold (task 9.6).

        Albert is the contact/beneficiary actor — appears in the
        contact-relationship scenarios. Albert's full role is in the
        Digital Estate story (test_digital_estate.py, task 8.44) +
        contact-relationship flows at M2. The `albert-lite-core` +
        `albert-lite-brain` compose entries land alongside the M2
        compose profile expansion. Port offsets continue from
        Sancho: +200 from Alonso.

        Note: task 8.44 notes Albert's Digital Estate suite is
        currently descoped on the Go side ("albert-data" volume
        commented out in docker-compose-test-stack.yml). Lite's
        equivalent follows the same descope until the story is
        re-activated.
        """
        return cls(
            core_url="http://127.0.0.1:28500",
            brain_url="http://127.0.0.1:28600",
            client_token=client_token,
        )
