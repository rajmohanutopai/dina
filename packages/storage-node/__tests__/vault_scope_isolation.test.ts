/**
 * Guided-demo data-scope isolation — vault repository against REAL SQLite.
 *
 * The spec's "Scope Leak Tests" + "Vault tests" on the app path
 * (SQLiteVaultRepository over NodeSQLiteAdapter / SQLCipher), so FTS5 MATCH,
 * the subject-link join, and DELETE-by-scope are exercised for real.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PERSONA_MIGRATIONS,
  applyMigrations,
  SQLiteVaultRepository,
  setCurrentDataScope,
  resetDataScope,
  scopedTableDeleter,
} from '@dina/core';
import { makeVaultItem } from '@dina/test-harness';

import { NodeSQLiteAdapter } from '../src/adapter';

const KEY = '0'.repeat(64);
const tmpDirs: string[] = [];
function openAdapter(): NodeSQLiteAdapter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-scope-'));
  tmpDirs.push(dir);
  return new NodeSQLiteAdapter({ path: path.join(dir, 'persona.sqlite'), passphraseHex: KEY });
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
});

describe('vault scope isolation (real SQLite)', () => {
  afterEach(() => resetDataScope());

  it('isolates items + subjects + FTS by scope, and cleanup deletes only the demo scope', () => {
    const a = openAdapter();
    try {
      applyMigrations(a, PERSONA_MIGRATIONS);
      const repo = new SQLiteVaultRepository(a);

      // 1. user row + a 'dinosaurs' memory linked to Emma.
      setCurrentDataScope('user');
      repo.storeItemSync(
        makeVaultItem({ id: 'u1', summary: 'dinosaurs', body: 'user dinos', retrieval_policy: 'normal' }),
      );
      repo.linkSubjectSync('u1', 'emma');

      // 2. demo row with the same logical content, in demo scope.
      setCurrentDataScope('guided_demo:x');
      repo.storeItemSync(
        makeVaultItem({ id: 'd1', summary: 'dinosaurs', body: 'demo dinos', retrieval_policy: 'normal' }),
      );
      repo.linkSubjectSync('d1', 'emma');

      // 3. demo scope sees ONLY the demo row (list, FTS, getItem, subjects).
      expect(repo.queryAllSync(10).map((i) => i.id)).toEqual(['d1']);
      expect(repo.queryFTSSync('dinosaurs', 10).map((i) => i.id)).toEqual(['d1']);
      expect(repo.getItemSync('u1')).toBeNull();
      expect(repo.getItemIdsForPersonSync('emma')).toEqual(['d1']);

      // 4. user scope sees ONLY the user row.
      setCurrentDataScope('user');
      expect(repo.queryAllSync(10).map((i) => i.id)).toEqual(['u1']);
      expect(repo.queryFTSSync('dinosaurs', 10).map((i) => i.id)).toEqual(['u1']);
      expect(repo.getItemSync('d1')).toBeNull();
      expect(repo.getItemIdsForPersonSync('emma')).toEqual(['u1']);

      // 5. cleanup deletes the demo scope only.
      const delSubjects = scopedTableDeleter(() => a, 'vault_item_subjects');
      const delItems = scopedTableDeleter(() => a, 'vault_items');
      expect(delSubjects('guided_demo:x')).toBe(1);
      expect(delItems('guided_demo:x')).toBe(1);

      // 6. user rows survive; demo rows are gone in their own scope.
      setCurrentDataScope('user');
      expect(repo.getItemSync('u1')?.id).toBe('u1');
      expect(repo.getItemIdsForPersonSync('emma')).toEqual(['u1']);
      setCurrentDataScope('guided_demo:x');
      expect(repo.getItemSync('d1')).toBeNull();
      expect(repo.getItemIdsForPersonSync('emma')).toEqual([]);
    } finally {
      a.close();
    }
  });

  it('exact-id soft delete cannot cross scopes', () => {
    const a = openAdapter();
    try {
      applyMigrations(a, PERSONA_MIGRATIONS);
      const repo = new SQLiteVaultRepository(a);
      setCurrentDataScope('user');
      repo.storeItemSync(makeVaultItem({ id: 'shared', retrieval_policy: 'normal' }));

      // In demo scope, deleting the user's id must be a no-op (different scope).
      setCurrentDataScope('guided_demo:x');
      expect(repo.deleteItemSync('shared')).toBe(false);

      setCurrentDataScope('user');
      expect(repo.getItemSync('shared')?.id).toBe('shared'); // untouched
      expect(repo.deleteItemSync('shared')).toBe(true); // own scope can delete
    } finally {
      a.close();
    }
  });
});
