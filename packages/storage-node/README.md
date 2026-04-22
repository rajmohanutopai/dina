# `@dina/storage-node`

SQLCipher-backed storage adapter for the Node build target (Fastify
Core + Fastify Brain). Implements `DatabaseAdapter` and `DBProvider`
from `@dina/core` against a native SQLCipher binding, providing
encrypted SQLite for identity + per-persona vault databases.

**Status:** scaffolding. Library choice decided (below); implementation
lands in docs/HOME_NODE_LITE_TASKS.md tasks 3.2–3.19.

## Library choice — `better-sqlite3-multiple-ciphers`

We evaluated three candidates against the requirements in task 3.1–3.4.
Summary:

| Library | Async? | Prebuilt arches | FTS5 | Maintenance | Verdict |
|---|---|---|---|---|---|
| **`better-sqlite3-multiple-ciphers`** | Sync (wrapped async at the port) | linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64 | ✅ | Active (m4heshd fork of WiseLibs better-sqlite3 + wxSQLite3 ciphers) | **Chosen** |
| `@journeyapps/sqlcipher` | Native async (node-sqlite3-based) | linux-x64, darwin-x64, darwin-arm64 — **no prebuilt linux-arm64** | ✅ (inherited from node-sqlite3) | Maintained (Journey Apps' commercial sync product) | Rejected — binary matrix gap |
| `node-sqlcipher` | Native async | Limited prebuild | ✅ | Sparse | Rejected — maintenance concern |

### Why `better-sqlite3-multiple-ciphers`

1. **Prebuilt binary coverage matches our deployment matrix** exactly
   (task 3.2 verified against v12.9.0 GitHub releases):

   | Platform      | Arches                              | Node ABIs published |
   |---------------|-------------------------------------|---------------------|
   | **darwin**    | arm64, x64                          | 115 / 127 / 137     |
   | **linux**     | arm64, x64, arm                     | 115 / 127 / 137     |
   | **linuxmusl** | arm64, x64                          | 115 / 127 / 137     |
   | **win32**     | arm64, x64                          | 115 / 127 / 137     |

   All 4 required targets (`linux-arm64`, `linux-x64`, `darwin-arm64`,
   `darwin-x64`) have prebuilds for Node 20 (ABI 115), Node 22 (ABI 127),
   and Node 23/24 (ABI 137). Our workspace targets `node >=22`, so every
   supported runtime lands on a prebuild without a native build toolchain.
   Bonus coverage: Alpine (linuxmusl), Raspberry Pi 32-bit (linux-arm),
   Windows.
2. **Sync API matches our sync port contract** (task 3.4). Dina's
   `DatabaseAdapter` port in `packages/core/src/storage/db_adapter.ts`
   returns sync values (`void` / `T[]` / `number`) — not `Promise<T>`.
   SQLite is CPU-bound, not I/O-bound; the Node-side `.prepare()+.run()`
   call completes inside a single V8 tick against the cached memory-
   mapped page or WAL frame. Wrapping in `Promise.resolve(...)` would
   just defer the same work to a microtask for no gain — callers lose
   direct-throw semantics on errors (stack traces become promise
   chains) and every repository call site picks up an `await` that
   buys no concurrency.
   The `dina/port-async-only` ESLint rule mentioned for Phase 2 is
   scoped to ports that cross a genuine async boundary (HTTP,
   WebSocket, file I/O on non-mmap paths); the storage port
   explicitly stays sync and is the pinned counter-example.
3. **Performance.** Prepared-statement cache, V8 native bindings, no
   callback overhead. better-sqlite3 is the fastest SQLite binding in
   the Node ecosystem; BSMC is a straightforward cipher-enabled
   fork that preserves those perf characteristics.
4. **API stability.** Mirrors `better-sqlite3`'s long-stable API, so
   migrating to/from it (if the ecosystem shifts) is mechanical.
5. **wxSQLite3 cipher coverage.** Supports the SQLCipher AES cipher
   (compatible with our existing go-sqlcipher encrypted files) plus
   AES-256-GCM + ChaCha20-Poly1305 for future-proofing.
6. **FTS5 + WAL** both supported out-of-the-box (task 3.3 verified by
   `__tests__/bsmc_feature_verification.test.ts`): an FTS5 virtual table
   with the `unicode61 remove_diacritics 1` tokenizer ingests diacritic
   text and matches non-diacritic queries; `PRAGMA journal_mode = WAL`
   on a file-backed DB returns `wal` and persists on read-back.

### What we gave up by not picking `@journeyapps/sqlcipher`

- Native async I/O. In practice SQLite is CPU-bound, not I/O-bound,
  so "native async" in node-sqlite3 is a thread-pool dispatch rather
  than real async — BSMC's sync-in-async-wrapper ends up in the same
  ballpark perf-wise with simpler ownership semantics (no callback
  queue, no implicit transaction ordering issues).
- Journey Apps' commercial sync-product ecosystem. Not relevant —
  Dina does its own sync via D2D.

## Open compatibility question — SQLCipher file format vs wxSQLite3

Our mobile path uses `go-sqlcipher` which implements the original
SQLCipher AES cipher. BSMC uses wxSQLite3 which has its own default
format. **Task 3.7** will verify that BSMC's `PRAGMA cipher = 'sqlcipher'`
mode produces byte-compatible databases with the mobile Go port —
the encrypted-file format must round-trip across both runtimes so a
user can move their Home Node between a Node server and a mobile
device without re-encrypting.

If compatibility turns out to require a specific cipher_page_size or
KDF-iteration setting, we'll pin it in the `open()` implementation
and document the invariant here.

## Package shape (planned)

```
packages/storage-node/
├── package.json           # deps on better-sqlite3-multiple-ciphers + @dina/core
├── src/
│   ├── index.ts           # public exports: NodeSQLiteAdapter, NodeDBProvider
│   ├── adapter.ts         # DatabaseAdapter impl (task 3.7-3.11)
│   ├── provider.ts        # DBProvider impl (task 3.12-3.14)
│   └── migration.ts       # schema_version runner (task 3.15)
└── __tests__/             # unit + smoke (task 3.16-3.19)
```

## Scope NOT in this package

- Identity-DB key derivation. `derivePersonaDEK` lives in `@dina/core/crypto`;
  this package only accepts a hex-encoded key via `PRAGMA key`.
- Per-persona open/close orchestration. Handled by `@dina/core`'s
  `bootstrapPersistence` / `openPersonaVault` helpers; this package
  implements the `DBProvider` interface they drive.
- FTS5 tokenizer choice. Dina uses `unicode61 remove_diacritics 1`
  (matches Go Core + mobile); the adapter emits the same DDL.

## Test coverage (task 3.16 checkpoint)

8 suites / 119 tests cover the public surface end-to-end against a
real `better-sqlite3-multiple-ciphers` native module — no mocking of
the SQLite layer.

| Suite | Tests | Purpose |
|-------|-------|---------|
| `bsmc_feature_verification.test.ts` | 4  | Library-level probes: FTS5 tokenizer + WAL round-trip (task 3.3). |
| `adapter.test.ts`                   | 33 | `NodeSQLiteAdapter`: option validation, open/close lifecycle, encryption round-trip, pragma application, CRUD, callback transactions, explicit BEGIN/COMMIT forms (tasks 3.7 – 3.9, 3.14). |
| `fts5.test.ts`                      | 5  | `CREATE VIRTUAL TABLE USING fts5(tokenize="unicode61 remove_diacritics 1")` via the adapter — diacritic strip, BM25 rank, phrase query, case-insensitivity, delete+re-insert (task 3.10). |
| `blobs.test.ts`                     | 8  | Uint8Array ↔ Buffer round-trip, NULL BLOB, 1 MB payload, transaction commit+rollback with blobs (task 3.11). |
| `provider.test.ts`                  | 36 | `NodeDBProvider`: identity DB at `identity.sqlite`, per-persona files at `vault/<persona>.sqlite`, path-safe persona validation, per-DB crash-safety pragmas, encrypted round-trip, wrong-DEK rejection (tasks 3.12 – 3.14). |
| `migration.test.ts`                 | 21 | `runMigrations`: schema_version table, ordered transactional apply, idempotent re-run, rollback on failure, shape validation, across-reopen persistence (task 3.15). |
| `perf_smoke.test.ts`                | 2  | 10K-item FTS5 benchmark — p95 budget 50 ms, gated via `PERF_SMOKE` / `PERF_P95_MS` envs (task 3.18). |
| `concurrent_access.test.ts`         | 8  | Multi-connection on one file: commit visibility, WAL snapshot isolation, SQLITE_BUSY on contended BEGIN IMMEDIATE, multi-reader (task 3.19). |

Run in-package via `npm test`. No native build toolchain required on
any of the 4 prebuilt target arches — `prebuild-install` fetches the
ABI-matching BSMC binary at install time.

## See also

- [docs/HOME_NODE_LITE_TASKS.md](../../docs/HOME_NODE_LITE_TASKS.md)
  Phase 3a — full task list.
- [packages/README.md](../README.md) — workspace-level layering rules.
- [packages/storage-expo/README.md](../storage-expo/README.md) — mobile
  counterpart (`op-sqlite` + go-sqlcipher-compatible cipher).
