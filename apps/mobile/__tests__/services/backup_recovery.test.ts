/**
 * docs/STATE_MACHINES.md BACKUP-1 (same as PH-03), PH-04, PH-09, PH-10,
 * BACKUP-2. Real recovery, real cloud_backup, real SQLite; a small fake answers
 * the store's routes.
 */

import { mkdirSync, rmSync } from 'node:fs';

import { generateMnemonic, openBackup, kvBackupStore } from '@dina/core';
import { listByPersona, resetReminderState } from '@dina/core/reminders';

import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import { isUnlocked, resetUnlockState } from '../../src/hooks/useUnlock';
import { recoverIdentity } from '../../src/onboarding/provision';
import {
  backupStatus,
  backUpIfDueNow,
  backUpNowFromSettings,
  deleteAllBackups,
  findBackupForPhrase,
  installBackupIdentity,
  restoreNewestBackupFromSettings,
  setBackupEnabled,
} from '../../src/services/cloud_backup';
import { signOutLocal } from '../../src/services/local_data_wipe';
import { getRuntimeWarnings, resetRuntimeWarningsForTest } from '../../src/services/runtime_warnings';
import { getIdentityAdapter, shutdownAllPersistence } from '../../src/storage/init';

const DIR = '/tmp/dina-test/';
const realFetch = globalThis.fetch;

let store: Map<number, Uint8Array>;
let offline: boolean;
let beforeGet: () => Promise<void>;
let beforeList: () => Promise<void>;
let failDelete: boolean;

function serve(): void {
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: Uint8Array }) => {
    if (offline) throw new Error('offline');
    const m = /\/v1\/backups\/([0-9a-f]+)(?:\/(.*))?$/.exec(new URL(String(url)).pathname);
    if (m === null) return { status: 404, text: async () => '' };
    const rest = m[2];
    const method = init?.method ?? 'GET';
    if (method === 'GET' && rest === 'list') {
      await beforeList();
      const copies = [...store.entries()].map(([counter, b]) => ({
        counter,
        size: b.length,
        stored_at: 1,
      }));
      return { status: 200, text: async () => JSON.stringify({ copies }) };
    }
    if (method === 'PUT') {
      store.set(Number(rest), new Uint8Array(init?.body as Uint8Array));
      return { status: 201, text: async () => '{}' };
    }
    if (method === 'GET') {
      await beforeGet();
      const key = rest === 'latest' ? Math.max(0, ...store.keys()) : Number(rest);
      const bytes = store.get(key);
      return {
        status: bytes === undefined ? 404 : 200,
        arrayBuffer: async () => (bytes ?? new Uint8Array()).slice().buffer,
        text: async () => '',
      };
    }
    if (method === 'DELETE') {
      if (failDelete) return { status: 500, text: async () => '{"error":"down"}' };
      store.clear();
      return { status: 200, text: async () => '{}' };
    }
    return { status: 405, text: async () => '' };
  }) as unknown as typeof fetch;
}

function words(m: string): string[] {
  return m.split(' ');
}

function addReminder(id: string): void {
  getIdentityAdapter()?.run(
    `INSERT INTO reminders (id, short_id, message, due_at, recurring, completed, created_at, source_item_id, source, persona, timezone, kind, status)
     VALUES (?, ?, ?, 4102444800000, '', 0, 1, '', '', 'general', '', 'manual', 'pending')`,
    [id, id.slice(-8), `note ${id}`],
  );
}

function reminderIds(): string[] {
  return (getIdentityAdapter()?.query(`SELECT id FROM reminders ORDER BY id`) ?? []).map((r) =>
    String(r.id),
  );
}

function recover(phrase: string, extra: Record<string, unknown> = {}) {
  return recoverIdentity({
    mnemonic: words(phrase),
    passphrase: 'PassA12345!',
    expectedDid: 'did:plc:aaaa',
    handle: 'a.test',
    ...extra,
  });
}

/** A new phone: empty files and keychain. The store stays. */
async function newPhone(): Promise<void> {
  installBackupIdentity(null);
  await shutdownAllPersistence().catch(() => undefined);
  resetUnlockState();
  resetKeychainMock();
  resetReminderState();
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
}

async function ownerWithCopy(phrase: string, ids: string[]): Promise<void> {
  await recover(phrase);
  for (const id of ids) addReminder(id);
  await backUpNowFromSettings();
}

beforeEach(async () => {
  store = new Map();
  offline = false;
  failDelete = false;
  beforeGet = async () => undefined;
  beforeList = async () => undefined;
  resetRuntimeWarningsForTest();
  serve();
  await newPhone();
});

afterAll(async () => {
  installBackupIdentity(null);
  await shutdownAllPersistence().catch(() => undefined);
  globalThis.fetch = realFetch;
});

describe('BACKUP-1 / PH-03: a recovery that restored nothing never becomes the newest copy', () => {
  it('network down at the find: no upload, a warning, and the screen can tell', async () => {
    const A = generateMnemonic();
    await ownerWithCopy(A, ['rem-1', 'rem-2']);
    await newPhone();
    offline = true;
    const r = await recover(A, { restoreBackup: true });
    expect(r.restoredItems).toBeUndefined();
    expect(getRuntimeWarnings().map((w) => w.code)).toContain('backup.restore_failed');
    offline = false;
    await backUpIfDueNow();
    expect([...store.keys()]).toEqual([1]);
    expect((await backupStatus()).heldForOwner).toBe(true);
  });

  it('restore switched off: no upload', async () => {
    const A = generateMnemonic();
    await ownerWithCopy(A, ['rem-1']);
    await newPhone();
    await recover(A);
    await backUpIfDueNow();
    expect([...store.keys()]).toEqual([1]);
  });

  it('a slow download: the daily run cannot land before the restore ends', async () => {
    const A = generateMnemonic();
    await ownerWithCopy(A, ['rem-1']);
    await newPhone();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    beforeGet = () => gate;
    const recovering = recover(A, { restoreBackup: true });
    await new Promise((res) => setTimeout(res, 50));
    // Nothing is unlocked yet, so nothing can run.
    expect(isUnlocked()).toBe(false);
    await backUpIfDueNow();
    expect([...store.keys()]).toEqual([1]);
    release();
    await recovering;
    await backUpIfDueNow();
    expect([...store.keys()]).toEqual([1, 2]);
    const hit = await findBackupForPhrase(words(A));
    if (hit === null) throw new Error('no copy');
    const tables = openBackup(hit.found.bytes, hit.identity).payload.identity.tables;
    expect((tables.reminders ?? []).length).toBe(1);
  });

  it('"Back up now" still writes: the owner chose to start fresh', async () => {
    const A = generateMnemonic();
    await ownerWithCopy(A, ['rem-1']);
    await newPhone();
    await recover(A);
    await backUpIfDueNow();
    await backUpNowFromSettings();
    expect([...store.keys()]).toEqual([1, 2]);
    expect((await backupStatus()).heldForOwner).toBe(false);
  });

  it('restore from the Backup screen ends the hold', async () => {
    const A = generateMnemonic();
    await ownerWithCopy(A, ['rem-1']);
    await newPhone();
    await recover(A);
    await backUpIfDueNow();
    await restoreNewestBackupFromSettings();
    expect(reminderIds()).toEqual(['rem-1']);
    expect((await backupStatus()).heldForOwner).toBe(false);
  });
});

describe('PH-04: a same-phrase re-onboard keeps newer local rows unless the owner agreed', () => {
  async function signedOutWithNewerRow(A: string): Promise<void> {
    await ownerWithCopy(A, ['rem-old']);
    addReminder('rem-new');
    await signOutLocal();
  }

  it('restore asked, not confirmed: local rows stay, and the owner is told', async () => {
    const A = generateMnemonic();
    await signedOutWithNewerRow(A);
    const r = await recover(A, { restoreBackup: true });
    expect(reminderIds()).toEqual(['rem-new', 'rem-old']);
    expect(r.restoredItems).toBeUndefined();
    expect(getRuntimeWarnings().map((w) => w.code)).toContain('backup.restore_failed');
  });

  it('confirmed: the copy replaces them', async () => {
    const A = generateMnemonic();
    await signedOutWithNewerRow(A);
    await recover(A, { restoreBackup: true, replaceLocalData: true });
    expect(reminderIds()).toEqual(['rem-old']);
  });
});

describe('PH-09: the app opens on restored data', () => {
  it('the reminders store holds what the database holds, when unlock completes', async () => {
    const A = generateMnemonic();
    await ownerWithCopy(A, ['rem-1']);
    await newPhone();
    const r = await recover(A, { restoreBackup: true });
    expect(isUnlocked()).toBe(true);
    expect(r.restoredItems).toBeDefined();
    expect(reminderIds()).toEqual(['rem-1']);
    expect(listByPersona('general').map((x) => x.id)).toEqual(['rem-1']);
  });
});

describe('PH-10: Delete all waits for a run in flight', () => {
  it('no copy survives, and backup stays off', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    await recover(generateMnemonic());
    beforeList = () => gate;
    const run = backUpIfDueNow();
    await new Promise((res) => setTimeout(res, 50));
    const del = deleteAllBackups();
    await new Promise((res) => setTimeout(res, 20));
    release();
    await Promise.all([run, del]);
    expect(store.size).toBe(0);
    expect((await backupStatus()).enabled).toBe(false);
  });

  it('a daily run queued behind the delete finds backup off', async () => {
    await recover(generateMnemonic());
    await deleteAllBackups();
    await backUpIfDueNow();
    expect(store.size).toBe(0);
  });

  it('a failed delete puts the switch back', async () => {
    await recover(generateMnemonic());
    await setBackupEnabled(true);
    failDelete = true;
    await expect(deleteAllBackups()).rejects.toThrow();
    expect((await backupStatus()).enabled).toBe(true);
  });
});

describe('BACKUP-2: delete all, turn on again', () => {
  it('writes a copy with the store empty and no store-behind warning', async () => {
    await ownerWithCopy(generateMnemonic(), ['rem-1']);
    await deleteAllBackups();
    expect(store.size).toBe(0);
    await setBackupEnabled(true);
    await backUpIfDueNow();
    expect(store.size).toBe(1);
    expect(await kvBackupStore.get('held_for_owner')).toBe('');
  });
});
