# Fixes found by the deck code checks

**Status:** PENDING, all items. Found 2026-10-12 against main 9bd04010, while
checking every claim in the four CEO decks (Security, PeerLens, Services, Inside
Dina) against the code. Read-only checks; no tests were run.

This list holds only what is broken or wrong **today**. Planned features are
elsewhere: PeerLens work in `docs/PEERLENS_COMPLETION_PLAN.md`, and the starred
"in plan" items on the decks. Where an item overlaps `docs/TODO.md`, the entry
says so.

Words used: PENDING (not started), DECIDE (needs the owner's call first).

## 1. Security and privacy (fix first)

| # | Fix | Where | Status |
|---|---|---|---|
| F1 | The cloud-AI consent gate for sensitive compartments does nothing. It checks for `financial` and `professional`, but the seeded compartments are `finance` and `work`; consent also defaults to yes and no compartment is passed in. | `packages/brain/src/composition/agentic_ask.ts:332-353`, `packages/brain/src/llm/router_dispatch.ts:426`, `packages/core/src/persona/names.ts:9-16` | PENDING |
| F2 | The rule that untrusted agents can't spend money never fires: the validate route marks every signed agent "verified". `transfer_money` is not in the money set either. HIGH still asks every time, so a purchase still waits for a tap. | `packages/core/src/server/routes/intent.ts:321-322`, `packages/core/src/gatekeeper/intent.ts:144` | PENDING |
| F3 | An agent picks `send_small` or `send_large` itself. Core never reads the count, and the CLI's `--count` flag is ignored. | `packages/core/src/gatekeeper/intent.ts` | PENDING |
| F4 | The CLI approves `read`, `lookup` and `recall` on its own when Core is unreachable. Core doesn't know those names and would treat them as MODERATE. | `cli/src/dina_cli/main.py:35-45, 1424-1432` | PENDING |
| F5 | A provider's Dina has no per-sender limit on incoming service questions. Only the relay limits senders (60 a minute); `rateLimitHint` is informational. | `packages/core/src/service/query_ingress.ts` | PENDING |
| F6 | Owner presence checks are skipped on nodes that can't verify presence. The photo-order path is the only exception (it fails closed). | `packages/core/src/server/routes/commerce.ts:600` | PENDING |
| F7 | PeerLens person scores still count reviews a moderator took down (subject scores already exclude them). Also W9 in the PeerLens plan. | `appview/src/scorer/jobs/refresh-profiles.ts:244-256` | PENDING |
| F8 | Service-query parameters skip the four outbound D2D checks. They go only to the chosen provider, sealed, but nothing filters personal data out of them. | `packages/core/src/d2d/send.ts:115-195` | DECIDE |

## 2. Broken or missing behaviour

| # | Fix | Where | Status |
|---|---|---|---|
| F9 | The plugin consent card tells people to run `dina-plugin serve`, which doesn't exist in the repo. | `apps/mobile/src/services/plugin_install.ts:170` | PENDING |
| F10 | When `/ask` invokes a plugin it passes no subject, so the context projector sends no context. | `packages/brain/src/reasoning/plugin_tools.ts` | PENDING |
| F11 | An answer paused for approval (Pattern A) is lost on restart: its state lives in `InMemoryAskAdapter`. Related to "in-flight ask lost on restart" in `docs/TODO.md`. | `packages/brain/src/composition/ask_coordinator.ts:202` | PENDING |
| F12 | The home server never calls topic touch, so its working memory and the ToC shown to the intent classifier are always empty. | `apps/home-node-lite/brain-server/src/boot.ts:394-404` | PENDING |
| F13 | The home server offers no Claude provider (phone only), and the router never selects the heavy tier. Related to TODO #10 (lite tier ignored). | `apps/home-node-lite/brain-server/src/config.ts:217-249`, `packages/brain/src/llm/router_dispatch.ts:264-275` | PENDING |
| F14 | Hybrid search's keyword half is a substring count over every row, which slows as the vault grows. Embeddings are generated only when the provider is Gemini. | `packages/core/src/vault/crud.ts:530-545`, `packages/brain/src/embedding/gemini_provider.ts:32` | PENDING |
| F15 | The phone's service editor hardcodes `mcpServer: 'openclaw'`, so Claude Code, Codex and Gemini daemons never get service tasks; those headless runners also drop the structured service details and return text. | `apps/mobile/app/service-settings.tsx:639`, `cli/src/dina_cli/headless_cli_runner.py:132-140, 200-204, 253-258` | PENDING |
| F16 | The catalog's `eta_query` parameters (flat `route_id`, `stop_id`, `lat`, `lng`) don't match Core's schema (`route_id` plus a nested `location`). | `packages/protocol/src/services/capability-catalog.ts`, `packages/core/src/service/capabilities/registry.ts` | PENDING |
| F17 | Order units have no lb, oz or gal; a US order in pounds can't be written. | `packages/commerce-protocol/src/units.ts:42-50` | PENDING |
| F18 | Reminders don't check Do Not Disturb when scheduled. | `apps/mobile/src/notifications/local.ts:34` | PENDING |
| F19 | PeerLens smaller defects: `authenticity` is always null in `resolve`; rate limits live in memory per instance; `FRIEND_BOOST` / `friendBoostFor()` are dead; `refresh-reviewer-namespace-stats` is never scheduled. The switched-off namespace and suspension gates are already in `docs/TODO.md`. Also W5/W9 in the PeerLens plan. | `appview/src/api/xrpc/resolve.ts`, `appview/src/ingester/rate-limiter.ts`, `appview/src/scorer/algorithms/friend-boost.ts`, `appview/src/scorer/scheduler.ts` | PENDING |

## 3. Docs and comments that say the wrong thing

| # | Fix | Where |
|---|---|---|
| D1 | The Argon2id header says 64 MB; the code uses 128 MB on every platform. (The security deck repeated 64 MB; corrected 2026-10-12.) | `packages/core/src/crypto/argon2id.ts:5`, `packages/crypto-expo/src/polyfills.ts:12` |
| D2 | `recovery.ts` describes a 64-byte PBKDF2 seed; the code uses the 32-byte entropy. | `packages/core/src/onboarding/recovery.ts:53` |
| D3 | The UCP doc gives the key path as `m/9999'/5'`; the code uses `/6'` (`/5'` is the A2A card key). | `docs/UCP_UNIVERSAL_COMMERCE.md:140` |
| D4 | authz lists `/v1/export` and `/v1/import`, but no HTTP route exists; the server backup is an offline tool. | `packages/core/src/auth/authz.ts` |
| D5 | `dina validate --help` says the reviewer sees context "in Telegram"; approvals land in the phone's Activity tab. | `cli/src/dina_cli/main.py` |
| D6 | The README says the bus provider uses Google Maps traffic; the demo is timetable-based and the stub returns random times. `docs/BUSDRIVER_SERVICES_SCENARIO.md` is cited but doesn't exist (the scenario is in `docs/SCENARIOS.md:877-990`). | `README.md:129-131` |
| D7 | Docs say "design only" or "uncommitted" for built work: UCP (`docs/UCP_UNIVERSAL_COMMERCE.md:3`, `docs/UCP_IMPLEMENTATION_PLAN.md:3`, `implementation-notes.html:113`), A2A M4–M5 (`docs/A2A_GATEWAY_ARCHITECTURE.md:3`), contact services, interactive services, push/watches, the photo-catalog lane, ask-for-quotes, the commerce procurement engine, the merchant integration and trade-first. | the docs named |
| D8 | Stale counts: `families.ts` says nine message types (14); `service_tools.ts` says three tools (five); `agentic_ask.ts` says five vault tools (21 always on plus 13 conditional); the capability catalog doc and a catalog comment say 3 capabilities (14); `service-search.ts` docstring says ranking v1 (v2, and it leaves out the liveness grouping). | `packages/core/src/d2d/families.ts:4`, `packages/brain/src/reasoning/service_tools.ts:2`, `packages/brain/src/composition/agentic_ask.ts:17`, `docs/SERVICE_CAPABILITY_CATALOG_DESIGN.md`, `packages/protocol/src/services/capability-catalog.ts:739-741`, `appview/src/api/xrpc/service-search.ts:54` |
| D9 | ARCHITECTURE.md says search defaults to hybrid and HNSW is hydrated on unlock; production uses FTS5 only and never builds HNSW. It also says `remove_diacritics 1`; the code uses 2. | `ARCHITECTURE.md:87, 154, 158` |
| D10 | The README says tier 3 is "saved for daily briefing"; no briefing is assembled or delivered. `lifecycle.ts` says sensitive compartments stay closed at boot; the owner's app opens them all. | `README.md:279`, `packages/core/src/vault/lifecycle.ts:4-9` |
| D11 | CLAUDE.md says a plugin runs as interpreted data or a runner; install refuses interpreted mode ("P0 is runner-only"). | `CLAUDE.md`, `packages/core/src/plugins/install_service.ts:1262-1269` |
| D12 | Tier 1 is documented as read-only, but it writes to the vault for approved bookings; the docs list Tier 1 on Lite as open work, but it is wired; comments still say "single row / fixed rkey self" for service config. | `docs/SERVICE_PROVIDER_TIERS.md:171, 189-191`, `packages/brain/src/service/capability_runtime.ts:14-15`, `packages/core/src/service/service_config.ts:12-14` |

## Order

If time is short before the demo: F1, F2 and F17 first (F1 and F2 contradict
claims on the slides; F17 shows the moment someone orders in pounds), then F9,
a short text fix.
