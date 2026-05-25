/**
 * Durable D2D outbox repository (issues.txt §1).
 *
 * Runs the contract against BOTH the real `NodeSQLiteAdapter`
 * (better-sqlite3-multiple-ciphers — the production identity-DB engine)
 * and the `InMemoryD2DOutboxRepository`, asserting parity. The SQLite
 * path additionally proves durability: a row written, the adapter
 * closed, and a NEW adapter opened on the same file still sees the row
 * and can drain it — the restart guarantee the issue mandates.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { NodeSQLiteAdapter } from '@dina/storage-node';
import {
  InMemoryD2DOutboxRepository,
  SQLiteD2DOutboxRepository,
  type D2DOutboxInsert,
  type D2DOutboxRepository,
} from '../../src/transport/outbox_repository';

function sqliteHarness(): { repo: SQLiteD2DOutboxRepository; reopen: () => SQLiteD2DOutboxRepository; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-outbox-'));
  const dbPath = path.join(dir, 'identity.sqlite');
  const passphraseHex = randomBytes(32).toString('hex');
  let adapter = new NodeSQLiteAdapter({ path: dbPath, passphraseHex, journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return {
    repo: new SQLiteD2DOutboxRepository(adapter),
    reopen: () => {
      adapter.close();
      adapter = new NodeSQLiteAdapter({ path: dbPath, passphraseHex, journalMode: 'WAL', synchronous: 'NORMAL' });
      // Migrations are idempotent (CREATE … IF NOT EXISTS); re-running is a no-op.
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
      return new SQLiteD2DOutboxRepository(adapter);
    },
    cleanup: () => {
      try {
        adapter.close();
      } catch {
        /* idempotent */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function ins(over: Partial<D2DOutboxInsert> = {}): D2DOutboxInsert {
  return {
    id: over.id ?? `row-${randomBytes(4).toString('hex')}`,
    targetDID: over.targetDID ?? 'did:plc:bob',
    messageType: over.messageType ?? 'service.query',
    bodyJson: over.bodyJson ?? '{"query_id":"q1"}',
    idempotencyKey: over.idempotencyKey,
    nextAttemptAt: over.nextAttemptAt ?? 1_000,
    expiresAt: over.expiresAt,
    createdAt: over.createdAt ?? 1_000,
  };
}

// ── Contract run against both implementations ──────────────────────────

type Factory = { name: string; make: () => { repo: D2DOutboxRepository; cleanup: () => void } };

const factories: Factory[] = [
  {
    name: 'InMemoryD2DOutboxRepository',
    make: () => ({ repo: new InMemoryD2DOutboxRepository(), cleanup: () => {} }),
  },
  {
    name: 'SQLiteD2DOutboxRepository',
    make: () => {
      const h = sqliteHarness();
      return { repo: h.repo, cleanup: h.cleanup };
    },
  },
];

describe.each(factories)('D2D outbox contract — $name', ({ make }) => {
  let repo: D2DOutboxRepository;
  let cleanup: () => void;
  beforeEach(() => {
    ({ repo, cleanup } = make());
  });
  afterEach(() => cleanup());

  it('inserts and reads back a row', () => {
    const row = repo.insert(ins({ id: 'a', idempotencyKey: 'k1' }));
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(0);
    const got = repo.get('a');
    expect(got?.targetDID).toBe('did:plc:bob');
    expect(got?.bodyJson).toBe('{"query_id":"q1"}');
  });

  it('is idempotent on idempotency key — duplicate enqueue returns existing, no second row', () => {
    const first = repo.insert(ins({ id: 'a', idempotencyKey: 'dup' }));
    const second = repo.insert(ins({ id: 'b', idempotencyKey: 'dup' }));
    expect(second.id).toBe(first.id); // returns the existing row
    expect(repo.get('b')).toBeNull(); // second insert did NOT create a row
    expect(repo.listAll()).toHaveLength(1);
  });

  it('lets a key be reused once the prior row is terminal', () => {
    const a = repo.insert(ins({ id: 'a', idempotencyKey: 'reuse' }));
    repo.markSent(a.id, 2_000); // terminal — frees the key
    const b = repo.insert(ins({ id: 'b', idempotencyKey: 'reuse' }));
    expect(b.id).toBe('b');
    expect(repo.listAll()).toHaveLength(2);
  });

  it('claimDue flips due pending rows to sending with a lease, respecting the limit', () => {
    repo.insert(ins({ id: 'a', idempotencyKey: 'a', nextAttemptAt: 500 }));
    repo.insert(ins({ id: 'b', idempotencyKey: 'b', nextAttemptAt: 600 }));
    repo.insert(ins({ id: 'c', idempotencyKey: 'c', nextAttemptAt: 5_000 })); // not yet due
    const claimed = repo.claimDue(1_000, 60_000, 10);
    expect(claimed.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(claimed.every((r) => r.state === 'sending' && r.leaseUntil === 61_000)).toBe(true);
    // A second claim returns nothing — the rows are already leased (sending).
    expect(repo.claimDue(1_000, 60_000, 10)).toHaveLength(0);
  });

  it('claimDue skips expired rows', () => {
    repo.insert(ins({ id: 'a', idempotencyKey: 'a', nextAttemptAt: 500, expiresAt: 900 }));
    expect(repo.claimDue(1_000, 60_000, 10)).toHaveLength(0);
  });

  it('markSent / markFailed / markDead transition state', () => {
    repo.insert(ins({ id: 'a', idempotencyKey: 'a' }));
    repo.markFailed('a', 1, 2_000, 'boom', 1_500);
    let r = repo.get('a');
    expect(r?.state).toBe('failed');
    expect(r?.attempts).toBe(1);
    expect(r?.nextAttemptAt).toBe(2_000);
    expect(r?.lastError).toBe('boom');
    expect(r?.leaseUntil).toBeNull();

    repo.markDead('a', 'gone', 3_000);
    r = repo.get('a');
    expect(r?.state).toBe('dead');

    repo.insert(ins({ id: 'b', idempotencyKey: 'b' }));
    repo.markSent('b', 4_000);
    expect(repo.get('b')?.state).toBe('sent');
  });

  it('resetStaleSending reclaims only leased rows whose lease expired', () => {
    repo.insert(ins({ id: 'a', idempotencyKey: 'a' }));
    repo.claimDue(1_000, 60_000, 10); // a → sending, lease 61_000
    // Lease still valid at now=50_000 → not reclaimed.
    expect(repo.resetStaleSending(50_000)).toBe(0);
    expect(repo.get('a')?.state).toBe('sending');
    // Lease expired at now=62_000 → reclaimed to pending.
    expect(repo.resetStaleSending(62_000)).toBe(1);
    expect(repo.get('a')?.state).toBe('pending');
    expect(repo.get('a')?.leaseUntil).toBeNull();
  });

  it('deleteTerminalBefore drops only old sent/dead rows', () => {
    repo.insert(ins({ id: 'a', idempotencyKey: 'a' }));
    repo.markSent('a', 1_000);
    repo.insert(ins({ id: 'b', idempotencyKey: 'b' }));
    repo.markDead('b', 'x', 1_000);
    repo.insert(ins({ id: 'c', idempotencyKey: 'c' })); // still pending
    const deleted = repo.deleteTerminalBefore(2_000);
    expect(deleted).toBe(2);
    expect(repo.get('a')).toBeNull();
    expect(repo.get('b')).toBeNull();
    expect(repo.get('c')?.state).toBe('pending'); // pending never swept
  });

  it('remove deletes a row, returns false for unknown', () => {
    repo.insert(ins({ id: 'a', idempotencyKey: 'a' }));
    expect(repo.remove('a')).toBe(true);
    expect(repo.remove('a')).toBe(false);
  });
});

// ── SQLite-only: durability across restart ─────────────────────────────

describe('SQLiteD2DOutboxRepository — durability across restart', () => {
  it('a queued row survives adapter close + reopen and is then claimable', () => {
    const h = sqliteHarness();
    try {
      h.repo.insert(ins({ id: 'survivor', idempotencyKey: 'survivor', nextAttemptAt: 500 }));
      // Simulate app kill/restart: close the handle, reopen the same file.
      const reopened = h.reopen();
      const got = reopened.get('survivor');
      expect(got).not.toBeNull();
      expect(got?.state).toBe('pending');
      const claimed = reopened.claimDue(1_000, 60_000, 10);
      expect(claimed.map((r) => r.id)).toEqual(['survivor']);
    } finally {
      h.cleanup();
    }
  });

  it('dedups a same-key enqueue to one row (active-key pre-check)', () => {
    const h = sqliteHarness();
    try {
      h.repo.insert(ins({ id: 'a', idempotencyKey: 'k' }));
      // The second enqueue's active-key pre-check finds the live row and
      // returns it — no duplicate row. (The partial unique index
      // idx_d2d_outbox_idem_active is the SQL-layer backstop for a
      // concurrent race that the pre-check could miss; insert() catches
      // that violation and returns the winning row — defence-in-depth that
      // sync single-process SQLite can't actually trigger in a unit test.)
      const dup = h.repo.insert(ins({ id: 'b', idempotencyKey: 'k' }));
      expect(dup.id).toBe('a');
      expect(h.repo.listAll()).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });
});
