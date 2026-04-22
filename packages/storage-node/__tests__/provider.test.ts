/**
 * NodeDBProvider tests — identity + per-persona DB lifecycle.
 *
 * Covers:
 *   - 3.12 per-persona file multiplexing + path-safety
 *   - 3.13 identity DB lives at `<vaultDir>/identity.sqlite`
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DBProvider } from '@dina/core';

import { NodeDBProvider, NodeDBProviderError } from '../src/provider';

const IDENTITY_KEY = '0'.repeat(64);
const PERSONA_KEY = 'a'.repeat(64);

const tmpDirs: string[] = [];
function newVaultDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-db-provider-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

function makeProvider(dir?: string): NodeDBProvider {
  return new NodeDBProvider({
    vaultDir: dir ?? newVaultDir(),
    identityDekHex: IDENTITY_KEY,
    resolvePersonaDekHex: async () => PERSONA_KEY,
  });
}

describe('NodeDBProvider — construction', () => {
  it.each([
    ['empty vaultDir', { vaultDir: '', identityDekHex: IDENTITY_KEY, resolvePersonaDekHex: async () => PERSONA_KEY }, /invalid_vault_dir/],
    ['non-hex identity key', { vaultDir: '/tmp/x', identityDekHex: 'nope', resolvePersonaDekHex: async () => PERSONA_KEY }, /invalid_identity_key/],
    ['short identity key', { vaultDir: '/tmp/x', identityDekHex: 'ab', resolvePersonaDekHex: async () => PERSONA_KEY }, /invalid_identity_key/],
  ] as const)('rejects %s', (_label, opts, re) => {
    expect(() => new NodeDBProvider(opts)).toThrow(re);
  });

  it('satisfies DBProvider at compile time', () => {
    const _p: DBProvider = makeProvider();
    expect(_p).toBeInstanceOf(NodeDBProvider);
  });
});

describe('NodeDBProvider — identity DB (task 3.13)', () => {
  it('openIdentityDB creates identity.sqlite at vaultDir root', async () => {
    const dir = newVaultDir();
    const p = makeProvider(dir);
    const db = await p.openIdentityDB();
    expect(db.isOpen).toBe(true);
    expect(fs.existsSync(path.join(dir, 'identity.sqlite'))).toBe(true);
    await p.closeAll();
  });

  it('openIdentityDB is idempotent — returns the same adapter', async () => {
    const p = makeProvider();
    const first = await p.openIdentityDB();
    const second = await p.openIdentityDB();
    expect(second).toBe(first);
    await p.closeAll();
  });

  it('getIdentityDB returns null before open, the adapter after open', async () => {
    const p = makeProvider();
    expect(await p.getIdentityDB()).toBeNull();
    const db = await p.openIdentityDB();
    expect(await p.getIdentityDB()).toBe(db);
    await p.closeAll();
    expect(await p.getIdentityDB()).toBeNull();
  });

  it('creates vaultDir if absent', async () => {
    const root = newVaultDir();
    const nested = path.join(root, 'does', 'not', 'exist', 'yet');
    const p = new NodeDBProvider({
      vaultDir: nested,
      identityDekHex: IDENTITY_KEY,
      resolvePersonaDekHex: async () => PERSONA_KEY,
    });
    await p.openIdentityDB();
    expect(fs.existsSync(path.join(nested, 'identity.sqlite'))).toBe(true);
    await p.closeAll();
  });
});

describe('NodeDBProvider — persona DB (task 3.12)', () => {
  it('openPersonaDB creates vault/<persona>.sqlite', async () => {
    const dir = newVaultDir();
    const p = makeProvider(dir);
    await p.openPersonaDB('personal');
    expect(fs.existsSync(path.join(dir, 'vault', 'personal.sqlite'))).toBe(true);
    await p.closeAll();
  });

  it('openPersonaDB is idempotent per-persona', async () => {
    const p = makeProvider();
    const first = await p.openPersonaDB('work');
    const second = await p.openPersonaDB('work');
    expect(second).toBe(first);
    await p.closeAll();
  });

  it('multiple personas open simultaneously, independently writable', async () => {
    const p = makeProvider();
    const work = await p.openPersonaDB('work');
    const personal = await p.openPersonaDB('personal');
    expect(work).not.toBe(personal);

    work.execute('CREATE TABLE t (v TEXT)');
    work.run('INSERT INTO t VALUES (?)', ['work-only']);

    // Personal persona is a different file — its schema + data are
    // independent.
    personal.execute('CREATE TABLE t (v TEXT)');
    personal.run('INSERT INTO t VALUES (?)', ['personal-only']);

    expect(work.query<{ v: string }>('SELECT v FROM t')).toEqual([{ v: 'work-only' }]);
    expect(personal.query<{ v: string }>('SELECT v FROM t')).toEqual([{ v: 'personal-only' }]);

    await p.closeAll();
  });

  it('closePersonaDB only affects the named persona', async () => {
    const p = makeProvider();
    await p.openPersonaDB('work');
    const personal = await p.openPersonaDB('personal');

    await p.closePersonaDB('work');

    expect(await p.getPersonaDB('work')).toBeNull();
    expect(await p.getPersonaDB('personal')).toBe(personal);

    await p.closeAll();
  });

  it('closePersonaDB on a never-opened persona is a no-op', async () => {
    const p = makeProvider();
    await expect(p.closePersonaDB('never')).resolves.toBeUndefined();
  });

  it('resolvePersonaDekHex is called with the exact persona name', async () => {
    const calls: string[] = [];
    const p = new NodeDBProvider({
      vaultDir: newVaultDir(),
      identityDekHex: IDENTITY_KEY,
      resolvePersonaDekHex: async (name) => {
        calls.push(name);
        return PERSONA_KEY;
      },
    });
    await p.openPersonaDB('work');
    await p.openPersonaDB('personal');
    await p.openPersonaDB('work'); // idempotent — DEK not re-resolved
    expect(calls).toEqual(['work', 'personal']);
    await p.closeAll();
  });

  it('rejects DEK resolver that returns garbage', async () => {
    const p = new NodeDBProvider({
      vaultDir: newVaultDir(),
      identityDekHex: IDENTITY_KEY,
      resolvePersonaDekHex: async () => 'not hex',
    });
    await expect(p.openPersonaDB('work')).rejects.toThrow(/invalid_identity_key/);
  });
});

describe('NodeDBProvider — persona name validation', () => {
  const dir = newVaultDir();
  const p = makeProvider(dir);

  afterAll(async () => { await p.closeAll(); });

  it.each([
    ['empty string', ''],
    ['path traversal via ..', '..'],
    ['path traversal embedded', 'foo/..'],
    ['forward slash', 'foo/bar'],
    ['backslash', 'foo\\bar'],
    ['null byte', 'foo\0bar'],
    ['upper-case', 'Work'],
    ['leading underscore', '_hidden'],
    ['leading dash', '-flag'],
    ['space', 'my persona'],
    ['unicode', 'café'],
    ['over 63 chars', 'a'.repeat(64)],
  ] as const)('rejects %s', async (_label, bad) => {
    await expect(p.openPersonaDB(bad as string)).rejects.toBeInstanceOf(NodeDBProviderError);
    await expect(p.openPersonaDB(bad as string)).rejects.toThrow(/invalid_persona/);
  });

  it.each([
    ['lowercase alnum', 'work'],
    ['with digits', 'persona1'],
    ['with dash', 'home-office'],
    ['with underscore', 'health_rx'],
    ['exactly 63 chars', `${'a'.repeat(63)}`],
  ] as const)('accepts %s', async (_label, good) => {
    const db = await p.openPersonaDB(good as string);
    expect(db.isOpen).toBe(true);
  });
});

describe('NodeDBProvider — crash-safety pragmas (task 3.14)', () => {
  it('identity DB uses journal_mode=delete + synchronous=FULL', async () => {
    const p = makeProvider();
    const db = await p.openIdentityDB();
    const jm = db.query<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(jm[0]!.journal_mode).toBe('delete');
    const sync = db.query<{ synchronous: number }>('PRAGMA synchronous');
    expect(sync[0]!.synchronous).toBe(2); // FULL
    await p.closeAll();
  });

  it('persona DB uses journal_mode=wal + synchronous=NORMAL', async () => {
    const p = makeProvider();
    const db = await p.openPersonaDB('personal');
    const jm = db.query<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(jm[0]!.journal_mode).toBe('wal');
    const sync = db.query<{ synchronous: number }>('PRAGMA synchronous');
    expect(sync[0]!.synchronous).toBe(1); // NORMAL
    await p.closeAll();
  });
});

describe('NodeDBProvider — closeAll', () => {
  it('closes identity + all personas + clears maps', async () => {
    const p = makeProvider();
    await p.openIdentityDB();
    await p.openPersonaDB('a');
    await p.openPersonaDB('b');
    await p.openPersonaDB('c');
    await p.closeAll();
    expect(await p.getIdentityDB()).toBeNull();
    expect(await p.getPersonaDB('a')).toBeNull();
    expect(await p.getPersonaDB('b')).toBeNull();
    expect(await p.getPersonaDB('c')).toBeNull();
  });

  it('closeAll without any open DBs is a no-op', async () => {
    const p = makeProvider();
    await expect(p.closeAll()).resolves.toBeUndefined();
  });
});

describe('NodeDBProvider — encrypted round-trip per persona', () => {
  it('reopening the provider reads back persona data with same DEK', async () => {
    const dir = newVaultDir();
    {
      const p = makeProvider(dir);
      const db = await p.openPersonaDB('personal');
      db.execute('CREATE TABLE t (v TEXT)');
      db.run('INSERT INTO t VALUES (?)', ['hello']);
      await p.closeAll();
    }
    {
      const p = makeProvider(dir);
      const db = await p.openPersonaDB('personal');
      expect(db.query<{ v: string }>('SELECT v FROM t')).toEqual([{ v: 'hello' }]);
      await p.closeAll();
    }
  });

  it('reopening with a WRONG DEK fails at openPersonaDB', async () => {
    const dir = newVaultDir();
    {
      const p = new NodeDBProvider({
        vaultDir: dir,
        identityDekHex: IDENTITY_KEY,
        resolvePersonaDekHex: async () => '1'.repeat(64),
      });
      const db = await p.openPersonaDB('personal');
      db.execute('CREATE TABLE t (v TEXT)');
      await p.closeAll();
    }
    {
      const p = new NodeDBProvider({
        vaultDir: dir,
        identityDekHex: IDENTITY_KEY,
        resolvePersonaDekHex: async () => '2'.repeat(64),
      });
      await expect(p.openPersonaDB('personal')).rejects.toThrow(/wrong_key/);
    }
  });
});
