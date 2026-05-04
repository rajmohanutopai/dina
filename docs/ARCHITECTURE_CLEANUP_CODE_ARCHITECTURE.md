# Architecture Cleanup Code Architecture Review

Date: 2026-05-04

Branch: `architecture-cleanup`

Scope: TypeScript code architecture for `apps/mobile`, `apps/home-node-lite`, and shared TypeScript packages used by both apps.

## Verdict

The current TS architecture is promising but not pristine.

It has several strong building blocks:

- `packages/core` has a transport-agnostic `CoreRouter`, `CoreClient`, `InProcessTransport`, and `HttpCoreTransport`.
- `packages/brain` has substantial ask, staging, enrichment, service, trust, and D2D orchestration primitives.
- Platform adapter packages exist for Node and Expo.
- Mobile has a real node composition path that proves a full TS Home Node is viable.
- There are useful architecture guard tests, especially around `CoreClient` and port hygiene.

But the actual code architecture is transitional. The mobile app owns most of the real Home Node boot, and home-node-lite still has separate Core and Brain server scaffolds instead of one shared runtime adapter. Shared packages expose too much internal state through deep imports and global setters. The code is workable, but it is not yet the clean shared architecture needed for "mobile and server are both Home Nodes."

If the goal is long-term TS consolidation, the next cleanup should be structural, not just feature wiring.

## What Pristine Should Mean Here

A pristine TS Home Node architecture would satisfy these rules:

1. Mobile and server share the same Home Node runtime composition.
2. `apps/mobile` contains UI and Expo/native adapters only.
3. `apps/home-node-lite` contains Node/Fastify adapters only.
4. Shared behavior lives in packages, not under either app.
5. Brain reaches Core through `CoreClient` or a clearly documented in-process runtime interface.
6. App code does not deep-import package internals like `@dina/core/src/...`.
7. Portable packages do not import Node-only modules.
8. A node instance owns its dependencies through an explicit context object, not process-wide globals.
9. The same install, remember, ask, trust, service, and D2D scenarios run against mobile and server.
10. The docs describe the TS architecture that is actually running.

The code does not meet that bar yet.

## Current Shape

### Shared Packages

Current useful package roles:

| Package | Current role | Architecture quality |
| --- | --- | --- |
| `@dina/core` | Core router, auth, D2D, staging, vault, workflow, storage contracts, clients | Strong primitives, but too many globals and deep-exported internals. |
| `@dina/brain` | Ask, staging drain, LLM routing, enrichment, service orchestration, trust reasoning | Strong primitives, but still imports Core internals and includes one Node-specific diagnostic module. |
| `@dina/protocol` | Wire/protocol types | Cleanest layer. |
| `@dina/home-node` | Shared runtime contract, endpoint resolver, lifecycle facade, feature handler contract, ask runtime composition, service runtime composition | Contract package now has initial shared composition slices; broader runtime extraction remains. |
| `@dina/adapters-expo` | Expo storage/fs/net/keystore aggregation | Good direction. |
| `@dina/adapters-node` | Node fs/keystore/crypto/net aggregation | Good direction, but storage integration is not consistently wired into home-node-lite. |

The center of the drift problem is now implementation ownership, not the absence
of a package. `@dina/home-node` now owns the first shared composition slice
for service runtime loops; most mobile composition and server boot still need
to move behind it.

### Mobile

Mobile has the closest thing to the actual Home Node runtime:

- `apps/mobile/src/services/bootstrap.ts` has 1344 lines.
- `apps/mobile/src/services/boot_service.ts` has 628 lines.
- `apps/mobile/src/services/boot_capabilities.ts` has 642 lines.

Together, those files compose Core, Brain, MsgBox, D2D, workflows, staging drain, ask handlers, service orchestration, hosted AppView, PDS stubs, and runtime degradations.

This is good because it proves the node can run in one JS VM. It is not ideal because most of that composition is mobile-owned. Server cannot share it cleanly.

### Home-node-lite

Home-node-lite is split across:

- `apps/home-node-lite/core-server`
- `apps/home-node-lite/brain-server`

The largest structural drift was the 94-file `core-server/src/brain` subtree. That retired subtree has now been deleted. Current Brain ownership is `packages/brain`, `apps/home-node-lite/brain-server`, and shared `@dina/home-node` runtime slices.

That means there are now two intended Brain locations:

1. `packages/brain`
2. `apps/home-node-lite/brain-server`

That is still not the final pristine architecture, because `brain-server` should become thinner as more runtime composition moves into `@dina/home-node`, but the most misleading third Brain location is gone.

The old `apps/home-node-lite/core-server/GAP.md` was deleted with the retired subtree. Current gap tracking lives in the architecture cleanup docs and task tables.

## Code Architecture Findings

### CA-01: `docs/CODE_ARCHITECTURE.md` Now Describes The TS Target

Evidence:

- Fixed in `docs/CODE_ARCHITECTURE.md`: the primary code architecture doc now describes the greenfield TypeScript Home Node target.
- It defines mobile and server as adapters over one shared runtime, documents the `CoreClient` boundary, records endpoint policy, and lists shared validation gates.
- It explicitly calls out current process-wide registries as transitional and names `HomeNodeContext` as the target ownership model.

Impact:

- The main architecture doc no longer contradicts the TS consolidation plan.
- Developers have a single canonical direction for mobile/server/runtime boundaries.

Remaining work:

- Implement the shared runtime/package boundaries described by the doc (`CA-002`, `CA-003`, `RT-001` through `RT-003`).
- Replace remaining production deep imports after stable package exports exist (`CA-005`, `CA-006`). Initial progress: `@dina/brain` now exports the ask coordinator, agentic ask pipeline, LLM provider types, Gemini adapter, service handler/orchestrator types, and service runtime primitives; `@dina/home-node/service-runtime` composes the service runtime through public package surfaces; Brain server imports that shared runtime and has a package-boundary test rejecting new production deep imports.

### CA-02: Shared Home Node Runtime Package Contract Exists

Evidence:

- Mobile composition lives in `apps/mobile/src/services/bootstrap.ts`, `boot_service.ts`, and `boot_capabilities.ts`.
- Home-node-lite boot files do not call into this composition.
- Fixed in `packages/home-node`: runtime lifecycle/status contracts, hosted endpoint resolver, mobile/server env keys, feature handler contracts, explicit feature-unavailable errors, and `createHomeNodeRuntime`.
- Fixed in app/config consumers: mobile MsgBox/onboarding/trust AppView, mobile node-runtime AppView, home-node-lite Core/Brain server config, home-node-lite Core MsgBox boot/readiness, home-node-lite Brain AppView boot, and home-node-lite Brain signed Core client config now use shared endpoint/config surfaces.
- Mobile `DinaNode` now extends the shared lifecycle type.
- Home-node-lite Brain boot references the shared runtime type.

Impact:

- Mobile and server can import the same runtime contract, but cannot yet share most runtime files.
- Server fixes will be built separately from mobile fixes.
- The same Home Node behavior cannot be validated once at the runtime layer.

Remaining work:

- Move platform-neutral composition from mobile into that package.
- Keep only adapter-specific boot code in each app.

Target layout:

```text
packages/home-node/
  src/runtime/create_home_node.ts
  src/runtime/home_node_runtime.ts
  src/runtime/home_node_context.ts
  src/runtime/install_flow.ts
  src/runtime/remember_flow.ts
  src/runtime/ask_flow.ts
  src/runtime/trust_publish_flow.ts
  src/runtime/d2d_flow.ts
  src/adapters/ports.ts
  src/config/endpoints.ts

apps/mobile/
  app/
  src/ui/
  src/adapters/expo_*.ts
  src/boot/mobile_boot.ts

apps/home-node-lite/
  core-server/src/http/
  brain-server/src/http/
  src/adapters/node_*.ts
  src/boot/server_boot.ts
```

### CA-03: Home-node-lite No Longer Has A Core-Server Brain Implementation

Evidence:

- The retired `apps/home-node-lite/core-server/src/brain` subtree was deleted.
- `apps/home-node-lite/brain-server/src` contains a small adapter set: `bin.ts`, `boot.ts`, `config.ts`, `logger.ts`, `main.ts`, `core_client.ts`, `llm_provider.ts`, and `routes/ask.ts`.
- `packages/brain` already contains the shared Brain implementation.
- `apps/home-node-lite/core-server/__tests__/package_boundary.test.ts` now
  asserts that `src/brain` does not exist under core-server.

Impact:

- The most misleading Brain location is gone.
- Remaining drift risk is now narrower: `brain-server` must continue shrinking
  into a server adapter while `packages/brain` and `@dina/home-node` own shared
  Brain/runtime logic.

Fix direction:

- Make `brain-server` a thin adapter around `packages/brain` and the shared Home Node runtime.
- Keep the guard preventing a new `core-server/src/brain/*` subtree.

Progress:

- `apps/home-node-lite/core-server/src/appview/profile_auto_republisher.ts`
  no longer imports `../brain/config_reloader` just for its type shape. It now
  owns a minimal config snapshot/event contract at the AppView boundary.
- `apps/home-node-lite/core-server/__tests__/package_boundary.test.ts` rejects
  production Core server Brain internal imports, asserts that `src/brain` does
  not exist under core-server, and rejects tests that import the retired
  subtree.
- The stale core-server-only tests for that subtree were deleted with the
  subtree, because they exercised non-runtime architecture.

### CA-04: Mobile Owns Too Much Runtime Composition

Evidence:

- `apps/mobile/src/services/bootstrap.ts` is 1344 lines.
- `boot_service.ts` and `boot_capabilities.ts` add another 1270 lines.
- These files wire Core globals, Brain globals, MsgBox, workflows, staging, service orchestration, ask, D2D, AppView, PDS stubs, and teardown.

Impact:

- The most important Home Node code is app-owned instead of shared.
- Server cannot reuse it without depending on mobile code.
- The composition root is hard to reason about because it mutates many process-wide registries.

Fix direction:

- Extract a runtime builder from mobile:
  - `createHomeNodeRuntime(options)`
  - `HomeNodeContext`
  - `HomeNodePlatformAdapters`
  - `HomeNodeCapabilities`
- Keep mobile-specific code limited to:
  - React/Expo unlock flow
  - Keychain
  - op-sqlite provider
  - Expo notifications/background fetch
  - UI hooks and screens

### CA-05: Deep Imports Make Package Boundaries Soft

Evidence:

- Initial audit found 352 production-area import hits for package internals such
  as `@dina/core/src/...`, `@dina/brain/src/...`, and relative
  `../../../core/src/...` or `../../../brain/src/...`.
- Mobile production code now has zero `@dina/core/src` or `@dina/brain/src`
  imports, and declared Core/Brain/Home Node subpaths are protected by package
  `exports` maps. Remaining work is the parallel home-node-lite Core
  `src/brain` subtree and relative package-internal imports.
- `packages/core/src/index.ts` is a 561-line barrel that exports many internals, including staging functions and Node-oriented modules.
- `packages/brain/src/index.ts` is also a broad barrel and requires collision workarounds.

Impact:

- Internal files become public API by habit.
- Metro and Jest can load the same logical module through multiple paths, creating split singleton state.
- Refactors become risky because app code depends on package internals.
- Public package contracts are unclear.

Fix direction:

- Keep explicit `exports` maps in package manifests and add new public subpaths
  only with guard tests.
- Define public subpath APIs, for example:
  - `@dina/core/client`
  - `@dina/core/router`
  - `@dina/core/domain`
  - `@dina/core/runtime-ports`
  - `@dina/brain/ask`
  - `@dina/brain/staging`
  - `@dina/brain/service`
- Replace app deep imports with public entry points.
- Add lint/Jest gates that fail on production deep imports.

Progress:

- `packages/brain/src/index.ts` now exports `buildAgenticAskPipeline`,
  `createAskCoordinator`, `buildAgenticExecuteFn`, LLM provider types, the
  Gemini adapter, and related types.
- `apps/home-node-lite/brain-server/src/routes/ask.ts` no longer deep-imports
  `@dina/brain/src/composition/ask_coordinator`.
- `packages/home-node/src/ask_runtime.ts` composes the ask coordinator through
  public `@dina/brain` and `@dina/core` surfaces, exposed via
  `@dina/home-node/ask-runtime`.
- `apps/home-node-lite/brain-server/src/boot.ts` consumes that shared ask
  runtime instead of owning a server-local ask composition helper.
- `apps/home-node-lite/brain-server/src/llm_provider.ts` builds the configured
  Gemini provider through the public Brain adapter export.
- `packages/home-node/src/service_runtime.ts` builds service handling,
  discovery, workflow delivery, and approval reconciliation through public
  `@dina/brain` and `@dina/core` surfaces, exposed via the explicit
  `@dina/home-node/service-runtime` package subpath so the root endpoint
  resolver import stays light.
- `apps/home-node-lite/brain-server/src/boot.ts` consumes that shared
  `@dina/home-node/service-runtime` runtime instead of owning a server-local
  copy.
- `apps/home-node-lite/brain-server/__tests__/package_boundary.test.ts` now
  rejects production `@dina/core/src` and `@dina/brain/src` imports in the
  Brain server adapter.
- `packages/home-node/__tests__/package_boundary.test.ts` applies the same
  guard to shared runtime source and public runtime subpaths.
- `packages/core/src/index.ts` now exposes the mobile-facing onboarding,
  identity, crypto, persona, and constants surfaces needed by current mobile
  install/persona code, so that code no longer has to deep-import those
  internals.
- `apps/mobile/__tests__/architecture/package_boundary.test.ts` locks that
  slice by rejecting production mobile imports of those public Core surfaces
  through `@dina/core/src/...`.

### CA-06: Portable Packages Still Contain Platform-Specific Imports

Evidence:

- `packages/core/src/identity/keypair.ts` imports `fs` and `path`.
- `packages/core/src/storage/seed_file.ts` imports `fs` and `path`.
- `packages/core/src/storage/spool.ts` imports `fs` and `path`.
- `packages/core/src/schema/identity.ts` and `schema/persona.ts` import `fs` and `path`.
- `packages/brain/src/diagnostics/trace_correlation.ts` imports `node:async_hooks` and `node:crypto`.

Impact:

- `@dina/core` and `@dina/brain` are not fully runtime-agnostic packages.
- Mobile bundling can break if a production import reaches one of these modules.
- The package docs say shared domain layers should not import runtime-specific modules, but the source still contains exceptions.

Fix direction:

- Move file-backed keypair, wrapped seed file, spool, schema fixture loading, and Node trace correlation to Node adapter packages or Node-only subpaths.
- Keep portable packages limited to pure serialization, interfaces, and injected I/O.
- Add dependency gates for both `packages/core/src` and `packages/brain/src` covering Node, Expo, React Native, and server framework imports.

Progress:

- `packages/brain/src/diagnostics/trace_correlation.ts` no longer imports
  `node:async_hooks` or `node:crypto`. It owns the portable trace API and uses
  an injected `TraceScopeStorage` plus `globalThis.crypto.getRandomValues`.
- `packages/brain/node-trace-storage.ts` is the explicit Node-only subpath that
  installs an AsyncLocalStorage-backed trace storage adapter.
- Brain Jest setup and the home-node-lite Brain server boot install the Node
  adapter explicitly.
- Mobile Metro no longer maps trace-specific `async_hooks` or `crypto` shims,
  and the old shim files were deleted.
- `packages/brain/__tests__/dep_hygiene.test.ts` now forbids
  `node:async_hooks` and `node:crypto` imports under portable Brain source.

### CA-07: Global Mutable State Is The Dominant Composition Mechanism

Evidence:

- There are many `setX`, `getX`, `resetX`, and `globalThis` registry patterns in `packages/core`, `packages/brain`, and mobile boot.
- Examples include workflow repositories, service config, middleware state, D2D sender, MsgBox identity, vault repositories, staging inbox, memory service, chat threads, notifications, approval manager, and service command handlers.

Impact:

- This works for one mobile node in one JS VM.
- It is fragile for tests, multi-node simulations, server process reuse, and future multi-account support.
- It makes teardown correctness critical and easy to miss.
- It weakens dependency clarity: reading a function does not show which node instance owns the dependencies.

Fix direction:

- Introduce `HomeNodeContext` as the owner of repositories, services, senders, handlers, schedulers, and clients.
- Keep module-level setters only as temporary test/bootstrap adapters while extraction is incomplete.
- Make `CoreRouter`, `BrainCoordinator`, staging drain, service orchestration, and D2D send/receive accept a context.
- Add tests that create two runtime instances in the same process and prove they do not share state.

### CA-08: Brain To Core Boundary Is Not Enforced Broadly Enough

Evidence:

- There is a useful test in `packages/brain/__tests__/core_port_usage_audit.test.ts`.
- That test only blocks non-allowlisted imports of Core repositories.
- Brain still imports many Core internals directly:
  - vault CRUD
  - persona service
  - staging service
  - contacts directory
  - reminders service
  - trust search
  - PII patterns
  - memory service

Impact:

- The stated invariant "Brain reaches Core only via CoreClient" is not fully true.
- Mobile can hide the issue because Core and Brain share one VM.
- Server cannot cleanly run the same Brain logic over HTTP unless every required Core interaction exists on `CoreClient`.

Fix direction:

- Decide the real invariant:
  - strict: Brain uses `CoreClient` only, or
  - explicit in-process runtime: Brain can access a `CoreServices` interface supplied by `HomeNodeContext`.
- Do not allow direct imports of Core service modules from Brain production code.
- Expand the import audit from repository-only to all `core/src/**` imports, with a small allowlist for pure domain/types only.

### CA-09: App Code Reaches Directly Into Domain Modules

Evidence:

- Mobile screens and hooks import Core and Brain internals directly:
  - contacts
  - personas
  - pairing
  - reminders
  - vault CRUD
  - chat thread state
  - notification inbox
  - trust runners

Impact:

- UI code becomes coupled to storage/runtime implementation.
- Server cannot share app-level workflows because logic is scattered into hooks and screens.
- It is harder to enforce lifecycle and persona gates consistently.

Fix direction:

- Expose a stable `DinaNode` or `HomeNodeRuntime` facade:
  - `node.contacts`
  - `node.personas`
  - `node.remember`
  - `node.ask`
  - `node.trust`
  - `node.d2d`
  - `node.notifications`
  - `node.services`
- Have mobile hooks call that facade instead of direct package internals.
- Keep UI-specific state in mobile; keep Home Node behavior in packages.

### CA-10: Package Manifests Now Protect Declared Public API Boundaries

Evidence:

- `packages/core/package.json`, `packages/brain/package.json`, and
  `packages/home-node/package.json` now declare explicit `exports` maps for
  their current public root and subpath APIs.
- Guard tests pin those maps so `./src/*` cannot silently become public again.
- Mobile `tsconfig.json` includes path aliases for `@dina/core/*` and `@dina/brain/*` that point to `../core/src/*` and `../brain/src/*`, which do not match the workspace package location from `apps/mobile`.

Impact:

- Package resolution now distinguishes declared public entry points from
  internals.
- Incorrect aliases can hide behind workspace resolution until a specific bundler path fails.

Fix direction:

- Correct or remove mobile path aliases.
- Add CI checks for public import paths.
- Keep internal files unavailable except to package-local tests.

### CA-11: Architecture Guard Tests Are Good But Narrow

Evidence:

- `packages/brain/__tests__/dep_hygiene.test.ts` blocks some server/network imports.
- `packages/brain/__tests__/core_port_usage_audit.test.ts` blocks some direct Core repository imports.
- `packages/core/__tests__/port_async_gate.test.ts` tracks repository/adapter/provider contracts.

Impact:

- The codebase has the right pattern for architecture enforcement.
- The current gates do not cover the actual highest-risk boundaries:
  - app deep imports
  - Core runtime-specific imports
  - Brain runtime-specific imports outside network/server imports
  - accidental reintroduction of `core-server/src/brain`
  - global singleton growth

Fix direction:

- Keep the Jest-as-lint style.
- Add gates for:
  - no app production deep imports from `@dina/core/src` or `@dina/brain/src`
  - no `packages/core/src` Node/Expo imports except allowed adapterless pure modules
  - no `packages/brain/src` Node/Expo imports except explicit Node-only subpaths
  - no new files under `apps/home-node-lite/core-server/src/brain`
  - no new `setX/getX/resetX` globals without architecture review

### CA-12: Adapter Packages Are The Right Direction, But Not The Runtime Boundary Yet

Evidence:

- `packages/adapters-expo` and `packages/adapters-node` exist.
- `@dina/adapters-node` comments still describe storage as placeholder, while `packages/storage-node` has a concrete `NodeSQLiteAdapter`.
- Mobile still has app-local storage provider code under `apps/mobile/src/storage`.
- Home-node-lite server boot does not yet compose Node storage into Core runtime.

Impact:

- Adapter packages are not yet the clean boundary between apps and shared runtime.
- Storage/provider wiring is still app-specific and manual.

Fix direction:

- Define `HomeNodePlatformAdapters`.
- Implement Expo and Node adapter bundles that satisfy it.
- Make mobile/server boot call the same runtime factory with different adapter bundles.

### CA-13: Old-Runtime Support Is Out Of Scope

Evidence:

- Greenfield constraint is now explicit in `docs/CODE_ARCHITECTURE.md` and
  `docs/SIMPLIFIED_ARCHITECTURE.md`.
- Fixed in home-node-lite: persona config no longer has a tier migration module
  and now rejects old `open` / `restricted` values as invalid configuration.
- Fixed in adapter-node smoke coverage: the Brain smoke no longer imports the
  retired `CircuitBreaker` export; it exercises `runStagingDrainTick` through
  `CoreClient` instead.
- Fixed in mobile tests/source comments: mobile no longer imports the retired
  `brain/src/core_client/http` type path.
- Fixed in home-node-lite Brain server: the Core client builder now uses
  canonical `CoreClient` naming instead of retaining the retired
  BrainCoreClient-era runtime vocabulary.
- Fixed in home-node-lite Brain server package-boundary coverage: production
  code cannot reintroduce the retired BrainCoreClient-era naming.
- Fixed in production Core/Brain comments: service/runtime `CoreClient` and
  transport slices now document current contracts directly instead of retaining
  retired `BrainCoreClient` vocabulary.
- Fixed in shared Brain parsers: classification now requires canonical
  `primary`, and person-link extraction now requires canonical
  `identity_links` / `role_phrase` output.

Impact:

- Runtime boot remains simpler: the node either sees canonical data or fails
  loudly.
- Tests and source comments stop pinning support surfaces that should not exist
  in the shared TS Home Node.

Fix direction:

- Do not add normal boot-time translators for previous Go/Python or transitional
  TS local data shapes.
- Keep any future import/export tooling outside the Home Node runtime path.

### CA-14: Mobile Brain Chat Imports Now Use A Public Subpath

Evidence:

- Added `packages/brain/chat.ts` for `@dina/brain/chat`.
- Replaced mobile production imports from `@dina/brain/src/chat/thread` and
  `@dina/brain/src/chat/orchestrator` with `@dina/brain/chat`.
- Added a mobile architecture guard that rejects those deep imports.

Impact:

- Chat UI/hooks/components now depend on a stable Brain chat API instead of
  package internals.
- The public subpath avoids root-level naming conflicts with LLM provider
  `ChatMessage` and `ChatResponse` types.

Validation:

- `@dina/brain` typecheck passed.
- `@dina/app` typecheck passed.
- Mobile architecture package-boundary test passed.
- Focused mobile chat hook tests passed.

### CA-15: Mobile Core Contact Imports Use The Public Core Boundary

Evidence:

- Added public `@dina/core` exports for the mobile-facing contact directory
  surface.
- Replaced mobile production imports from `@dina/core/src/contacts/directory`
  with `@dina/core`.
- Extended the mobile architecture guard to reject contacts-directory deep
  imports.

Impact:

- People/contact screens, D2D chat, MsgBox wiring, staging enrichment, storage
  boot, and trust search now depend on Core's public package surface.
- The export set deliberately reuses the existing root `Contact` and
  `TrustLevel` types to avoid duplicate public symbols.

Validation:

- `@dina/core` typecheck passed.
- `@dina/app` typecheck passed.
- Mobile architecture package-boundary test passed.
- Focused mobile contact/staging-enrichment tests passed.
- Core contacts directory/repository tests passed.

### CA-16: Mobile Boot Uses Public Runtime Subpaths

Evidence:

- Added `@dina/core/runtime` for Core assembly primitives used by mobile boot.
- Added `@dina/brain/runtime` for Brain assembly primitives used by mobile
  boot.
- Replaced Core/Brain deep imports in `apps/mobile/src/services/bootstrap.ts`,
  `apps/mobile/src/services/boot_service.ts`, and
  `apps/mobile/src/services/boot_capabilities.ts`.
- Added a mobile architecture guard that rejects new Core/Brain deep imports in
  those three boot composition files.

Impact:

- Mobile boot is still the largest remaining platform-neutral composition
  owner, but it now depends on named package boundaries instead of source-file
  paths.
- This gives the shared `@dina/home-node` extraction a cleaner next step:
  move composition using the runtime subpaths first, then collapse adapter-only
  mobile code back into Expo-specific services.

Validation:

- `@dina/core` typecheck passed.
- `@dina/brain` typecheck passed.
- `@dina/app` typecheck passed.
- Mobile architecture package-boundary test passed.
- Focused mobile boot/bootstrap tests passed.

### CA-17: Mobile Storage Uses A Public Core Storage Boundary

Evidence:

- Added `@dina/core/storage` for storage adapters, DB provider contracts,
  persistence bootstrap helpers, SQLite repositories, repository setters, and
  hydration hooks.
- Replaced Core deep imports in `apps/mobile/src/storage/init.ts`,
  `apps/mobile/src/storage/provider.ts`, and
  `apps/mobile/src/storage/op_sqlite_adapter.ts`.
- Added a mobile architecture guard that rejects new Core deep imports from the
  mobile storage folder.

Impact:

- Mobile persistence setup no longer depends on Core source paths.
- The shared runtime extraction can now consume the same storage boundary when
  the server adapter gets real storage wiring.

Validation:

- `@dina/core` typecheck passed.
- `@dina/app` typecheck passed.
- Mobile architecture package-boundary test passed.
- Mobile storage teardown and boot capability tests passed.
- Focused Core storage/domain test set passed.

### CA-18: Mobile LLM Imports Use A Public Brain Subpath

Evidence:

- Added `@dina/brain/llm` for Brain LLM provider types, provider config,
  AI-SDK/Gemini adapters, stream chunks, and chat-reasoning registration.
- Replaced Brain LLM deep imports in mobile AI provider setup, chat reasoning
  wiring, health checks, LLM settings/onboarding, chat streaming, and trust
  compose/review-draft flows.
- Added a mobile architecture guard that rejects new Brain LLM deep imports.

Impact:

- Mobile BYOK/provider code now depends on a named Brain LLM API instead of
  implementation paths.
- The public LLM subpath keeps LLM concerns separate from the root Brain
  orchestration API and the chat thread API.

Validation:

- `@dina/brain` typecheck passed.
- `@dina/app` typecheck passed.
- Mobile architecture package-boundary test passed.
- Focused mobile LLM/chat/trust tests passed.
- Focused deterministic Brain LLM/chat-reasoning tests passed.

### CA-19: Mobile Enrichment And Service Schema Imports Use Public Brain Surfaces

Evidence:

- Added `@dina/brain/enrichment` for topic extraction, preference extraction,
  and topic-touch pipeline APIs.
- Replaced Brain enrichment deep imports in
  `apps/mobile/src/services/staging_enrichment.ts`.
- Replaced AppView-client and service-capability deep imports in
  `apps/mobile/src/services/appview_stub.ts` and
  `apps/mobile/src/services/demo_bus_driver_responder.ts` with public
  `@dina/brain` imports.
- Added a mobile architecture guard that rejects those deep imports.

Impact:

- Mobile staging enrichment and demo AppView/service fixtures no longer depend
  on Brain source layout.
- The split keeps enrichment on a purpose-built subpath while reusing the root
  Brain service/AppView public API where that surface already exists.

Validation:

- `@dina/brain` typecheck passed.
- `@dina/app` typecheck passed.
- Mobile architecture package-boundary, staging enrichment, AppView stub,
  boot, and staging-drain integration tests passed.
- Focused Brain enrichment and service-capability tests passed.

### CA-20: Mobile Reminders And Notifications Use Public Subpaths

Evidence:

- Added `@dina/core/reminders` for reminder service functions and types.
- Added `@dina/brain/notifications` for notification inbox functions and types.
- Replaced mobile deep imports in reminder hooks, notification hooks, reminder
  cards, notification screens, and notification bridges.
- Added a mobile architecture guard that rejects the moved reminder and
  notification deep imports.

Impact:

- Mobile reminder and notification surfaces now depend on named package APIs
  instead of Core/Brain source layout.
- The ownership split stays clean: Core owns reminders, Brain owns the
  notification inbox.

Validation:

- `@dina/core`, `@dina/brain`, and `@dina/app` typechecks passed.
- Focused mobile reminder/notification tests passed.
- Focused Core reminder tests passed.
- Focused Brain notification/nudge tests passed.

### CA-21: Mobile Service Config And Workflow Imports Use Public Core

Evidence:

- Replaced Core service-config deep imports in the mobile service config form
  hook and service settings screen with `@dina/core`.
- Replaced the demo bus-driver responder's workflow-service deep import with
  `@dina/core`.
- Added a mobile architecture guard that rejects those deep imports.

Impact:

- Service settings and demo service responder code now use existing public Core
  APIs instead of implementation paths.

Validation:

- `@dina/app` typecheck passed.
- Mobile architecture, service config form, demo responder, and bus-driver E2E
  tests passed.

### CA-22: Mobile D2D And MsgBox Imports Use A Public Core Subpath

Evidence:

- Added `@dina/core/d2d` for D2D message-family constants, DID resolution,
  quarantine APIs, installed D2D sender accessors, and MsgBox WebSocket factory
  types.
- Replaced Core D2D deep imports in mobile MsgBox wiring, D2D chat egress, and
  D2D quarantine/message hooks.
- Added a mobile architecture guard that rejects those deep imports.

Impact:

- Mobile D2D/MsgBox code now uses a named Core D2D API surface.
- This is aligned with the simplified architecture because D2D through MsgBox is
  a primary Home Node behavior, not app-local implementation detail.

Validation:

- `@dina/core` and `@dina/app` typechecks passed.
- Focused mobile D2D tests passed.
- Focused Core D2D/MsgBox tests passed.

### CA-23: Mobile Domain Hooks Use Public Root Package APIs

Evidence:

- Replaced deep imports in mobile contact detail, service-thread delivery,
  unlock, chat nudge, vault browser/items, and share export hooks.
- Added the missing root Core export for `setSharingPolicy`.
- Added a mobile architecture guard that rejects those deep imports.

Impact:

- Mobile UI hooks now use root Core/Brain domain APIs where those surfaces are
  already public.
- This avoids creating redundant subpaths for domain APIs that are not runtime
  adapter boundaries.

Validation:

- `@dina/core`, `@dina/brain`, and `@dina/app` typechecks passed.
- Focused mobile hook tests passed.
- Focused Core sharing/vault/export tests passed.
- Focused Brain nudge/service-event tests passed.

### CA-24: Mobile Production Has No Core/Brain Source-Path Imports

Evidence:

- Added `@dina/core/audit`, `@dina/core/devices`, and `@dina/core/kv`.
- Exported `getAskApprovalGateway` from public `@dina/brain`.
- Replaced the last production mobile Core/Brain deep imports in paired
  devices, local notifications, audit log, trust memory warning, and chat
  approvals.
- Added a broad mobile architecture guard that rejects any production import of
  `@dina/core/src` or `@dina/brain/src`.

Impact:

- Mobile is now cleanly behind package APIs. That is a prerequisite for moving
  more mobile-owned boot/runtime composition into `@dina/home-node`.

Validation:

- `@dina/core`, `@dina/brain`, and `@dina/app` typechecks passed.
- Focused mobile final-offender tests passed.
- Focused Core KV/audit/trust/approval/devices/pairing tests passed.
- Focused Brain ask approval/coordinator tests passed.
- `rg` found no remaining production mobile Core/Brain source-path imports.

## Recommended Target Architecture

### Package Structure

```text
packages/protocol
  Wire types and protocol constants only.

packages/core
  Core domain, Core services, CoreRouter, CoreClient, transport contracts.
  No Node, Expo, React Native, Fastify, fs, or path imports in portable source.

packages/brain
  Brain domain and orchestration.
  Talks to Core through CoreClient or explicit HomeNodeContext interfaces.
  No app-owned state and no server framework imports.

packages/home-node
  The shared Home Node runtime.
  Owns install, unlock, ask, remember, trust, D2D, service, scheduling,
  lifecycle, and dependency composition.

packages/adapters-expo
  Expo implementations of storage, keychain, net, notifications, background jobs.

packages/adapters-node
  Node implementations of storage, keystore, fs, net, process lifecycle.

apps/mobile
  React Native UI plus Expo adapter boot.

apps/home-node-lite
  Fastify HTTP adapters plus Node adapter boot.
```

### Dependency Direction

```text
apps/mobile
apps/home-node-lite
  depend on
packages/home-node
  depends on
packages/core, packages/brain, packages/protocol
  depend on
adapter ports only

packages/adapters-expo and packages/adapters-node
  implement ports
  are passed into packages/home-node by apps
```

### Shared File Target

For a healthy final architecture:

- 70 to 80 percent of Home Node behavior should be shared in packages.
- Mobile-specific code should be UI, native capabilities, and mobile lifecycle.
- Server-specific code should be HTTP surface, Node process lifecycle, and server adapters.
- Install, remember, ask, trust publish, service query, D2D, staging, approval, endpoint resolution, AppView/PDS clients, and MsgBox logic should be shared.

## Code Architecture Cleanup Order

Recommended order:

1. Freeze the target TS code architecture in docs.
2. Add `packages/home-node` with interfaces first, not a massive move.
3. Move mobile composition into the shared runtime in small slices.
4. Wire mobile back to the shared runtime and verify no behavior changes.
5. Wire home-node-lite to the same runtime using Node adapters.
6. Relocate or delete `apps/home-node-lite/core-server/src/brain`.
7. Keep public package subpath exports explicit and guarded.
8. Replace deep imports with public entry points.
9. Move platform-specific files out of portable packages.
10. Convert global singleton composition to `HomeNodeContext` ownership.
11. Add architecture guard tests.
12. Add parity scenarios for mobile and server.

## Bottom Line

The TS codebase is not poorly written. There are many carefully implemented modules and good tests. But it is not pristine because the architecture boundary is not clean yet.

The main issue is not code quality inside individual modules. The main issue is ownership:

- Mobile owns the real runtime.
- Home-node-lite owns a parallel server/Brain surface.
- Shared packages expose internals and globals.
- The docs still describe an older architecture.

The cleanup branch should make the shared TS Home Node runtime the center of the codebase. Once that exists, mobile and server can share most files naturally instead of trying to stay in sync by discipline.
