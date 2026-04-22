# Dina TS Packages

Shared TypeScript packages that power both build targets:

- `apps/home-node-lite/` — Node Fastify servers
- `apps/mobile/` — Expo / React Native (lands in Phase 1 per option (c))

Nothing in this directory imports from `apps/*`. Apps depend on packages; packages never depend on apps.

## Layers

| Layer                                 | Packages                                                                                       | Role                                                                                                                                                  | Runtime deps                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **1 — pure domain**                   | `@dina/core`, `@dina/brain`                                                                    | Router, gatekeeper, identity, D2D, HNSW, prompts, orchestration                                                                                       | None — no `fs`, `node:*`, `react-native`, `expo-*`, `fetch`, `ws` |
| **2 — protocol**                      | `@dina/protocol`                                                                               | Wire types, canonical-sign, envelope builders, frame constants. Independently publishable so a third-party implementer in any language can consume it | None                                                              |
| **3 — test support**                  | `@dina/fixtures`, `@dina/test-harness`                                                         | Fixture DIDs/keys, mock in-memory adapters, `MockCoreClient`                                                                                          | None                                                              |
| **4a — platform adapters (granular)** | `@dina/{storage,crypto,fs,net,keystore}-node`<br>`@dina/{storage,crypto,fs,net,keystore}-expo` | One package per capability × platform                                                                                                                 | Native / platform SDKs                                            |
| **4b — platform adapter meta**        | `@dina/adapters-node`, `@dina/adapters-expo`                                                   | Thin re-export of the five granular packages; convenience for apps inside this repo                                                                   | workspace:\* to granular packages                                 |

## Rules that keep the layering honest

- **Async everywhere.** Every port interface method returns `Promise<T>`. Node adapters wrap sync calls (e.g. better-sqlite3 is sync; the adapter returns `Promise<…>`); Expo adapters are natively async. Pure domain code never assumes sync I/O. See the **Async-port rule** section below for the conversion patterns. CI enforces via the `dina/port-async-only` ESLint rule (Phase 2 task 2.8).
- **One-way dependency graph.** `@dina/protocol` is a leaf; it imports nothing else in the workspace. `@dina/core` depends on `@dina/protocol`; `@dina/brain` depends on `@dina/core` (via the `CoreClient` interface, never via HTTP in pure code). Adapters depend on protocol + core interfaces.
- **No runtime-specific imports in layers 1–3.** If `packages/core/src/**` or `packages/brain/src/**` imports `fetch`, `ws`, `undici`, `node:*`, `react-native`, or `expo-*`, it's a layering bug — move the code to an adapter.

## Async-port rule (Phase 2)

**Every port interface method returns `Promise<T>`**, regardless of whether the current implementation is synchronous. The port signature is the contract; sync implementations wrap their result in a resolved Promise.

### Why

Current SQLite-under-go-sqlcipher is synchronous, so an async port adds one promise creation per call — effectively zero overhead. The async contract future-proofs for storage backends that genuinely are async (SQLite WASM on web, IndexedDB for mobile web, network-backed stores, remote managed databases). Without a uniform async contract, a future port would need a parallel API and every caller would choose.

### Four conversion patterns

Phase 2.3 codified four patterns as pilots landed (7 of 11 repositories + 1 of 2 storage adapters converted). Each maps to a different service-layer constraint:

| Pattern | When to use | Caller churn | Examples |
|---------|------------|--------------|----------|
| **Full-async wrapper** | Service is a thin routing layer; callers few / already async-friendly | Callers ripple async (TSC-guided) | `KVRepository`, `TopicRepository`, `DBProvider` |
| **Fire-and-forget write-through** | Service has authoritative in-memory state + prior try/catch with fail-safe comment | **Zero** | `AuditRepository`, `DeviceRepository`, `ReminderRepository`, `StagingRepository`, `VaultRepository` |
| **Hybrid** | Mixed read/write shape — writes can be fire-and-forget, reads must be awaited | One read-path function becomes async | `ChatMessageRepository` |
| **Explicit boot hydrate** | Service-layer has a sync read hot path (e.g. D2D ingress) + wants restart-restore from persistence | Boot adds one `await hydrateX()` call | `ServiceConfigRepository` (`hydrateServiceConfig()` replaces lazy-hydrate-in-getter) |

### Fire-and-forget canonical shape

```typescript
// Service layer stays sync; port call fires async with double-guard.
const sqlRepo = getRepo();
if (sqlRepo) {
  try {
    void sqlRepo.write(data).catch(() => {
      /* fail-safe — transient SQL write loss is acceptable */
    });
  } catch {
    /* fail-safe — sync-throw variant (e.g. test mocks) */
  }
}
```

The **double-guard** (outer try/catch + inner `.catch()`) handles both cases: a port impl that returns a rejected Promise AND one that throws synchronously before returning. Test mocks commonly do the latter — `.catch()` alone misses those.

### In-transaction helpers

When a repo method runs inside `db.transaction(fn)`, the callback is synchronous (adapter contract). Async methods on the port still need a sync internal helper for in-transaction use:

```typescript
// public async method — satisfies the port contract
async storeItem(item: VaultItem): Promise<void> {
  this.storeItemSync(item);
}

// sync internal — used inside db.transaction() where awaiting would
// break atomicity
private storeItemSync(item: VaultItem): void {
  this.db.execute(...);
}

// batched method uses the sync helper inside the transaction
async storeBatch(items: VaultItem[]): Promise<void> {
  this.db.transaction(() => {
    for (const item of items) this.storeItemSync(item);
  });
}
```

See `SQLiteTopicRepository.getSync()` and `SQLiteVaultRepository.storeItemSync()` for concrete uses.

### Test conversion checklist

Converting a port + its callers to async surfaces these test-file edits:

1. `it('…', () => { … })` → `it('…', async () => { … })`
2. `repo.method(...)` → `await repo.method(...)`
3. **Chain expressions need parens:** `await repo.x().map(...)` → `(await repo.x()).map(...)` — without parens, TS parses as `await (repo.x().map(...))` which fails because `.map` doesn't exist on `Promise`.
4. **Sync-throw tests:** `expect(() => repo.x()).toThrow(...)` → `await expect(repo.x()).rejects.toThrow(...)` for methods whose throw becomes a rejection.
5. **Fire-and-forget writes:** when asserting against repo state after a sync service-layer call that fires the repo write asynchronously, drain the microtask queue with `await Promise.resolve()` before the assertion.

TSC surfaces most of these automatically — run `npx tsc --noEmit` after the port flip and work through the errors. `perl -i -pe 's/…/…/g'` handles the bulk of mechanical `await` inserts.

### Exempted ports

Not every port should be async. The rule targets **genuine I/O-boundary ports** — HTTP clients, WebSocket hubs, non-mmap file handles, remote datastores. CPU-bound native bindings don't benefit; wrapping their sync call in `Promise<T>` adds microtask overhead, breaks sync-throw semantics, and complicates callback contracts that require the body to run to completion.

Exemptions are enumerated in the `EXEMPTED_PORTS` list inside `packages/core/__tests__/port_async_gate.test.ts`. The gate enforces:

1. Every exempted port has a rationale in the gate ≥50 characters long.
2. The port's source file itself contains a `/* sync on purpose */`-style comment using the word "sync" and one of {`cpu-bound`, `native`, `transaction`, `microtask`}. Keeps the code + the gate synchronised — you can't exempt a port by editing only the test.

Current exemptions (1):

| Port | File | Why sync is correct |
|------|------|---------------------|
| `DatabaseAdapter` | `core/src/storage/db_adapter.ts` | SQLite via better-sqlite3-multiple-ciphers (Node) and op-sqlite via JSI (RN) both expose synchronous native calls. Async wrap would push identical work into a microtask, mask synchronous throw semantics, and break the `transaction(fn)` callback contract where `fn()` must run to completion before `COMMIT`. Pinned as the canonical counter-example per task 3.4. |

## Dependency graph

```
  @dina/protocol  ◀──  @dina/core  ◀──  @dina/brain
                          ▲              ▲
              @dina/test-harness     @dina/fixtures
                          ▲
         @dina/adapters-{node,expo}  ◀──  @dina/{storage,crypto,fs,net,keystore}-{node,expo}
```

## See also

- `../docs/HOME_NODE_LITE_TASKS.md` — end-to-end task plan with phase-by-phase breakdown
- Individual package READMEs for implementer-facing docs
