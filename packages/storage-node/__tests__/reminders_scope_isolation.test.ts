/**
 * Guided-demo data-scope isolation — reminders repository against REAL SQLite.
 *
 * Covers the spec's "Reminder tests": demo reminders list only in demo scope,
 * the fire path (listPending) never surfaces user reminders while a demo is
 * active, and cleanup removes the demo reminder only. Real SQLite is required
 * because the in-memory mock adapter does not enforce the data_scope WHERE.
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
  type Reminder,
} from '@dina/core';
import { SQLiteReminderRepository } from '@dina/core/storage';

import { NodeSQLiteAdapter } from '../src/adapter';

const KEY = '0'.repeat(64);
const tmpDirs: string[] = [];
function openAdapter(): NodeSQLiteAdapter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-scope-'));
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

function rem(id: string, over: Partial<Reminder> = {}): Reminder {
  return {
    id,
    short_id: id.slice(0, 4),
    message: 'm',
    due_at: 1000,
    persona: 'general',
    kind: 'manual',
    source_item_id: '',
    source: '',
    recurring: '' as Reminder['recurring'],
    timezone: '',
    status: 'pending',
    completed: 0,
    created_at: 0,
    ...over,
  };
}

describe('reminders scope isolation (real SQLite)', () => {
  afterEach(() => resetDataScope());

  it('isolates create/get/listPending/listAll by scope; cleanup deletes demo only', async () => {
    const a = openAdapter();
    try {
      applyMigrations(a, IDENTITY_MIGRATIONS);
      const repo = new SQLiteReminderRepository(a);

      setCurrentDataScope('user');
      await repo.create(rem('r-user'));
      setCurrentDataScope('guided_demo:x');
      await repo.create(rem('r-demo'));

      // demo scope sees only the demo reminder (incl. the fire path).
      expect((await repo.listAll()).map((r) => r.id)).toEqual(['r-demo']);
      expect((await repo.listPending(99999)).map((r) => r.id)).toEqual(['r-demo']);
      expect(await repo.get('r-user')).toBeNull();

      // user scope sees only the user reminder.
      setCurrentDataScope('user');
      expect((await repo.listAll()).map((r) => r.id)).toEqual(['r-user']);
      expect((await repo.listPending(99999)).map((r) => r.id)).toEqual(['r-user']);
      expect(await repo.get('r-demo')).toBeNull();

      // cleanup removes the demo reminder only.
      expect(scopedTableDeleter(() => a, 'reminders')('guided_demo:x')).toBe(1);
      setCurrentDataScope('user');
      expect(await repo.get('r-user')).not.toBeNull();
      setCurrentDataScope('guided_demo:x');
      expect(await repo.get('r-demo')).toBeNull();
      expect(await repo.listPending(99999)).toEqual([]);
    } finally {
      a.close();
    }
  });

  it('exact-id remove/update cannot cross scopes', async () => {
    const a = openAdapter();
    try {
      applyMigrations(a, IDENTITY_MIGRATIONS);
      const repo = new SQLiteReminderRepository(a);
      setCurrentDataScope('user');
      await repo.create(rem('shared'));

      setCurrentDataScope('guided_demo:x');
      expect(await repo.remove('shared')).toBe(false); // different scope → no-op
      await repo.update('shared', { completed: 1 }); // also a no-op across scope

      setCurrentDataScope('user');
      const got = await repo.get('shared');
      expect(got).not.toBeNull();
      expect(got?.completed).toBe(0); // cross-scope update did not touch it
      expect(await repo.remove('shared')).toBe(true);
    } finally {
      a.close();
    }
  });
});
