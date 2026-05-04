# Architecture Cleanup Tasks

Date: 2026-05-04

Branch: `architecture-cleanup`

Scope: TypeScript cleanup for `apps/mobile`, `apps/home-node-lite`, and shared TS packages used by those apps.

## Status Legend

| Status | Meaning |
| --- | --- |
| `todo` | No production-ready implementation yet. |
| `partial` | Useful code exists, but important release behavior is missing. |
| `blocked-decision` | Needs an architecture or infrastructure decision before implementation. |
| `dev-only` | Works for local/test paths, not release. |
| `done` | Implemented and should be protected by tests. |

## Review Conclusion And Fix Map

The simplified architecture plan is good. The fixes below are about reducing TS implementation drift, not changing the target. Mobile is the closest TS Home Node today; home-node-lite should reuse/extract that runtime shape instead of independently recreating the prior Go/Python architecture. This is a greenfield target: no legacy support, no normal migration path, and no compatibility layer for superseded TS or Go/Python runtime shapes.

| Area | Mobile TS fix | Home-node-lite TS fix | Primary tasks |
| --- | --- | --- | --- |
| Shared runtime | Move platform-neutral boot from `apps/mobile/src/services/*` into shared runtime package. | Continue moving Brain/Core composition into `@dina/home-node`; service runtime composition now lives there and Brain server consumes it. | CA-003, RT-002, RT-003 |
| Install | Complete PDS account/session/publisher boot around existing did:plc provisioning. | Add seed/DID/PDS/session/MsgBox/AppView install flow. | ID-001, ID-002, PDS-001, PDS-002, CONFIG-001, CONFIG-002 |
| Endpoint defaults | Done: mobile endpoint consumers and node-runtime AppView resolve through `@dina/home-node`. | Done: Core/Brain server config resolves through `@dina/home-node`, and Brain boot constructs the configured AppView client. | CONFIG-001, CONFIG-002, APPVIEW-001 |
| `/remember` | CoreClient ingest, durable staging authority, explicit per-persona resolve gates, approval-backed locked rows, pre-store enrichment, and shared transport parity tests are in place. | Brain server now constructs a signed `HttpCoreTransport` when the service key is provisioned and starts the shared staging drain scheduler after Fastify binds. | HNL-004 |
| `/ask` | Keep agentic coordinator as canonical; ensure AppView/provider/approval prerequisites are explicit. | Brain server can compose/register the real coordinator from signed Core, hosted AppView, approval manager, service orchestrator, and explicit Gemini config. | ASK-001, ASK-002, HNL-004, HNL-005 |
| D2D / MsgBox | Pin whether D2D is MsgBox `/forward` or WS frames and test against test relay. | Core server now connects to MsgBox through shared boot logic; remaining work is the same D2D/service sender/receiver parity as mobile. | D2D-001 through D2D-004, HNL-003 |
| Trust publish | Replace release path with durable outbox -> PDS createRecord -> AppView reconciliation. | Use the same trust publisher/runtime once server runtime exists. | TRUST-001 through TRUST-003, PDS-002, APPVIEW-002 |
| Service discovery/query | Mobile uses a real requester-side AppView client by default; finish PDS publisher defaults for profile publish. | `@dina/home-node` now owns service runtime composition; Brain server consumes it with signed Core/AppView dependencies. Remaining work is MsgBox delivery, PDS profile publish, and parity tests. | SERVICE-001 through SERVICE-003, APPVIEW-001, PDS-002 |

## P0 Tasks

| ID | Status | Area | Task | Fix outline | Acceptance checks |
| --- | --- | --- | --- | --- | --- |
| CA-001 | done | code architecture | Publish canonical TS code architecture. | Replaced `docs/CODE_ARCHITECTURE.md` with the greenfield TypeScript Home Node architecture: shared runtime target, mobile/server adapter roles, CoreClient boundary, endpoint policy, runtime state policy, and validation gates. | Docs describe mobile and server as adapters over one shared TS Home Node runtime. |
| CA-002 | done | code architecture | Add shared `@dina/home-node` runtime package. | Added `packages/home-node` with runtime lifecycle/feature contracts, hosted endpoint resolver, explicit feature-unavailable errors, a delegating runtime factory, and shared service runtime composition. Mobile and home-node-lite Brain now import shared runtime surfaces. | `@dina/home-node` typecheck/test pass; mobile and home-node-lite Brain typechecks resolve the package. |
| CA-003 | partial | code architecture | Move mobile runtime composition into shared package. | Mobile boot composition now imports Core/Brain runtime dependencies through public `@dina/core/runtime` and `@dina/brain/runtime` subpaths. Remaining work: extract platform-neutral logic from `apps/mobile/src/services/bootstrap.ts`, `boot_service.ts`, and `boot_capabilities.ts` into `@dina/home-node`. | Mobile boot becomes mostly Expo adapter construction plus runtime start. |
| CA-004 | done | code architecture | Eliminate parallel Brain code under core-server. | Deleted the retired 94-file `apps/home-node-lite/core-server/src/brain` subtree, removed its core-server-only tests and stale `GAP.md`, and strengthened the core-server package-boundary guard so the subtree cannot return and tests cannot import it. Remaining Brain ownership is now `packages/brain`, `apps/home-node-lite/brain-server`, and shared `@dina/home-node` runtime slices. | `apps/home-node-lite/core-server/src/brain` no longer exists; non-Brain Core server production code has no Brain internal imports; core-server package-boundary/typecheck/full test suite pass on the remaining server surface. |
| CA-005 | partial | package boundaries | Define public package exports. | Added public `@dina/brain` exports for ask/service runtime composition, ask-approval gateway access, service delivery, vault-context, nudge, and service/AppView schema helpers; public `@dina/brain/chat`, `@dina/brain/llm`, `@dina/brain/enrichment`, `@dina/brain/notifications`, `@dina/brain/runtime`, and `@dina/brain/node-trace-storage`; public `@dina/core/audit`, `@dina/core/d2d`, `@dina/core/devices`, `@dina/core/kv`, `@dina/core/reminders`, `@dina/core/runtime`, and `@dina/core/storage`; public `@dina/home-node/ask-runtime` and `@dina/home-node/service-runtime`; and public `@dina/core` exports for mobile onboarding, identity, contacts, crypto, persona, vault/PII, sharing, trust cache, export, approval manager, Core service config/workflow, and constants surfaces. Added explicit package `exports` maps and guard tests for the declared Core, Brain, and Home Node subpaths. Remaining work: stable subpath APIs for other Core, Brain, and Home Node runtime areas, plus cleanup of relative package-internal imports. | Brain-server ask routes import `AskCoordinator` from `@dina/brain`; mobile production code no longer imports `@dina/core/src/*` or `@dina/brain/src/*`; mobile uses public Core/Brain root exports and named subpaths for chat, LLM, enrichment, notifications, audit, D2D, devices, KV, reminders, runtime, and storage; npm package resolution now rejects undeclared Core/Brain/Home Node subpaths outside test-specific mappers. |
| CA-006 | partial | package boundaries | Ban production deep imports. | Added production-source Jest guards for brain-server and `@dina/home-node` that reject `@dina/core/src` and `@dina/brain/src` imports. Added a broad mobile production guard that rejects any `@dina/core/src` or `@dina/brain/src` import under `apps/mobile/src` and `apps/mobile/app`, plus focused guards for the public surfaces moved during cleanup. Added a Core server guard that rejects any production Brain internal imports and asserts the retired `src/brain` subtree is absent. Added Core/Brain/Home Node package `exports` maps for package-manager enforcement of declared public subpaths. Remaining work: replace remaining relative package-internal production imports. | Brain-server and shared runtime code cannot add new Core/Brain deep imports; mobile production code cannot add any Core/Brain deep import; Core server cannot regain a parallel Brain subtree or depend on Brain internals; package-manager-level enforcement exists for declared public package entry points. |
| CA-007 | partial | portability | Move platform-specific code out of portable packages. | Brain trace correlation is now portable: `packages/brain/src/diagnostics/trace_correlation.ts` uses injected trace storage and Web Crypto, while Node AsyncLocalStorage lives in `@dina/brain/node-trace-storage`; mobile no longer carries trace-specific `async_hooks`/`node_crypto` Metro shims. Remaining work: move Core `fs/path` modules and any remaining Node-only helpers to Node adapters or Node-only subpaths. | `packages/brain/src` dependency hygiene now forbids `node:async_hooks` and `node:crypto`; broader `packages/core/src` portability gate still pending. |
| CA-008 | partial | runtime state | Replace global singleton composition with runtime context. | Introduce `HomeNodeContext` owning repositories, senders, schedulers, clients, and handlers; keep module-level setters only as temporary test/bootstrap adapters while extraction is incomplete. | Two Home Node instances can run in one test process without shared state. |
| GREEN-001 | partial | greenfield cleanup | Remove old-runtime support from normal TS runtime. | Delete code whose only purpose is to translate previous Go/Python or transitional TS runtime shapes. Runtime config/data should be canonical and fail fast when it is not. Persona tier migration is removed; mobile tests/source no longer import the retired `brain/src/core_client/http` path; server Brain now uses `buildCoreClient` naming instead of preserving `BrainCoreClient` terminology; the brain-server package-boundary guard rejects that retired naming; production Core/Brain comments now describe current `CoreClient`/transport contracts directly; Brain classification/person-link parsers now reject old `persona` and `links` envelopes instead of accepting them. | Home-node-lite persona config rejects `open`/`restricted`; Brain parser tests prove old envelopes fail closed and canonical `primary`/`identity_links` envelopes pass; adapter-node smoke tests current `CoreClient` staging composition; affected mobile/server/Brain typechecks pass; no production boot path silently rewrites old runtime data; production TS source no longer references `BrainCoreClient`. |
| RT-001 | done | shared runtime | Define `HomeNodeRuntime` contract. | Added `HomeNodeRuntime`, lifecycle, status, remember, ask, trust publish, service query, endpoint, and handler contracts in `@dina/home-node`; mobile `DinaNode` extends the shared lifecycle and server Brain boot references the runtime type. | Contract is documented and used by mobile and server boot code. |
| RT-002 | partial | shared runtime | Extract mobile's platform-neutral node composition. | Moved ask coordinator composition into `@dina/home-node/ask-runtime`, service handler/orchestrator/dispatcher/workflow-loop composition into `@dina/home-node/service-runtime`, and fenced mobile boot dependencies behind public Core/Brain runtime subpaths. Remaining work: extract the larger mobile `createNode`/`bootAppNode` composition slices. | Shared ask/service runtime tests pass; mobile still owns most boot composition. |
| RT-003 | partial | shared runtime | Add Node.js platform adapter for home-node-lite. | Brain server now consumes `@dina/home-node/ask-runtime` and `@dina/home-node/service-runtime` with Node/server dependencies; Core server now uses the Node WebSocket adapter for MsgBox boot. Remaining work: Node storage, key custody hardening, PDS, scheduler/logger/runtime ownership, and full runtime assembly. | Brain server can consume shared ask/service runtimes and Core server can connect to MsgBox; full home-node-lite runtime construction is still pending. |
| HNL-001 | partial | home-node-lite core | Wire Core server boot to real CoreRouter. | Core boot now creates the shared `@dina/core` `createCoreRouter()`, binds it safely through `bindCoreRouter`, skips only shell-owned `/healthz`, and exposes readiness checks for the bound router and MsgBox. Remaining work: real storage/adapter wiring. | `core-server` serves signed Core routes through the booted Fastify process and rejects unsigned signed-route requests; storage-dependent routes still report their explicit not-wired state. |
| HNL-002 | done | home-node-lite core | Fix Fastify CoreRouter auth binding. | Implemented by dispatching requests through `CoreRouter.handle` with the real URL path. | Auth regression tests cover unsigned, invalid signed, valid signed, and trusted in-process cases. |
| HNL-003 | done | home-node-lite core | Wire MsgBox in Core/server runtime. | Core boot derives the Home Node root DID from the local seed, uses `@dina/core/runtime` `bootstrapMsgBox`, uses `@dina/net-node` as the Node WebSocket adapter, defaults to the hosted test MsgBox endpoint through `@dina/home-node`, and closes the socket on Fastify shutdown. Tests inject a fake WS factory so the default-connect path is validated without network IO. | Server connects to the test MsgBox endpoint by default, `msgbox_connect` is `ok`, and `/readyz` reports `msgbox: ok`; explicit `DINA_MSGBOX_ENABLED=false` or relay handshake failure leaves MsgBox pending, keeps `/healthz` alive, and makes `/readyz` fail. |
| HNL-004 | partial | home-node-lite brain | Wire Brain server boot. | Brain server now has Core URL config, service-key config, signed `HttpCoreTransport` construction, AppView client construction, staging drain scheduler boot wiring, config-driven Gemini LLM setup, `@dina/home-node/ask-runtime` composition, and `@dina/home-node/service-runtime` composition. Remaining work: MsgBox, PDS, and full runtime ownership. | Brain server can run staging drain against Core server, expose `/api/v1/ask` through the same agentic coordinator shape as mobile when Gemini is explicitly configured, and consume the shared ask/service runtimes when dependencies are supplied. |
| HNL-005 | done | home-node-lite brain | Register ask routes in Brain boot. | Boot registers `apps/home-node-lite/brain-server/src/routes/ask.ts` from either an injected `AskCoordinator` or config/`askRuntime` composition, and reports `askRoutes` in readiness. | `/api/v1/ask`, status, approve, and deny route surfaces work through the server process with the composed coordinator. |
| STG-001 | done | staging/remember | Add transport-level staging ingest. | Implemented signed `/v1/staging/ingest`, `CoreClient.stagingIngest`, and both HTTP/in-process transport methods. | Core route, HTTP transport, in-process transport, API contract, and mock-client tests pass. |
| STG-002 | done | staging/remember | Route `/remember` through canonical Brain/Core path. | Brain chat orchestrator now uses injected `CoreClient.stagingIngest`; alternate mobile remember paths were deleted. | Mobile UI routes through `useChatThread` -> Brain orchestrator -> CoreClient; no production mobile direct staging ingest remains. |
| STG-003 | done | staging persistence | Make staging repository authoritative. | Implemented repository-first ingest/dedup/claim/resolve/fail/approval/lease/sweep/list/read plus explicit cache hydration on mobile persistence boot. | Ingest -> restart/cache reset -> claim -> resolve works without item loss or duplicate store. |
| STG-004 | done | persona gates | Require per-persona access decisions on resolve. | Implemented explicit `persona_open` for single-persona resolve and `persona_access` for multi-persona resolve; `StagingResolveRequest` is typed as a gate-required union; Brain drain now supplies access decisions from accessible personas. | Missing access state is rejected; locked targets become `pending_unlock` instead of storing. |
| STG-005 | done | persona gates | Add durable approval/pending unlock resume. | Implemented workflow `approval` tasks for locked staging rows with payload type `staging_persona_access`; workflow approve drains by `approval_id`, workflow cancel/fail marks the row failed with retries exhausted, and persona unlock does not bypass approval-gated rows. | Approve stores, deny does not store, and cache reset/restart preserves the pending approval state. |
| STG-006 | done | enrichment | Complete remember enrichment before store. | Implemented by routing the staging drain and processor helper through the shared enrichment pipeline, recording stage metadata, and normalizing JSON vector embeddings at Core store. | Drain/processor/pipeline and Core embedding tests pass; fallback states are explicit. |
| STG-007 | done | tests | Add remember parity scenario tests. | Implemented shared `/remember` scenarios against mobile in-process transport and server signed HTTP transport. Also added Brain authorization for signed `/v1/staging/*` routes. | Tests cover single persona, multi-persona, locked persona, restart/cache reset, and failed enrichment. |
| ASK-001 | partial | ask | Make agentic ask the default runtime path on mobile and server. | Ensure boot always installs the same ask coordinator when model/tool prerequisites exist; use explicit degraded mode otherwise. | `/ask` returns through the same coordinator in mobile and server. |
| ASK-002 | todo | ask approvals | Align ask approval routes across mobile and server. | Share approval manager and route semantics for status, approve, deny, and draft review. | Approval workflow behaves identically in mobile and home-node-lite tests. |
| APPVIEW-001 | partial | AppView | Build real AppView client by default. | Mobile node runtime constructs Brain `AppViewClient` from `@dina/home-node` and passes it into service discovery and agentic tools; trust UI resolves the same endpoint policy. Home-node-lite Brain boot constructs the configured AppView client and passes it into shared ask/service runtimes when enabled. Trust route/runtime wiring remains. | Mobile fresh test boot and Brain server boot use `https://test-appview.dinakernel.com` without injection; server ask/service runtimes use the boot client; trust route parity still pending. |
| APPVIEW-002 | partial | AppView | Remove split AppView paths. | Endpoint selection is shared between trust UI, node runtime, and home-node-lite Brain boot. Remaining cleanup is to share/standardize the actual client surface and route all server Brain tools through the boot client. | Trust UI, mobile agentic tools, and Brain server boot use the same AppView base URL; server Brain route parity still pending. |
| PDS-001 | partial | PDS | Define PDS account/session lifecycle. | Specify create/login/refresh/logout, secure session storage, test/release PDS defaults, and DID/account relationship. | Install creates or imports a usable PDS session. |
| PDS-002 | todo | PDS | Build real PDS publisher in boot. | Use persisted PDS session to create a publisher adapter for service profiles and trust records. | Provider profile publish does not emit `publisher.stub` in normal test install. |
| TRUST-001 | dev-only | trust publish | Wire production trust publish through PDS. | Use `packages/core/src/trust/pds_publish.ts` for signed `createRecord`; keep AppView inject explicit dev-only. | Trust records publish to PDS and appear in AppView without test injection. |
| TRUST-002 | todo | trust outbox | Make trust outbox durable. | Replace in-memory outbox with SQLCipher/SQLite repository and retry runner. | Restart preserves queued records and retry state. |
| TRUST-003 | todo | trust reconciliation | Add AppView status/reconciliation. | Poll or subscribe for trust record visibility and update local status. | UI can show queued, published, indexed, failed, and retrying states. |
| CONFIG-001 | done | config | Centralize test/release endpoint resolution. | `@dina/home-node` now owns hosted endpoint mode selection, mobile/server env keys, URL validation, PDS host derivation, and MsgBox/PDS/AppView/PLC defaults. Mobile MsgBox, onboarding handle/PLC defaults, HandlePicker/OwnerName, trust AppView, node-runtime AppView, and `@dina/net-expo` use it. | `@dina/home-node`, mobile onboarding tests, boot capability tests, mobile typecheck, and `@dina/net-expo` typecheck pass. |
| CONFIG-002 | done | config | Apply endpoint config to home-node-lite. | Core and Brain server config now resolve hosted endpoints through `@dina/home-node`; Brain boot constructs AppView from that config; default mode is test, release mode is explicit, and URL/mode mistakes fail during config load. | Core/Brain server config tests and typechecks pass; server config defaults to `test-mailbox`, `test-pds`, and `test-appview`. |
| ID-001 | partial | install | Complete install flow. | Install should create/import seed, create DID, create/login PDS account, persist session, connect MsgBox, and verify AppView visibility. | New install can publish service/trust records and receive D2D. |
| ID-002 | todo | identity | Replace stub PDS session in production boot. | Fail or degrade explicitly when a real PDS session is required and absent. | Release/provider mode cannot silently publish with a stub session. |

## P1 Tasks

| ID | Status | Area | Task | Fix outline | Acceptance checks |
| --- | --- | --- | --- | --- | --- |
| D2D-001 | blocked-decision | D2D/MsgBox | Decide canonical D2D relay transport. | Choose either WS D2D frames or HTTP `/forward` as the canonical send path through MsgBox. | Architecture doc and code agree on one contract. |
| D2D-002 | partial | D2D/MsgBox | Align implementation with relay decision. | If WS D2D is supported, enable WS delivery. If HTTP forward is canonical, document it and test it as first-class. | D2D send/receive passes against test MsgBox. |
| D2D-003 | todo | D2D notify | Wire D2D receive notifications. | Add runtime event/notification adapter and connect Core D2D receive to mobile UI/server event stream. | Received D2D creates a visible local event/notification. |
| D2D-004 | partial | D2D tests | Add D2D parity tests. | Run sign/seal/send/receive scenarios for mobile in-process and server runtime. | Tests cover online delivery, replay rejection, unknown sender quarantine, and queued retry. |
| ALT-001 | done | mobile cleanup | Remove `apps/mobile/src/ai/chat.ts` path. | Deleted the file and its processMessage tests; chat runs through Brain orchestrator. | Production UI imports only canonical chat hooks. |
| ALT-002 | done | mobile cleanup | Remove `apps/mobile/src/ai/memory.ts` memory path. | Deleted the file and its in-memory memory tests. | No production mobile code imports `staging/service` directly for remember. |
| ALT-003 | done | mobile cleanup | Remove standalone `useChatRemember` path. | Deleted the hook and its tests; `/remember` is handled by Brain orchestrator only. | No hook can mark stored before staging drain actually stores. |
| ALT-004 | todo | mobile cleanup | Add import guard for Core internals. | Add lint/test rule blocking app code from importing `packages/core/src/staging/service` directly. | CI fails if production app imports staging internals. |
| PERSIST-002 | partial | persistence | Review approval/workflow repository authority. | Workflow-backed staging persona approvals are durable; continue reviewing ask approval manager and broader workflow state across mobile and server. | Restart preserves active approvals and workflows. |
| PERSIST-003 | todo | persistence | Add server storage adapter parity tests. | Verify Node storage adapter satisfies the same repository contracts as mobile SQLCipher. | Repository contract tests pass on mobile adapter and Node adapter. |
| SERVICE-001 | partial | services | Wire service discovery to real AppView. | Mobile service query orchestrator and agentic tools now receive the shared default AppView client; `@dina/home-node/service-runtime` composes `ServiceQueryOrchestrator` around injected AppView/Core clients, and server Brain passes its boot AppView client into that runtime. Remaining work is MsgBox-backed route/D2D delivery and parity tests. | Mobile service search points at test AppView in normal test mode; shared service runtime and server boot tests pass; route/D2D parity still pending. |
| SERVICE-002 | partial | services | Publish service profiles through real PDS publisher. | Remove provider-mode stub path for normal test/release installs. | Provider service appears in AppView through PDS indexing. |
| SERVICE-003 | todo | services | Add service query parity scenario. | Test provider discovery, workflow start, service query, response, and approval on mobile and server. | Same fixture passes in both runtimes. |
| OBS-001 | todo | observability | Add runtime health/readiness contract. | Define status for storage, identity, MsgBox, PDS, AppView, Brain, staging, and D2D. | Mobile boot banner and server `/readyz` report equivalent dependency states. |
| OBS-002 | todo | observability | Remove production console noise in staging. | Replace direct `console.log`/`console.warn` in staging paths with structured logger or audit events. | Tests do not emit unexpected console output. |
| SECURITY-001 | partial | security | Harden server seed/key storage. | Replace raw convenience seed files with wrapped/OS-keystore-backed custody before release. | Server key material is encrypted at rest and never logs mnemonic in release mode. |
| SECURITY-002 | todo | security | Review signed route coverage. | Enumerate public vs signed Core routes and assert auth behavior. | Signed route matrix test exists and passes. |
| TEST-001 | todo | parity tests | Build end-to-end install scenario fixture. | Test install -> unlock -> connect MsgBox -> PDS session -> AppView health. | Fixture passes for mobile test harness and home-node-lite. |
| TEST-002 | todo | parity tests | Build end-to-end remember/ask fixture. | Remember a fact, drain staging, ask for it, verify persona-gated retrieval. | Same expected answer path passes in both runtimes. |
| TEST-003 | todo | parity tests | Build end-to-end trust fixture. | Publish trust attestation to PDS, observe in AppView, use it in trust-aware ask/tooling. | Test injection is not used in release-mode fixture. |
| TEST-004 | todo | parity tests | Build end-to-end D2D fixture. | Pair two nodes, send sealed message, receive, verify replay protection and notification. | Fixture passes against test MsgBox. |

## App-Specific Granular Fixes

### Mobile TS

| ID | Status | Fix | Why |
| --- | --- | --- | --- |
| MOB-001 | partial | Keep `provisionIdentity` as the install base, but extend it with PDS account/session persistence. | DID and MsgBox endpoint provisioning exist; publishing still needs real PDS credentials. |
| MOB-002 | done | Build a real AppView client during boot from shared endpoint config. | Mobile trust UI and node runtime now resolve AppView through `@dina/home-node`; agentic tools and service discovery receive the same hosted client by default. |
| MOB-003 | todo | Build a real PDS publisher/session during boot. | Provider profiles and trust records should not emit `publisher.stub` in normal test/release installs. |
| MOB-004 | todo | Make trust outbox SQLCipher/SQLite-backed with retry/reconciliation. | Current outbox state is in-memory and lost on restart. |
| MOB-005 | done | Route all production `/remember` calls through `CoreClient.stagingIngest`. | Brain chat orchestrator is the only production mobile remember path and it uses the CoreClient boundary. |
| MOB-006 | done | Make staging repository authoritative or rehydrate strongly at boot. | Core staging uses repository-first operations when wired, and mobile hydrates after installing `SQLiteStagingRepository`. |
| MOB-007 | done | Enforce per-persona access decisions and durable approval resume for remember. | Explicit access decisions are enforced; locked rows create workflow approvals; approve resumes and stores, deny fails without retry, and the mobile approvals inbox renders the memory access approval type. |
| MOB-008 | done | Remove mobile `ai/chat.ts`, `ai/memory.ts`, and standalone remember hook paths. | Greenfield target: no alternate remember/chat paths remain. |
| MOB-009 | blocked-decision | Confirm D2D relay contract as MsgBox `/forward` or WS D2D frames. | Current TS deliberately uses `/forward`; docs and tests must match the infrastructure contract. |
| MOB-010 | partial | Keep agentic ask coordinator as canonical and make degraded boot states visible. | Mobile ask is close, but release behavior depends on provider, AppView, and approval wiring. |

### Home-node-lite TS

| ID | Status | Fix | Why |
| --- | --- | --- | --- |
| HNL-A01 | todo | Replace scaffold boot with shared `HomeNodeRuntime` composition plus Node adapters. | The server should be the same Home Node behavior, not an independent port. |
| HNL-A02 | partial | Open storage, wire adapters, assemble `createCoreRouter`, and expose readiness only after real dependencies. | Core server now assembles/binds `createCoreRouter` and reports MsgBox readiness; storage and adapter steps remain pending. |
| HNL-A03 | done | Fix Fastify router binding to dispatch through `CoreRouter.handle` or equivalent auth middleware. | Implemented and validated with signed-route regression tests. |
| HNL-A04 | partial | Wire MsgBox connect using shared endpoint config. | Core server connects to MsgBox with shared endpoint config; service/D2D delivery parity through the full server runtime is still pending. |
| HNL-A05 | partial | Wire Brain server with `HttpCoreTransport`, the configured AppView client, LLM/router, ask coordinator, staging drain, and service handlers. | Brain boot currently serves health, returns `503 not_ready`, configures signed Core/AppView clients, starts staging drain when Core is keyed, composes/registers ask when Gemini is configured, and consumes `@dina/home-node/service-runtime` when explicit service dependencies are supplied. MsgBox, PDS, and full runtime ownership remain. |
| HNL-A06 | done | Register ask/status/approve/deny routes with real dependencies. | Route code is part of boot, and config/`askRuntime` builds the real coordinator from Core/AppView/LLM/approval dependencies. |
| HNL-A07 | todo | Add server install flow for seed/DID/PDS session/MsgBox/AppView verification. | A server install cannot yet become a full Home Node. |
| HNL-A08 | todo | Add parity tests that run same install/remember/ask/trust/D2D fixtures as mobile. | Shared runtime is not proven until both form factors pass the same scenarios. |
| HNL-A09 | done | Reject old persona tier names instead of translating them. | Greenfield target has no local-data migration path; non-canonical `open`/`restricted` config values now fail with `invalid_tier`. |

## Suggested Implementation Slices

### Slice 1: Stop Runtime Drift

Primary tasks:

- RT-001
- RT-002
- RT-003
- HNL-001
- HNL-002
- HNL-004

Goal:

Mobile and home-node-lite construct the same logical node. Server can still expose separate Core/Brain HTTP processes if needed, but the behavioral composition should come from shared TS runtime modules.

### Slice 2: Make Remember Correct

Primary tasks:

- Done: STG-001 through STG-007

Goal:

`/remember` is now transport-safe, durable, persona-aware, enrichment-aware, restart-safe, and covered by shared mobile/server transport parity tests. The remaining server work is runtime boot composition under HNL-004, not remember semantics.

### Slice 3: Make Publish Real

Primary tasks:

- APPVIEW-001
- APPVIEW-002
- PDS-001
- PDS-002
- TRUST-001
- TRUST-002
- TRUST-003
- SERVICE-001
- SERVICE-002

Goal:

Provider profiles and trust records publish through PDS and become visible through AppView without test injection. Test injection remains only for dev fixtures.

### Slice 4: Lock Down Transport And Parity

Primary tasks:

- D2D-001
- D2D-002
- D2D-003
- D2D-004
- TEST-001
- TEST-002
- TEST-003
- TEST-004

Goal:

The app uses one endpoint policy, one MsgBox/D2D contract, and one scenario suite that validates mobile and server behavior against the same expectations.

## Immediate Next Actions

1. Move the remaining platform-neutral parts of mobile boot behind `@dina/home-node`.
2. Move the remaining staging scheduler ownership and mobile `createNode`/`bootAppNode` slices behind shared `@dina/home-node` runtime modules.
3. Wire MsgBox inbound/outbound delivery into the server Brain service dispatcher and reject/response paths.
4. Define the PDS session/publisher adapter needed by install, trust publish, and service profile publish.
5. Decide and test the MsgBox D2D relay contract (`/forward` vs WS frames) before changing transport code.
