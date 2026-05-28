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

import {
  createArchive,
  importArchive,
  setArchiveDataSource,
  type ArchiveDataSource,
  type ArchivePersonaSource,
} from '../../src/export/archive';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS, PERSONA_MIGRATIONS } from '../../src/storage/schemas';

import type { DatabaseAdapter } from '../../src/storage/db_adapter';

const PASS = 'correct horse battery staple';
const WRONG = 'incorrect zebra';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dina-archive-'));
}
function openId(p: string): NodeSQLiteAdapter {
  const a = new NodeSQLiteAdapter({
    path: p,
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(a, IDENTITY_MIGRATIONS);
  return a;
}
function openPersona(p: string): NodeSQLiteAdapter {
  const a = new NodeSQLiteAdapter({
    path: p,
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(a, PERSONA_MIGRATIONS);
  return a;
}
const PASSHEX = randomBytes(32).toString('hex');

function seedIdentity(a: DatabaseAdapter): void {
  a.execute('INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)', ['theme', 'dark', 1]);
  // A secret — must NOT appear in the archive.
  a.execute('INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)', [
    'gemini_api_key',
    'SECRET-123',
    1,
  ]);
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
function freshBundle(personas: [string, string][]): Bundle {
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
      expect(dest.id.query("SELECT value FROM kv_store WHERE key = 'theme'")[0]?.value).toBe(
        'dark',
      );
      expect(
        dest.id.query('SELECT message FROM reminders WHERE id = ?', ['rem-1'])[0]?.message,
      ).toBe('call mom');
      // Secret EXCLUDED — never entered the archive.
      expect(dest.id.query("SELECT 1 FROM kv_store WHERE key = 'gemini_api_key'")).toHaveLength(0);
      // Both personas restored (created on demand during import).
      expect(
        dest.personas
          .get('general')!
          .adapter.query('SELECT content_l0 FROM vault_items WHERE id = ?', ['v-gen'])[0]
          ?.content_l0,
      ).toBe('general note');
      expect(
        dest.personas
          .get('health')!
          .adapter.query('SELECT content_l0 FROM vault_items WHERE id = ?', ['v-health'])[0]
          ?.content_l0,
      ).toBe('bp 120/80');
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

  // SEC — a crafted archive can carry a path-traversing persona name in its
  // (attacker-influenced) manifest. Import must reject it BEFORE the name
  // becomes a `${name}.sqlite` filename, so nothing is written outside the
  // vault dir. The AES-GCM tag + checksums don't help here (the attacker chose
  // the passphrase and computed the checksums).
  it('refuses to restore a persona whose manifest name path-traverses', async () => {
    // Export side: a real persona file on disk, but the manifest REPORTS a
    // traversal name — createArchive copies persona.name verbatim into the payload.
    const src = freshBundle([['health', 'sensitive']]);
    let archive: Uint8Array;
    try {
      const health = src.personas.get('health');
      if (!health) throw new Error('test setup: missing health persona');
      seedVaultItem(health.adapter, 'v1', 'secret note');
      setArchiveDataSource({
        identityAdapter: () => src.id,
        personaSources: async () => [
          { name: '../../evil', tier: 'sensitive', adapter: health.adapter },
        ],
        openPersonaForRestore: async () => {
          throw new Error('export path does not restore');
        },
        hasExistingUserData: async () => false,
      });
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    // Import side: the guard must reject the traversal name BEFORE any file open.
    const dest = freshBundle([]);
    const openedNames: string[] = [];
    try {
      setArchiveDataSource({
        identityAdapter: () => dest.id,
        personaSources: async () => [],
        openPersonaForRestore: async (name, tier) => {
          openedNames.push(name);
          const a = openPersona(path.join(dest.dir, `${name}.sqlite`));
          dest.personas.set(name, { tier, adapter: a });
          return a;
        },
        hasExistingUserData: async () => false,
      });
      await expect(importArchive(archive, PASS)).rejects.toThrow(/refusing to restore persona/);
      // Never reached the file-open — no traversal write happened.
      expect(openedNames).toHaveLength(0);
    } finally {
      closeBundle(dest);
    }
  });

  // SEC (P2.8) — import must DELIVER each persona's archived tier to
  // openPersonaForRestore so the app can re-register it at the right tier (a
  // restored sensitive/locked persona must not silently become open). Locks
  // the core-side enabling contract; the mobile data source consumes it.
  it('delivers each persona archived tier to openPersonaForRestore', async () => {
    const src = freshBundle([['health', 'sensitive']]);
    let archive: Uint8Array;
    try {
      const health = src.personas.get('health');
      if (!health) throw new Error('test setup: missing health persona');
      seedIdentity(src.id);
      seedVaultItem(health.adapter, 'v1', 'bp 120/80');
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    const dest = freshBundle([]);
    const captured: { name: string; tier: string }[] = [];
    try {
      const base = dataSourceFor(dest);
      setArchiveDataSource({
        ...base,
        openPersonaForRestore: async (name, tier) => {
          captured.push({ name, tier });
          return base.openPersonaForRestore(name, tier);
        },
      });
      await importArchive(archive, PASS);
      expect(captured).toContainEqual({ name: 'health', tier: 'sensitive' });
    } finally {
      closeBundle(dest);
    }
  });

  // SEC (P1.1) — a FORCE (overwrite) restore must be a TRUE overwrite: rows on
  // the target that aren't in the backup are removed (INSERT OR REPLACE alone
  // only overwrites matching PKs). kv_store is the exception — it holds secrets
  // excluded from the archive, so they must SURVIVE.
  it('force restore removes target-only rows but preserves excluded kv secrets', async () => {
    const src = freshBundle([['general', 'default']]);
    let archive: Uint8Array;
    try {
      seedIdentity(src.id); // backup has reminder rem-1 + theme=dark (gemini_api_key excluded)
      const gen = src.personas.get('general');
      if (!gen) throw new Error('setup');
      seedVaultItem(gen.adapter, 'v-keep', 'from backup');
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    const dest = freshBundle([['general', 'default']]);
    try {
      // Target has its OWN data: a reminder NOT in the backup, a vault item NOT
      // in the backup, a secret kv key (excluded from backups), and theme=light.
      dest.id.execute(
        `INSERT INTO reminders (id, short_id, message, due_at, persona, kind, source_item_id, source, recurring, timezone, status, completed, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['rem-OLD', 'rO', 'stale', 1, 'general', 'manual', '', 'user', '', '', 'pending', 0, 1],
      );
      dest.id.execute('INSERT INTO kv_store (key, value, updated_at) VALUES (?,?,?)', [
        'gemini_api_key',
        'DEST-SECRET',
        1,
      ]);
      dest.id.execute('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?,?,?)', [
        'theme',
        'light',
        1,
      ]);
      const destGen = dest.personas.get('general');
      if (!destGen) throw new Error('setup');
      seedVaultItem(destGen.adapter, 'v-OLD', 'stale vault');

      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS, { force: true });

      // Backup rows present; target-only rows GONE (true overwrite).
      expect(dest.id.query('SELECT 1 FROM reminders WHERE id = ?', ['rem-1'])).toHaveLength(1);
      expect(dest.id.query('SELECT 1 FROM reminders WHERE id = ?', ['rem-OLD'])).toHaveLength(0);
      expect(
        destGen.adapter.query('SELECT 1 FROM vault_items WHERE id = ?', ['v-keep']),
      ).toHaveLength(1);
      expect(
        destGen.adapter.query('SELECT 1 FROM vault_items WHERE id = ?', ['v-OLD']),
      ).toHaveLength(0);
      // Backup pref overwrote the target's; the target's SECRET (never in the
      // backup) SURVIVES — kv_store is not cleared.
      expect(dest.id.query("SELECT value FROM kv_store WHERE key = 'theme'")[0]?.value).toBe(
        'dark',
      );
      expect(
        dest.id.query("SELECT value FROM kv_store WHERE key = 'gemini_api_key'")[0]?.value,
      ).toBe('DEST-SECRET');
    } finally {
      closeBundle(dest);
    }
  });
});
