/**
 * D2D outbox facade (issues.txt §1) — backoff/idempotency/TTL policy
 * over the active repository. These exercise the in-memory fallback
 * (no SQL repo installed); real SQL + restart are covered in
 * `outbox_repository.test.ts` and `retry.test.ts`.
 */

import { InMemoryDatabaseAdapter } from '../../src/storage/db_adapter';
import {
  BASE_BACKOFF_MS,
  MAX_ATTEMPTS,
  clearOutbox,
  computeBackoff,
  deriveIdempotencyKey,
  enqueueD2D,
  getOutboxRow,
  isOutboxDurable,
  outboxCount,
  recordFailure,
} from '../../src/transport/outbox';
import {
  getD2DOutboxRepository,
  setD2DOutboxRepository,
  SQLiteD2DOutboxRepository,
} from '../../src/transport/outbox_repository';

beforeEach(() => {
  setD2DOutboxRepository(null);
  clearOutbox();
});

describe('computeBackoff', () => {
  it('is exponential from a 30 s base (1-based attempts)', () => {
    expect(computeBackoff(1)).toBe(BASE_BACKOFF_MS); // first failure → 30s
    expect(computeBackoff(2)).toBe(60_000);
    expect(computeBackoff(3)).toBe(120_000);
    expect(computeBackoff(4)).toBe(240_000);
    expect(computeBackoff(5)).toBe(480_000);
  });
});

describe('deriveIdempotencyKey', () => {
  it('keys service traffic on type:targetDID:query_id:bodyHash', () => {
    expect(
      deriveIdempotencyKey('service.query', 'did:plc:bus', '{"query_id":"q-42"}', 'msg-x'),
    ).toMatch(/^service\.query:did:plc:bus:q-42:[0-9a-f]{16}$/);
  });
  it('does NOT collapse the same query_id sent to DIFFERENT recipients (P1.4 fan-out)', () => {
    const body = '{"query_id":"q-42"}';
    const a = deriveIdempotencyKey('service.query', 'did:plc:busA', body, 'm1');
    const b = deriveIdempotencyKey('service.query', 'did:plc:busB', body, 'm2');
    expect(a).not.toBe(b);
  });
  it('does NOT collapse the same query_id with DIFFERENT bodies', () => {
    const a = deriveIdempotencyKey(
      'service.query',
      'did:plc:bus',
      '{"query_id":"q","cap":"eta"}',
      'm1',
    );
    const b = deriveIdempotencyKey(
      'service.query',
      'did:plc:bus',
      '{"query_id":"q","cap":"price"}',
      'm2',
    );
    expect(a).not.toBe(b);
  });
  it('DOES collapse an identical re-enqueue (same type+target+query+body)', () => {
    const body = '{"query_id":"q-42"}';
    expect(deriveIdempotencyKey('service.query', 'did:plc:bus', body, 'm1')).toBe(
      deriveIdempotencyKey('service.query', 'did:plc:bus', body, 'm2'),
    );
  });
  it('falls back to the message id for non-service / non-JSON bodies', () => {
    expect(deriveIdempotencyKey('social.update', 'did:plc:x', '{"text":"hi"}', 'msg-y')).toBe(
      'msg-y',
    );
    expect(deriveIdempotencyKey('social.update', 'did:plc:x', 'not json', 'msg-z')).toBe('msg-z');
  });
});

describe('enqueueD2D (memory fallback)', () => {
  it('persists a pending row with the semantic body', () => {
    const row = enqueueD2D({
      targetDID: 'did:plc:bob',
      messageType: 'service.query',
      bodyJson: '{"query_id":"q1"}',
      now: 1_000,
    });
    expect(row.state).toBe('pending');
    expect(row.bodyJson).toBe('{"query_id":"q1"}');
    expect(row.nextAttemptAt).toBe(1_000);
    expect(row.expiresAt).toBe(1_000 + 24 * 60 * 60 * 1000);
    expect(getOutboxRow(row.id)?.id).toBe(row.id);
  });

  it('dedups a re-enqueue of the same query_id to one row', () => {
    const a = enqueueD2D({
      targetDID: 'did:plc:bob',
      messageType: 'service.query',
      bodyJson: '{"query_id":"dup"}',
    });
    const b = enqueueD2D({
      targetDID: 'did:plc:bob',
      messageType: 'service.query',
      bodyJson: '{"query_id":"dup"}',
    });
    expect(b.id).toBe(a.id);
    expect(outboxCount()).toBe(1);
  });

  it('isOutboxDurable reflects whether a SQL repo is installed', () => {
    expect(isOutboxDurable()).toBe(false);
    setD2DOutboxRepository(new SQLiteD2DOutboxRepository(new InMemoryDatabaseAdapter()));
    expect(isOutboxDurable()).toBe(true);
    setD2DOutboxRepository(null);
  });
});

describe('recordFailure', () => {
  it('schedules a backoff retry below the attempt cap', () => {
    const row = enqueueD2D({
      targetDID: 'did:plc:bob',
      messageType: 'service.query',
      bodyJson: '{"query_id":"q1"}',
      now: 1_000,
    });
    const state = recordFailure(row, 'network', 2_000);
    expect(state).toBe('failed');
    const after = getOutboxRow(row.id);
    expect(after?.state).toBe('failed');
    expect(after?.attempts).toBe(1);
    expect(after?.nextAttemptAt).toBe(2_000 + BASE_BACKOFF_MS);
    expect(after?.lastError).toBe('network');
  });

  it('dead-letters at MAX_ATTEMPTS', () => {
    const row = enqueueD2D({
      targetDID: 'did:plc:bob',
      messageType: 'service.query',
      bodyJson: '{"query_id":"q1"}',
      now: 1_000,
    });
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const st = recordFailure(getOutboxRow(row.id)!, 'network', 1_000 + i);
      expect(st).toBe('failed');
    }
    const finalState = recordFailure(getOutboxRow(row.id)!, 'network', 9_999);
    expect(finalState).toBe('dead');
    expect(getOutboxRow(row.id)?.state).toBe('dead');
  });

  it('dead-letters a message past its TTL even on the first failure', () => {
    const row = enqueueD2D({
      targetDID: 'did:plc:bob',
      messageType: 'service.query',
      bodyJson: '{"query_id":"q1"}',
      ttlMs: 10,
      now: 1_000,
    });
    const state = recordFailure(row, 'network', 5_000); // past expiresAt (1_010)
    expect(state).toBe('dead');
    expect(getOutboxRow(row.id)?.lastError).toMatch(/expired/);
  });
});

describe('durable routing', () => {
  it('routes through the installed SQL repo, not the memory fallback', () => {
    const repo = new SQLiteD2DOutboxRepository(new InMemoryDatabaseAdapter());
    // The shared InMemoryDatabaseAdapter is a SELECT-less shell, so stub the
    // return — real SQL behaviour is covered in outbox_repository.test.ts.
    // Here we only assert the facade routes through the installed repo.
    const spy = jest.spyOn(repo, 'insert').mockReturnValue({
      id: 'stub',
      targetDID: 'did:plc:bob',
      messageType: 'service.query',
      bodyJson: '{"query_id":"q1"}',
      idempotencyKey: 'service.query:q1',
      state: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      lastAttemptAt: null,
      leaseUntil: null,
      expiresAt: null,
      lastError: null,
      createdAt: 0,
      updatedAt: 0,
    });
    setD2DOutboxRepository(repo);
    try {
      enqueueD2D({
        targetDID: 'did:plc:bob',
        messageType: 'service.query',
        bodyJson: '{"query_id":"q1"}',
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(getD2DOutboxRepository()).toBe(repo);
    } finally {
      setD2DOutboxRepository(null);
    }
  });
});
