"""Real HTTP clients for the TypeScript Home Node Lite stack (task 8.3).

These mirror the production `real_clients.py` pattern: inherit from
the Mock base class so the interface stays identical, override the
network paths to hit the Lite containers' HTTP API.

At M1 scope the Lite Core's wire surface is a strict subset of Go
Core's — same endpoint paths, same wire shapes per `@dina/protocol`.
So the only thing that changes between `RealGoCore` and `RealLiteCore`
is the base URL and a handful of error-prose expectations (tracked in
`tests/integration/LITE_ERROR_STRINGS.md`). Keeping the Mock base
classes shared (`MockGoCore` / `MockPythonBrain`) means migrating a
test to run against Lite is swapping the fixture's Real class, not
rewriting assertions.

**Status: scaffold (task 8.3).** Full method coverage lands per Phase
8a migration (tasks 8.5-8.11) — each test file that migrates pulls
into this module whatever endpoint surface it needs, ratcheting the
implementation outward from `/healthz` over time.

**M1 endpoint coverage:**

| Endpoint        | Status | Migration task |
|-----------------|--------|----------------|
| `GET /healthz`  | ✅     | this file      |
| `POST /v1/vault/store` | ⏳ | task 8.5 (test_home_node.py) |
| `POST /v1/vault/query` | ⏳ | task 8.5 / 8.7 |
| `POST /v1/did/sign`    | ⏳ | task 8.8 (test_didcomm.py) |
| `POST /api/v1/ask`     | ⏳ | task 8.5 / 8.7 |
| `POST /api/v1/reason`  | ⏳ | task 8.7 (test_memory_flows.py) |
| `POST /api/v1/process` | ⏳ | task 8.5 |

When a migration task needs a new endpoint, add the override here;
don't inline HTTP calls in the test file.
"""

from __future__ import annotations

import httpx

from .mocks import MockGoCore, MockPythonBrain


class RealLiteCore(MockGoCore):
    """HTTP client targeting the TypeScript Lite Core container.

    Inherits from MockGoCore so existing tests (which assert against
    MockGoCore's interface) keep working with zero changes — only the
    wired URL and actual network path differ.

    Only `/healthz` is overridden at this scaffold stage; per-endpoint
    overrides land with the migration tasks that need them.
    """

    def __init__(self, base_url: str, client_token: str = "") -> None:
        # MockGoCore takes (vault, identity, scrubber) — real calls
        # bypass these in favour of HTTP, but the base class still
        # tracks assertion state that existing tests reference (e.g.
        # `_notifications_sent`). Instantiating the default mocks here
        # matches `RealGoCore`'s pattern.
        from .mocks import MockIdentity, MockPIIScrubber, MockVault

        super().__init__(MockVault(), MockIdentity(), MockPIIScrubber())
        self.base_url = base_url.rstrip("/")
        self.client_token = client_token
        self._http = httpx.Client(timeout=5.0)

    def close(self) -> None:
        self._http.close()

    # ------------------------------------------------------------------
    # Overridden endpoints (the "Real" part — talk to Lite container)
    # ------------------------------------------------------------------

    def healthz(self) -> bool:
        """GET /healthz — Lite Core aliveness probe."""
        try:
            r = self._http.get(f"{self.base_url}/healthz")
            return r.is_success
        except httpx.HTTPError:
            return False


class RealLiteBrain(MockPythonBrain):
    """HTTP client targeting the TypeScript Lite Brain container.

    Same inherit-from-Mock pattern as RealLiteCore. Only /healthz is
    overridden at scaffold stage; `/api/v1/ask`, `/api/v1/reason`,
    `/api/v1/process` land per the migration tasks that need them.
    """

    def __init__(self, base_url: str, client_token: str = "") -> None:
        # MockPythonBrain takes (classifier, whisper, router). Assertion
        # state (call counts, generated whispers) lives on these; real
        # network calls bypass them, mock state updated alongside per
        # the `RealPythonBrain` convention in `real_clients.py`.
        from .mocks import (
            MockLLMRouter,
            MockSilenceClassifier,
            MockVault,
            MockWhisperAssembler,
        )

        mock_vault = MockVault()
        super().__init__(
            MockSilenceClassifier(),
            MockWhisperAssembler(mock_vault),
            MockLLMRouter(profile="offline"),
        )
        self.base_url = base_url.rstrip("/")
        self.client_token = client_token
        self._http = httpx.Client(timeout=5.0)

    def close(self) -> None:
        self._http.close()

    def healthz(self) -> bool:
        """GET /healthz — Lite Brain aliveness probe."""
        try:
            r = self._http.get(f"{self.base_url}/healthz")
            return r.is_success
        except httpx.HTTPError:
            return False
