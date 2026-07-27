import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  SQLiteAuditRepository,
  setAuditRepository,
  type AuditRepository,
} from '../../src/audit/repository';
import {
  appendAudit,
  appendSampledAudit,
  auditCount,
  hydrateAuditState,
  queryAudit,
  resetAuditState,
  sweepRetention,
  verifyAuditChain,
} from '../../src/audit/service';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const PASSHEX = randomBytes(32).toString('hex');

function openIdentity(): {
  adapter: NodeSQLiteAdapter;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-audit-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return {
    adapter,
    cleanup: () => {
      try {
        adapter.close();
      } catch {
        /* a failure-path test may close it first */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('audit durability', () => {
  afterEach(() => {
    setAuditRepository(null);
    resetAuditState();
  });

  it('hydrates a prior chain and continues its sequence after restart', () => {
    const { adapter, cleanup } = openIdentity();
    try {
      const repository = new SQLiteAuditRepository(adapter);
      setAuditRepository(repository);
      hydrateAuditState(repository);
      expect(appendAudit('did:key:agent', 'first', 'tool')?.seq).toBe(1);

      resetAuditState();
      hydrateAuditState(repository);
      expect(auditCount()).toBe(1);
      expect(appendAudit('did:key:agent', 'second', 'tool')?.seq).toBe(2);
      expect(queryAudit().map((entry) => entry.action)).toEqual(['second', 'first']);
      expect(verifyAuditChain()).toEqual({ valid: true });
    } finally {
      cleanup();
    }
  });

  it('does not publish or advance an entry when SQLite rejects the append', () => {
    const { adapter, cleanup } = openIdentity();
    try {
      const repository = new SQLiteAuditRepository(adapter);
      setAuditRepository(repository);
      hydrateAuditState(repository);
      adapter.close();

      expect(appendAudit('did:key:agent', 'blocked', 'tool')).toBeNull();
      expect(auditCount()).toBe(0);
      expect(queryAudit()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('does not consume a sampling window when the durable append fails', () => {
    let attempts = 0;
    const entries: ReturnType<AuditRepository['allEntries']> = [];
    const repository: AuditRepository = {
      append(entry) {
        attempts += 1;
        if (attempts === 1) throw new Error('disk full');
        entries.push(entry);
      },
      latest: () => entries.at(-1) ?? null,
      query: () => [...entries],
      compact: () => 0,
      count: () => entries.length,
      allEntries: () => [...entries],
      highestSequence: () => entries.at(-1)?.seq ?? 0,
      retentionCheckpoint: () => null,
    };
    setAuditRepository(repository);
    hydrateAuditState(repository);

    const options = { key: 'safe-read', intervalMs: 60_000, nowMs: 1_000 };
    expect(appendSampledAudit('did:key:agent', 'safe', 'Read', '{}', options)).toBeNull();
    expect(appendSampledAudit('did:key:agent', 'safe', 'Read', '{}', options)).not.toBeNull();
    expect(attempts).toBe(2);
    expect(auditCount()).toBe(1);
  });

  it('persists a retention checkpoint and continues the chain after restart', () => {
    const { adapter, cleanup } = openIdentity();
    try {
      const repository = new SQLiteAuditRepository(adapter);
      setAuditRepository(repository);
      hydrateAuditState(repository);
      appendAudit('did:key:agent', 'old', 'tool', '', 1_600_000_000);

      expect(sweepRetention(Date.now())).toBe(1);
      expect(auditCount()).toBe(0);

      resetAuditState();
      hydrateAuditState(repository);
      const next = appendAudit('did:key:agent', 'new', 'tool');
      expect(next?.seq).toBe(2);
      expect(next?.prev_hash).not.toBe('genesis');

      resetAuditState();
      hydrateAuditState(repository);
      expect(verifyAuditChain()).toEqual({ valid: true });
    } finally {
      cleanup();
    }
  });

  it('compacts a sequence prefix without deleting later clock-rollback entries', () => {
    const { adapter, cleanup } = openIdentity();
    try {
      const repository = new SQLiteAuditRepository(adapter);
      setAuditRepository(repository);
      hydrateAuditState(repository);
      appendAudit('did:key:agent', 'old-prefix', 'tool', '', 1_600_000_000);
      appendAudit('did:key:agent', 'recent', 'tool');
      appendAudit('did:key:agent', 'clock-rollback', 'tool', '', 1_600_000_001);

      expect(sweepRetention(Date.now())).toBe(1);
      expect(queryAudit().map((entry) => entry.action)).toEqual(['clock-rollback', 'recent']);

      resetAuditState();
      hydrateAuditState(repository);
      expect(queryAudit().map((entry) => entry.action)).toEqual(['clock-rollback', 'recent']);
      expect(verifyAuditChain()).toEqual({ valid: true });
    } finally {
      cleanup();
    }
  });

  it('rejects silent prefix deletion without a retention checkpoint', () => {
    const { adapter, cleanup } = openIdentity();
    try {
      const repository = new SQLiteAuditRepository(adapter);
      setAuditRepository(repository);
      hydrateAuditState(repository);
      appendAudit('did:key:agent', 'first', 'tool');
      appendAudit('did:key:agent', 'second', 'tool');
      adapter.execute('DELETE FROM audit_log WHERE seq = 1');

      resetAuditState();
      expect(() => hydrateAuditState(repository)).toThrow('durable hash chain verification failed');
    } finally {
      cleanup();
    }
  });

  it('rejects silent suffix deletion even when the remaining hash links verify', () => {
    const { adapter, cleanup } = openIdentity();
    try {
      const repository = new SQLiteAuditRepository(adapter);
      setAuditRepository(repository);
      hydrateAuditState(repository);
      appendAudit('did:key:agent', 'first', 'tool');
      appendAudit('did:key:agent', 'second', 'tool');
      adapter.execute('DELETE FROM audit_log WHERE seq = 2');

      resetAuditState();
      expect(() => hydrateAuditState(repository)).toThrow('durable hash chain verification failed');
    } finally {
      cleanup();
    }
  });
});
