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
    shred_after: null,
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

  it('R5-05: listRunIdsWithActionableMessages returns runs by oldest actionable message, capped', () => {
    const repo = makeRepo();
    // Non-actionable states never surface a run.
    repo.create(msg({ message_id: 'i1', run_id: 'idle-1', dedup_key: 'k1', state: 'classified' }));
    repo.create(msg({ message_id: 'i2', run_id: 'idle-2', dedup_key: 'k2', state: 'dispatched' }));
    // Three runs with actionable messages, oldest-actionable determines order.
    repo.create(
      msg({ message_id: 'a1', run_id: 'run-c', dedup_key: 'k3', state: 'approved', created_at: NOW + 30 }),
    );
    repo.create(
      msg({ message_id: 'a2', run_id: 'run-a', dedup_key: 'k4', state: 'risk_authorized', created_at: NOW + 10 }),
    );
    repo.create(
      msg({ message_id: 'a3', run_id: 'run-b', dedup_key: 'k5', state: 'sending', created_at: NOW + 20 }),
    );
    // A second, newer actionable message on run-a must not demote it.
    repo.create(
      msg({ message_id: 'a4', run_id: 'run-a', dedup_key: 'k6', sequence: 2, state: 'approved', created_at: NOW + 99 }),
    );

    expect(repo.listRunIdsWithActionableMessages(10)).toEqual(['run-a', 'run-b', 'run-c']);
    // The limit caps the fan-out but keeps most-overdue-first order.
    expect(repo.listRunIdsWithActionableMessages(2)).toEqual(['run-a', 'run-b']);
  });

  it('appendReconciliation accumulates append-only evidence', () => {
    const repo = makeRepo();
    repo.create(msg({ message_id: 'a', state: 'outcome_unknown' }));
    repo.appendReconciliation('a', JSON.stringify({ late: true, at: 1 }), NOW);
    repo.appendReconciliation('a', JSON.stringify({ late: true, at: 2 }), NOW + 1);
    const ev = JSON.parse(String(repo.getById('a')?.reconciliation_evidence)) as unknown[];
    expect(ev.length).toBe(2);
  });

  it('A-09: expireDecidable expires unclaimed approved/risk_authorized past their bound (claimed survives)', () => {
    const repo = makeRepo();
    // Past-expiry, unclaimed post-decision states: without a terminal transition
    // the dispatch guard refuses them forever while the engine rescans them
    // every tick — zombies that also never crypto-shred.
    repo.create(
      msg({ message_id: 'auth', state: 'risk_authorized', kind: 'action', action_type: 'send', expires_at: NOW - 1 }),
    );
    repo.create(
      msg({ message_id: 'appr', dedup_key: 'k2', sequence: 2, state: 'approved', kind: 'action', action_type: 'send', expires_at: NOW - 1 }),
    );
    // A CLAIMED effect survives expiry (reconciled by the drain deadline).
    repo.create(
      msg({ message_id: 'sent', dedup_key: 'k3', sequence: 3, state: 'sending', kind: 'action', action_type: 'send', expires_at: NOW - 1 }),
    );
    const expired = repo.expireDecidable('r1', NOW, NOW + 60_000);
    expect(new Set(expired)).toEqual(new Set(['auth', 'appr']));
    expect(repo.getById('auth')?.state).toBe('expired');
    expect(repo.getById('appr')?.state).toBe('expired');
    expect(repo.getById('sent')?.state).toBe('sending');
    // The run stays listed ONLY for the claimed `sending` row (re-driven for
    // dispatch retries) — the two expired zombies no longer count.
    expect(repo.listRunIdsWithActionableMessages(10)).toEqual(['r1']);
  });

  it('CA-3: stamps only payload-bearing TERMINAL rows, then drains via the sentinel', () => {
    const repo = makeRepo();
    // terminal + payload → stamped; live → not; terminal-but-no-payload → not.
    repo.create(msg({ message_id: 'term', state: 'completed', updated_at: NOW - 10_000 }));
    repo.create(msg({ message_id: 'live', dedup_key: 'k2', sequence: 2, state: 'classified' }));
    repo.create(
      msg({ message_id: 'nopay', dedup_key: 'k3', sequence: 3, state: 'deny', payload_ref: null }),
    );

    expect(repo.stampTerminalShredDeadlines(5_000)).toBe(1); // only `term`
    expect(repo.getById('term')?.shred_after).toBe(NOW - 5_000); // updated_at + window
    expect(repo.getById('live')?.shred_after).toBeNull();
    expect(repo.getById('nopay')?.shred_after).toBeNull();

    // Due at NOW; the live/no-payload rows never appear.
    expect(repo.listPayloadShredDue(NOW, 10)).toEqual(['term']);
    // Idempotent stamp: a second pass adds nothing.
    expect(repo.stampTerminalShredDeadlines(5_000)).toBe(0);

    // Mark shredded → drains (sentinel 0) and is never re-stamped or re-listed.
    repo.markPayloadShredded('term');
    expect(repo.getById('term')?.shred_after).toBe(0);
    expect(repo.listPayloadShredDue(NOW, 10)).toEqual([]);
    expect(repo.stampTerminalShredDeadlines(5_000)).toBe(0);
  });

  it('CA-3: a not-yet-due terminal deadline is withheld from the sweep', () => {
    const repo = makeRepo();
    repo.create(msg({ message_id: 'term', state: 'acknowledged', updated_at: NOW }));
    repo.stampTerminalShredDeadlines(60_000); // deadline = NOW + 60s
    expect(repo.listPayloadShredDue(NOW, 10)).toEqual([]); // not due yet
    expect(repo.listPayloadShredDue(NOW + 60_000, 10)).toEqual(['term']); // due at the bound
  });

  it('CA-9: listClassifiedAfter returns only classified rows, keyset-ordered + paged', () => {
    const repo = makeRepo();
    repo.create(msg({ message_id: 'c2', state: 'classified', created_at: NOW + 200 }));
    repo.create(msg({ message_id: 'c1', dedup_key: 'k2', sequence: 2, state: 'classified', created_at: NOW + 100 }));
    repo.create(msg({ message_id: 'c3', dedup_key: 'k5', sequence: 5, state: 'classified', created_at: NOW + 300 }));
    repo.create(msg({ message_id: 'done', dedup_key: 'k3', sequence: 3, state: 'acknowledged' }));
    repo.create(msg({ message_id: 'pend', dedup_key: 'k4', sequence: 4, state: 'classification_pending' }));

    // Only classified, ascending by (created_at, message_id).
    expect(repo.listClassifiedAfter(0, '', 10).map((m) => m.message_id)).toEqual(['c1', 'c2', 'c3']);
    // Keyset paging: page 1 (size 2), then resume after the last row → exhaustion.
    const page1 = repo.listClassifiedAfter(0, '', 2);
    expect(page1.map((m) => m.message_id)).toEqual(['c1', 'c2']);
    const cur = page1[page1.length - 1];
    const page2 = repo.listClassifiedAfter(cur?.created_at ?? 0, cur?.message_id ?? '', 2);
    expect(page2.map((m) => m.message_id)).toEqual(['c3']);
  });

  it('CA-9: keyset pages across EQUAL timestamps via message_id (no skip/dup at the boundary)', () => {
    const repo = makeRepo();
    const T = NOW + 500;
    // Four classified rows sharing ONE created_at — only message_id breaks the
    // tie, so this exercises the `created_at = ? AND message_id > ?` branch that
    // a distinct-timestamp fixture never reaches.
    for (const id of ['m4', 'm1', 'm3', 'm2']) {
      repo.create(msg({ message_id: id, dedup_key: `k-${id}`, sequence: 1, state: 'classified', created_at: T }));
    }
    // Page size 2 straddling the equal-timestamp boundary → exact concatenation.
    const p1 = repo.listClassifiedAfter(0, '', 2);
    const a = p1[p1.length - 1];
    const p2 = repo.listClassifiedAfter(a?.created_at ?? 0, a?.message_id ?? '', 2);
    const b = p2[p2.length - 1];
    const p3 = repo.listClassifiedAfter(b?.created_at ?? 0, b?.message_id ?? '', 2);
    expect(p1.map((m) => m.message_id)).toEqual(['m1', 'm2']);
    expect(p2.map((m) => m.message_id)).toEqual(['m3', 'm4']);
    expect(p3).toEqual([]); // exhausted — no skips, no duplicates
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
