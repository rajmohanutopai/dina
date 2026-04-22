# Phase 2 — Async-port audit

Task 2.1 enumerates every port interface the workspace currently
declares. Task 2.2 produces the method-return-type audit below so the
subsequent 2.3 conversion pass (wrap all non-`Promise<T>` returns)
has a concrete target list.

Audit conducted 2026-04-21 against `packages/core/src/**`,
`packages/brain/src/**`, `packages/test-harness/src/**`, and
`packages/protocol/src/**`. Produced via grep for `^export interface
\w+(Port|Adapter|Provider|Repository)\b` plus a manual pass of the
shape `Promise<T>` / bare-T / `T | null` returns.

## TL;DR

- **Core repositories (13) are all synchronous.** Backed by SQLite
  via go-sqlcipher which exposes a sync API; this is the single
  biggest target for Phase 2.3's conversion pass.
- **Core storage adapters (2) are synchronous.** `DatabaseAdapter`
  + `DBProvider`. Touches every repository implementation.
- **Brain LLM/embedding providers are already async.** No conversion
  needed.
- **Transports are already async.** `HttpClient`, `CoreClient`,
  `InProcessTransport`, `HttpCoreTransport` all return `Promise<T>`.
- **Many ports listed in 2.1 do not yet exist as interfaces** —
  crypto, fs, websocket-client, keystore, msgbox-client, appview-client,
  pds-client, plc-client, clock, logger. These need Phase 3+ port
  introductions before they can be audited.

## Existing ports — method → return type

### Core repositories (task 2.1a — storage-backed)

| Port | File | Methods | Returns | Phase 2 conversion |
|------|------|---------|---------|---------------------|
| `StagingRepository` | `core/src/staging/repository.ts` | `ingest`, `get`, `claim`, `updateStatus`, `sweep`, `listByStatus`, `size` | all sync | wrap all 7 |
| `KVRepository` | `core/src/kv/repository.ts` | `get`, `set`, `delete`, `has`, `list`, `count` | all sync | wrap all 6 |
| `TopicRepository` | `core/src/memory/repository.ts` | `touch`, `top`, `get`, `resolveAlias`, `putAlias` | all sync | wrap all 5 |
| `ChatMessageRepository` | `core/src/chat/repository.ts` | `append`, `listByThread`, `listThreadIds`, `deleteThread`, `reset` | all sync | wrap all 5 |
| `ContactRepository` | `core/src/contacts/repository.ts` | `add`, `get`, `list`, `update`, `remove`, `addAlias`, `removeAlias`, `resolveAlias`, `getAliases`, `setPreferredFor`, `getPreferredFor`, `findByPreferredFor` | all sync | wrap all 12 |
| `AuditRepository` | `core/src/audit/repository.ts` | `append`, `latest`, `query`, `sweep`, `count`, `allEntries` | all sync | wrap all 6 |
| `WorkflowRepository` | `core/src/workflow/repository.ts` | `create`, `getById`, `getByProposalId`, `getByIdempotencyKey`, `getActiveByIdempotencyKey`, `getByCorrelationId`, `transition`, `setRunId`, `setInternalStash`, `findServiceQueryTask`, … | all sync | wrap all (~15) |
| `ServiceConfigRepository` | `core/src/service/service_config_repository.ts` | `get`, `put`, `remove` | all sync | wrap all 3 |
| `ReminderRepository` | `core/src/reminders/repository.ts` | `create`, `get`, `listPending`, `listByPersona`, `update`, `remove` | all sync | wrap all 6 |
| `VaultRepository` | `core/src/vault/repository.ts` | `storeItem`, `getItem`, `getItemIncludeDeleted`, `deleteItem`, `queryFTS`, `queryAll`, `storeBatch` | all sync | wrap all 7 |
| `DeviceRepository` | `core/src/devices/repository.ts` | `register`, `get`, `getByPublicKey`, `getByDID`, `list`, `revoke`, `touch` | all sync | wrap all 7 |

**Repository subtotal: ~80 methods to convert.**

### Core storage adapters (task 2.1a — persistence layer)

| Port | File | Methods | Returns | Phase 2 conversion |
|------|------|---------|---------|---------------------|
| `DatabaseAdapter` | `core/src/storage/db_adapter.ts` | `execute`, `query<T>`, `run`, `transaction(fn)`, `close`, `isOpen` | all sync (execute/query/run return rows immediately; transaction blocks) | wrap `execute`, `query`, `run`, `close`; `transaction` needs `Promise<void>` outer + async-capable inner fn |
| `DBProvider` | `core/src/storage/db_provider.ts` | `openIdentityDB`, `openPersonaDB`, `closePersonaDB`, `getIdentityDB`, `getPersonaDB`, `closeAll` | all sync | wrap all 6 |

**Adapter subtotal: 10 methods to convert, plus `transaction`'s callback-type change.**

### Transports (task 2.1d — HTTP/WebSocket)

| Port | File | Methods | Returns | Phase 2 conversion |
|------|------|---------|---------|---------------------|
| `HttpClient` | `core/src/client/http-transport.ts` | `request` | `Promise<HttpResponse>` | ✅ already async |
| `CoreClient` | `core/src/client/core-client.ts` | `healthz`, vault CRUD (4), `didSign`, `didSignCanonical`, `piiScrub`, `piiRehydrate`, `notify`, persona (2), service (2), `memoryToC` | all `Promise<T>` | ✅ already async |

### Brain providers (task 2.1h, 2.1i — LLM + embedding)

| Port | File | Methods | Returns | Phase 2 conversion |
|------|------|---------|---------|---------------------|
| `LLMProvider` | `brain/src/llm/adapters/provider.ts` | `chat`, `stream`, `embed` | `Promise<ChatResponse>`, `AsyncIterable<StreamChunk>`, `Promise<EmbedResponse>` | ✅ already async |
| `ReasoningLLMProvider` (fn-type) | `brain/src/vault_context/assembly.ts` | call-as-function | `Promise<LLMMessage>` | ✅ already async |
| `ReminderLLMProvider` (fn-type) | `brain/src/pipeline/reminder_planner.ts` | call-as-function | `Promise<string>` | ✅ already async |
| `PersonaSelectorProvider` (fn-type) | `brain/src/routing/persona_selector.ts` | call-as-function | `Promise<...>` | ✅ already async |
| `SilenceLLMProvider` (fn-type) | `brain/src/guardian/llm_classify.ts` | call-as-function | `Promise<string>` | ✅ already async |
| `PersonLinkProvider` (fn-type) | `brain/src/person/linking.ts` | call-as-function | `Promise<string>` | ✅ already async |
| `EmbeddingProvider` (fn-type) | `brain/src/embedding/generation.ts` | call-as-function | `Promise<EmbeddingResult>` | ✅ already async |
| `DataSourceProvider` (fn-type) | `brain/src/sync/engine.ts` | call-as-function | `Promise<...>` | ✅ already async |

### Test-harness ports (`packages/test-harness/src/ports.ts`)

30+ interfaces covering Brain-side abstractions. **Mixed sync/async.**
These are the contracts mocks implement; they need to match the
corresponding production interface once Phase 2 lands. Deferred to
task 2.6 (mock updates) since any change here is driven by the
production port shape, not an independent decision.

Key ones worth naming explicitly:

- `Signer`, `HDKeyDeriver`, `Encryptor`, `KeyWrapper`, `KEKDeriver`,
  `VaultDEKDeriver`, `KeyConverter` — crypto mocks. Today the Brain
  crypto layer is synchronous (Ed25519 via `@noble/ed25519` sync
  path). If Phase 2 ports crypto as async, these need wrapping.
- `Gatekeeper`, `ApprovalManager`, `ScenarioPolicyManager` — decision
  authorities. Mixed sync/async today; audit per-method in 2.3.
- `PersonaManager`, `DeviceRegistry`, `ContactDirectory` — CRUD-style
  ports backed by repositories. Should be `Promise<T>` throughout
  after 2.3.
- `BrainClient`, `WSHub` — transport-side; already async.

## Missing ports (listed in 2.1 sub-items but not yet defined)

Phase 3+ work — these ports don't exist as TS interfaces; the
underlying concerns are handled by direct imports / inlined logic.

| Task | Missing port(s) | Current state | Phase owning port introduction |
|------|-----------------|---------------|--------------------------------|
| 2.1b | `Ed25519Port` / `X25519Port` / `Secp256k1Port` / `SealedBoxPort` / `ArgonPort` / `HashPort` / `HKDFPort` / `RandomPort` | Direct `@noble/*` / `@scure/*` / `hash-wasm` imports scattered throughout core | Phase 3 (Node adapters) — introduce as part of `packages/crypto-node` + `packages/crypto-expo` split |
| 2.1c | `FsPort` | Sparse direct `node:fs` use; the donor mobile app pushes filesystem through `packages/fs-expo` already | Phase 3 — already partially scaffolded as `packages/fs-expo`; needs Node equivalent |
| 2.1d | `WebSocketClientPort` | Inlined in `core/src/relay/msgbox_ws.ts` via `ws` package | Phase 3 — introduce as `WSClient` interface parallel to `HttpClient` |
| 2.1e | `KeystorePort` | Scaffolded as `packages/keystore-expo`; no Node peer | Phase 3 |
| 2.1f | `MsgBoxClientPort` | Logic in `core/src/relay/msgbox_*.ts` uses raw WS client | Phase 3 — depends on WebSocketClientPort |
| 2.1g | `AppViewClientPort` / `PDSClientPort` / `PLCClientPort` | `brain/src/appview_client/http.ts` is a concrete HTTP client; no abstract port yet | Phase 3 |
| 2.1j | `NotifyPort` | `notify()` is a method on `CoreClient`, not a standalone port | Already covered by CoreClient; may not need a separate port |
| 2.1k | `ClockPort` | Some code uses `Date.now()` / `Math.floor(Date.now()/1000)` directly; others take `nowSecFn` / `nowMsFn` in constructor options (see `MemoryService`, `CoreRouter`) | Phase 2.3 adjacent — formalise the existing `nowFn` pattern as `ClockPort` |
| 2.1l | `LoggerPort` | Direct `console.*` calls in several places | Phase 2.3 adjacent — minor port with `info` / `warn` / `error` |

## Phase 2.3 conversion target summary

| Category | Interface count | Method count (approx) | Already async | Needs wrapping |
|----------|----------------:|----------------------:|--------------:|---------------:|
| Core repositories | 11 | ~80 | 0 | **~80** |
| Core storage adapters | 2 | 10 | 0 | **10** |
| Transports (CoreClient / HttpClient) | 2 | 14 | 14 | 0 |
| Brain providers (LLM + embedding) | 8 | ~12 | 12 | 0 |
| Test-harness mocks | ~30 | ~150 | depends | audit per-method in 2.3 |

**Phase 2.3 focus: core repositories + storage adapters.** ~90 method
signatures change from `T`/`T | null` to `Promise<T>`/`Promise<T | null>`.
Per-file SQLite implementations stay sync internally (go-sqlcipher is
sync) but wrap results in `Promise.resolve(...)` at the port boundary,
preserving the `await`-everywhere rule at call-sites.

Call-site churn will be proportional — every repo method has 1–5
callers in services/handlers/middleware. Spot-checking: `StagingRepository`
has ~40 call-sites, `VaultRepository` ~50, `WorkflowRepository` ~60.
Phase 2.4 (in-core callers) + 2.5 (in-brain callers) do the `await`
insertion mechanically.

## Invariants the conversion must preserve

- **Transaction atomicity.** `DatabaseAdapter.transaction(fn)` today
  runs `fn` synchronously; the port's signature becomes
  `transaction(fn: () => Promise<void>): Promise<void>` — every inner
  call becomes awaitable. SQLite's sync-txn semantics are preserved
  because the underlying implementation doesn't yield (go-sqlcipher
  microtask-synchronous), but the TYPES let an async backend work.
- **In-flight idempotency.** Repositories that use
  `getActiveByIdempotencyKey` for dedupe must keep that read-check
  atomic with the follow-up insert. Today's sync API enforces that by
  co-location; the async version should wrap the pair in
  `transaction(async () => { ... })` at the caller.
- **Test-harness mocks stay consumable.** Any port signature change
  requires matching mock edits; 2.6 covers that explicitly.

## Next steps after this audit

1. **2.3 conversion.** Rewrite each port interface's methods to
   `Promise<T>`. Update each implementation (SQLite + InMemory) to
   `async` methods that `return` the sync result.
2. **2.4 in-core callers.** Insert `await` at every call-site. CI's
   typecheck catches missed ones.
3. **2.5 in-brain callers.** Same for `packages/brain/src`.
4. **2.6 mock updates.** Align `packages/test-harness/src/mocks/*` +
   `src/ports.ts` with the new async contracts.
5. **2.7 full test suite green.** Regression-check.
6. **2.8 custom ESLint rule** (`dina/port-async-only`) — fail lint on
   any non-`Promise<T>` method in files under `src/**/port*` or
   `src/**/repository*`. Prevents regression.
