/**
 * Mobile backup-restore service (issues.txt §3) — the injectable file IO
 * + the preview/restore wrappers the Admin screen drives. Builds a real
 * encrypted archive (via Core's data-source export) and round-trips it
 * back through the mobile wrapper into a fresh DB set.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applyMigrations,
  IDENTITY_MIGRATIONS,
  PERSONA_MIGRATIONS,
  createArchive,
  setArchiveDataSource,
  type ArchivePersonaSource,
  type DatabaseAdapter,
} from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  configureRestore,
  resetRestore,
  isRestoreConfigured,
  pickBackupBytes,
  previewBackup,
  restoreBackup,
} from '../../src/services/restore_import';

const PASS = 'a-strong-backup-pass';
const PASSHEX = randomBytes(32).toString('hex');

function openId(p: string): NodeSQLiteAdapter {
  const a = new NodeSQLiteAdapter({ path: p, passphraseHex: PASSHEX, journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(a, IDENTITY_MIGRATIONS);
  return a;
}
function openPersona(p: string): NodeSQLiteAdapter {
  const a = new NodeSQLiteAdapter({ path: p, passphraseHex: PASSHEX, journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(a, PERSONA_MIGRATIONS);
  return a;
}
function sourceOver(id: DatabaseAdapter, personas: Map<string, { tier: string; adapter: DatabaseAdapter }>, dir: string) {
  return {
    identityAdapter: () => id,
    personaSources: async (): Promise<ArchivePersonaSource[]> =>
      [...personas.entries()].map(([name, { tier, adapter }]) => ({ name, tier, adapter })),
    openPersonaForRestore: async (name: string, tier: string) => {
      const existing = personas.get(name);
      if (existing) return existing.adapter;
      const adapter = openPersona(path.join(dir, `${name}.sqlite`));
      personas.set(name, { tier, adapter });
      return adapter;
    },
    hasExistingUserData: async () => id.query('SELECT 1 FROM reminders LIMIT 1').length > 0,
  };
}

afterEach(() => {
  resetRestore();
  setArchiveDataSource(null);
});

describe('restore IO wiring', () => {
  it('isRestoreConfigured + pickBackupBytes reflect the injected picker', async () => {
    expect(isRestoreConfigured()).toBe(false);
    await expect(pickBackupBytes()).rejects.toThrow(/not configured/);

    const bytes = new Uint8Array([1, 2, 3]);
    configureRestore({
      pickFile: async () => ({ uri: 'file:///x.dina', name: 'x.dina' }),
      readFile: async () => bytes,
    });
    expect(isRestoreConfigured()).toBe(true);
    expect(await pickBackupBytes()).toEqual({ name: 'x.dina', bytes });
  });

  it('returns null when the user cancels the picker', async () => {
    configureRestore({
      pickFile: async () => null,
      readFile: async () => new Uint8Array(),
    });
    expect(await pickBackupBytes()).toBeNull();
  });
});

describe('preview + restore round-trip', () => {
  it('previews a real backup, rejects the wrong passphrase, and restores into a fresh device', async () => {
    // ── Build a real archive with one persona + a reminder ──
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-rsrc-'));
    const srcId = openId(path.join(srcDir, 'identity.sqlite'));
    srcId.execute(
      `INSERT INTO reminders (id, short_id, message, due_at, persona, kind, source_item_id, source, recurring, timezone, status, completed, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['rem-1', 'r1', 'water the plants', 9_999, 'general', 'manual', '', 'user', '', '', 'pending', 0, 1],
    );
    const srcPersonas = new Map<string, { tier: string; adapter: DatabaseAdapter }>();
    const gen = openPersona(path.join(srcDir, 'general.sqlite'));
    gen.execute('INSERT INTO vault_items (id, content_l0, timestamp, created_at, updated_at) VALUES (?,?,?,?,?)', ['v1', 'note', 1, 1, 1]);
    srcPersonas.set('general', { tier: 'default', adapter: gen });

    setArchiveDataSource(sourceOver(srcId, srcPersonas, srcDir));
    const archive = await createArchive(PASS);
    srcId.close();
    gen.close();
    fs.rmSync(srcDir, { recursive: true, force: true });

    // ── Preview: right passphrase reveals the persona; wrong one throws ──
    const preview = await previewBackup(archive, PASS);
    expect(preview.totalPersonas).toBe(1);
    expect(preview.personas[0].name).toBe('general');
    await expect(previewBackup(archive, 'wrong-pass')).rejects.toThrow();

    // ── Restore into a fresh (clean) device ──
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-rdst-'));
    const destId = openId(path.join(destDir, 'identity.sqlite'));
    const destPersonas = new Map<string, { tier: string; adapter: DatabaseAdapter }>();
    setArchiveDataSource(sourceOver(destId, destPersonas, destDir));
    try {
      await restoreBackup(archive, PASS);
      expect(destId.query('SELECT message FROM reminders WHERE id = ?', ['rem-1'])[0]?.message).toBe('water the plants');
      expect(destPersonas.get('general')!.adapter.query('SELECT content_l0 FROM vault_items WHERE id = ?', ['v1'])[0]?.content_l0).toBe('note');
    } finally {
      destId.close();
      for (const { adapter } of destPersonas.values()) (adapter as NodeSQLiteAdapter).close();
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });
});
