/**
 * T1.30-1.32 — VaultDB abstraction: open, close, WAL pragmas.
 *
 * Tests the InMemoryVaultDB backend. Same tests will run against
 * NativeVaultDB (op-sqlite + SQLCipher) once native build is ready.
 *
 * Source: ARCHITECTURE.md Tasks 1.30, 1.31, 1.32
 */

import {
  InMemoryVaultDB,
  openVaultDB,
  closeVaultDB,
  getVaultDB,
  isVaultDBOpen,
  closeAllVaultDBs,
  resetVaultDBs,
} from '../../src/storage/vault_db';

const VALID_DEK = new Uint8Array(32).fill(0xab);
const WRONG_DEK = new Uint8Array(16); // wrong length

describe('InMemoryVaultDB (1.30-1.32)', () => {
  describe('open (1.30)', () => {
    it('opens with valid 32-byte DEK', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);

      expect(db.isOpen).toBe(true);
      expect(db.persona).toBe('general');
    });

    it('rejects wrong DEK length', () => {
      const db = new InMemoryVaultDB('general');
      expect(() => db.open('/vault/general.db', WRONG_DEK)).toThrow('32 bytes');
    });

    it('rejects empty DEK', () => {
      const db = new InMemoryVaultDB('general');
      expect(() => db.open('/vault/general.db', new Uint8Array(0))).toThrow('32 bytes');
    });

    it('rejects double open', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);
      expect(() => db.open('/vault/general.db', VALID_DEK)).toThrow('already open');
    });
  });

  describe('close (1.31)', () => {
    it('closes an open database', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);
      db.close();

      expect(db.isOpen).toBe(false);
    });

    it('close is idempotent', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);
      db.close();
      db.close(); // no error
      expect(db.isOpen).toBe(false);
    });

    it('queries throw after close', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);
      db.close();

      expect(() => db.exec('SELECT 1')).toThrow('not open');
      expect(() => db.query('SELECT 1')).toThrow('not open');
      expect(() => db.run('INSERT INTO x VALUES(1)')).toThrow('not open');
    });

    it('WAL is disabled after close', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);
      expect(db.walEnabled).toBe(true);

      db.close();
      expect(db.walEnabled).toBe(false);
    });
  });

  describe('WAL + synchronous pragmas (1.32)', () => {
    it('sets journal_mode=WAL on open', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);

      expect(db.walEnabled).toBe(true);
      expect(db.getPragma('journal_mode')).toBe('wal');
    });

    it('sets synchronous=NORMAL on open', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);

      expect(db.getPragma('synchronous')).toBe('normal');
    });

    it('sets foreign_keys=ON on open', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);

      expect(db.getPragma('foreign_keys')).toBe('on');
    });

    it('sets busy_timeout=5000 on open', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);

      expect(db.getPragma('busy_timeout')).toBe('5000');
    });

    it('PRAGMA can be updated', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);
      db.exec('PRAGMA busy_timeout = 10000');

      expect(db.getPragma('busy_timeout')).toBe('10000');
    });
  });

  describe('SQL execution', () => {
    it('CREATE TABLE creates a table', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);
      db.exec('CREATE TABLE IF NOT EXISTS test (id TEXT PRIMARY KEY)');

      expect(db.hasTable('test')).toBe(true);
    });

    it('CREATE TABLE IF NOT EXISTS is idempotent', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);
      db.exec('CREATE TABLE IF NOT EXISTS test (id TEXT)');
      db.exec('CREATE TABLE IF NOT EXISTS test (id TEXT)');

      expect(db.hasTable('test')).toBe(true);
    });

    it('transaction runs statements', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);

      db.transaction(() => {
        db.exec('CREATE TABLE IF NOT EXISTS a (id TEXT)');
        db.exec('CREATE TABLE IF NOT EXISTS b (id TEXT)');
      });

      expect(db.hasTable('a')).toBe(true);
      expect(db.hasTable('b')).toBe(true);
    });
  });

  describe('schema application', () => {
    it('applies persona schema SQL', () => {
      const db = new InMemoryVaultDB('general');
      db.open('/vault/general.db', VALID_DEK);

      // Apply a subset of the real schema
      const schema = `
        CREATE TABLE IF NOT EXISTS vault_items (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
      `;

      for (const stmt of schema.split(';').filter((s) => s.trim())) {
        db.exec(stmt.trim());
      }

      expect(db.hasTable('vault_items')).toBe(true);
      expect(db.hasTable('schema_version')).toBe(true);
      expect(db.tableCount()).toBe(2);
    });
  });
});

describe('VaultDB Registry', () => {
  beforeEach(() => resetVaultDBs());

  it('opens and retrieves a vault', () => {
    const db = openVaultDB('general', '/vault/general.db', VALID_DEK);
    expect(db.isOpen).toBe(true);
    expect(getVaultDB('general')).toBe(db);
    expect(isVaultDBOpen('general')).toBe(true);
  });

  it('rejects duplicate open', () => {
    openVaultDB('general', '/vault/general.db', VALID_DEK);
    expect(() => openVaultDB('general', '/vault/general.db', VALID_DEK)).toThrow('already open');
  });

  it('closes and removes from registry', () => {
    openVaultDB('general', '/vault/general.db', VALID_DEK);
    closeVaultDB('general');

    expect(isVaultDBOpen('general')).toBe(false);
    expect(getVaultDB('general')).toBeNull();
  });

  it('closeAllVaultDBs closes everything', () => {
    openVaultDB('general', '/vault/general.db', VALID_DEK);
    openVaultDB('health', '/vault/health.db', VALID_DEK);

    closeAllVaultDBs();

    expect(isVaultDBOpen('general')).toBe(false);
    expect(isVaultDBOpen('health')).toBe(false);
  });
});
