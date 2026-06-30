/**
 * Node runner for the shared storage conformance suite.
 *
 * Runs every `@dina/adapter-conformance` storage case against a fresh
 * better-sqlite3 (`NodeSQLiteAdapter`) instance. The SAME cases run on a
 * device against op-sqlite via the in-app conformance screen — so a green run
 * here plus a green run there proves the two adapters agree on the contract.
 *
 * Each case gets its own freshly-opened in-memory encrypted DB (cases create
 * their own tables and some close the connection, so isolation is required).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { STORAGE_CASES, assertExtends, type ConformanceDatabaseAdapter } from '@dina/adapter-conformance';
import type { DatabaseAdapter } from '@dina/core';

import { NodeSQLiteAdapter } from '../src/adapter';

// Drift-guard: the kit defines its `ConformanceDatabaseAdapter` shape locally
// (to stay zero-dep / RN-pure). This binds it to the REAL `@dina/core`
// contract — if `DatabaseAdapter` ever stops satisfying the conformance shape
// (e.g. `run()` becomes async), this line fails to compile.
assertExtends<DatabaseAdapter, ConformanceDatabaseAdapter>();

// 64 hex chars = a 32-byte SQLCipher DEK. SQLCipher rejects `PRAGMA key` on
// `:memory:` DBs, so every case opens a fresh FILE-backed encrypted DB (this
// also exercises the real cipher path). Cross-impl file decryption (node-write
// → op-sqlite-read) is a separate device-side test.
const TEST_DEK_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00';

const tmpDirs: string[] = [];

function makeAdapter(): DatabaseAdapter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-storage-conformance-'));
  tmpDirs.push(dir);
  return new NodeSQLiteAdapter({
    path: path.join(dir, 'conformance.sqlite'),
    passphraseHex: TEST_DEK_HEX,
  });
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('storage adapter conformance — NodeSQLiteAdapter (better-sqlite3)', () => {
  it('exposes a non-empty case suite', () => {
    expect(STORAGE_CASES.length).toBeGreaterThan(0);
  });

  for (const testCase of STORAGE_CASES) {
    it(testCase.name, async () => {
      const adapter = makeAdapter();
      try {
        await testCase.run(adapter);
      } finally {
        try {
          adapter.close();
        } catch {
          // A case may legitimately have closed it already (idempotent).
        }
      }
    });
  }
});
