# Architecture Cleanup Review

Date: 2026-05-04

Branch: `architecture-cleanup`

Scope: TypeScript implementation drift for `apps/mobile`, `apps/home-node-lite`, and the TypeScript packages they compose (`packages/core`, `packages/brain`, `packages/protocol`, and TS storage/client surfaces). Go and Python Core/Brain are used only as mature behavior references for `/remember`, `/ask`, staging, persona gates, approvals, service query, and install semantics. They are not the future target architecture.

Related cleanup docs:

- `docs/SIMPLIFIED_ARCHITECTURE.md`
- `docs/ARCHITECTURE_CLEANUP_TASKS.md`
- `docs/ARCHITECTURE_CLEANUP_CODE_ARCHITECTURE.md`

## Target Architecture

The cleanup target is one TypeScript Home Node runtime that can run in two form factors:

1. Mobile Home Node: `apps/mobile` on Android and iOS. This is a full Home Node, not a wrapper.
2. Server Home Node: `apps/home-node-lite`, using the same TS runtime semantics as mobile, with Node.js platform adapters.

All network integration should flow through the hosted Dina services:

| Environment | MsgBox | System PDS | AppView | PLC |
| --- | --- | --- | --- | --- |
| Test/install | `wss://test-mailbox.dinakernel.com/ws` | `https://test-pds.dinakernel.com` | `https://test-appview.dinakernel.com` | `https://plc.directory` |
| Release | `wss://mailbox.dinakernel.com/ws` | `https://pds.dinakernel.com` | `https://appview.dinakernel.com` | `https://plc.directory` |

The important cleanup principle is that mobile and server must not become two different products. They should share the same Home Node composition, and only differ at platform adapter boundaries: storage, secure key custody, foreground/background scheduling, notifications, HTTP serving, and native/mobile UI integration.

Greenfield constraint: Go and Python Core/Brain are behavior references only. The TS mobile and server apps do not need to keep old runtime surfaces alive. There is no legacy support requirement, no normal migration path, and no compatibility layer for superseded runtime shapes.

Practical cleanup rule: when a TS file only exists to preserve an old runtime
shape or translate previous local config/data names, delete that path or make
the runtime reject the non-canonical input. Import/export tooling can be added
later as an explicit operator tool if needed; it should not be part of normal
Home Node boot.

## Simplified Architecture Plan Assessment

I agree with the simplified architecture plan.

It is the right direction because it removes the biggest source of drift: three independently evolving runtimes. Mobile should be a full Home Node, home-node-lite should be the server form factor of the same TS Home Node, and Go/Python should be used as behavior reference while being deactivated as production runtime.

The plan is especially good on these points:

- Private memory/persona state stays local to the Home Node.
- Public trust and service records go through signed PDS records and AppView indexing.
- Node-to-node delivery goes through MsgBox, so normal Home Nodes do not expose public inbound ports.
- Mobile and server share protocol, D2D envelope, memory semantics, trust records, and service workflows.
- Platform differences are adapters, not alternate product logic.

Possible architecture mistakes to avoid:

- Treating the shared runtime as a document-only goal. The code needs an actual `HomeNodeRuntime`/composition package used by both apps.
- Preserving the prior Go Core / Python Brain process split as the server product shape. Separate server processes are acceptable, but only as adapters around the same TS behavior.
- Leaving endpoint mode split. MsgBox, PDS, AppView, and PLC config must move together between test and release.
- Saying "MsgBox" without pinning the relay contract. Current TS D2D uses MsgBox HTTP `/forward` while WS handles session/RPC/inbound delivery; docs and implementation need to agree whether that remains canonical.
- Treating DID provisioning as install-complete without PDS account/session/publisher readiness.
- Letting mobile trust UI, agentic tools, service discovery, and node runtime use separate AppView configuration paths.
- Keeping direct Core staging imports in production mobile/Brain code. They bypass the transport boundary that server needs.

Bottom line: the target architecture is good. The work is to reduce TS drift against that target, not to redesign the target from Go/Python.

## Executive Summary

`apps/mobile` is much closer to the intended full Home Node than `apps/home-node-lite`. Mobile has a real composition path in `boot_service.ts`, `boot_capabilities.ts`, and `bootstrap.ts`: it creates a CoreRouter, in-process Core transport, workflow services, D2D sender, hosted AppView client, staging drain, agentic ask coordinator, service handlers, and MsgBox connection. Mobile onboarding also provisions did:plc material and publishes a MsgBox endpoint into the DID document. That said, release-critical wiring is still partial: PDS account/session/publisher boot, trust record persistence, durable trust reconciliation, persona approval parity review, and production trust publishing.

`apps/home-node-lite` is still mostly a scaffold. The README correctly says it is pre-M1. The Core server now boots Fastify, identity seed setup, the shared CoreRouter, and the shared MsgBox WebSocket bootstrap, but leaves keystore, DB, and adapter wiring pending. The Brain server now loads hosted endpoint config, constructs AppView and signed Core clients when a Brain service key is provisioned, starts the shared Brain staging drain scheduler against that signed Core client, builds/registers the agentic ask coordinator when Gemini is explicitly configured, consumes the `@dina/home-node/service-runtime` runtime when explicit service dependencies are supplied, and exposes health/readiness. It still does not wire PDS, full D2D/service delivery parity, or the full shared Home Node runtime. Existing TS packages contain much of the logic needed to make a real server Home Node, but the server app does not currently compose that logic into a full node.

The largest architectural miss is that there is no shared TS Home Node composition root. Mobile has most of the node, server has scaffolding, and shared packages expose pieces. Without extracting or standardizing the runtime composition, drift will continue.

Code architecture verdict: not pristine yet. The module-level implementation quality is often good, but ownership boundaries are not clean. Mobile currently owns the real runtime composition, home-node-lite has scaffolds and parallel server wiring, and shared packages expose many internals through deep imports. The main `docs/CODE_ARCHITECTURE.md` has been replaced with the TypeScript consolidation target. See `docs/ARCHITECTURE_CLEANUP_CODE_ARCHITECTURE.md` for the detailed code-architecture review.

## TS Drift Snapshot

| Area | Ideal simplified architecture | Mobile TS drift | Home-node-lite TS drift |
| --- | --- | --- | --- |
| Runtime composition | One shared TS Home Node runtime, adapters per platform. | Partial. Real runtime exists but lives under `apps/mobile`. | Major/partial. Core and Brain servers now bind real shared Core/Brain package surfaces, but they do not compose the full shared Home Node runtime yet. |
| Install | Seed, DID, PDS account/session, MsgBox endpoint, local vault, AppView check. | Partial/strong. DID PLC and MsgBox endpoint are provisioned; PDS session/publisher is incomplete. | Major. No full install/PDS/AppView/MsgBox composition. |
| Endpoint defaults | Test fleet by default; release fleet as one mode switch. | Done for endpoint policy. Mobile MsgBox, onboarding handle/PLC defaults, HandlePicker/OwnerName, trust AppView, node-runtime AppView, and `@dina/net-expo` now resolve through `@dina/home-node`. PDS publisher/session runtime still needs composition. | Done for config policy. Core/Brain server config now resolves hosted endpoints through `@dina/home-node`; Brain boot constructs AppView; runtime MsgBox/PDS clients and AppView route composition still need wiring. |
| `/remember` | Core ingest, Brain drain, enrichment, gates, durable pending approval, vault store. | Partial/strong. Canonical CoreClient ingest, repository-authoritative staging, explicit per-persona resolve gates, approval-backed locked staging rows, and pre-store L0/L1/embedding enrichment are in place. | Partial. Core ingest transport, staging repository authority, explicit resolve gates, approval-backed locked staging rows, enrichment-capable resolve data, Brain signed Core client construction, and Brain staging scheduler boot wiring exist. |
| `/ask` | Same coordinator/tool semantics on mobile and server. | Partial/strong. Agentic coordinator exists when provider/tools are configured. | Partial/strong. Brain boot composes/registers the same agentic coordinator shape when Gemini is explicitly configured. |
| D2D / MsgBox | Signed/sealed D2D through MsgBox with one documented relay contract. | Partial/strong. MsgBox and D2D are wired; current D2D uses `/forward` with WS for session/RPC. | Partial. Core server connects/authenticates to MsgBox and reports readiness; full D2D/service delivery parity and the relay contract decision remain open. |
| Trust publish | Dev test injection allowed; release publishes signed PDS records and reconciles through AppView. | Partial. UI/test path and PDS helper exist; durable outbox and default PDS path are missing. | Major. No full trust publish runtime. |
| Service discovery/query | Provider PDS profile, AppView discovery, MsgBox service windows. | Partial. Workflow/windows and default requester-side hosted AppView exist; PDS publisher default wiring is missing. | Partial. `@dina/home-node/service-runtime` can compose the shared service handler, discovery orchestrator, D2D dispatcher, workflow event consumer, and approval reconciler around signed Core/AppView; Brain server consumes it when explicit service dependencies are supplied; MsgBox/PDS/parity remain. |

## Behavior Reference Check

This is the Go/Python comparison that matters: not whether TS is shaped like Go/Python, but whether TS preserves the mature behavior.

| Flow | Mature behavior to preserve | TS mobile status | TS home-node-lite status |
| --- | --- | --- | --- |
| Install | Identity, DID, account/session, local vault, public routing endpoint, test fleet defaults. | Partial. DID/MsgBox/persona seed are good; PDS session/publisher still incomplete. | Missing. |
| `/remember` | Staging first, provenance, classification, enrichment, persona gates, pending approval/unlock, durable vault write. | Partial/strong. Production path crosses CoreClient, staging state is repository-authoritative, resolve requires explicit access state, locked targets resume through durable workflow approval tasks, and enrichment runs before store. | Partial. Core ingest transport, staging repository authority, resolve gates, approval-backed locked staging rows, enrichment-ready resolve data, signed Brain Core client construction, and Brain server scheduler boot wiring exist. |
| `/ask` | Fast path vs pending reason, persona guard/approval resume, vault tools, trust/service tools, PII-safe LLM path. | Partial/strong. Agentic path exists; release completeness depends on configured provider, AppView, and approvals. | Partial/strong. Server Brain builds the same Pattern A coordinator from signed Core/AppView/Gemini prerequisites. |
| D2D | Sign/seal, replay/type checks, service bypass windows, quarantine unknowns, MsgBox delivery. | Partial/strong. Core pipeline exists and mobile wires it; relay contract needs to be pinned as `/forward` vs WS D2D. | Partial. Core server connects to MsgBox and can host the Core RPC/D2D receive bootstrap, but server-side service/D2D runtime parity is incomplete. |
| Trust publish | Compose/validate, durable outbox, signed PDS record, AppView indexing/reconciliation; test injection dev-only. | Partial. UI/test injection and PDS publish helper exist; durable/default release path missing. | Missing. |
| Service query | Provider publishes capabilities, AppView discovery, idempotent workflow, policy approval/delegation, service.response completion. | Partial. Workflow, D2D windows, and requester-side AppView default exist; provider PDS publish default is missing. | Partial. Shared service runtime composition exists and Brain can consume it when dependencies are supplied; MsgBox delivery, provider PDS publish, and parity fixtures remain. |

## Current State By App

### `apps/mobile`

Mobile is the best reference for the TypeScript Home Node shape.

Strong areas:

- `apps/mobile/src/onboarding/provision.ts` provisions did:plc identity, publishes a DinaMsgBox endpoint, persists the DID, and seeds default personas.
- `apps/mobile/src/services/bootstrap.ts` composes many Home Node services in one place.
- `apps/mobile/src/services/boot_service.ts` degrades explicitly when platform capabilities are missing.
- `apps/mobile/src/services/boot_capabilities.ts` wires unlock-derived keys, the open database adapter when available, MsgBox, D2D send, staging enrichment, and agentic ask.
- `apps/mobile/src/hooks/useNodeBootstrap.ts` controls a singleton node lifecycle after unlock.
- `apps/mobile/src/storage/init.ts` initializes identity, contacts, reminders, audit, device, staging, chat, people graph, and persona vault persistence.
- D2D sign/seal/verify machinery exists in `packages/core`.
- Agentic ask and service tools exist in `packages/brain`.
- Trust publish UI in `apps/mobile/app/trust/write.tsx` is more concrete than the server path, especially for test AppView injection.

Major remaining gaps:

- Mobile now builds a real hosted AppView client by default in `boot_capabilities.ts` from the shared endpoint resolver. Home-node-lite Brain boot also constructs the hosted AppView client. Remaining AppView drift is wiring that server client into Brain routes/runtime and the fact that trust UI still uses a focused trust fetcher instead of the Brain `AppViewClient` type.
- PDS publisher/session boot is not built by default. Provider profile publishing and production trust publishing fall back to stubs/local outbox behavior.
- `/remember` now has one production mobile path: Chat tab -> Brain chat orchestrator -> `CoreClient.stagingIngest` -> Core staging route. The deleted mobile `ai/chat.ts`, `ai/memory.ts`, and `useChatRemember.ts` surfaces were removed outright; no alternate path is retained.
- Staging persistence is now repository-authoritative for Core staging state, and enrichment runs before Core resolve.
- Persona gate/approval handling during remember is implemented for locked staging rows. Multi-persona staging resolve now requires explicit access state; locked rows create durable workflow approvals and resume by approval id.
- Remember enrichment now runs the shared Brain enrichment pipeline before Core resolve. Records store deterministic L0, L1 when an LLM is registered, embeddings when an embedding provider is registered, structured `enrichment_version`, and explicit fallback metadata when providers are absent.
- Trust outbox is in-memory and test-inject oriented.
- No deleted mobile AI/chat/memory remember entry points remain in production code.

### `apps/home-node-lite`

Home-node-lite has useful tests and scaffolds, but it is not yet a runnable full Home Node.

Core server current state:

- `apps/home-node-lite/core-server/src/boot.ts` loads config and identity seed, assembles the shared `@dina/core` `CoreRouter`, binds it to Fastify through `bindCoreRouter`, starts Fastify, connects to MsgBox by default through `@dina/core/runtime` and `@dina/net-node`, and reports storage/adapter steps as pending.
- `apps/home-node-lite/core-server/src/server.ts` creates health/readiness/error envelope/rate limit/CORS infrastructure.
- `apps/home-node-lite/core-server/src/server/bind_core_router.ts` can bind a CoreRouter into Fastify, but boot does not call it.
- Config requires `DINA_VAULT_DIR`, resolves hosted endpoints through `@dina/home-node`, and defaults Core MsgBox boot to `wss://test-mailbox.dinakernel.com/ws`; PDS and storage runtime clients are not yet composed.

Brain server current state:

- `apps/home-node-lite/brain-server/src/boot.ts` starts Fastify with `/healthz` and `/readyz`, constructs a hosted AppView client from endpoint config, constructs a signed `HttpCoreTransport` when the Brain service key file exists, starts the staging drain scheduler after Fastify binds, registers ask routes either from an injected coordinator or from a real coordinator built with Core/AppView/LLM runtime dependencies, and consumes the `@dina/home-node/service-runtime` runtime when explicit service dependencies are supplied.
- `packages/home-node/src/service_runtime.ts`, exposed as `@dina/home-node/service-runtime`, owns the service handler/orchestrator/D2D dispatcher/workflow event/approval reconciler composition that mobile and server should share.
- `packages/home-node/src/ask_runtime.ts`, exposed as `@dina/home-node/ask-runtime`, mirrors mobile's shared `buildAgenticAskPipeline` path with injected dependencies: `ServiceQueryOrchestrator`, signed `CoreClient`, hosted `AppViewClient`, `ApprovalManager`, and supplied `LLMProvider`.
- Config covers host, port, log level, Core URL/service key, hosted endpoints, and explicit `none`/`gemini` LLM provider selection. It does not yet configure MsgBox runtime or PDS session/publisher.

Server target gap:

- The server app must eventually be another platform adapter for the same TS Home Node runtime. Today it is still mirroring the old split Core/Brain process shape without wiring the shared TS runtime into either process.

## Highest Risk Misses

| ID | Severity | Area | Status | Impact |
| --- | --- | --- | --- | --- |
| HN-01 | P0 | home-node-lite runtime | Partial | Server Home Node still is not a full TS Home Node, but Core and Brain boots now bind real shared Core/Brain package surfaces and Core now connects to MsgBox instead of remaining health-only scaffolding. |
| RT-01 | P0 | shared runtime | Partial | Initial shared `@dina/home-node` runtime contracts plus ask/service composition subpaths exist, but mobile still owns most full-node boot composition and server still lacks full runtime ownership. |
| AUTH-01 | P0 | core router binding | Done | `bindCoreRouter` now dispatches through `CoreRouter.handle`; signed-route regression tests pass. |
| GREEN-01 | P0 | greenfield cleanup | Partial | Persona tier runtime translation was removed from home-node-lite; server Brain no longer preserves `BrainCoreClient` builder naming; remaining old-runtime support comments/tests should be deleted or rewritten to canonical TS contracts. |
| STG-01 | P0 | remember/staging API | Done | Core exposes signed staging ingest and Brain/mobile remember use `CoreClient.stagingIngest`; server Brain now constructs a signed Core client and starts the shared staging drain scheduler when that client is configured. |
| MEM-01 | P0 | persona gates | Done | Resolve no longer defaults personas open. Locked targets create durable workflow approvals; approve stores, deny fails without retrying, and restart keeps the pending approval state. |
| MEM-02 | P0 | enrichment | Done | Brain staging drain and processor helper now run the shared enrichment pipeline before Core resolve, with JSON-safe embeddings and explicit fallback metadata. |
| PUB-01 | P0 | PDS/AppView | Partial | Mobile and Brain server construct real requester-side AppView clients by default; PDS publisher/session boot and server Brain route/runtime use remain incomplete. |
| TRUST-01 | P0 | trust publish | Partial | Test inject exists, but production PDS trust publish and durable outbox are missing. |
| PERSIST-01 | P0 | staging persistence | Done | Staging repository is authoritative for ingest/dedup/claim/resolve/fail/sweep, with restart-safety tests. |
| D2D-01 | P1 | MsgBox D2D | Needs decision | Target says all connections through MsgBox, but current TS disables WS D2D frames and uses HTTP forward fallback. |
| ALT-01 | P1 | mobile alternate paths | Done | Deleted mobile `ai/chat`, `ai/memory`, and standalone remember hook paths were removed outright. |
| ID-01 | P1 | install/account | Open | DID/PDS session/account model is not complete enough for release publishing. |

## Detailed Findings

### GREEN-01: Greenfield Means Canonical Runtime Inputs Only

Evidence:

- Fixed in `apps/home-node-lite/core-server/src/persona/persona_config.ts`: the
  persona config loader now accepts only canonical tiers
  (`default`, `standard`, `sensitive`, `locked`).
- Deleted `apps/home-node-lite/core-server/src/persona/tier_migration.ts` and
  its tests. The runtime no longer translates old `open` / `restricted` tier
  names.
- Fixed in `packages/adapters-node/__tests__/brain_smoke.test.ts`: the smoke no
  longer imports the retired Brain `CircuitBreaker`; it now proves Brain's
  staging drain composes with `CoreClient`/`InProcessTransport`.
- Fixed in mobile tests/source comments: app code and mobile tests no longer
  import the retired `brain/src/core_client/http` type path.
- Fixed in `apps/home-node-lite/brain-server/src/core_client.ts`: the server
  Brain Core client builder is named for the current `CoreClient` contract
  (`buildCoreClient` / `CoreClientBuildResult`) instead of the retired
  BrainCoreClient-era runtime.
- Fixed in `apps/home-node-lite/brain-server/__tests__/package_boundary.test.ts`:
  production Brain server code is guarded against reintroducing retired
  BrainCoreClient-era runtime naming.
- Fixed in production Core/Brain comments: narrow `CoreClient` and transport
  slices now describe the current contracts directly instead of preserving
  retired `BrainCoreClient` vocabulary.
- Fixed in `packages/brain/src/routing/gemini_classify.ts`: classification
  parsing now requires canonical `primary`; old `persona` response keys fall
  back instead of being accepted.
- Fixed in `packages/brain/src/person/linking.ts`: person-link parsing now
  accepts only the canonical `identity_links` envelope with `role_phrase`;
  old `links` / `role` aliases are not translated.

Impact:

- Home-node-lite boot/config behavior now matches the greenfield target: bad or
  non-canonical local config fails loudly instead of silently rewriting itself.
- Smoke tests protect the current TS runtime surface instead of pinning
  BrainCoreClient-era compatibility.
- Server Brain boot reads as a current TS Home Node adapter instead of a
  compatibility bridge from the retired BrainCoreClient runtime.
- Brain parsers now fail closed on old response envelopes while canonical
  `primary` and `identity_links` flows continue to pass tests.

Remaining work:

- Treat compatibility words carefully: product compatibility fields such as
  device `compat` tags are real domain vocabulary; old-runtime compatibility is
  not part of the target.

### CA-05/CA-06: Mobile Brain Chat Public Boundary

Evidence:

- Added `packages/brain/chat.ts` as the public `@dina/brain/chat` subpath for
  chat thread and chat orchestrator APIs.
- Updated mobile chat UI, inline cards, D2D chat, service delivery, reminders,
  nudges, approvals, trust draft review, and chat hooks to import from
  `@dina/brain/chat` instead of `@dina/brain/src/chat/thread` or
  `@dina/brain/src/chat/orchestrator`.
- Extended `apps/mobile/__tests__/architecture/package_boundary.test.ts` so
  production mobile code cannot reintroduce those Brain chat deep imports.

Impact:

- Mobile now treats Brain chat thread/orchestrator as a stable public API
  surface instead of reaching into package internals.
- The public subpath avoids root-level `ChatMessage` / `ChatResponse` type-name
  collisions with the LLM provider API already exported from `@dina/brain`.

Validation:

- `npm run typecheck --workspace @dina/brain`
- `npm run typecheck --workspace @dina/app`
- `npm test --workspace @dina/app -- architecture/package_boundary.test.ts --runInBand`
- `npm test --workspace @dina/app -- hooks/useChatThread.live.test.ts hooks/useChatAsk.test.ts hooks/useChatSystemMessages.test.ts hooks/useD2DMessages.test.ts hooks/useD2DChat.test.ts hooks/useChatApprovals.test.ts hooks/useServiceThreadDelivery.test.ts --runInBand`

Review:

- This is an intentional public subpath, not a workaround. The chat thread
  types are user-facing app state, while the LLM provider chat types remain on
  the root `@dina/brain` provider surface. Keeping them separate avoids
  ambiguous public names and gives mobile a stable import target.
- This is still partial CA-05/CA-06 work. Other mobile deep imports remain and
  should be moved behind similarly named public subpaths or root exports.

### CA-05/CA-06: Mobile Core Contacts Public Boundary

Evidence:

- Added public `@dina/core` exports for the mobile-facing contacts directory
  surface: contact CRUD, alias mutation, trust lookup, preferred-contact lookup,
  directory hydration, and contact resolution helpers.
- Updated mobile People, Add Contact, contact hooks, D2D chat, MsgBox wiring,
  staging enrichment, storage boot, and trust search imports from
  `@dina/core/src/contacts/directory` to `@dina/core`.
- Extended `apps/mobile/__tests__/architecture/package_boundary.test.ts` so
  production mobile code cannot reintroduce `contacts/directory` deep imports.

Impact:

- Contact directory operations now sit on the public Core package boundary used
  by mobile, rather than depending on Core source layout.
- Existing root `TrustLevel` and `Contact` public types are reused; the new
  exports avoid introducing duplicate public type names.

Validation:

- `npm run typecheck --workspace @dina/core`
- `npm run typecheck --workspace @dina/app`
- `npm test --workspace @dina/app -- architecture/package_boundary.test.ts --runInBand`
- `npm test --workspace @dina/app -- hooks/useContacts.test.ts hooks/useContactDetail.test.ts hooks/usePhoneContacts.test.ts services/staging_enrichment.test.ts --runInBand`
- `npm test --workspace @dina/core -- contacts/directory.test.ts contacts/repository.test.ts --runInBand`

Review:

- This is a correct boundary move: contacts are a stable Core domain surface
  used directly by mobile UI and runtime wiring. Root exports are now backed by
  package `exports` maps for the declared public Core entry points.
- This remains a focused slice. Storage repositories, workflow internals,
  service route setters, and other app-level deep imports still need separate
  public API decisions.

### CA-05/CA-06: Mobile Boot Runtime Public Subpaths

Evidence:

- Added `packages/core/runtime.ts` as the public `@dina/core/runtime` subpath
  for Core runtime composition primitives used by mobile boot: CoreRouter,
  CoreClient, in-process transport, workflow/service repositories, MsgBox,
  D2D sender/delivery hooks, auth bootstrap hooks, sweepers, memory service,
  and storage adapter types.
- Added `packages/brain/runtime.ts` as the public `@dina/brain/runtime` subpath
  for Brain runtime composition primitives used by mobile boot: staging
  scheduler/drain types, AppView client, routing/classifier setup, LLM runtime
  dispatch, review-draft starter, and approval inbox bridges.
- Updated `apps/mobile/src/services/bootstrap.ts`,
  `apps/mobile/src/services/boot_service.ts`, and
  `apps/mobile/src/services/boot_capabilities.ts` to import those runtime
  dependencies from the public subpaths instead of `@dina/core/src/*` or
  `@dina/brain/src/*`.
- Extended `apps/mobile/__tests__/architecture/package_boundary.test.ts` so
  those three mobile boot composition files cannot reintroduce Core/Brain deep
  imports.

Impact:

- Mobile boot still owns too much platform-neutral composition, but it no
  longer couples that composition directly to Core/Brain source layout.
- This creates a stable staging point for the next extraction: the same import
  sets can move from `apps/mobile` into `@dina/home-node` without changing the
  underlying Core/Brain internals again.
- The subpaths are deliberately named `runtime`, not `internal`, because they
  are part of the shared Home Node assembly contract for mobile and server.

Validation:

- `npm run typecheck --workspace @dina/core`
- `npm run typecheck --workspace @dina/brain`
- `npm run typecheck --workspace @dina/app`
- `npm test --workspace @dina/app -- architecture/package_boundary.test.ts --runInBand`
- `npm test --workspace @dina/app -- services/bootstrap.test.ts services/boot_capabilities.test.ts services/boot_service.test.ts hooks/useNodeBootstrap.test.ts --runInBand`

Review:

- I agree with this direction as an intermediate architecture cleanup. It does
  not solve shared runtime ownership by itself, but it removes a real barrier:
  mobile boot can now be extracted module-by-module without preserving dozens
  of deep imports.
- This is not legacy support or migration code. It is a public greenfield TS
  runtime boundary over the current canonical implementation.
- The declared Core and Brain runtime subpaths are now backed by package
  `exports` maps, so these are package-manager-enforced API boundaries instead
  of only conventional workspace entrypoints.

### CA-05/CA-06: Mobile Core Storage Public Boundary

Evidence:

- Added `packages/core/storage.ts` as the public `@dina/core/storage` subpath
  for storage adapters, DB providers, persistence bootstrap, SQLite repository
  implementations, repository setters, and storage hydration hooks needed by
  mobile persistence setup.
- Updated `apps/mobile/src/storage/init.ts`,
  `apps/mobile/src/storage/provider.ts`, and
  `apps/mobile/src/storage/op_sqlite_adapter.ts` to import those storage
  surfaces from `@dina/core/storage`.
- Extended `apps/mobile/__tests__/architecture/package_boundary.test.ts` so the
  mobile storage folder cannot reintroduce `@dina/core/src/*` imports.

Impact:

- Mobile persistence initialization is now coupled to a named Core storage API,
  not the internal layout of Core repository modules.
- The API is intentionally storage-specific. UI/domain hooks still need their
  own public surfaces instead of importing everything from storage.

Validation:

- `npm run typecheck --workspace @dina/core`
- `npm run typecheck --workspace @dina/app`
- `npm test --workspace @dina/app -- architecture/package_boundary.test.ts --runInBand`
- `npm test --workspace @dina/app -- storage/init_teardown.test.ts services/boot_capabilities.test.ts --runInBand`
- `npm test --workspace @dina/core -- storage staging reminders memory people contacts devices audit vault --runInBand`

Review:

- This is a correct public boundary for a full Home Node adapter: mobile and
  server adapters need storage implementations and repository wiring, while
  Core should continue to own repository contracts and hydration semantics.
- Remaining issue: the public storage surface still exposes module-level
  repository setters. That matches the current code, but the target should move
  these into a `HomeNodeContext` so multiple node instances can run without
  global state.

### CA-05/CA-06: Mobile Brain LLM Public Boundary

Evidence:

- Added `packages/brain/llm.ts` as the public `@dina/brain/llm` subpath for
  mobile-facing LLM provider adapters, provider configuration, LLM provider
  types, stream chunk types, and chat-reasoning registration hooks.
- Updated mobile provider setup, chat reasoning wiring, health checks, LLM
  provider settings, onboarding LLM setup, chat streaming, and trust
  compose/review draft code to import Brain LLM surfaces from
  `@dina/brain/llm`.
- Updated trust compose/review draft code and chat reasoning wiring to use
  existing public `@dina/core` exports for vault query and PII helpers.
- Extended `apps/mobile/__tests__/architecture/package_boundary.test.ts` so
  production mobile code cannot reintroduce `@dina/brain/src/llm/*` or
  `@dina/brain/src/pipeline/chat_reasoning` imports.

Impact:

- BYOK provider wiring is now a stable Brain public API instead of a set of
  direct imports into adapter/config implementation files.
- Trust review prefill and chat reasoning no longer couple their LLM types to
  Brain source layout.

Validation:

- `npm run typecheck --workspace @dina/brain`
- `npm run typecheck --workspace @dina/app`
- `npm test --workspace @dina/app -- architecture/package_boundary.test.ts --runInBand`
- `npm test --workspace @dina/app -- ai/brain_wiring.test.ts hooks/useOnboardingLLM.test.ts hooks/useHealthCheck.test.ts hooks/useLLMProviders.test.ts hooks/useChatStreaming.test.ts trust/compose_context.test.ts trust/use_compose_context.test.tsx trust/review_draft.test.ts trust/write_compose_prefill.test.tsx trust/write.render.test.tsx --runInBand`
- `npm test --workspace @dina/brain -- llm/prompts.test.ts pipeline/chat_reasoning.test.ts --runInBand`

Review:

- This is the right boundary shape for mobile: app code owns BYOK key retrieval
  and platform model factories, while Brain owns provider interfaces,
  adapters, provider configuration, and reasoning registration.
- A broad Brain Jest pattern accidentally included
  `persona_classification_real_llm_100.test.ts`, which calls live Gemini and
  failed one scenario (`Max needs his rabies booster shot...` classified
  `general` instead of expected `health`). That is not a regression from this
  export-only slice; deterministic focused Brain tests passed.

### CA-05/CA-06: Mobile Brain Enrichment And Service Schema Boundary

Evidence:

- Added `packages/brain/enrichment.ts` as the public
  `@dina/brain/enrichment` subpath for staging enrichment composition:
  `TopicExtractor`, `PreferenceExtractor`, topic-touch pipeline types, and
  `touchTopicsForItem`.
- Updated `apps/mobile/src/services/staging_enrichment.ts` to import enrichment
  APIs from `@dina/brain/enrichment`.
- Updated `apps/mobile/src/services/appview_stub.ts` and
  `apps/mobile/src/services/demo_bus_driver_responder.ts` to use public
  `@dina/brain` exports for AppView service profiles, ETA schemas/results, and
  `computeSchemaHash`.
- Extended `apps/mobile/__tests__/architecture/package_boundary.test.ts` so
  these mobile service files cannot reintroduce deep Brain enrichment,
  AppView-client, or service-capability imports.

Impact:

- Mobile staging drain enrichment no longer reaches into Brain enrichment
  internals directly.
- Demo AppView/service fixtures now consume the same public service schema
  exports that runtime code uses, which reduces drift between demo and
  production service query paths.

Validation:

- `npm run typecheck --workspace @dina/brain`
- `npm run typecheck --workspace @dina/app`
- `npm test --workspace @dina/app -- architecture/package_boundary.test.ts services/staging_enrichment.test.ts services/appview_stub.test.ts services/boot_capabilities.test.ts services/boot_service.test.ts integration/staging_drain_end_to_end.test.ts --runInBand`
- `npm test --workspace @dina/brain -- enrichment/topic_touch_pipeline.test.ts enrichment/topic_extractor.test.ts enrichment/preference_extractor.test.ts service/capabilities/registry.test.ts --runInBand`

Review:

- This is the right boundary split: enrichment has a narrow subpath because it
  is a staging-drain composition concern, while AppView/service schema helpers
  already belong on the root Brain API used by runtime service composition.
- No workaround was added. The mobile code still constructs the platform-level
  helper locally, but the domain pieces now come through named package
  surfaces.

### CA-05/CA-06: Mobile Reminder And Notification Public Boundaries

Evidence:

- Added `packages/core/reminders.ts` as the public `@dina/core/reminders`
  subpath for reminder service functions and `Reminder` types used by mobile.
- Added `packages/brain/notifications.ts` as the public
  `@dina/brain/notifications` subpath for notification inbox APIs, hydration,
  unread counts, subscriptions, and notification types.
- Updated mobile reminder and notification hooks/screens/components to use
  those public subpaths:
  `useReminders`, `useReminderFireWatcher`, `InlineReminderCard`,
  `reminder_push_bridge`, `screen_filter`, `useNotificationsBadge`,
  `useChatNudges`, `app/notifications.tsx`, `app/_layout.tsx`, and
  `app/reminders.tsx`.
- Extended `apps/mobile/__tests__/architecture/package_boundary.test.ts` so
  production mobile code cannot reintroduce
  `@dina/core/src/reminders/service` or
  `@dina/brain/src/notifications/inbox`.

Impact:

- Reminder and notification UI now depend on domain-level public APIs instead
  of service implementation paths.
- The boundary is correctly split: reminders remain Core-owned durable local
  state; notification inbox remains Brain-owned app/attention state.

Validation:

- `npm run typecheck --workspace @dina/core`
- `npm run typecheck --workspace @dina/brain`
- `npm run typecheck --workspace @dina/app`
- `npm test --workspace @dina/app -- architecture/package_boundary.test.ts hooks/useReminders.test.ts hooks/useReminderFireWatcher.test.ts hooks/useNotificationsBadge.test.ts hooks/useChatNudges.test.ts notifications/reminder_push_bridge.test.ts notifications/screen_filter.test.ts notifications/screen.render.test.tsx notifications/deep_link.test.ts --runInBand`
- `npm test --workspace @dina/core -- reminders/service.test.ts reminders/scheduler.test.ts reminders/background.test.ts --runInBand`
- `npm test --workspace @dina/brain -- notifications/inbox.test.ts notifications/bridges.test.ts nudge/whisper.test.ts --runInBand`

Review:

- This is the correct public API shape for the architecture: reminders are part
  of Core's local memory/action state, while notifications are a Brain/UI
  attention surface.
- No workaround was introduced. The tests cover both pure data hooks and render
  surfaces, plus Core/Brain package owners for the moved APIs.

### CA-05/CA-06: Mobile Core Service Config And Workflow Boundary

Evidence:

- Updated `apps/mobile/src/hooks/useServiceConfigForm.ts` and
  `apps/mobile/app/service-settings.tsx` to import `ServiceConfig` and
  `validateServiceConfig` from public `@dina/core`.
- Updated `apps/mobile/src/services/demo_bus_driver_responder.ts` to import
  `getWorkflowService` from public `@dina/core`.
- Extended `apps/mobile/__tests__/architecture/package_boundary.test.ts` so
  those files cannot reintroduce deep Core service-config or workflow imports.

Impact:

- Mobile's service settings and demo service responder now depend on the same
  public Core service/workflow surface used by runtime composition.
- This avoids creating a second service-config API just for app UI; the root
  Core API is already the correct owner for validation and workflow access.

Validation:

- `npm run typecheck --workspace @dina/app`
- `npm test --workspace @dina/app -- architecture/package_boundary.test.ts hooks/useServiceConfigForm.test.ts services/demo_bus_driver_responder.test.ts integration/bus_driver_e2e.test.ts --runInBand`

Review:

- This is a direct boundary correction with no architectural workaround.
  `validateServiceConfig`, `ServiceConfig`, and `getWorkflowService` were
  already public Core APIs; mobile should not deep-import their source modules.

### CA-05/CA-06: Mobile D2D And MsgBox Public Boundary

Evidence:

- Added `packages/core/d2d.ts` as the public `@dina/core/d2d` subpath for D2D
  message-family constants, DID resolver types, quarantine APIs, installed D2D
  sender accessors, and MsgBox WebSocket factory types.
- Updated `apps/mobile/src/services/msgbox_wiring.ts`,
  `apps/mobile/src/services/chat_d2d.ts`, and
  `apps/mobile/src/hooks/useD2DMessages.ts` to import from `@dina/core/d2d`.
- Extended `apps/mobile/__tests__/architecture/package_boundary.test.ts` so
  those files cannot reintroduce deep Core D2D, route, or MsgBox imports.

Impact:

- Mobile D2D send, MsgBox resolver setup, and quarantine review now depend on a
  stable Core D2D API instead of a set of unrelated source paths.
- This keeps the simplified architecture honest: D2D/MsgBox is a first-class
  Home Node boundary, not a private app implementation detail.

Validation:

- `npm run typecheck --workspace @dina/core`
- `npm run typecheck --workspace @dina/app`
- `npm test --workspace @dina/app -- architecture/package_boundary.test.ts services/chat_d2d.test.ts hooks/useD2DMessages.test.ts --runInBand`
- `npm test --workspace @dina/core -- d2d/resolver.test.ts d2d/quarantine.test.ts d2d/families.test.ts relay/msgbox_ws.test.ts --runInBand`

Review:

- This is the correct public API shape for the current implementation. D2D
  message families, sender wiring, DID resolution, quarantine, and MsgBox
  socket factory types are used together by Home Node adapters.
- Remaining issue: `@dina/core/d2d` still exposes module-level sender state
  because the current runtime uses module-level route setters. That should move
  into `HomeNodeContext` under CA-008, but this slice does not make that
  problem worse.

### CA-05/CA-06: Mobile Root Core/Brain Domain Boundary

Evidence:

- Updated mobile hooks that were reaching into already-public domain modules:
  `useContactDetail`, `useServiceThreadDelivery`, `useUnlock`,
  `useChatNudges`, `useVaultBrowser`, `useVaultItems`, and `useShareExport`.
- Added the missing public Core export for `setSharingPolicy`, completing the
  sharing-policy surface already represented by `getSharingTier` and
  `checkSharingPolicy`.
- Extended `apps/mobile/__tests__/architecture/package_boundary.test.ts` so
  these hooks cannot reintroduce deep imports for Core sharing/vault/export or
  Brain workflow-event/vault-context/nudge APIs.

Impact:

- Mobile UI data hooks now use public package APIs for domain actions that are
  already owned by Core or Brain.
- This avoided unnecessary new subpaths: vault CRUD, archive export, sharing
  policy, workflow event consumption, vault context, and nudge silence policy
  are already part of the root package surfaces.

Validation:

- `npm run typecheck --workspace @dina/core`
- `npm run typecheck --workspace @dina/brain`
- `npm run typecheck --workspace @dina/app`
- `npm test --workspace @dina/app -- architecture/package_boundary.test.ts hooks/useContactDetail.test.ts hooks/useServiceThreadDelivery.test.ts hooks/useUnlock.test.ts hooks/useUnlock.reactive.test.ts hooks/useChatNudges.test.ts hooks/useVaultBrowser.test.ts hooks/useShareExport.test.ts --runInBand`
- `npm test --workspace @dina/core -- gatekeeper/sharing.test.ts vault/crud.test.ts export/archive.test.ts --runInBand`
- `npm test --workspace @dina/brain -- nudge/whisper.test.ts service/workflow_event_consumer.test.ts --runInBand`

Review:

- This is the simplest correct boundary move. Creating more subpaths here would
  add API surface without reducing architecture risk.
- Existing `useUnlock` tests still log the known op-sqlite Jest ESM warning
  from persistence init, but the tests pass and the warning is unrelated to
  this import-boundary change.

### CA-05/CA-06: Mobile Production Deep Imports Are Gone

Evidence:

- Added public Core subpaths for the last mobile-only package surfaces:
  `@dina/core/audit`, `@dina/core/devices`, and `@dina/core/kv`.
- Added public Brain root export for `getAskApprovalGateway`.
- Updated the final mobile offenders:
  `app/paired-devices.tsx`, `src/notifications/local.ts`,
  `src/hooks/useAuditLog.ts`, `src/trust/memory_warning.ts`, and
  `src/hooks/useChatApprovals.ts`.
- Added a broad guard in
  `apps/mobile/__tests__/architecture/package_boundary.test.ts` that scans all
  production `apps/mobile/src` and `apps/mobile/app` TS/TSX files and rejects
  any `@dina/core/src` or `@dina/brain/src` import.
- Verified with `rg` that production mobile code has zero Core/Brain source-path
  imports.

Impact:

- Mobile now depends on Core and Brain through public package surfaces only.
- This materially reduces TS drift: server and mobile can extract shared Home
  Node runtime code without carrying mobile-only source-path imports into
  `@dina/home-node`.

Validation:

- `npm run typecheck --workspace @dina/core`
- `npm run typecheck --workspace @dina/brain`
- `npm run typecheck --workspace @dina/app`
- `npm test --workspace @dina/app -- architecture/package_boundary.test.ts hooks/useChatApprovals.test.ts hooks/useAuditLog.test.ts notifications/local.test.ts trust/memory_warning.test.ts --runInBand`
- `npm test --workspace @dina/core -- kv/store.test.ts audit/service.test.ts trust/cache.test.ts approval/singleton.test.ts devices/registry.test.ts pairing/ceremony.test.ts --runInBand`
- `npm test --workspace @dina/brain -- ask/ask_approval_gateway.test.ts ask/ask_approval_resumer.test.ts composition/ask_coordinator.test.ts --runInBand`

Review:

- This is the right state for the mobile app: no production deep imports into
  Core or Brain remain.
- This does not complete package-boundary cleanup globally. The home-node-lite
  Core parallel Brain subtree is gone, but Brain still has relative
  package-internal imports that should move to stable public surfaces as the
  shared runtime extraction continues.

### CA-05/CA-06: Package Export Maps Enforce Declared Public Subpaths

Evidence:

- Added explicit `exports` maps to `packages/core/package.json`,
  `packages/brain/package.json`, and `packages/home-node/package.json`.
- Core now declares root plus `audit`, `d2d`, `devices`, `kv`, `reminders`,
  `runtime`, and `storage`.
- Brain now declares root plus `chat`, `enrichment`, `llm`,
  `node-trace-storage`, `notifications`, and `runtime`.
- Home Node now declares root plus `ask-runtime` and `service-runtime`.
- Removed remaining production Brain `@dina/core/src` package-specifier imports
  from ask composition and trust scoring code so mobile typecheck works under
  the new export map.
- Added package export guard tests in Core, Brain, and Home Node.

Impact:

- Mobile and home-node-lite can no longer rely on undeclared Core/Brain/Home
  Node package subpaths through normal package resolution.
- Public subpaths are now an explicit contract. Adding another public surface
  requires changing the package manifest and the corresponding guard test.
- This still leaves separate cleanup work for relative imports inside package
  source trees.

Validation:

- `npm test --workspace @dina/core -- api/package_exports.test.ts --runInBand`
- `npm test --workspace @dina/brain -- composition/agentic_ask.test.ts composition/ask_coordinator.test.ts composition/persona_guard.test.ts trust/scorer.test.ts api/package_exports.test.ts --runInBand`
- `npm test --workspace @dina/home-node -- package_boundary.test.ts --runInBand`
- `npm test --workspace @dina/app -- architecture/package_boundary.test.ts --runInBand`
- `npm run typecheck --workspace @dina/core`
- `npm run typecheck --workspace @dina/brain`
- `npm run typecheck --workspace @dina/home-node`
- `npm run typecheck --workspace @dina/app`
- `npm run typecheck --workspace @dina/home-node-lite-brain-server`
- `npm run typecheck --workspace @dina/home-node-lite-core-server`

### RT-01: Missing Shared TS Home Node Composition Root

Evidence:

- `apps/mobile/src/services/bootstrap.ts`
- `apps/mobile/src/services/boot_service.ts`
- `apps/mobile/src/services/boot_capabilities.ts`
- `apps/home-node-lite/core-server/src/boot.ts`
- `apps/home-node-lite/brain-server/src/boot.ts`

Mobile has a real composition path; home-node-lite does not. The platform-independent part of mobile boot has grown into the de facto TS Home Node runtime, but it still lives under `apps/mobile`. Server boot is not reusing it.

Why this matters:

- Every fix to mobile ask/remember/trust/service/D2D can be missed by server.
- Server can accidentally recreate older Go/Python process boundaries instead of using the new TS node model.
- Tests cannot easily prove that mobile and server follow the same functional flow.

Fix direction:

- Define a shared `HomeNodeRuntime` composition contract.
- Move platform-neutral node composition out of `apps/mobile` into a shared TS module/package.
- Keep platform adapters in mobile/server:
  - secure seed/key access
  - SQLite/SQLCipher adapter
  - network fetch/WebSocket adapter
  - notification/background scheduling adapter
  - HTTP server adapter for home-node-lite

### HN-01: Home-node-lite Core And Brain Are Scaffolds

Evidence:

- `apps/home-node-lite/README.md` marks status as pre-M1.
- `apps/home-node-lite/core-server/src/boot.ts` pushes keystore, DB open, and adapter wiring as pending while binding the shared CoreRouter and connecting MsgBox by default.
- `apps/home-node-lite/brain-server/src/boot.ts` starts health/readiness, configures hosted AppView and signed Core clients, starts the staging scheduler when Core is configured, registers ask routes when a coordinator can be supplied or composed, and composes service primitives when explicit service runtime dependencies are supplied.
- `apps/home-node-lite/brain-server/src/routes/ask.ts` is wired into boot by dependency injection, and `@dina/home-node/ask-runtime` can build the production coordinator from the configured Core/AppView/LLM dependencies.

Impact:

- A server install cannot currently perform install -> remember -> ask -> trust publish -> D2D as a full Home Node.
- Existing packages contain useful functionality, but the server process does not compose them.

Fix direction:

- Core server must still open storage and wire adapters. `createCoreRouter`, safe Fastify binding, and MsgBox connection are now implemented.
- Brain server now constructs `HttpCoreTransport`/`CoreClient` when its service key is provisioned, starts `StagingDrainScheduler` after Fastify binds, registers the ask route plugin from either an injected coordinator or the server `askRuntime`/Gemini config composition, and consumes `@dina/home-node/service-runtime` composition for `ServiceHandler`, `ServiceQueryOrchestrator`, `D2DDispatcher`, `WorkflowEventConsumer`, and `ApprovalReconciler` when explicit service runtime dependencies are supplied. It still must bind MsgBox/PDS and remaining route plugins around the configured clients.
- Fixed for config/runtime boot: server Core and Brain config now resolve the same test/release endpoints as mobile through `@dina/home-node`, and Core server uses that policy for MsgBox boot/readiness.

Validation:

- `npm test --workspace @dina/home-node-lite-core-server -- config.test.ts boot.test.ts server.test.ts status_code_parity.test.ts --runInBand`
  passed: 5 suites and 83 tests.
- `npm test --workspace @dina/home-node-lite-core-server -- --runInBand --forceExit`
  passed: 105 suites and 2351 tests.
- `npm test --workspace @dina/net-node -- --runInBand`
  passed: 4 suites and 62 tests.
- `npm run typecheck --workspace @dina/home-node-lite-core-server`
- `npm run typecheck --workspace @dina/net-node`

### CA-04: Core Server No Longer Contains A Parallel Brain Subtree

Evidence:

- Fixed in `apps/home-node-lite/core-server/src/appview/profile_auto_republisher.ts`:
  the AppView republisher no longer imports `../brain/config_reloader` for a
  type-only dependency. It now owns a minimal `ConfigSnapshotReader` and
  `ConfigSnapshotEvent` boundary.
- Added `apps/home-node-lite/core-server/__tests__/package_boundary.test.ts`:
- Deleted the retired 94-file `apps/home-node-lite/core-server/src/brain`
  subtree and the stale core-server-only tests that imported it.
- Deleted `apps/home-node-lite/core-server/GAP.md`; the old gap list described
  the retired subtree rather than the current package-owned Brain runtime.
- Strengthened `apps/home-node-lite/core-server/__tests__/package_boundary.test.ts`
  so it now asserts:
  - `src/brain` does not exist under core-server
  - production Core server code has no Brain internal imports
  - core-server tests cannot import `../src/brain/*`
- Updated the remaining core-server auth binding tests to use the public
  `@dina/core/runtime` subpath instead of blocked `@dina/core/src/*` imports.

Impact:

- Core server is now a Core/server adapter again, not a third Brain location.
- Brain ownership is concentrated in `packages/brain`,
  `apps/home-node-lite/brain-server`, and shared `@dina/home-node` runtime
  slices.
- Removing the retired tests is intentional. They only proved behavior of a
  non-runtime subtree, so keeping them would create false confidence and
  pressure to preserve dead architecture.

Validation:

- `npm test --workspace @dina/home-node-lite-core-server -- boot.test.ts bind_core_router.test.ts package_boundary.test.ts --runInBand`
- `npm run typecheck --workspace @dina/home-node-lite-core-server`
- `npm test --workspace @dina/home-node-lite-core-server -- --runInBand --forceExit`
  passed: 105 suites and 2351 tests.
- `npm run typecheck --workspace @dina/home-node-lite-core-server`

### AUTH-01: Fastify CoreRouter Binder Can Bypass Auth

Evidence:

- `packages/core/src/server/router.ts` owns route auth semantics.
- Fixed in `apps/home-node-lite/core-server/src/server/bind_core_router.ts`: Fastify now builds a `CoreRequest` with the real URL path and dispatches through `CoreRouter.handle(coreReq)` instead of invoking raw route handlers.
- Regression coverage added in `apps/home-node-lite/core-server/__tests__/bind_core_router.test.ts`.

Impact:

- Before the fix, using `bind_core_router.ts` as the production binding could expose signed Core routes without CoreRouter auth checks.
- The fixed binding keeps signed/public route behavior owned by CoreRouter and keeps HTTP callers from forging the in-process trust marker.

Validation:

- `npm test --workspace @dina/home-node-lite-core-server -- bind_core_router.test.ts`
- `npm test --workspace @dina/home-node-lite-core-server -- path_params.test.ts`
- `npm run typecheck --workspace @dina/home-node-lite-core-server`

### STG-01: Missing HTTP Staging Ingest Blocks Server Remember

Evidence:

- Fixed in `packages/core/src/server/routes/staging.ts`: Core now exposes signed `POST /v1/staging/ingest`.
- Fixed in `packages/core/src/client/core-client.ts`, `http-transport.ts`, and `in-process-transport.ts`: `CoreClient.stagingIngest` exists on both transports.
- Fixed in `packages/brain/src/chat/orchestrator.ts`: `/remember` uses an injected `CoreClient` slice, not Core staging internals.
- Removed alternate mobile paths: `apps/mobile/src/ai/chat.ts`, `apps/mobile/src/ai/memory.ts`, and `apps/mobile/src/hooks/useChatRemember.ts`.

Impact:

- Mobile remember now crosses the same CoreClient boundary the server form factor needs.
- Server Brain now starts the shared staging drain over the signed HTTP transport when its service key is configured.
- Auth, audit, quotas, and storage semantics can now be enforced at the Core boundary.

Validation:

- `npm test --workspace @dina/core -- server/staging_routes.test.ts`
- `npm test --workspace @dina/core -- client/in_process_transport.test.ts`
- `npm test --workspace @dina/core -- client/http_transport.test.ts`
- `npm test --workspace @dina/brain -- chat/orchestrator.test.ts chat/response_types.test.ts integration/mobile_remember_ask_e2e.test.ts`
- `npm test --workspace @dina/app -- hooks/useChatThread.test.ts hooks/useChatThread.live.test.ts services/bootstrap.test.ts ai/active_provider.test.ts ai/brain_wiring.test.ts`

### MEM-01: Explicit Resolve Gates And Durable Approval Resume Done

Evidence:

- Fixed in `packages/core/src/server/routes/staging.ts`: single-persona resolve requires `persona_open`; multi-persona resolve requires `persona_access` with a boolean for every target persona.
- Fixed in `packages/core/src/client/core-client.ts`: `StagingResolveRequest` is now a union type, so TypeScript callers must provide the correct gate field for the persona shape.
- Fixed in `packages/core/src/client/http-transport.ts` and `packages/core/src/client/in-process-transport.ts`: `CoreClient.stagingResolve` sends `persona_open` for string persona and `persona_access` for persona arrays.
- Fixed in `packages/brain/src/staging/drain.ts`: Brain reads accessible personas and passes an explicit access map into Core resolve.
- Fixed in `packages/core/src/staging/service.ts`: locked targets create `approval` workflow tasks with payload type `staging_persona_access`; the staging row keeps the durable `approval_id`.
- Fixed in `packages/core/src/server/routes/workflow.ts`: approving a staging persona-access task drains by `approval_id` and stores the encrypted memory; cancelling or failing it marks the staging row failed with retries exhausted.
- Fixed in `apps/mobile/src/hooks/useServiceInbox.ts` and `apps/mobile/app/approvals.tsx`: the approvals inbox recognizes local memory access approvals and denies them without sending service responses.

Impact:

- Missing access state is now rejected instead of interpreted as open.
- Locked/sensitive routing no longer stores by default. Persona unlock alone does not store approval-gated rows; only approval resume does.
- Denial is terminal for the staged row and will not be requeued by sweep.

Validation added:

- locked single-persona remember creates a workflow approval task
- approve stores after staging cache reset
- deny does not store and exhausts staging retries
- single-persona route passes classified data to vault storage
- persona unlock does not bypass approval-gated pending rows

Validation:

- `npm test --workspace @dina/core -- staging/service.test.ts server/staging_routes.test.ts`
- `npm test --workspace @dina/core -- client/in_process_transport.test.ts client/http_transport.test.ts api/contract.test.ts test_harness/mock_core_client.test.ts server/core_router_integration.test.ts workflow/service.test.ts workflow/repository_lifecycle.test.ts`
- `npm run typecheck --workspace @dina/core`
- `npm test --workspace @dina/brain -- integration/staging_pipeline.test.ts api/process.test.ts staging/drain.test.ts`
- `npm test --workspace @dina/app -- hooks/useServiceInbox.test.ts integration/staging_drain_end_to_end.test.ts`

### MEM-02: Remember Enrichment Parity Done

Evidence:

- Fixed in `packages/brain/src/staging/drain.ts`: staging drain calls the shared enrichment pipeline before `CoreClient.stagingResolve`, and sends L0, L1, embedding vector, structured enrichment version, and enrichment stage metadata in the resolve payload.
- Fixed in `packages/brain/src/staging/processor.ts`: the in-memory processor helper uses the same enrichment pipeline as the production drain.
- Fixed in `packages/brain/src/enrichment/pipeline.ts`: enrichment reports explicit stage states for L1, embedding, PII redaction, low-trust policy instruction, sponsored detection, and fallback reasons.
- Fixed in `packages/core/src/vault/crud.ts`: Core normalizes JSON vector embeddings from the CoreClient boundary into the vault's Float32-byte embedding blob.

Impact:

- `/remember` no longer stores a final-looking L0-only row when enrichment providers are missing. The row remains `l0_complete`, and metadata records `llm_unavailable` / `embedding_unavailable` or failed provider stages.
- When LLM and embedding providers are registered, the vault row is stored with L1, embedding, and `enrichment_status: "ready"` before post-publish and ask retrieval can depend on it.

Validation:

- `npm run typecheck --workspace @dina/brain`
- `npm run typecheck --workspace @dina/core`
- `npm test --workspace @dina/brain -- staging/drain.test.ts staging/processor.test.ts enrichment/pipeline.test.ts integration/staging_pipeline.test.ts`
- `npm test --workspace @dina/brain -- integration/remember_transport_parity.test.ts`
- `npm test --workspace @dina/core -- vault/hybrid_search.test.ts server/staging_routes.test.ts client/http_transport.test.ts client/in_process_transport.test.ts`

### PERSIST-01: Staging SQL Is Authoritative

Evidence:

- Fixed in `packages/core/src/staging/repository.ts`: `StagingRepository` is sync-on-purpose over the sync SQLite adapter, avoiding fire-and-forget persistence.
- Fixed in `packages/core/src/staging/service.ts`: when a repository is wired, ingest/dedup/claim/resolve/fail/approval/lease/sweep/list/read operations use the repository first and then update the in-memory cache.
- Fixed in `apps/mobile/src/storage/init.ts`: mobile hydrates staging cache after wiring `SQLiteStagingRepository`.
- Covered in `packages/core/__tests__/staging/service.test.ts`: ingest -> restart/cache reset -> claim -> resolve survives through repository authority.

Impact:

- In-flight staging rows are recoverable after app/process restart.
- Dedup reads from the durable repository when the in-memory cache is empty.
- The in-memory cache is now a cache layer, not the authority.

Validation:

- `npm test --workspace @dina/core -- staging/service.test.ts port_async_gate.test.ts server/staging_routes.test.ts staging/heartbeat.test.ts`
- `npm test --workspace @dina/core -- client/in_process_transport.test.ts client/http_transport.test.ts api/contract.test.ts test_harness/mock_core_client.test.ts staging/heartbeat.test.ts`
- `npm run typecheck --workspace @dina/core`

### CA-05/CA-06: Mobile Public Core Boundary Slice

Evidence:

- Fixed in `packages/core/src/index.ts`: the root `@dina/core` package now
  intentionally exports the mobile-facing onboarding, identity, crypto,
  persona, lifecycle, and constants surfaces used by current install/persona
  flows.
- Fixed in mobile production code: onboarding, unlock, identity, persona,
  security, handle-picker, and related boot code no longer deep-import those
  public Core surfaces from `@dina/core/src/...`.
- Added `apps/mobile/__tests__/architecture/package_boundary.test.ts`: a
  focused guard rejects production mobile imports of those moved public
  surfaces through Core internals.

Impact:

- Mobile install/persona code now uses a stable package entry point for this
  slice, reducing Metro/Jest split-singleton risk and making the future package
  export map easier to enforce.
- This is intentionally partial. Other mobile Core/Brain deep imports remain
  until their public surfaces are defined and moved.

Validation:

- `npm test --workspace @dina/app -- architecture/package_boundary.test.ts --runInBand`
- `npm run typecheck --workspace @dina/core`
- `npm run typecheck --workspace @dina/app`
- `npm test --workspace @dina/app -- onboarding/provision.test.ts onboarding/handle_pick.render.test.tsx hooks/useOnboarding.test.ts hooks/useUnlock.test.ts hooks/useIdentity.test.ts hooks/usePersonas.test.ts hooks/useSecurity.test.ts --runInBand`
- `npm test --workspace @dina/app -- services/wrapped_seed_store.test.ts services/boot_capabilities.test.ts hooks/useHealthCheck.test.ts hooks/useChatSystemMessages.test.ts hooks/useVaultBrowser.test.ts hooks/useContactDetail.test.ts trust/write_form_data.test.ts trust/write_compose_prefill.test.tsx trust/write.render.test.tsx trust/write_v2_publish.test.tsx --runInBand`

### CA-07: Brain Trace Correlation Is Portable

Evidence:

- Fixed in `packages/brain/src/diagnostics/trace_correlation.ts`: portable Brain
  source no longer imports `node:async_hooks` or `node:crypto`. It exposes a
  `TraceScopeStorage` port and uses `globalThis.crypto.getRandomValues` for
  request-id bytes.
- Added `packages/brain/node-trace-storage.ts`: an explicit Node-only subpath
  that installs an AsyncLocalStorage-backed trace storage adapter.
- Fixed Node consumers: Brain Jest setup, home-node-lite Brain server boot, and
  home-node-lite Core server test setup install the Node trace storage adapter
  explicitly.
- Fixed mobile Metro config: removed the trace-specific `async_hooks` and
  `crypto` shims and deleted those shim files.
- Tightened `packages/brain/__tests__/dep_hygiene.test.ts` so portable Brain
  source cannot reintroduce `node:async_hooks` or `node:crypto` imports.

Impact:

- Brain trace correlation no longer forces React Native to pretend Node
  async-hooks/crypto exist.
- Node still gets correct parallel async trace isolation via
  AsyncLocalStorage.
- Platforms without an installed async-context adapter execute traced callbacks
  without ambient trace state rather than risking wrong cross-request
  correlation.

Validation:

- `npm test --workspace @dina/brain -- diagnostics/trace_correlation.test.ts dep_hygiene.test.ts --runInBand`
- `npm run typecheck --workspace @dina/brain`
- `npm test --workspace @dina/home-node-lite-brain-server -- --runInBand`
- `npm run typecheck --workspace @dina/home-node-lite-brain-server`
- `npm test --workspace @dina/home-node-lite-core-server -- brain_logger.test.ts process_handler.test.ts reason_handler.test.ts package_boundary.test.ts --runInBand`
- `npm run typecheck --workspace @dina/home-node-lite-core-server`
- `npm run typecheck --workspace @dina/app`
- Metro config smoke: `hasAsyncHooks=false`, `hasCrypto=false`, `hasFs=true`, `hasPath=true`

### PUB-01: PDS Publisher Is Not A Default Runtime Capability

Evidence:

- Fixed on mobile AppView runtime: `apps/mobile/src/services/boot_capabilities.ts` creates a real hosted `AppViewClient` by default from `@dina/home-node`; demo mode still supplies `AppViewStub`.
- `apps/mobile/src/services/boot_capabilities.ts` leaves PDS publisher unset by default.
- `packages/core/src/trust/pds_publish.ts` provides a PDS publish building block, but mobile boot does not wire it as the normal release path.
- Fixed for server AppView boot: `apps/home-node-lite/brain-server` config resolves AppView/PDS endpoints and boot constructs the hosted AppView client without touching the network.

Impact:

- Provider service profile publishing can be stubbed.
- Trust publish can remain local/test-only.
- Server trust surfaces can still drift from the configured Brain AppView path until trust runtime wiring lands.

Fix direction:

- Fixed for config: endpoint resolution is centralized in `@dina/home-node`.
- Fixed for mobile requester runtime: build a real AppView client by default from config.
- Fixed for home-node-lite ask/service composition: the configured Brain AppView client is passed into shared `@dina/home-node/ask-runtime` and `@dina/home-node/service-runtime`.
- Thread the configured home-node-lite Brain AppView client into trust routes when the trust runtime lands.
- Build a real PDS publisher from a persisted PDS session/account.
- Pass the same clients into service discovery, agentic ask tools, trust tools, and service profile publisher.

### TRUST-01: Trust Publish Is Test-Oriented

Evidence:

- `apps/mobile/app/trust/write.tsx` publishes to AppView test injection when `EXPO_PUBLIC_DINA_TEST_INJECT_TOKEN` exists.
- Otherwise it enqueues to a local trust outbox.
- `apps/mobile/src/trust/outbox_store.ts` is in-memory.
- `packages/core/src/trust/pds_publish.ts` has production-oriented PDS publish code, but it is not the default mobile release path.

Impact:

- Trust publish can work in tests but not as a durable release path.
- Offline/retry semantics are not reliable.
- PDS/AppView eventual consistency cannot be validated end to end.

Fix direction:

- Use signed PDS `createRecord` publishing for production trust attestations.
- Make AppView test injection dev-only and visibly gated by environment.
- Persist trust outbox in SQLCipher/SQLite.
- Add retry, status, and reconciliation from AppView.

### D2D-01: MsgBox D2D Transport Semantics Need A Decision

Evidence:

- `packages/core/src/relay/msgbox_boot.ts` explicitly sets `setWSDeliverFn(null)`.
- The same file says the shared Dina MsgBox relay drops `type: 'd2d'` WS frames, so D2D send uses HTTP `/forward` fallback while RPC remains on WS.
- `apps/mobile/src/services/msgbox_wiring.ts` now resolves MsgBox through `@dina/home-node`; the default remains `wss://test-mailbox.dinakernel.com/ws` in test mode.

Impact:

- Architecture docs that describe WS-first D2D delivery do not match current TS behavior.
- Tests can pass against HTTP forward while release assumptions expect WebSocket delivery.
- Server/mobile parity depends on a clear relay contract.

Fix direction:

- Decide whether the canonical D2D send path is:
  - WebSocket relay frames for D2D and RPC, or
  - WebSocket for RPC/inbox plus HTTP `/forward` for D2D.
- Update implementation and docs to one contract.
- Add integration tests against `test-mailbox.dinakernel.com`.

### ALT-01: Duplicate Mobile Ask/Remember Paths Create Drift

Evidence:

- Removed `apps/mobile/src/ai/chat.ts`.
- Removed `apps/mobile/src/ai/memory.ts`.
- Removed `apps/mobile/src/hooks/useChatRemember.ts`.
- `packages/brain/src/chat/orchestrator.ts` is the newer canonical chat path used by `apps/mobile/src/hooks/useChatThread.ts`.

Impact:

- UI and tests no longer have alternate mobile ask/remember surfaces to call.
- Production mobile remember has one path through Brain/Core transport.
- Future fixes land in the canonical Brain orchestrator and CoreClient boundary.

Fix direction:

- Pick `packages/brain/src/chat/orchestrator.ts` plus CoreClient transport as canonical.
- Delete alternate paths outright.
- Add import-lint or tests preventing app code from importing Core staging internals directly.

### ID-01: Install, DID, And PDS Session Are Not Release-Complete

Evidence:

- `apps/mobile/src/onboarding/provision.ts` creates DID PLC material and derives a handle from MsgBox/PDS environment.
- Mobile boot still uses stub PDS session behavior when no real session is supplied.
- PDS publisher boot is not default.

Impact:

- A user can have a DID/key identity but still not have a usable PDS account/session for publishing service profiles and trust records.
- Test install defaults are partly present, but release account lifecycle is not a complete Home Node install flow.

Fix direction:

- Define install as:
  - create/import seed
  - create DID
  - create/login PDS account on test/release PDS
  - persist PDS session securely
  - publish service profile/trust records through PDS
  - connect MsgBox
  - verify AppView visibility
- Implement that flow once and use it from mobile and server.

### NOTIFY-01: D2D Receive Notifications Are Not Fully Wired

Evidence:

- Mobile boot accepts D2D and staging hooks in several places.
- The reviewed composition did not show a clear production `onD2DReceived` notification path from Core receive to mobile notification/UI state.

Impact:

- D2D messages may be processed but not surfaced consistently to the user.
- Trust/service/memory nudges can become silent background state.

Fix direction:

- Define a notification/event bus adapter in the shared runtime.
- Wire Core D2D receive events into mobile notification/UI state and server logs/webhooks.
- Add tests for received D2D -> visible notification/event.

## Cleanup Order

Recommended order:

1. Move mobile's platform-neutral boot logic behind the new `@dina/home-node` contract.
2. Expand `@dina/home-node` from contract shell into the shared composition root.
3. Wire home-node-lite to the shared runtime instead of rebuilding Core/Brain behavior manually.
4. Fix CoreRouter Fastify auth binding before exposing server routes.
5. Finish durable approval/resume for remember.
6. Thread server Brain AppView into route composition and wire real PDS publisher defaults.
7. Wire production trust publish and durable trust outbox.
8. Resolve the MsgBox D2D transport contract.
9. Add parity scenarios that run against mobile in-process transport and home-node-lite HTTP transport.

## Definition Of Done

Architecture cleanup should be considered done only when all of these are true:

- Mobile and home-node-lite run the same shared TS Home Node composition.
- Fresh install defaults to the test fleet without manual endpoint injection.
- `/remember` enters Core through a supported transport API, drains through Brain, enriches, respects persona gates, persists durably, and survives restart.
- `/ask` uses the same coordinator and tool semantics on mobile and server.
- Trust publish writes signed records to PDS in production mode and reaches AppView through normal indexing.
- Test AppView injection remains available only as an explicit dev/test shortcut.
- D2D transport is documented and tested against MsgBox.
- No production mobile code imports Core staging internals directly.
- The parity test suite runs the same install/remember/ask/trust/D2D scenarios against mobile in-process and server HTTP modes.
