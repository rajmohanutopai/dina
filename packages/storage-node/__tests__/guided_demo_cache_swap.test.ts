/**
 * Guided-demo in-memory cache swap against REAL SQLite.
 *
 * The repositories enforce `data_scope` at the SQL layer, but the app reads
 * Chat + Reminders from in-memory caches (the chat thread Map, the reminders
 * Map) that are NOT scope-partitioned and merge-only on hydrate. The mobile
 * `refreshCachesForCurrentScope()` clears + re-reads them on every scope
 * transition. This test drives that exact mechanism end-to-end and asserts the
 * functional invariants the caches would otherwise break:
 *   - on START → user Chat/Reminders are hidden inside the demo (invariant #2);
 *   - on TEARDOWN → demo Chat/Reminders are gone, user data restored (#1).
 *
 * Source: docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md § "Cleanup" + "Functional
 * Invariants" #1/#2.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  IDENTITY_MIGRATIONS,
  applyMigrations,
  startGuidedDemo,
  endGuidedDemo,
  clearActiveDemo,
  resetDataScope,
  setGuidedDemoIdFactory,
  resetGuidedDemoIdFactory,
  wireIdentityScopeCleanups,
  clearScopedCleanups,
  type Reminder,
  type StoredChatMessage,
} from '@dina/core';
import {
  SQLiteReminderRepository,
  setReminderRepository,
  SQLiteChatMessageRepository,
  setChatMessageRepository,
} from '@dina/core/storage';
import {
  hydrateRemindersFromRepo,
  resetReminderState,
  listPending,
} from '@dina/core/reminders';
import { hydrateThread, getThread, resetThreads } from '@dina/brain/chat';

import { NodeSQLiteAdapter } from '../src/adapter';

const KEY = '0'.repeat(64);
const tmpDirs: string[] = [];
function openIdentity(): NodeSQLiteAdapter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-swap-'));
  tmpDirs.push(dir);
  const a = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: KEY });
  applyMigrations(a, IDENTITY_MIGRATIONS);
  return a;
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

function rem(id: string): Reminder {
  return {
    id,
    short_id: id.slice(0, 4),
    message: `${id} msg`,
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
  };
}
function chat(id: string, content: string): StoredChatMessage {
  return { id, threadId: 'main', type: 'system', content, metadata: {}, sources: [], timestamp: 1 };
}

/** Mirror of mobile's `refreshCachesForCurrentScope` (sans persona HNSW). */
async function refreshCaches(): Promise<void> {
  resetReminderState();
  await hydrateRemindersFromRepo();
  await hydrateThread('main', { force: true });
}

describe('guided demo cache swap (real SQLite)', () => {
  it('hides user Chat/Reminders in the demo, restores them on teardown', async () => {
    const identity = openIdentity();
    const reminders = new SQLiteReminderRepository(identity);
    const chatRepo = new SQLiteChatMessageRepository(identity);
    setReminderRepository(reminders);
    setChatMessageRepository(chatRepo);

    clearScopedCleanups();
    wireIdentityScopeCleanups(() => identity);
    setGuidedDemoIdFactory(() => 'run1');
    await clearActiveDemo();
    resetDataScope();
    resetReminderState();
    resetThreads();

    try {
      // ── 1. User data in the default 'user' scope. ──
      await reminders.create(rem('r-user'));
      await chatRepo.append(chat('m-user', 'user note'));
      await refreshCaches();
      expect(listPending().map((r) => r.id)).toEqual(['r-user']);
      expect(getThread('main').map((m) => m.content)).toEqual(['user note']);

      // ── 2. START demo → swap caches → user data hidden. ──
      await startGuidedDemo(1000);
      await refreshCaches();
      expect(listPending()).toEqual([]);
      expect(getThread('main')).toEqual([]);

      // ── 3. Demo data lives only in the demo scope. ──
      await reminders.create(rem('r-demo'));
      await chatRepo.append(chat('m-demo', 'demo note'));
      await refreshCaches();
      expect(listPending().map((r) => r.id)).toEqual(['r-demo']);
      expect(getThread('main').map((m) => m.content)).toEqual(['demo note']);

      // ── 4. TEARDOWN → demo gone, user data restored. ──
      await endGuidedDemo();
      await refreshCaches();
      expect(listPending().map((r) => r.id)).toEqual(['r-user']);
      expect(getThread('main').map((m) => m.content)).toEqual(['user note']);
    } finally {
      setReminderRepository(null);
      setChatMessageRepository(null);
      clearScopedCleanups();
      resetGuidedDemoIdFactory();
      resetReminderState();
      resetThreads();
      resetDataScope();
      identity.close();
    }
  });
});
