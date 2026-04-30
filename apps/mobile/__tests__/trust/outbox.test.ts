/**
 * Outbox state machine + selectors tests (TN-MOB-004 + TN-MOB-007).
 *
 * Pins the rules the runner + screen renderer + inbox surface all
 * share:
 *
 *   - State machine: queued-offline → submitted-pending → indexed |
 *     rejected; tick events drive 24h offline + 60s pending budgets.
 *   - Terminal statuses (indexed / rejected / stuck-*) ignore all
 *     events (replay-safe).
 *   - Mismatched clientId silently ignored.
 *   - Cap enforcement: 50 in-flight max; terminal rows DON'T count.
 *   - Duplicate clientId on enqueue is rejected (caller bug).
 *   - Selectors: selectFlushable (queued-offline), selectActivePolling
 *     (submitted-pending), selectInboxFailureRows (terminal failures);
 *     all sorted FIFO.
 *   - Reference identity preserved on no-op steps.
 *   - Garbage clock input on tick is a no-op (not a transition).
 *   - Malformed wire data on submitted/status_response is a no-op.
 *
 * Pure function — runs under plain Jest, no RN deps.
 */

import {
  MAX_QUEUE_SIZE,
  STUCK_OFFLINE_AGE_MS,
  STUCK_PENDING_BUDGET_MS,
  enqueueDraft,
  inFlightCount,
  isTerminalStatus,
  outboxStepRow,
  outboxStepRows,
  selectActivePolling,
  selectFlushable,
  selectInboxFailureRows,
  type AttestationStatusResponse,
  type OutboxEvent,
  type OutboxRow,
  type OutboxStatus,
} from '../../src/trust/outbox';

const T0_ISO = '2026-04-29T12:00:00.000Z';
const T0_MS = Date.parse(T0_ISO);

interface Body {
  text: string;
}

function row(overrides: Partial<OutboxRow<Body>> = {}): OutboxRow<Body> {
  return {
    clientId: 'cid-1',
    draftBody: { text: 'review body' },
    status: 'queued-offline',
    enqueuedAt: T0_ISO,
    ...overrides,
  };
}

function statusResponse(overrides: Partial<AttestationStatusResponse> = {}): AttestationStatusResponse {
  return { state: 'pending', ...overrides };
}

// ─── enqueueDraft ─────────────────────────────────────────────────────────

describe('enqueueDraft', () => {
  it('appends a queued-offline row to an empty outbox', () => {
    const r = enqueueDraft<Body>([], {
      clientId: 'cid-1',
      draftBody: { text: 'hello' },
      enqueuedAt: T0_ISO,
    });
    if (!r.ok) throw new Error('expected enqueue ok');
    expect(r.rows).toHaveLength(1);
    const first = r.rows[0];
    if (first === undefined) throw new Error('expected one row');
    expect(first.status).toBe('queued-offline');
    expect(first.clientId).toBe('cid-1');
    expect(first.enqueuedAt).toBe(T0_ISO);
    expect(first.draftBody).toEqual({ text: 'hello' });
  });

  it('preserves prior rows (immutable append)', () => {
    const existing: OutboxRow<Body>[] = [row({ clientId: 'old-1' })];
    const r = enqueueDraft<Body>(existing, {
      clientId: 'new-1',
      draftBody: { text: 'new' },
      enqueuedAt: T0_ISO,
    });
    if (!r.ok) throw new Error('expected enqueue ok');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toBe(existing[0]); // identity preserved
  });

  it('rejects a duplicate clientId', () => {
    const existing: OutboxRow<Body>[] = [row({ clientId: 'cid-1' })];
    const r = enqueueDraft<Body>(existing, {
      clientId: 'cid-1',
      draftBody: { text: 'dup' },
      enqueuedAt: T0_ISO,
    });
    if (r.ok) throw new Error('expected enqueue to fail');
    expect(r.reason).toBe('duplicate_client_id');
  });

  it('rejects when the queue is at cap (50 in-flight)', () => {
    const existing: OutboxRow<Body>[] = Array.from({ length: MAX_QUEUE_SIZE }, (_, i) =>
      row({ clientId: `cid-${i}`, status: 'queued-offline' }),
    );
    const r = enqueueDraft<Body>(existing, {
      clientId: 'cid-overflow',
      draftBody: { text: 'overflow' },
      enqueuedAt: T0_ISO,
    });
    if (r.ok) throw new Error('expected enqueue to fail');
    expect(r.reason).toBe('cap_exceeded');
  });

  it('does NOT count terminal rows toward the cap', () => {
    // 50 indexed rows + 0 in-flight = under cap, should accept.
    const existing: OutboxRow<Body>[] = Array.from({ length: MAX_QUEUE_SIZE }, (_, i) =>
      row({ clientId: `done-${i}`, status: 'indexed' }),
    );
    const r = enqueueDraft<Body>(existing, {
      clientId: 'fresh',
      draftBody: { text: 'fresh' },
      enqueuedAt: T0_ISO,
    });
    expect(r.ok).toBe(true);
  });

  it('counts submitted-pending toward the cap (in-flight)', () => {
    const existing: OutboxRow<Body>[] = Array.from({ length: MAX_QUEUE_SIZE }, (_, i) =>
      row({
        clientId: `cid-${i}`,
        status: 'submitted-pending',
        atUri: `at://x/${i}`,
        submittedAt: T0_ISO,
      }),
    );
    const r = enqueueDraft<Body>(existing, {
      clientId: 'overflow',
      draftBody: { text: 'overflow' },
      enqueuedAt: T0_ISO,
    });
    if (r.ok) throw new Error('expected cap to be enforced');
    expect(r.reason).toBe('cap_exceeded');
  });

  it('throws on empty / non-string clientId (caller bug)', () => {
    expect(() =>
      enqueueDraft<Body>([], { clientId: '', draftBody: { text: 'x' }, enqueuedAt: T0_ISO }),
    ).toThrow();
    expect(() =>
      // @ts-expect-error — runtime guard
      enqueueDraft<Body>([], { clientId: undefined, draftBody: { text: 'x' }, enqueuedAt: T0_ISO }),
    ).toThrow();
  });

  it('throws on non-ISO enqueuedAt', () => {
    expect(() =>
      enqueueDraft<Body>([], {
        clientId: 'cid-1',
        draftBody: { text: 'x' },
        enqueuedAt: 'yesterday',
      }),
    ).toThrow();
  });
});

// ─── outboxStepRow — submitted event ──────────────────────────────────────

describe('outboxStepRow — submitted event', () => {
  it('queued-offline + submitted with matching clientId → submitted-pending', () => {
    const r = row({ status: 'queued-offline' });
    const next = outboxStepRow(r, {
      kind: 'submitted',
      clientId: 'cid-1',
      atUri: 'at://did:plc:author/com.dina.trust.attestation/abc',
      submittedAt: T0_ISO,
    });
    expect(next.status).toBe('submitted-pending');
    expect(next.atUri).toBe('at://did:plc:author/com.dina.trust.attestation/abc');
    expect(next.submittedAt).toBe(T0_ISO);
  });

  it('mismatched clientId → unchanged (same reference)', () => {
    const r = row({ status: 'queued-offline' });
    const next = outboxStepRow(r, {
      kind: 'submitted',
      clientId: 'cid-other',
      atUri: 'at://x/y',
      submittedAt: T0_ISO,
    });
    expect(next).toBe(r);
  });

  it('non-queued-offline status → unchanged (same reference)', () => {
    const r = row({ status: 'submitted-pending', atUri: 'at://x/y', submittedAt: T0_ISO });
    const next = outboxStepRow(r, {
      kind: 'submitted',
      clientId: 'cid-1',
      atUri: 'at://x/z',
      submittedAt: T0_ISO,
    });
    expect(next).toBe(r);
  });

  it('empty atUri → unchanged (defensive — the runner never produces this)', () => {
    const r = row({ status: 'queued-offline' });
    const next = outboxStepRow(r, {
      kind: 'submitted',
      clientId: 'cid-1',
      atUri: '',
      submittedAt: T0_ISO,
    });
    expect(next).toBe(r);
  });

  it('malformed submittedAt → unchanged', () => {
    const r = row({ status: 'queued-offline' });
    const next = outboxStepRow(r, {
      kind: 'submitted',
      clientId: 'cid-1',
      atUri: 'at://x/y',
      submittedAt: 'yesterday',
    });
    expect(next).toBe(r);
  });
});

// ─── outboxStepRow — status_response event ────────────────────────────────

describe('outboxStepRow — status_response event', () => {
  const submittedRow = (): OutboxRow<Body> =>
    row({
      status: 'submitted-pending',
      atUri: 'at://did:plc:author/abc',
      submittedAt: T0_ISO,
    });

  it('indexed response → indexed terminal state', () => {
    const next = outboxStepRow(submittedRow(), {
      kind: 'status_response',
      clientId: 'cid-1',
      response: statusResponse({ state: 'indexed', indexedAt: '2026-04-29T12:00:30Z' }),
    });
    expect(next.status).toBe('indexed');
    expect(next.indexedAt).toBe('2026-04-29T12:00:30Z');
  });

  it('rejected response → rejected terminal state with rejection details', () => {
    const next = outboxStepRow(submittedRow(), {
      kind: 'status_response',
      clientId: 'cid-1',
      response: statusResponse({
        state: 'rejected',
        rejection: {
          reason: 'rate_limit',
          rejectedAt: '2026-04-29T12:00:30Z',
        },
      }),
    });
    expect(next.status).toBe('rejected');
    expect(next.rejection?.reason).toBe('rate_limit');
  });

  it('rejected response without rejection details → no transition (defensive)', () => {
    const r = submittedRow();
    const next = outboxStepRow(r, {
      kind: 'status_response',
      clientId: 'cid-1',
      response: { state: 'rejected' }, // no rejection field
    });
    expect(next).toBe(r);
  });

  it('pending response → no-op (keep polling)', () => {
    const r = submittedRow();
    const next = outboxStepRow(r, {
      kind: 'status_response',
      clientId: 'cid-1',
      response: statusResponse({ state: 'pending' }),
    });
    expect(next).toBe(r);
  });

  it('mismatched clientId → no-op', () => {
    const r = submittedRow();
    const next = outboxStepRow(r, {
      kind: 'status_response',
      clientId: 'cid-other',
      response: statusResponse({ state: 'indexed', indexedAt: T0_ISO }),
    });
    expect(next).toBe(r);
  });

  it('queued-offline row + status_response → no-op (race condition guard)', () => {
    const r = row({ status: 'queued-offline' });
    const next = outboxStepRow(r, {
      kind: 'status_response',
      clientId: 'cid-1',
      response: statusResponse({ state: 'indexed', indexedAt: T0_ISO }),
    });
    expect(next).toBe(r);
  });

  it('unknown response state → no-op (defensive against malformed wire data)', () => {
    const r = submittedRow();
    const next = outboxStepRow(r, {
      kind: 'status_response',
      clientId: 'cid-1',
      // @ts-expect-error — defensive guard against unknown states
      response: { state: 'something-else' },
    });
    expect(next).toBe(r);
  });
});

// ─── outboxStepRow — tick event ──────────────────────────────────────────

describe('outboxStepRow — tick event (queued-offline → stuck-offline)', () => {
  it('queued-offline + tick within 24h → no-op', () => {
    const r = row({ status: 'queued-offline', enqueuedAt: T0_ISO });
    const next = outboxStepRow(r, {
      kind: 'tick',
      nowMs: T0_MS + STUCK_OFFLINE_AGE_MS - 1, // 1ms shy of budget
    });
    expect(next).toBe(r);
  });

  it('queued-offline + tick AT 24h boundary → stuck-offline', () => {
    const r = row({ status: 'queued-offline', enqueuedAt: T0_ISO });
    const next = outboxStepRow(r, {
      kind: 'tick',
      nowMs: T0_MS + STUCK_OFFLINE_AGE_MS, // exactly at boundary
    });
    expect(next.status).toBe('stuck-offline');
    expect(next.stuckAt).toBeDefined();
  });

  it('queued-offline + tick past 24h → stuck-offline with stuckAt timestamp', () => {
    const r = row({ status: 'queued-offline', enqueuedAt: T0_ISO });
    const tickMs = T0_MS + STUCK_OFFLINE_AGE_MS + 60_000;
    const next = outboxStepRow(r, { kind: 'tick', nowMs: tickMs });
    expect(next.status).toBe('stuck-offline');
    expect(next.stuckAt).toBe(new Date(tickMs).toISOString());
  });
});

describe('outboxStepRow — tick event (submitted-pending → stuck-pending)', () => {
  const submittedRow = (): OutboxRow<Body> =>
    row({
      status: 'submitted-pending',
      atUri: 'at://x/y',
      submittedAt: T0_ISO,
    });

  it('submitted-pending + tick within 60s budget → no-op', () => {
    const r = submittedRow();
    const next = outboxStepRow(r, {
      kind: 'tick',
      nowMs: T0_MS + STUCK_PENDING_BUDGET_MS - 1,
    });
    expect(next).toBe(r);
  });

  it('submitted-pending + tick AT 60s boundary → stuck-pending', () => {
    const r = submittedRow();
    const next = outboxStepRow(r, {
      kind: 'tick',
      nowMs: T0_MS + STUCK_PENDING_BUDGET_MS,
    });
    expect(next.status).toBe('stuck-pending');
    expect(next.stuckAt).toBeDefined();
  });

  it('submitted-pending + tick past budget → stuck-pending', () => {
    const r = submittedRow();
    const next = outboxStepRow(r, {
      kind: 'tick',
      nowMs: T0_MS + STUCK_PENDING_BUDGET_MS + 1000,
    });
    expect(next.status).toBe('stuck-pending');
  });

  it('submitted-pending without submittedAt (defensive) → no-op', () => {
    const r = row({ status: 'submitted-pending', atUri: 'at://x/y' });
    const next = outboxStepRow(r, { kind: 'tick', nowMs: T0_MS + STUCK_PENDING_BUDGET_MS * 2 });
    expect(next).toBe(r);
  });

  it('submitted-pending with malformed submittedAt → no-op', () => {
    const r = row({ status: 'submitted-pending', atUri: 'at://x/y', submittedAt: 'yesterday' });
    const next = outboxStepRow(r, { kind: 'tick', nowMs: T0_MS + STUCK_PENDING_BUDGET_MS * 2 });
    expect(next).toBe(r);
  });
});

describe('outboxStepRow — tick event (defensive)', () => {
  it('non-finite nowMs → no-op', () => {
    const r = row({ status: 'queued-offline' });
    expect(outboxStepRow(r, { kind: 'tick', nowMs: Number.NaN })).toBe(r);
    expect(outboxStepRow(r, { kind: 'tick', nowMs: Number.POSITIVE_INFINITY })).toBe(r);
  });

  it('non-number nowMs → no-op', () => {
    const r = row({ status: 'queued-offline' });
    // @ts-expect-error — runtime guard
    expect(outboxStepRow(r, { kind: 'tick', nowMs: 'now' })).toBe(r);
  });
});

// ─── outboxStepRow — terminal idempotence ────────────────────────────────

describe('outboxStepRow — terminal idempotence', () => {
  const events: OutboxEvent[] = [
    {
      kind: 'submitted',
      clientId: 'cid-1',
      atUri: 'at://x/y',
      submittedAt: T0_ISO,
    },
    {
      kind: 'status_response',
      clientId: 'cid-1',
      response: { state: 'indexed', indexedAt: T0_ISO },
    },
    { kind: 'tick', nowMs: T0_MS + 365 * 24 * 3600 * 1000 }, // a year later
  ];

  const terminalStatuses: OutboxStatus[] = [
    'indexed',
    'rejected',
    'stuck-pending',
    'stuck-offline',
  ];

  for (const status of terminalStatuses) {
    it(`${status} ignores all events (replay-safe)`, () => {
      const r = row({ status });
      for (const event of events) {
        expect(outboxStepRow(r, event)).toBe(r);
      }
    });
  }
});

// ─── outboxStepRows — batch ──────────────────────────────────────────────

describe('outboxStepRows', () => {
  it('applies the event to every row', () => {
    const rows: OutboxRow<Body>[] = [
      row({ clientId: 'cid-1', status: 'queued-offline' }),
      row({ clientId: 'cid-2', status: 'queued-offline' }),
    ];
    const next = outboxStepRows(rows, {
      kind: 'submitted',
      clientId: 'cid-1',
      atUri: 'at://x/1',
      submittedAt: T0_ISO,
    });
    const r0 = next[0];
    const r1 = next[1];
    if (r0 === undefined || r1 === undefined) throw new Error('expected two rows');
    expect(r0.status).toBe('submitted-pending');
    expect(r1).toBe(rows[1]); // unchanged → identity preserved
  });

  it('returns a fresh array', () => {
    const rows: OutboxRow<Body>[] = [row()];
    const next = outboxStepRows(rows, { kind: 'tick', nowMs: T0_MS });
    expect(next).not.toBe(rows);
  });
});

// ─── selectFlushable / selectActivePolling / selectInboxFailureRows ──────

describe('selectors', () => {
  const oldQueuedRow = row({
    clientId: 'cid-old',
    status: 'queued-offline',
    enqueuedAt: '2026-04-28T08:00:00.000Z',
  });
  const newQueuedRow = row({
    clientId: 'cid-new',
    status: 'queued-offline',
    enqueuedAt: '2026-04-29T12:00:00.000Z',
  });
  const submittedRow = row({
    clientId: 'cid-sub',
    status: 'submitted-pending',
    atUri: 'at://x/y',
    submittedAt: T0_ISO,
    enqueuedAt: '2026-04-29T11:00:00.000Z',
  });
  const indexedRow = row({
    clientId: 'cid-idx',
    status: 'indexed',
    indexedAt: T0_ISO,
  });
  const rejectedRow = row({ clientId: 'cid-rej', status: 'rejected' });
  const stuckPendingRow = row({ clientId: 'cid-sp', status: 'stuck-pending' });
  const stuckOfflineRow = row({ clientId: 'cid-so', status: 'stuck-offline' });

  const all = [
    newQueuedRow,
    submittedRow,
    oldQueuedRow,
    indexedRow,
    rejectedRow,
    stuckPendingRow,
    stuckOfflineRow,
  ];

  it('selectFlushable returns only queued-offline rows in FIFO order', () => {
    expect(selectFlushable(all)).toEqual([oldQueuedRow, newQueuedRow]);
  });

  it('selectActivePolling returns only submitted-pending rows', () => {
    expect(selectActivePolling(all)).toEqual([submittedRow]);
  });

  it('selectInboxFailureRows returns rejected + stuck-* (not indexed)', () => {
    const failures = selectInboxFailureRows(all);
    expect(failures).toHaveLength(3);
    expect(failures.map((r) => r.status).sort()).toEqual(
      ['rejected', 'stuck-offline', 'stuck-pending'].sort(),
    );
  });

  it('selectFlushable returns a fresh array (caller can sort/mutate)', () => {
    const a = selectFlushable(all);
    const b = selectFlushable(all);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('FIFO sort is stable across runs (clientId tiebreaker)', () => {
    const a = row({ clientId: 'a', enqueuedAt: T0_ISO });
    const z = row({ clientId: 'z', enqueuedAt: T0_ISO });
    const result = selectFlushable([z, a]);
    const r0 = result[0];
    const r1 = result[1];
    if (r0 === undefined || r1 === undefined) throw new Error('expected two rows');
    expect(r0.clientId).toBe('a');
    expect(r1.clientId).toBe('z');
  });
});

// ─── inFlightCount + isTerminalStatus ────────────────────────────────────

describe('inFlightCount', () => {
  it('counts queued-offline + submitted-pending; ignores terminal', () => {
    const rows = [
      row({ clientId: 'q1', status: 'queued-offline' }),
      row({ clientId: 's1', status: 'submitted-pending', atUri: 'at://1', submittedAt: T0_ISO }),
      row({ clientId: 'i1', status: 'indexed' }),
      row({ clientId: 'r1', status: 'rejected' }),
      row({ clientId: 'sp1', status: 'stuck-pending' }),
      row({ clientId: 'so1', status: 'stuck-offline' }),
    ];
    expect(inFlightCount(rows)).toBe(2);
  });

  it('returns 0 for empty outbox', () => {
    expect(inFlightCount([])).toBe(0);
  });
});

describe('isTerminalStatus', () => {
  it('flags terminal statuses true', () => {
    expect(isTerminalStatus('indexed')).toBe(true);
    expect(isTerminalStatus('rejected')).toBe(true);
    expect(isTerminalStatus('stuck-pending')).toBe(true);
    expect(isTerminalStatus('stuck-offline')).toBe(true);
  });

  it('flags non-terminal statuses false', () => {
    expect(isTerminalStatus('queued-offline')).toBe(false);
    expect(isTerminalStatus('submitted-pending')).toBe(false);
  });
});

// ─── Constants ────────────────────────────────────────────────────────────

describe('constants', () => {
  it('MAX_QUEUE_SIZE matches plan §1 row 69 (50)', () => {
    expect(MAX_QUEUE_SIZE).toBe(50);
  });

  it('STUCK_PENDING_BUDGET_MS matches plan §3.5.1 (60s)', () => {
    expect(STUCK_PENDING_BUDGET_MS).toBe(60_000);
  });

  it('STUCK_OFFLINE_AGE_MS matches plan §1 row 69 (24h)', () => {
    expect(STUCK_OFFLINE_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

// ─── Full lifecycle integration ──────────────────────────────────────────

describe('outbox — full lifecycle integration', () => {
  it('happy path: enqueue → submit → indexed', () => {
    const enq = enqueueDraft<Body>([], {
      clientId: 'cid-1',
      draftBody: { text: 'review' },
      enqueuedAt: T0_ISO,
    });
    if (!enq.ok) throw new Error('expected enqueue ok');

    const submitted = outboxStepRows(enq.rows, {
      kind: 'submitted',
      clientId: 'cid-1',
      atUri: 'at://did:plc:author/abc',
      submittedAt: '2026-04-29T12:00:01.000Z',
    });
    expect(submitted[0]?.status).toBe('submitted-pending');

    const indexed = outboxStepRows(submitted, {
      kind: 'status_response',
      clientId: 'cid-1',
      response: { state: 'indexed', indexedAt: '2026-04-29T12:00:05.000Z' },
    });
    expect(indexed[0]?.status).toBe('indexed');
    expect(indexed[0]?.indexedAt).toBe('2026-04-29T12:00:05.000Z');
  });

  it('rate-limit rejection path: enqueue → submit → rejected', () => {
    const enq = enqueueDraft<Body>([], {
      clientId: 'cid-2',
      draftBody: { text: 'review' },
      enqueuedAt: T0_ISO,
    });
    if (!enq.ok) throw new Error('expected enqueue ok');

    const submitted = outboxStepRows(enq.rows, {
      kind: 'submitted',
      clientId: 'cid-2',
      atUri: 'at://x/y',
      submittedAt: T0_ISO,
    });
    const rejected = outboxStepRows(submitted, {
      kind: 'status_response',
      clientId: 'cid-2',
      response: {
        state: 'rejected',
        rejection: { reason: 'rate_limit', rejectedAt: T0_ISO },
      },
    });
    expect(rejected[0]?.status).toBe('rejected');
    expect(rejected[0]?.rejection?.reason).toBe('rate_limit');
  });

  it('60s pending budget path: enqueue → submit → tick → stuck-pending', () => {
    const enq = enqueueDraft<Body>([], {
      clientId: 'cid-3',
      draftBody: { text: 'review' },
      enqueuedAt: T0_ISO,
    });
    if (!enq.ok) throw new Error('expected enqueue ok');

    const submitted = outboxStepRows(enq.rows, {
      kind: 'submitted',
      clientId: 'cid-3',
      atUri: 'at://x/y',
      submittedAt: T0_ISO,
    });
    const stuck = outboxStepRows(submitted, {
      kind: 'tick',
      nowMs: T0_MS + STUCK_PENDING_BUDGET_MS + 1000,
    });
    expect(stuck[0]?.status).toBe('stuck-pending');
  });

  it('24h offline path: enqueue → tick (24h+) → stuck-offline', () => {
    const enq = enqueueDraft<Body>([], {
      clientId: 'cid-4',
      draftBody: { text: 'review' },
      enqueuedAt: T0_ISO,
    });
    if (!enq.ok) throw new Error('expected enqueue ok');

    const stuck = outboxStepRows(enq.rows, {
      kind: 'tick',
      nowMs: T0_MS + STUCK_OFFLINE_AGE_MS + 1000,
    });
    expect(stuck[0]?.status).toBe('stuck-offline');
  });

  it('NetInfo-reconnect flow: queued rows surface via selectFlushable in FIFO order', () => {
    let rows: readonly OutboxRow<Body>[] = [];
    const enqueue = (clientId: string, enqueuedAt: string): void => {
      const r = enqueueDraft<Body>(rows, { clientId, draftBody: { text: clientId }, enqueuedAt });
      if (!r.ok) throw new Error('enqueue failed');
      rows = r.rows;
    };

    enqueue('a', '2026-04-29T08:00:00.000Z');
    enqueue('b', '2026-04-29T09:00:00.000Z');
    enqueue('c', '2026-04-29T10:00:00.000Z');

    const flushable = selectFlushable(rows);
    expect(flushable.map((r) => r.clientId)).toEqual(['a', 'b', 'c']);
  });
});
