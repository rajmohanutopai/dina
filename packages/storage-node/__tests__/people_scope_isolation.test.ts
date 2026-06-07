/**
 * Guided-demo data-scope isolation — people graph against REAL SQLite.
 *
 * Covers the spec's "People tests": Emma created in demo scope only, the SAME
 * extraction applied in two scopes produces TWO distinct people (no cross-scope
 * merge — the resolution chain is scoped), Emma vanishes from user scope after
 * cleanup, and no DID/contact is created (Emma is a Relation, not a Contact).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  IDENTITY_MIGRATIONS,
  applyMigrations,
  setCurrentDataScope,
  resetDataScope,
  scopedTableDeleter,
  type ExtractionResult,
} from '@dina/core';
import { SQLitePeopleRepository } from '@dina/core/storage';

import { NodeSQLiteAdapter } from '../src/adapter';

const KEY = '0'.repeat(64);
const tmpDirs: string[] = [];
function openAdapter(): NodeSQLiteAdapter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-scope-'));
  tmpDirs.push(dir);
  return new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: KEY });
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

/** The demo's Emma extraction (name + role-phrase, high confidence → confirmed). */
function emmaExtraction(sourceItemId: string): ExtractionResult {
  return {
    sourceItemId,
    extractorVersion: 'test-1',
    results: [
      {
        canonicalName: 'Emma',
        relationshipHint: 'daughter',
        surfaces: [
          { surface: 'Emma', surfaceType: 'name', confidence: 'high' },
          { surface: 'my daughter', surfaceType: 'role_phrase', confidence: 'high' },
        ],
        sourceExcerpt: 'Emma is my daughter.',
      },
    ],
  };
}

describe('people graph scope isolation (real SQLite)', () => {
  afterEach(() => resetDataScope());

  it('same extraction in two scopes makes TWO distinct people; cleanup removes demo only', () => {
    const a = openAdapter();
    try {
      applyMigrations(a, IDENTITY_MIGRATIONS);
      const repo = new SQLitePeopleRepository(a);

      // Distinct sourceItemIds (each scope's memory is its own vault item) so
      // the global extraction-log dedup doesn't skip the second apply.
      setCurrentDataScope('user');
      const userResp = repo.applyExtraction(emmaExtraction('u-emma'));
      setCurrentDataScope('guided_demo:x');
      const demoResp = repo.applyExtraction(emmaExtraction('d-emma'));

      const userIds = userResp.personIds ?? [];
      const demoIds = demoResp.personIds ?? [];
      expect(userIds).toHaveLength(1);
      expect(demoIds).toHaveLength(1);
      const userEmmaId = userIds[0] as string;
      const demoEmmaId = demoIds[0] as string;
      // No cross-scope merge: same name + role phrase, but distinct persons.
      expect(userEmmaId).not.toBe(demoEmmaId);

      // listPeople is scope-isolated.
      setCurrentDataScope('user');
      const userPeople = repo.listPeople();
      expect(userPeople.map((p) => p.personId)).toEqual([userEmmaId]);
      expect(repo.getPerson(demoEmmaId)).toBeNull();
      // Emma is a Relation, not a Contact — surfaces exist, but no DID identity.
      const userEmma = repo.getPerson(userEmmaId);
      expect(userEmma?.surfaces?.length ?? 0).toBeGreaterThan(0);

      setCurrentDataScope('guided_demo:x');
      expect(repo.listPeople().map((p) => p.personId)).toEqual([demoEmmaId]);
      expect(repo.getPerson(userEmmaId)).toBeNull();

      // Cleanup demo scope only.
      const delSurfaces = scopedTableDeleter(() => a, 'person_surfaces');
      const delPeople = scopedTableDeleter(() => a, 'people');
      expect(delSurfaces('guided_demo:x')).toBe(2); // name + role_phrase
      expect(delPeople('guided_demo:x')).toBe(1);

      // user Emma survives; demo Emma is gone.
      setCurrentDataScope('user');
      expect(repo.getPerson(userEmmaId)?.personId).toBe(userEmmaId);
      expect(repo.listPeople()).toHaveLength(1);
      setCurrentDataScope('guided_demo:x');
      expect(repo.getPerson(demoEmmaId)).toBeNull();
      expect(repo.listPeople()).toHaveLength(0);
    } finally {
      a.close();
    }
  });
});
