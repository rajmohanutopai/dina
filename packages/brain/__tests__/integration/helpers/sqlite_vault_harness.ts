/**
 * Jest test harness: a real SQLite-backed vault repository, bound to
 * a persona via the same `setVaultRepository` registry the production
 * mobile boot uses.
 *
 * Why this exists
 * ---------------
 * The `InMemoryVaultRepository` in `packages/core/src/vault/repository.ts`
 * is a convenient fake but **not behaviourally equivalent** to the
 * SQLite backend: its `queryFTSSync` does a loose substring/OR scan
 * while SQLite FTS5 is strict AND by default. That gap let /ask bugs
 * slip past Jest and reproduce only on the iOS simulator (see
 * `mobile_remember_ask_e2e.test.ts` docstring — FTS5 AND-semantics
 * incident).
 *
 * `withSQLiteVault(persona, fn)` stands up a fresh SQLCipher-encrypted
 * `NodeSQLiteAdapter` (via `@dina/storage-node`, which wraps
 * `better-sqlite3-multiple-ciphers`), applies the production
 * `PERSONA_MIGRATIONS` DDL, registers a `SQLiteVaultRepository` for
 * the persona, runs the caller's test body, and tears everything
 * down. Tests that exercise the real search predicate should use this
 * helper instead of letting `crud.ts` auto-provision the in-memory
 * stub.
 *
 * Not for production code — this module lives under `__tests__/`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { NodeSQLiteAdapter } from '@dina/storage-node';
import { applyMigrations, PERSONA_MIGRATIONS } from '@dina/core';
import {
  SQLiteVaultRepository,
  setVaultRepository,
} from '@dina/core/src/vault/repository';

export interface SQLiteVaultHandle {
  adapter: NodeSQLiteAdapter;
  repo: SQLiteVaultRepository;
  persona: string;
  dbPath: string;
}

/**
 * Open a fresh SQLCipher DB, migrate to the latest persona schema,
 * and register a SQLite-backed vault repository under `persona`.
 * Returns a handle the caller is responsible for closing + cleaning up.
 *
 * Prefer `withSQLiteVault(persona, fn)` — the scoped form auto-cleans
 * on both pass + fail paths.
 */
export function openSQLiteVault(persona: string): SQLiteVaultHandle {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-sqlite-vault-'));
  const dbPath = path.join(dir, `${persona}.sqlite`);
  // 32-byte random passphrase for SQLCipher — distinct per test so a
  // leaked file from a prior run can't be inadvertently unlocked.
  const passphraseHex = randomBytes(32).toString('hex');
  const adapter = new NodeSQLiteAdapter({
    path: dbPath,
    passphraseHex,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, PERSONA_MIGRATIONS);
  const repo = new SQLiteVaultRepository(adapter);
  setVaultRepository(persona, repo);
  return { adapter, repo, persona, dbPath };
}

/** Close + delete the temp DB. Safe to call multiple times. */
export function closeSQLiteVault(handle: SQLiteVaultHandle): void {
  try {
    handle.adapter.close();
  } catch {
    /* swallow — best-effort teardown */
  }
  setVaultRepository(handle.persona, null);
  const dir = path.dirname(handle.dbPath);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
}

/**
 * Scoped version — opens a SQLite vault, runs `fn`, tears it down
 * (even when the test throws). Use this in `it()` bodies:
 *
 *   await withSQLiteVault('general', async () => {
 *     storeItem('general', { ... });
 *     const hits = queryVault('general', { mode: 'fts5', text: 'emma' });
 *     expect(hits.length).toBeGreaterThan(0);
 *   });
 */
export async function withSQLiteVault<T>(
  persona: string,
  fn: (handle: SQLiteVaultHandle) => Promise<T> | T,
): Promise<T> {
  const handle = openSQLiteVault(persona);
  try {
    return await fn(handle);
  } finally {
    closeSQLiteVault(handle);
  }
}
