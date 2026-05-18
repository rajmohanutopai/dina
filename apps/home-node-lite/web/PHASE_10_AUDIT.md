# Phase 10 — Full test sweep + parity audit

Source-of-truth for the regression contract the Home Node Lite Web UI
ships against. Updated whenever new Playwright specs land, new
Chrome-plugin scenarios are added, or the dual-mode shim parity tests
are extended.

## Summary — test count snapshot

| Surface                                         | Count                                    | Notes                                         |
| ----------------------------------------------- | ---------------------------------------- | --------------------------------------------- |
| **Jest** — `@dina/protocol`                     | 14                                       | wire-format contract                          |
| **Jest** — `@dina/brain`                        | 3,175 (+40 skipped)                      | reasoning, chat, ask, vault context           |
| **Jest** — `@dina/core` (TS)                    | 4,328 (+1 skipped)                       | crypto, vault domain, port interfaces         |
| **Jest** — `@dina/home-node`                    | 114                                      | ask + service runtime composition             |
| **Jest** — `@dina/storage-node`                 | 19                                       | SQLCipher-backed persistence                  |
| **Jest** — `@dina/keystore-node`                | 17                                       |                                               |
| **Jest** — `@dina/net-node`                     | 25                                       |                                               |
| **Jest** — `@dina/adapters-node`                | 62                                       |                                               |
| **Jest** — `@dina/fixtures`                     | 380 (+2 skipped)                         | shared test data                              |
| **Jest** — `@dina/test-harness`                 | 128                                      | test utilities                                |
| **Jest** — `@dina/home-node-lite-brain-server`  | 49                                       | Fastify routes (chat, ask, **web**, scaffold) |
| **Jest** — `@dina/home-node-lite-core-server`   | 2,351                                    | full Core HTTP surface                        |
| **Jest** — `@dina/app` (mobile)                 | 2,692 (+10 skipped)                      | hooks, screens, services, keychain parity     |
| **Playwright** — `@dina/home-node-lite-web-e2e` | 38                                       | full SPA suite (this file's primary scope)    |
| **TOTAL functional tests**                      | **13,354 jest + 38 playwright = 13,392** |                                               |

(53 skipped across the workspace are intentional — flaky-on-CI or
environment-dependent tests gated behind feature flags.)

## Playwright sweep — 38 specs across 7 files

```
__e2e__/smoke.spec.ts        — 3 specs · SPA shell + bundle mount + SPA fallback
__e2e__/onboarding.spec.ts   — 1 spec  · infra-setup → welcome → mode-choice render walk
__e2e__/chat_api.spec.ts     — 3 specs · POST /api/v1/chat + /reset + 400 validation
__e2e__/tab_routes.spec.ts   — 29 specs · every Expo Router route renders cleanly
__e2e__/d2d_websocket.spec.ts — 2 specs · WS + WebCrypto capability + chat/[did] route
```

Each Playwright spec runs against the paired stack the
`playwright.config.ts` `webServer` block spawns:

- `core-server` listening on `:18298` with a fresh `DINA_VAULT_DIR`
  temp directory.
- `brain-server` listening on `:18299` with `DINA_BRAIN_WEB_UI=1`, a
  random Ed25519 service-key seed generated at config-load time,
  and `DINA_CORE_URL` pointing at the just-started Core.

## Phase-by-phase coverage

| Phase                                      | Playwright spec(s)                                                | Other artifacts                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **0** Architecture spike                   | (none — direct Chrome plugin run)                                 | `apps/mobile/__chrome__/welcome_screen_renders.scenario.md` + result.md                                                                   |
| **1** Build pipeline                       | `smoke.spec.ts` (3)                                               | `apps/home-node-lite/brain-server/src/routes/web.ts` + 8 unit tests in `__tests__/web_routes.test.ts`; `.github/workflows/ts-web-e2e.yml` |
| **2** Storage shim                         | (Jest)                                                            | `apps/mobile/src/services/keychain.web.ts` + 15-spec dual-mode parity test; `apps/home-node-lite/web/SECURITY.md`                         |
| **3** Onboarding render walk               | `onboarding.spec.ts` (1)                                          | `apps/mobile/__chrome__/onboarding_walk.scenario.md`                                                                                      |
| **4** Chat tab HTTP backend                | `chat_api.spec.ts` (3)                                            | (brain-server's chat orchestrator route)                                                                                                  |
| **5** PeerLens tab + 6 preferences screens | `tab_routes.spec.ts` (11)                                         |                                                                                                                                           |
| **6** Vault tab + persona switcher         | `tab_routes.spec.ts` (2)                                          |                                                                                                                                           |
| **7** 12 other tabs                        | `tab_routes.spec.ts` (14)                                         |                                                                                                                                           |
| **8** Notifications + reminder fire        | `tab_routes.spec.ts` (2 — `/web/notifications`, `/web/reminders`) | `expo-notifications` already ships `.web.js` peers; mobile-side `Platform.OS !== 'web'` gates the scheduling primitives                   |
| **9** D2D + MsgBox WebSocket               | `d2d_websocket.spec.ts` (2)                                       |                                                                                                                                           |
| **10** Full test sweep + parity audit      | **this document**                                                 | All of the above                                                                                                                          |
| **11** Distribution                        | (none — manual verification)                                      | `apps/home-node-lite/install-lite.sh --web-ui`; README web-UI section; `docker-compose.lite.yml` web volume mount                         |

## Parity audit — what the spec MEANS

### Keychain parity (Phase 2)

`apps/mobile/__tests__/services/keychain_dual.test.ts` runs the same
7 scenarios against:

1. The mobile `keychain.ts` → `react-native-keychain` mock.
2. The web peer `keychain.web.ts` → fake-indexeddb + Node-WebCrypto.

If either backend drifts from the other's external contract the
test fails. Plus one direct ciphertext-on-disk inspection that
asserts the plaintext canary doesn't appear anywhere in the stored
IndexedDB row — the encryption-at-rest claim is mechanically
enforced.

### Route resolution parity (Phases 5-9)

`tab_routes.spec.ts` walks every Expo Router file under
`apps/mobile/app/*` and verifies the brain-server's `/web/*` SPA
fallback delivers them. Two failure modes the spec catches:

- **Native module leakage.** Any `TypeError` / `ReferenceError`
  / "cannot read properties of undefined" with a Module-not-found
  signature fails the spec. That's the Phase 2 keychain regression
  class plus any future Phase X regression where a `react-native-*`
  module without a `.web.ts` peer sneaks into the bundle.
- **SPA-fallback collapse.** Any `/web/<unknown>` request that
  returns 404 (rather than the SPA index.html) fails. That's the
  Phase 1 brain-server SPA-fallback regression class.

### Chrome-plugin scenarios

The `apps/mobile/__chrome__/` directory holds Markdown-driven
scenarios any operator can replay manually:

```
welcome_screen_renders.scenario.md   (Phase 0)
onboarding_walk.scenario.md          (Phase 3)
```

The driver-doctor (`apps/mobile/__chrome__/scripts/drivers-doctor.sh`)
verifies the local machine has Chrome plugin / idb / adb ready
before the operator runs them.

## What's NOT in this sweep — known gaps

These items require infrastructure beyond what fits inside the
single-process Playwright run; they're documented here so they
don't get silently lost:

1. **PDS-backed onboarding completion.** Provisioning a real
   `did:plc` requires a PDS (test fleet or local fixture). The
   Phase 3 render walk stops at mode-choice for that reason. A
   future CI matrix that spawns a local PDS container + plumbs its
   URL through `DINA_PDS_URL` unblocks the full
   onboarding → chat-home happy-path spec.
2. **Live MsgBox round-trip.** The Phase 9 spec proves the
   browser's `WebSocket` ctor + WebCrypto primitives are present
   and `/web/chat/<did>` renders. The actual send → receive →
   render-in-thread path crosses a wss:// boundary; a local
   MsgBox fixture lets us pin that contract in CI.
3. **Full `/remember` and `/ask` UI flows.** Phase 4 covers the
   HTTP layer (`POST /api/v1/chat` returns valid `ChatResponse`).
   Driving the same path through the chat input UI requires a
   reachable LLM provider (Anthropic / Gemini / OpenAI key in CI
   secrets) — a Phase 12+ orchestration concern once the
   per-provider credential flow ships.

## How to extend this sweep

When adding a new web-side feature:

1. **Render path** — add the new route to `tab_routes.spec.ts` so
   the bundle-mount + console-error contract is asserted.
2. **HTTP path** — add an API-level test to either `chat_api.spec.ts`
   (if it lives under `/api/v1/chat/*`) or a new `*_api.spec.ts`
   sibling.
3. **Storage path** — if the feature reads/writes via the
   keychain shim, extend the scenarios in `keychain_dual.test.ts`
   so parity stays mechanically enforced.
4. **Chrome-plugin scenario** — for UI-heavy features, add a
   `.scenario.md` under `apps/mobile/__chrome__/` so an operator
   can replay the flow manually outside CI.
5. **This document** — append the new spec count + the
   phase-by-phase row.
