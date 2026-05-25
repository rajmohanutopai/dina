/**
 * Real export/import (issues.txt §3).
 *
 * Seeds identity + two persona SQLCipher DBs with real rows, exports an
 * archive, then imports into a SEPARATE clean set of DBs and verifies the
 * rows came back — the clean-install restore the spec mandates. Also
 * covers: secret exclusion, wrong passphrase, corrupt bytes, unsupported
 * version, the clean-install guard, and the "data + no data source →
 * throws" production guarantee.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS, PERSONA_MIGRATIONS } from '../../src/storage/schemas';
import type { DatabaseAdapter } from '../../src/storage/db_adapter';
import {
  createArchive,
  importArchive,
  setArchiveDataSource,
  type ArchiveDataSource,
  type ArchivePersonaSource,
} from '../../src/export/archive';

const PASS = 'correct horse battery staple';
const WRONG = 'incorrect zebra';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dina-archive-'));
}
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
const PASSHEX = randomBytes(32).toString('hex');

function seedIdentity(a: DatabaseAdapter): void {
  a.execute('INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)', ['theme', 'dark', 1]);
  // A secret — must NOT appear in the archive.
  a.execute('INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)', ['gemini_api_key', 'SECRET-123', 1]);
  a.execute(
    `INSERT INTO reminders (id, short_id, message, due_at, persona, kind, source_item_id, source, recurring, timezone, status, completed, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['rem-1', 'r1', 'call mom', 9_999, 'general', 'manual', '', 'user', '', '', 'pending', 0, 1],
  );
}
function seedVaultItem(a: DatabaseAdapter, id: string, text: string): void {
  a.execute(
    'INSERT INTO vault_items (id, content_l0, timestamp, created_at, updated_at) VALUES (?,?,?,?,?)',
    [id, text, 1, 1, 1],
  );
}

interface Bundle {
  id: NodeSQLiteAdapter;
  personas: Map<string, { tier: string; adapter: NodeSQLiteAdapter }>;
  dir: string;
}
function freshBundle(personas: Array<[string, string]>): Bundle {
  const dir = tmpDir();
  const id = openId(path.join(dir, 'identity.sqlite'));
  const map = new Map<string, { tier: string; adapter: NodeSQLiteAdapter }>();
  for (const [name, tier] of personas) {
    map.set(name, { tier, adapter: openPersona(path.join(dir, `${name}.sqlite`)) });
  }
  return { id, personas: map, dir };
}
function closeBundle(b: Bundle): void {
  try {
    b.id.close();
  } catch {
    /* */
  }
  for (const { adapter } of b.personas.values()) {
    try {
      adapter.close();
    } catch {
      /* */
    }
  }
  fs.rmSync(b.dir, { recursive: true, force: true });
}

function dataSourceFor(b: Bundle): ArchiveDataSource {
  return {
    identityAdapter: () => b.id,
    personaSources: async (): Promise<ArchivePersonaSource[]> =>
      [...b.personas.entries()].map(([name, { tier, adapter }]) => ({ name, tier, adapter })),
    openPersonaForRestore: async (name, tier) => {
      const existing = b.personas.get(name);
      if (existing) return existing.adapter;
      const adapter = openPersona(path.join(b.dir, `${name}.sqlite`));
      b.personas.set(name, { tier, adapter });
      return adapter;
    },
    hasExistingUserData: async () =>
      b.id.query('SELECT 1 FROM reminders LIMIT 1').length > 0 ||
      b.id.query("SELECT 1 FROM kv_store WHERE key NOT LIKE '%api_key%' LIMIT 1").length > 0,
  };
}

afterEach(() => setArchiveDataSource(null));

describe('real export → clean-install import', () => {
  it('restores identity + multi-persona rows, excluding secrets', async () => {
    const src = freshBundle([
      ['general', 'default'],
      ['health', 'sensitive'],
    ]);
    let archive: Uint8Array;
    try {
      seedIdentity(src.id);
      seedVaultItem(src.personas.get('general')!.adapter, 'v-gen', 'general note');
      seedVaultItem(src.personas.get('health')!.adapter, 'v-health', 'bp 120/80');
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    // Import into a clean install (fresh empty DBs, personas created on demand).
    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS);

      // Identity restored — non-secret kv + reminder.
      expect(dest.id.query("SELECT value FROM kv_store WHERE key = 'theme'")[0]?.value).toBe('dark');
      expect(dest.id.query('SELECT message FROM reminders WHERE id = ?', ['rem-1'])[0]?.message).toBe('call mom');
      // Secret EXCLUDED — never entered the archive.
      expect(dest.id.query("SELECT 1 FROM kv_store WHERE key = 'gemini_api_key'")).toHaveLength(0);
      // Both personas restored (created on demand during import).
      expect(dest.personas.get('general')!.adapter.query('SELECT content_l0 FROM vault_items WHERE id = ?', ['v-gen'])[0]?.content_l0).toBe('general note');
      expect(dest.personas.get('health')!.adapter.query('SELECT content_l0 FROM vault_items WHERE id = ?', ['v-health'])[0]?.content_l0).toBe('bp 120/80');
    } finally {
      closeBundle(dest);
    }
  });

  it('refuses to import onto a non-clean target without force', async () => {
    const src = freshBundle([['general', 'default']]);
    let archive: Uint8Array;
    try {
      seedIdentity(src.id);
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }
    const dest = freshBundle([['general', 'default']]);
    try {
      seedIdentity(dest.id); // dest already has user data
      setArchiveDataSource(dataSourceFor(dest));
      await expect(importArchive(archive, PASS)).rejects.toThrow(/not a clean install/);
      // force overrides.
      await expect(importArchive(archive, PASS, { force: true })).resolves.toBeUndefined();
    } finally {
      closeBundle(dest);
    }
  });

  it('a data-bearing archive with NO data source throws (never silently succeeds)', async () => {
    const src = freshBundle([['general', 'default']]);
    let archive: Uint8Array;
    try {
      seedIdentity(src.id);
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }
    setArchiveDataSource(null);
    await expect(importArchive(archive, PASS)).rejects.toThrow(/no ArchiveDataSource/);
  });

  it('wrong passphrase, corrupt bytes, and unsupported version all fail', async () => {
    const src = freshBundle([['general', 'default']]);
    let archive: Uint8Array;
    try {
      seedIdentity(src.id);
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }
    await expect(importArchive(archive, WRONG)).rejects.toThrow();
    await expect(importArchive(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), PASS)).rejects.toThrow();
    const badVersion = archive.slice();
    badVersion[4] = 0x63; // version 99
    await expect(importArchive(badVersion, PASS)).rejects.toThrow(/unsupported version/);
  });
});
