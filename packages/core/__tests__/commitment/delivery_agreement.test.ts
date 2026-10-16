/**
 * COMMITMENT_KERNEL §10 — delivery and the agreement's life (step 1c of
 * §15). The term engine's suites cover these through two real engines;
 * these pin the kernel rules on their own.
 *
 *   K-20  the resend schedule: the first resend at half the time left, no
 *         sooner than five minutes and no later than six hours; daily once held;
 *   K-21  where a sent document stands, from its receipt and give-up;
 *   K-22  effects wait for the commit, run once after it, and never after a
 *         rollback; an inner act joins the outer one's transaction;
 *   K-23  the outbox: an intent is recorded and tried once after commit; a
 *         failed first send comes forward; a receipt from a stranger is
 *         unknown; a held receipt moves the next try a day on;
 *   K-24  the sweep gives up past the stop point (with its hook, in one
 *         transaction), gives up quietly on a body that no longer reads, and
 *         resends the rest;
 *   K-30  an ending's date is accepted only near its arrival;
 *   K-31  a trial waives notice only for an ending that arrived in the trial;
 *   K-32  the end folds the earliest ending; a refused one takes no effect;
 *         an unconfirmed one does not free what the deal holds.
 */

import {
  AfterCommit,
  DELIVERY_TIMINGS,
  deliveryState,
  firstResendAt,
  foldAgreementEnd,
  judgeEndingArrival,
  Outbox,
  resendInterval,
  trialWaiverArrivedLate,
  type OutboxPort,
  type OutboxRow,
  type ReceiptOutcome,
} from '../../src/commitment';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('K-20 the resend schedule', () => {
  it('is half the time left, between five minutes and six hours', () => {
    expect(firstResendAt(0, 2 * HOUR)).toBe(HOUR);
    expect(firstResendAt(0, 4 * MIN)).toBe(5 * MIN);
    expect(firstResendAt(0, 3 * DAY)).toBe(6 * HOUR);
  });
  it('is daily once the other side holds the document', () => {
    expect(resendInterval('held')).toBe(DAY);
    expect(resendInterval(null)).toBe(6 * HOUR);
  });
});

describe('K-21 deliveryState', () => {
  const row = (receiptOutcome: ReceiptOutcome | null, gaveUpAt: number | null = null) => ({
    receiptOutcome,
    gaveUpAt,
  });
  it('reads each state', () => {
    expect(deliveryState(null)).toBeNull();
    expect(deliveryState(row(null))).toBe('sent');
    expect(deliveryState(row('held'))).toBe('waiting');
    expect(deliveryState(row('stored'))).toBe('delivered');
    expect(deliveryState(row('refused'))).toBe('refused');
    expect(deliveryState(row(null, 5))).toBe('not_delivered');
    // A final receipt outranks a give-up.
    expect(deliveryState(row('stored', 5))).toBe('delivered');
  });
});

function transaction(events: string[], fail = false) {
  return {
    atomically: <T>(label: string, body: () => T): T => {
      events.push(`begin ${label}`);
      const result = body();
      if (fail) throw new Error('rolled back');
      events.push('commit');
      return result;
    },
  };
}

describe('K-22 AfterCommit', () => {
  it('runs effects once, after the commit', () => {
    const events: string[] = [];
    const effects = new AfterCommit(transaction(events), 'k');
    effects.atomically('outer', () => {
      effects.run(() => events.push('effect'));
      events.push('body');
    });
    expect(events).toEqual(['begin k:outer', 'body', 'commit', 'effect']);
  });
  it('drops effects when the transaction rolls back', () => {
    const events: string[] = [];
    const effects = new AfterCommit(transaction(events, true), 'k');
    expect(() => effects.atomically('x', () => effects.run(() => events.push('effect')))).toThrow(
      'rolled back',
    );
    expect(events).not.toContain('effect');
    // Outside a transaction an effect runs at once.
    effects.run(() => events.push('now'));
    expect(events.at(-1)).toBe('now');
  });
  it('joins an inner act to the outer transaction', () => {
    const events: string[] = [];
    const effects = new AfterCommit(transaction(events), 'k');
    effects.atomically('outer', () => {
      effects.atomically('inner', () => effects.run(() => events.push('inner effect')));
      events.push('outer body');
    });
    expect(events).toEqual(['begin k:outer', 'outer body', 'commit', 'inner effect']);
  });
});

/** An in-memory outbox with the store's rules: a final receipt is never replaced. */
function memoryOutbox(): OutboxPort & { rows: Map<string, OutboxRow> } {
  const rows = new Map<string, OutboxRow>();
  const open = (r: OutboxRow) =>
    r.gaveUpAt === null && (r.receiptOutcome === null || r.receiptOutcome === 'held');
  return {
    rows,
    putOutbox: (row) => {
      if (rows.has(row.recordDigest)) return false;
      rows.set(row.recordDigest, {
        ...row,
        attempts: 0,
        receiptOutcome: null,
        receiptAt: null,
        gaveUpAt: null,
      });
      return true;
    },
    getOutbox: (digest) => rows.get(digest) ?? null,
    dueOutbox: (nowMs, limit) =>
      [...rows.values()].filter((r) => open(r) && r.nextAttemptAt <= nowMs).slice(0, limit),
    pullAttemptForward: (digest, at) => {
      const r = rows.get(digest);
      if (r !== undefined && open(r) && r.attempts <= 1)
        r.nextAttemptAt = Math.min(r.nextAttemptAt, at);
    },
    markAttempt: (digest, next) => {
      const r = rows.get(digest);
      if (r !== undefined) {
        r.attempts += 1;
        r.nextAttemptAt = next;
      }
    },
    recordReceipt: (digest, outcome, nowMs, next) => {
      const r = rows.get(digest);
      if (r === undefined) return null;
      if (r.receiptOutcome === null || r.receiptOutcome === 'held') {
        r.receiptOutcome = outcome;
        r.receiptAt = nowMs;
        r.nextAttemptAt = next;
      }
      return r;
    },
    giveUp: (digest, nowMs) => {
      const r = rows.get(digest);
      if (r !== undefined && r.gaveUpAt === null) r.gaveUpAt = nowMs;
    },
  };
}

function rig(sendResult = true) {
  const events: string[] = [];
  const sent: { to: string; kind: string }[] = [];
  const clock = { now: 0 };
  const store = memoryOutbox();
  const effects = new AfterCommit(transaction(events), 'k');
  const outbox = new Outbox({
    outbox: store,
    effects,
    send: (to, kind) => {
      sent.push({ to, kind });
      return Promise.resolve(sendResult);
    },
    now: () => clock.now,
  });
  return { events, sent, clock, store, effects, outbox };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('K-23 the outbox', () => {
  it('records the intent and sends once after the commit', async () => {
    const r = rig();
    r.effects.atomically('send', () => {
      r.outbox.enqueue({
        toDid: 'did:b',
        kind: 'offer',
        digest: 'd1',
        document: {},
        stopAtMs: DAY,
      });
      expect(r.sent).toEqual([]);
    });
    await flush();
    expect(r.sent).toEqual([{ to: 'did:b', kind: 'offer' }]);
    expect(r.store.rows.get('d1')).toMatchObject({ attempts: 1, nextAttemptAt: 6 * HOUR });
  });
  it('brings a failed first send forward to a minute', async () => {
    const r = rig(false);
    r.outbox.enqueue({ toDid: 'did:b', kind: 'offer', digest: 'd1', document: {}, stopAtMs: DAY });
    await flush();
    expect(r.store.rows.get('d1')?.nextAttemptAt).toBe(DELIVERY_TIMINGS.failedSendRetryMs);
  });
  it('takes a receipt only from the peer it was sent to; held moves the next try a day on', () => {
    const r = rig();
    r.outbox.enqueue({ toDid: 'did:b', kind: 'offer', digest: 'd1', document: {}, stopAtMs: DAY });
    expect(r.outbox.takeReceipt({ senderDid: 'did:c', ofDigest: 'd1', outcome: 'stored' })).toBe(
      'unknown',
    );
    expect(r.outbox.takeReceipt({ senderDid: 'did:b', ofDigest: 'nope', outcome: 'stored' })).toBe(
      'unknown',
    );
    r.clock.now = HOUR;
    expect(
      r.outbox.takeReceipt({ senderDid: 'did:b', ofDigest: 'd1', outcome: 'held' }),
    ).toMatchObject({ receiptOutcome: 'held', nextAttemptAt: HOUR + DAY });
    expect(
      r.outbox.takeReceipt({ senderDid: 'did:b', ofDigest: 'd1', outcome: 'stored' }),
    ).toMatchObject({ receiptOutcome: 'stored' });
    // A final receipt stands.
    expect(
      r.outbox.takeReceipt({ senderDid: 'did:b', ofDigest: 'd1', outcome: 'held' }),
    ).toMatchObject({ receiptOutcome: 'stored' });
  });
});

describe('K-24 the sweep', () => {
  it('gives up past the stop point, quietly on an unreadable body, and resends the rest', async () => {
    const r = rig();
    r.outbox.enqueue({
      toDid: 'did:b',
      kind: 'offer',
      digest: 'late',
      document: {},
      stopAtMs: HOUR,
    });
    r.outbox.enqueue({ toDid: 'did:b', kind: 'bad', digest: 'bad', document: {}, stopAtMs: DAY });
    r.outbox.enqueue({ toDid: 'did:b', kind: 'offer', digest: 'ok', document: {}, stopAtMs: DAY });
    await flush();
    r.sent.length = 0;
    r.clock.now = 7 * HOUR;
    const gaveUp: string[] = [];
    const result = r.outbox.sweep({
      limit: 10,
      readable: (row) => (row.kind === 'bad' ? undefined : JSON.parse(row.documentJson)),
      onGiveUp: (row) => gaveUp.push(row.recordDigest),
    });
    await flush();
    expect(result).toEqual({ resent: 1, gaveUp: 1 });
    expect(gaveUp).toEqual(['late']);
    expect(r.events).toContain('begin k:give_up');
    expect(r.store.rows.get('bad')?.gaveUpAt).toBe(7 * HOUR);
    expect(r.sent).toEqual([{ to: 'did:b', kind: 'offer' }]);
    expect(r.store.rows.get('ok')?.nextAttemptAt).toBe(13 * HOUR);
  });
});

describe('K-30 judgeEndingArrival', () => {
  const args = (signed: number, received: number) => ({
    signedAtMs: signed,
    receivedAtMs: received,
    windowMs: 3 * DAY,
    driftMs: 5 * MIN,
  });
  it('accepts a date near its arrival and refuses one from the future or long before', () => {
    expect(judgeEndingArrival(args(10 * DAY, 11 * DAY))).toBe('in_time');
    expect(judgeEndingArrival(args(10 * DAY + 4 * MIN, 10 * DAY))).toBe('in_time');
    expect(judgeEndingArrival(args(10 * DAY + 6 * MIN, 10 * DAY))).toBe('dated_after_arrival');
    expect(judgeEndingArrival(args(10 * DAY, 13 * DAY + 1))).toBe('dated_too_early');
  });
});

describe('K-31 trialWaiverArrivedLate', () => {
  it('refuses the waiver to an ending dated in the trial that arrived after it', () => {
    const base = { signedAtMs: 10 * DAY, trialEndMs: 14 * DAY, driftMs: 5 * MIN };
    expect(trialWaiverArrivedLate({ ...base, receivedAtMs: 12 * DAY })).toBe(false);
    expect(trialWaiverArrivedLate({ ...base, receivedAtMs: 15 * DAY })).toBe(true);
    expect(trialWaiverArrivedLate({ ...base, trialEndMs: undefined, receivedAtMs: 15 * DAY })).toBe(
      false,
    );
    // Signed after the trial: it never claimed the waiver.
    expect(trialWaiverArrivedLate({ ...base, signedAtMs: 15 * DAY, receivedAtMs: 15 * DAY })).toBe(
      false,
    );
  });
});

describe('K-32 foldAgreementEnd', () => {
  it('ends at its own end with no ending on record', () => {
    expect(foldAgreementEnd({ endMs: 100, endings: [] })).toEqual({
      endsAtMs: 100,
      heldUntilMs: 100,
      ended: false,
    });
  });
  it('takes the earliest ending; a refused one takes no effect; an unconfirmed one still holds', () => {
    expect(
      foldAgreementEnd({
        endMs: 100,
        endings: [
          { effectiveAtMs: 40, refused: true, confirmed: false },
          { effectiveAtMs: 60, refused: false, confirmed: false },
          { effectiveAtMs: 80, refused: false, confirmed: true },
        ],
      }),
    ).toEqual({ endsAtMs: 60, heldUntilMs: 80, ended: true });
    expect(
      foldAgreementEnd({
        endMs: 100,
        endings: [{ effectiveAtMs: 40, refused: true, confirmed: true }],
      }),
    ).toEqual({ endsAtMs: 100, heldUntilMs: 100, ended: false });
  });
});
