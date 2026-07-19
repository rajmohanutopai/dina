/**
 * D2D outbox drainer (issues.txt §1) — claim due → re-deliver → mark
 * outcome, exponential-backoff retry, dead-letter + audit, boot recovery
 * of crashed-mid-send rows, and a SQL-backed restart drain.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { queryAudit, resetAuditState } from '../../src/audit/service';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import {
  claimDue,
  clearOutbox,
  enqueueD2D,
  getOutboxRow,
  MAX_ATTEMPTS,
} from '../../src/transport/outbox';
import {
  setD2DOutboxRepository,
  SQLiteD2DOutboxRepository,
} from '../../src/transport/outbox_repository';
import {
  drainOutbox,
  recoverOutboxOnBoot,
  resetRetryState,
  setOutboxRedeliverFn,
  type OutboxRedeliverFn,
} from '../../src/transport/retry';

beforeEach(() => {
  setD2DOutboxRepository(null);
  clearOutbox();
  resetRetryState();
  resetAuditState();
});

const enqueue = (queryId: string, now = 1_000) =>
  enqueueD2D({
    targetDID: 'did:plc:bob',
    messageType: 'service.query',
    bodyJson: `{"query_id":"${queryId}"}`,
    now,
  });

describe('drainOutbox', () => {
  it('is a no-op when no re-delivery function is wired', async () => {
    enqueue('q1');
    const r = await drainOutbox(2_000);
    expect(r).toEqual({ attempted: 0, delivered: 0, failed: 0, dead: 0 });
  });

  it('delivers a due message and marks it sent', async () => {
    const row = enqueue('q1');
    const deliver: OutboxRedeliverFn = async () => ({ delivered: true });
    setOutboxRedeliverFn(deliver);
    const r = await drainOutbox(2_000);
    expect(r.delivered).toBe(1);
    expect(getOutboxRow(row.id)?.state).toBe('sent');
  });

  it('records a backoff failure when re-delivery fails', async () => {
    const row = enqueue('q1');
    setOutboxRedeliverFn(async () => ({ delivered: false, error: 'still offline' }));
    const r = await drainOutbox(2_000);
    expect(r.failed).toBe(1);
    const after = getOutboxRow(row.id);
    expect(after?.state).toBe('failed');
    expect(after?.attempts).toBe(1);
    expect(after?.lastError).toBe('still offline');
    // Backed off into the future → not immediately re-claimable.
    expect(after!.nextAttemptAt).toBeGreaterThan(2_000);
  });

  it('treats a throwing re-delivery as a failure (error isolation)', async () => {
    const a = enqueue('qa');
    const b = enqueue('qb');
    let calls = 0;
    setOutboxRedeliverFn(async (rowArg) => {
      calls++;
      if (rowArg.id === a.id) throw new Error('kaboom');
      return { delivered: true };
    });
    const r = await drainOutbox(2_000);
    expect(calls).toBe(2); // both attempted despite the throw
    expect(r.failed).toBe(1);
    expect(r.delivered).toBe(1);
    expect(getOutboxRow(a.id)?.state).toBe('failed');
    expect(getOutboxRow(b.id)?.state).toBe('sent');
  });

  it('dead-letters after MAX_ATTEMPTS and writes an audit entry', async () => {
    const row = enqueue('q1');
    setOutboxRedeliverFn(async () => ({ delivered: false, error: 'permafail' }), 'did:plc:self');
    let now = 2_000;
    // Each drain claims the row once it's due; advance the clock past the
    // backoff so the next drain re-claims it.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await drainOutbox(now);
      now += 10 * 60 * 1000; // 10 min — beyond the largest backoff
    }
    expect(getOutboxRow(row.id)?.state).toBe('dead');
    const dead = queryAudit({ action: 'd2d_outbox_dead' });
    expect(dead.length).toBe(1);
    expect(dead[0].actor).toBe('did:plc:self');
    // The audit detail names the type + id but never the message body.
    expect(dead[0].detail).not.toContain('query_id');
  });
});

describe('recoverOutboxOnBoot', () => {
  it('reclaims sending rows whose lease expired, leaving fresh leases alone', () => {
    enqueue('stale');
    enqueue('fresh');
    // Simulate a crash mid-send: claiming leaves both rows 'sending' with a
    // lease but no terminal mark (the process died before the result).
    claimDue(1_000, 60_000, 10); // both → sending, lease 61_000
    // At now=30_000 the leases are still valid → nothing reclaimed.
    expect(recoverOutboxOnBoot(30_000)).toBe(0);
    // At now=62_000 both leases expired → both reclaimed to pending.
    expect(recoverOutboxOnBoot(62_000)).toBe(2);
  });
});

describe('SQL-backed restart drain', () => {
  it('enqueues durably, survives a simulated restart, then drains and delivers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-retry-'));
    const dbPath = path.join(dir, 'identity.sqlite');
    const passphraseHex = randomBytes(32).toString('hex');
    const open = () => {
      const a = new NodeSQLiteAdapter({ path: dbPath, passphraseHex, journalMode: 'WAL', synchronous: 'NORMAL' });
      applyMigrations(a, IDENTITY_MIGRATIONS);
      return a;
    };
    try {
      // ── Session 1: install SQL repo, enqueue a message, "crash" ──
      const a1 = open();
      setD2DOutboxRepository(new SQLiteD2DOutboxRepository(a1));
      const row = enqueueD2D({
        targetDID: 'did:plc:bob',
        messageType: 'service.query',
        bodyJson: '{"query_id":"durable"}',
        now: 1_000,
      });
      expect(row.state).toBe('pending');
      a1.close();
      // Reset module-level memory (the in-memory fallback + redeliver fn) to
      // prove nothing relevant survives in process state.
      setD2DOutboxRepository(null);
      resetRetryState();
      clearOutbox();

      // ── Session 2: reopen the SAME db, drain delivers the queued row ──
      const a2 = open();
      setD2DOutboxRepository(new SQLiteD2DOutboxRepository(a2));
      recoverOutboxOnBoot(2_000); // no-op here (row was never leased)
      const seen: string[] = [];
      setOutboxRedeliverFn(async (r) => {
        seen.push(r.bodyJson);
        return { delivered: true };
      });
      const result = await drainOutbox(2_000);
      expect(result.delivered).toBe(1);
      expect(seen).toEqual(['{"query_id":"durable"}']); // semantic body recovered from SQL
      expect(getOutboxRow(row.id)?.state).toBe('sent');
      a2.close();
    } finally {
      setD2DOutboxRepository(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
