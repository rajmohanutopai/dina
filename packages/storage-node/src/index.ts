/**
 * `@dina/storage-node` — SQLCipher-backed storage adapter for the
 * Node build target.
 *
 * Phase 3a task roadmap:
 *   - 3.6  ✅ Scaffold + port-conforming skeletons
 *   - 3.7  `open(path, passphrase)` — `PRAGMA key`, WAL, cipher_page_size
 *   - 3.8  CRUD surface on NodeSQLiteAdapter
 *   - 3.9  Transactions — callback + explicit
 *   - 3.10 FTS5 virtual table + tokenizer `unicode61 remove_diacritics 1`
 *   - 3.11 Blob handling — Uint8Array ↔ Buffer
 *   - 3.12 Per-persona file multiplexing via `openPersona`
 *   - 3.13 Identity DB at `identity.sqlite`
 *   - 3.14 Crash-safety config
 *   - 3.15 Migration runner
 *   - 3.16 Unit tests
 *   - 3.17 `@dina/core` suite green with this backend
 *   - 3.18 Perf smoke — 10K items, FTS5 p95 <50ms
 *   - 3.19 Concurrent-access smoke
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 3a.
 */

export { NodeSQLiteAdapter, NodeSQLiteAdapterError } from './adapter';
export type {
  JournalMode,
  NodeSQLiteAdapterOptions,
  Synchronous,
} from './adapter';

export { NodeDBProvider, NodeDBProviderError } from './provider';
export type { NodeDBProviderOptions } from './provider';

export { getSchemaVersion, MigrationError, runMigrations } from './migration';
export type { Migration } from './migration';
