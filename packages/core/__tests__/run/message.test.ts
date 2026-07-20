/**
 * ISVC-4 — per-message lifecycle store (§6.3). InMemory + real-SQLite parity
 * (the v23 migration + the state-machine CAS).
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  InMemoryMessageRepository,
  SQLiteMessageRepository,
  isMessageTerminal,
  isValidMessageTransition,
  type MessageRecord,
  type MessageRepository,
} from '../../src/run/message';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const NOW = 1_700_000_000_000;

function msg(over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    message_id: 'm1',
    run_id: 'r1',
    reservation_id: 'res1',
    dedup_key: 'd1',
    sequence: 1,
    kind: 'informational',
    action_type: null,
    risk_class: null,
    state: 'enqueued',
    decision: null,
    decision_revision: 0,
    delegation_id: null,
    expires_at: NOW + 60_000,
    payload_ref: 'cid1',
    content_digest: null,
    tier_candidate: null,
    final_tier: null,
    tier_source: null,
    reconciliation_evidence: '[]',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function runSuite(makeRepo: () => MessageRepository): void {
  it('round-trips + counts enqueued-undecided', () => {
    const repo = makeRepo();
    repo.create(msg({ message_id: 'a', state: 'enqueued' }));
    repo.create(msg({ message_id: 'b', state: 'classified' }));
    repo.create(msg({ message_id: 'c', state: 'deny' })); // terminal, not counted
    expect(repo.getById('a')?.state).toBe('enqueued');
    expect(repo.countEnqueuedUndecided('r1')).toBe(2);
  });

  it('CAS transition enforces the state machine', () => {
    const repo = makeRepo();
    repo.create(msg({ message_id: 'a', state: 'enqueued' }));
    expect(repo.transition('a', 'enqueued', 'classification_pending', NOW)).toBe(true);
    // invalid edge rejected
    expect(repo.transition('a', 'classification_pending', 'completed', NOW)).toBe(false);
    // wrong `from` rejected
    expect(repo.transition('a', 'enqueued', 'classified', NOW)).toBe(false);
    expect(repo.getById('a')?.state).toBe('classification_pending');
  });

  it('decide only fires from classified and stamps decision + revision', () => {
    const repo = makeRepo();
    repo.create(msg({ message_id: 'a', state: 'enqueued' }));
    expect(repo.decide('a', 'approve', 1, NOW)).toBe(false); // not classified
    repo.create(msg({ message_id: 'b', state: 'classified' }));
    expect(repo.decide('b', 'approve', 5, NOW)).toBe(true);
    const r = repo.getById('b');
    expect(r?.state).toBe('approved');
    expect(r?.decision).toBe('approve');
    expect(r?.decision_revision).toBe(5);
  });

  it('deny / acknowledge map to terminal states', () => {
    const repo = makeRepo();
    repo.create(msg({ message_id: 'd', state: 'classified' }));
    expect(repo.decide('d', 'deny', 1, NOW)).toBe(true);
    expect(repo.getById('d')?.state).toBe('deny');
    repo.create(msg({ message_id: 'k', state: 'classified' }));
    expect(repo.decide('k', 'acknowledge', 1, NOW)).toBe(true);
    expect(repo.getById('k')?.state).toBe('acknowledged');
  });

  it('setTier records tier fields', () => {
    const repo = makeRepo();
    repo.create(msg({ message_id: 'a' }));
    repo.setTier('a', { tier_candidate: 3, final_tier: 3, tier_source: 'brain_candidate' }, NOW);
    const r = repo.getById('a');
    expect(r?.tier_candidate).toBe(3);
    expect(r?.final_tier).toBe(3);
    expect(r?.tier_source).toBe('brain_candidate');
  });

  it('fenceOpen cancels/expires every fenceable message', () => {
    const repo = makeRepo();
    repo.create(msg({ message_id: 'a', state: 'classification_pending' }));
    repo.create(msg({ message_id: 'b', state: 'risk_authorized' }));
    // `approved` rests unclaimed until the run engine risk-gates it, so it MUST
    // fence (VERIF #1). Before the fix it was omitted from FENCEABLE and an
    // approved-but-unclaimed action survived termination.
    repo.create(msg({ message_id: 'd', state: 'approved', kind: 'action', action_type: 'send' }));
    repo.create(msg({ message_id: 'c', state: 'dispatched' })); // not fenceable
    const fenced = repo.fenceOpen('r1', 'cancelled', NOW);
    expect(new Set(fenced)).toEqual(new Set(['a', 'b', 'd']));
    expect(repo.getById('a')?.state).toBe('cancelled');
    expect(repo.getById('d')?.state).toBe('cancelled');
    expect(repo.getById('c')?.state).toBe('dispatched');
  });

  it('appendReconciliation accumulates append-only evidence', () => {
    const repo = makeRepo();
    repo.create(msg({ message_id: 'a', state: 'outcome_unknown' }));
    repo.appendReconciliation('a', JSON.stringify({ late: true, at: 1 }), NOW);
    repo.appendReconciliation('a', JSON.stringify({ late: true, at: 2 }), NOW + 1);
    const ev = JSON.parse(String(repo.getById('a')?.reconciliation_evidence)) as unknown[];
    expect(ev.length).toBe(2);
  });
}

describe('message state-machine helpers', () => {
  it('isValidMessageTransition', () => {
    expect(isValidMessageTransition('classified', 'approved')).toBe(true);
    expect(isValidMessageTransition('classified', 'completed')).toBe(false);
    expect(isValidMessageTransition('dispatched', 'outcome_unknown')).toBe(true);
  });
  it('isMessageTerminal', () => {
    expect(isMessageTerminal('completed')).toBe(true);
    expect(isMessageTerminal('cancelled')).toBe(true);
    expect(isMessageTerminal('enqueued')).toBe(false);
  });
});

describe('InMemoryMessageRepository', () => {
  runSuite(() => new InMemoryMessageRepository());
});

describe('SQLiteMessageRepository (real SQLite, v23 migration)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  runSuite(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'isvc4m-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    return new SQLiteMessageRepository(adapter);
  });
  afterEach(() => {
    adapter?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
});
