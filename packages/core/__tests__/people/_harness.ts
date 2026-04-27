/**
 * Real-SQLite identity-DB harness for the people-graph repository tests.
 *
 * The InMemoryDatabaseAdapter is a coarse stub — it doesn't filter
 * WHERE, doesn't honour JOIN, doesn't track row updates by primary
 * key. The people repository depends on all of that for correctness
 * (e.g. `applyExtraction` matches confirmed role_phrase surfaces via
 * a JOIN). So these tests run against `NodeSQLiteAdapter` from
 * `@dina/storage-node`, which is the same `better-sqlite3-multiple-
 * ciphers` engine the production identity DB uses on Node.
 *
 * Each test gets a fresh SQLCipher database in a temp dir; the
 * handle's `cleanup()` closes the adapter and deletes the file.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyMigrations, IDENTITY_MIGRATIONS } from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { SQLitePeopleRepository } from '../../src/people/repository';

export interface PeopleHarness {
  adapter: NodeSQLiteAdapter;
  repo: SQLitePeopleRepository;
  cleanup: () => void;
}

/** Open a fresh identity DB and return a wired-up `SQLitePeopleRepository`. */
export function openPeopleHarness(opts?: { nowFn?: () => number }): PeopleHarness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-people-'));
  const dbPath = path.join(dir, 'identity.sqlite');
  const passphraseHex = randomBytes(32).toString('hex');
  const adapter = new NodeSQLiteAdapter({
    path: dbPath,
    passphraseHex,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  const repo = new SQLitePeopleRepository(adapter, opts?.nowFn);
  return {
    adapter,
    repo,
    cleanup: () => {
      try {
        adapter.close();
      } catch {
        /* idempotent */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}
