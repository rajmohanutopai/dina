/**
 * Guided-demo data-scope isolation — chat messages against REAL SQLite.
 *
 * Spec's "Chat" surface: demo messages list only in demo scope, listThreadIds
 * is scoped, reset() clears only the active scope, and cleanup removes the demo
 * messages only.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  IDENTITY_MIGRATIONS,
  applyMigrations,
  SQLiteChatMessageRepository,
  setCurrentDataScope,
  resetDataScope,
  scopedTableDeleter,
} from '@dina/core';

import { NodeSQLiteAdapter } from '../src/adapter';

const KEY = '0'.repeat(64);
const tmpDirs: string[] = [];
function openAdapter(): NodeSQLiteAdapter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-scope-'));
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

function msg(id: string, threadId: string, content: string) {
  return { id, threadId, type: 'user', content, metadata: {}, sources: [], timestamp: 1 };
}

describe('chat scope isolation (real SQLite)', () => {
  afterEach(() => resetDataScope());

  it('isolates messages, listThreadIds, reset; cleanup deletes demo only', async () => {
    const a = openAdapter();
    try {
      applyMigrations(a, IDENTITY_MIGRATIONS);
      const repo = new SQLiteChatMessageRepository(a);

      setCurrentDataScope('user');
      await repo.append(msg('u1', 'main', 'user msg'));
      setCurrentDataScope('guided_demo:x');
      await repo.append(msg('d1', 'main', 'demo msg'));

      // each scope sees only its own thread content
      expect((await repo.listByThread('main')).map((m) => m.id)).toEqual(['d1']);
      expect(await repo.listThreadIds()).toEqual(['main']);
      setCurrentDataScope('user');
      expect((await repo.listByThread('main')).map((m) => m.id)).toEqual(['u1']);

      // reset() is scope-bound — clears user only, demo survives
      await repo.reset();
      expect(await repo.listByThread('main')).toEqual([]);
      setCurrentDataScope('guided_demo:x');
      expect((await repo.listByThread('main')).map((m) => m.id)).toEqual(['d1']);

      // re-seed user, then cleanup the demo scope
      setCurrentDataScope('user');
      await repo.append(msg('u2', 'main', 'user again'));
      expect(scopedTableDeleter(() => a, 'chat_messages')('guided_demo:x')).toBe(1);
      expect((await repo.listByThread('main')).map((m) => m.id)).toEqual(['u2']);
      setCurrentDataScope('guided_demo:x');
      expect(await repo.listByThread('main')).toEqual([]);
    } finally {
      a.close();
    }
  });
});
