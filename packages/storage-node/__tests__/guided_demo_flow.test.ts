/**
 * Guided-demo end-to-end flow against REAL SQLite (design doc § "Integration
 * Tests" + "Leak test"). Wires the actual reminders / people / vault repos over
 * NodeSQLiteAdapter, registers the cleanups, and drives the orchestrator
 * through: seed user data → start demo → demo data isolated from user → end
 * demo → demo data gone, user data intact.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  IDENTITY_MIGRATIONS,
  PERSONA_MIGRATIONS,
  applyMigrations,
  SQLiteVaultRepository,
  startGuidedDemo,
  endGuidedDemo,
  clearActiveDemo,
  currentDataScope,
  setCurrentDataScope,
  resetDataScope,
  setGuidedDemoIdFactory,
  resetGuidedDemoIdFactory,
  wireIdentityScopeCleanups,
  wirePersonaScopeCleanups,
  clearScopedCleanups,
  type ExtractionResult,
  type Reminder,
} from '@dina/core';
import { SQLiteReminderRepository, SQLitePeopleRepository } from '@dina/core/storage';
import { makeVaultItem } from '@dina/test-harness';

import { NodeSQLiteAdapter } from '../src/adapter';

const KEY = '0'.repeat(64);
const tmpDirs: string[] = [];
function openAdapter(file: string, migrations: Parameters<typeof applyMigrations>[1]): NodeSQLiteAdapter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-flow-'));
  tmpDirs.push(dir);
  const a = new NodeSQLiteAdapter({ path: path.join(dir, file), passphraseHex: KEY });
  applyMigrations(a, migrations);
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
function emma(sourceItemId: string): ExtractionResult {
  return {
    sourceItemId,
    extractorVersion: 't',
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

describe('guided demo end-to-end flow (real SQLite)', () => {
  it('isolates demo from user, cleans up on finish, leaves user data intact', async () => {
    const identity = openAdapter('identity.sqlite', IDENTITY_MIGRATIONS);
    const persona = openAdapter('general.sqlite', PERSONA_MIGRATIONS);
    const reminders = new SQLiteReminderRepository(identity);
    const people = new SQLitePeopleRepository(identity);
    const vault = new SQLiteVaultRepository(persona);

    clearScopedCleanups();
    wireIdentityScopeCleanups(() => identity);
    wirePersonaScopeCleanups(() => [persona]);
    setGuidedDemoIdFactory(() => 'run1');
    await clearActiveDemo();
    resetDataScope();

    try {
      // ── 1. Real user data (default 'user' scope). ──
      await reminders.create(rem('r-user'));
      const userEmma = people.applyExtraction(emma('u-emma')).personIds?.[0] as string;
      vault.storeItemSync(makeVaultItem({ id: 'v-user', retrieval_policy: 'normal' }));

      // ── 2. Start the guided demo. ──
      const scope = await startGuidedDemo(1000);
      expect(scope).toBe('guided_demo:run1');
      expect(currentDataScope()).toBe('guided_demo:run1');

      // ── 3. The user's real data is INVISIBLE inside the demo scope. ──
      expect(await reminders.listAll()).toEqual([]);
      expect(people.listPeople()).toEqual([]);
      expect(vault.queryAllSync(10)).toEqual([]);

      // ── 4. Create demo data (same logical content as the user's). ──
      await reminders.create(rem('r-demo'));
      const demoEmma = people.applyExtraction(emma('d-emma')).personIds?.[0] as string;
      vault.storeItemSync(makeVaultItem({ id: 'v-demo', retrieval_policy: 'normal' }));
      expect(demoEmma).not.toBe(userEmma); // distinct people across scopes
      expect((await reminders.listAll()).map((r) => r.id)).toEqual(['r-demo']);
      expect(people.listPeople().map((p) => p.personId)).toEqual([demoEmma]);
      expect(vault.queryAllSync(10).map((i) => i.id)).toEqual(['v-demo']);

      // ── 5. Finish the demo → teardown + back to user. ──
      await endGuidedDemo();
      expect(currentDataScope()).toBe('user');

      // ── 6. User data intact; demo data gone. ──
      expect((await reminders.listAll()).map((r) => r.id)).toEqual(['r-user']);
      expect(people.listPeople().map((p) => p.personId)).toEqual([userEmma]);
      expect(vault.queryAllSync(10).map((i) => i.id)).toEqual(['v-user']);

      // Demo scope is empty even if we look directly.
      setCurrentDataScope('guided_demo:run1');
      expect(await reminders.listAll()).toEqual([]);
      expect(people.listPeople()).toEqual([]);
      expect(vault.queryAllSync(10)).toEqual([]);
    } finally {
      clearScopedCleanups();
      resetGuidedDemoIdFactory();
      resetDataScope();
      identity.close();
      persona.close();
    }
  });
});
