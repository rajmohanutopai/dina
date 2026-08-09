/**
 * WS-6.6 — competitor and probing resistance (§14.3, §20.10).
 *
 * The harm here is in the AGGREGATE, not in any single answer: a hundred
 * legitimate quote replies at varying quantities draw a supplier's price
 * curve. So the tests come in two families — one about the budget that sees
 * the aggregate, and one about the refusal not becoming an oracle in its own
 * right.
 */

import {
  MAX_RETAINED_ATTEMPTS_PER_PEER,
  QuoteAttemptLedger,
} from '../../src/commerce/probing_ledger';
import {
  DEFAULT_PROBING_POLICY,
  PROBING_REFUSAL,
  admitQuoteRequest,
  refusalsAreUniform,
  type QuoteAttempt,
} from '../../src/commerce/probing_resistance';

const COMPETITOR = 'did:plc:competitor01';
const CUSTOMER = 'did:plc:sancho000001';
const NOW = 1_000_000_000;

function attempts(fromDid: string, count: number, atMs = NOW - 1000): QuoteAttempt[] {
  return Array.from({ length: count }, () => ({ fromDid, atMs }));
}

describe('a stranger may ask, but may not map the price curve', () => {
  it('answers the first question from an unknown peer', () => {
    // §20.10 is about the curve, not the first question. A stranger has to be
    // able to become a customer.
    const verdict = admitQuoteRequest({
      fromDid: COMPETITOR,
      standing: 'unknown',
      recentAttempts: [],
      nowMs: NOW,
    });
    expect(verdict.quote).toBe(true);
  });

  it('stops answering once the unknown budget is spent', () => {
    const verdict = admitQuoteRequest({
      fromDid: COMPETITOR,
      standing: 'unknown',
      recentAttempts: attempts(COMPETITOR, DEFAULT_PROBING_POLICY.unknownBudget),
      nowMs: NOW,
    });
    expect(verdict.quote).toBe(false);
    expect(!verdict.quote && verdict.reason).toBe('budget_exhausted');
  });

  it('gives a known customer far more room', () => {
    // A real customer revising an order several times is ordinary. A limit
    // that catches them is a limit that gets turned off — and a defence
    // nobody runs protects nothing.
    const verdict = admitQuoteRequest({
      fromDid: CUSTOMER,
      standing: 'known',
      recentAttempts: attempts(CUSTOMER, DEFAULT_PROBING_POLICY.unknownBudget + 1),
      nowMs: NOW,
    });
    expect(verdict.quote).toBe(true);
  });

  it('counts per counterparty, never globally', () => {
    // A global counter would let one busy customer exhaust everyone's budget —
    // turning a privacy defence into an outage a competitor can trigger by
    // being noisy on purpose.
    const noisy = attempts(CUSTOMER, 500);
    const verdict = admitQuoteRequest({
      fromDid: COMPETITOR,
      standing: 'unknown',
      recentAttempts: noisy,
      nowMs: NOW,
    });
    expect(verdict.quote).toBe(true);
  });

  it('forgets attempts outside the window', () => {
    const old = attempts(
      COMPETITOR,
      DEFAULT_PROBING_POLICY.unknownBudget * 10,
      NOW - DEFAULT_PROBING_POLICY.windowMs - 1,
    );
    expect(
      admitQuoteRequest({
        fromDid: COMPETITOR,
        standing: 'unknown',
        recentAttempts: old,
        nowMs: NOW,
      }).quote,
    ).toBe(true);
  });

  it('refuses a blocked counterparty regardless of budget', () => {
    const verdict = admitQuoteRequest({
      fromDid: COMPETITOR,
      standing: 'blocked',
      recentAttempts: [],
      nowMs: NOW,
    });
    expect(verdict.quote).toBe(false);
    expect(!verdict.quote && verdict.reason).toBe('blocked');
  });
});

/**
 * The half that is easy to get wrong. A budget with distinguishable refusals
 * leaks the catalog BEFORE the budget runs out: the prober stops reading the
 * answers and starts reading the shape of the "no".
 */
describe('the refusal is not itself an oracle (§14.3)', () => {
  it('a blocked peer and an exhausted peer receive the SAME words', () => {
    const blocked = admitQuoteRequest({
      fromDid: COMPETITOR,
      standing: 'blocked',
      recentAttempts: [],
      nowMs: NOW,
    });
    const exhausted = admitQuoteRequest({
      fromDid: COMPETITOR,
      standing: 'unknown',
      recentAttempts: attempts(COMPETITOR, DEFAULT_PROBING_POLICY.unknownBudget),
      nowMs: NOW,
    });
    expect(refusalsAreUniform(blocked, exhausted)).toBe(true);
    // The distinction survives where it belongs — the owner's log — and only
    // there.
    expect(!blocked.quote && blocked.reason).not.toBe(!exhausted.quote && exhausted.reason);
  });

  it('the wire refusal says nothing about products, budgets, or windows', () => {
    // Every "helpful" detail is a bit of the catalog handed over.
    const refusal = PROBING_REFUSAL.toLowerCase();
    for (const leak of ['budget', 'window', 'block', 'limit', 'known', 'sku', 'product', 'rate']) {
      expect(refusal).not.toContain(leak);
    }
  });

  it('never reports remaining budget on a refusal', () => {
    // A countdown is a side channel: watch it fall and you have measured the
    // policy, which tells you exactly how slowly to probe.
    const verdict = admitQuoteRequest({
      fromDid: COMPETITOR,
      standing: 'unknown',
      recentAttempts: attempts(COMPETITOR, DEFAULT_PROBING_POLICY.unknownBudget),
      nowMs: NOW,
    });
    expect(verdict).not.toHaveProperty('remaining');
  });

  it('reports remaining budget ONLY on success, for the owner’s own surface', () => {
    const verdict = admitQuoteRequest({
      fromDid: CUSTOMER,
      standing: 'known',
      recentAttempts: [],
      nowMs: NOW,
    });
    expect(verdict.quote && verdict.remaining).toBe(DEFAULT_PROBING_POLICY.knownBudget - 1);
  });
});

describe('the aggregate is what is defended', () => {
  it('a hundred requests from one competitor yield at most the budget', () => {
    // The §20.10 property stated directly: a curve needs many points, and this
    // is what caps how many a stranger can collect.
    const history: QuoteAttempt[] = [];
    let answered = 0;
    for (let i = 0; i < 100; i += 1) {
      const verdict = admitQuoteRequest({
        fromDid: COMPETITOR,
        standing: 'unknown',
        recentAttempts: history,
        nowMs: NOW,
      });
      if (verdict.quote) answered += 1;
      history.push({ fromDid: COMPETITOR, atMs: NOW });
    }
    expect(answered).toBe(DEFAULT_PROBING_POLICY.unknownBudget);
  });

  it('a competitor cannot buy budget by spreading across the window', () => {
    // Attempts anywhere inside the window count, so pacing does not help
    // within it — only waiting the window out does, which is the point.
    const spread: QuoteAttempt[] = Array.from(
      { length: DEFAULT_PROBING_POLICY.unknownBudget },
      (_, i) => ({
        fromDid: COMPETITOR,
        atMs: NOW - i * (DEFAULT_PROBING_POLICY.windowMs / 10),
      }),
    );
    expect(
      admitQuoteRequest({
        fromDid: COMPETITOR,
        standing: 'unknown',
        recentAttempts: spread,
        nowMs: NOW,
      }).quote,
    ).toBe(false);
  });
});

/**
 * WS-2.11 — the ledger that makes the pure check usable, and the retention
 * discipline it exists to enforce.
 *
 * `admitQuoteRequest` takes its history as an argument on the stated grounds
 * that the CALLER should own retention: "a supplier should not accumulate a
 * permanent log of who asked what". These tests are mostly about the
 * forgetting.
 */
describe('the quote-attempt ledger (§20.10)', () => {
  const WINDOW = 60 * 60 * 1000;
  const T0 = 1_700_000_000_000;
  const PEER = 'did:plc:competitor';

  it('counts attempts inside the window', () => {
    const ledger = new QuoteAttemptLedger(WINDOW);
    ledger.record(PEER, T0);
    ledger.record(PEER, T0 + 1_000);
    expect(ledger.recent(PEER, T0 + 2_000)).toHaveLength(2);
  });

  it('FORGETS attempts that have aged out', () => {
    const ledger = new QuoteAttemptLedger(WINDOW);
    ledger.record(PEER, T0);
    expect(ledger.recent(PEER, T0 + WINDOW + 1)).toEqual([]);
  });

  it('forgets the PEER, not merely their attempts', () => {
    // An empty array per peer who ever asked is still a list of everyone who
    // ever asked — the log this is supposed not to keep.
    const ledger = new QuoteAttemptLedger(WINDOW);
    ledger.record(PEER, T0);
    expect(ledger.peerCount(T0 + 1)).toBe(1);
    expect(ledger.peerCount(T0 + WINDOW + 1)).toBe(0);
  });

  it('counts each counterparty separately', () => {
    // A global counter would let one busy customer exhaust the budget for
    // everyone, turning a privacy defence into an outage a competitor can
    // trigger on purpose.
    const ledger = new QuoteAttemptLedger(WINDOW);
    ledger.record(PEER, T0);
    ledger.record(PEER, T0);
    expect(ledger.recent('did:plc:someoneelse', T0)).toEqual([]);
  });

  it('caps retention per peer without ever turning a refusal into an admission', () => {
    // The cap sits far above every budget, so dropping the OLDEST entries
    // cannot let a flooding peer back in: they are past the limit long before
    // the cap bites.
    const ledger = new QuoteAttemptLedger(WINDOW);
    for (let i = 0; i < MAX_RETAINED_ATTEMPTS_PER_PEER + 200; i += 1) {
      ledger.record(PEER, T0 + i);
    }
    const kept = ledger.recent(PEER, T0 + 1_000);
    expect(kept).toHaveLength(MAX_RETAINED_ATTEMPTS_PER_PEER);
    expect(
      admitQuoteRequest({
        fromDid: PEER,
        standing: 'known',
        recentAttempts: kept,
        nowMs: T0 + 1_000,
      }).quote,
    ).toBe(false);
  });

  it('hands back the shape the pure check wants', () => {
    // Returning raw timestamps would let the two drift over what an "attempt"
    // is; the ledger owns the conversion.
    const ledger = new QuoteAttemptLedger(WINDOW);
    ledger.record(PEER, T0);
    expect(ledger.recent(PEER, T0 + 1)).toEqual([{ fromDid: PEER, atMs: T0 }]);
  });
});
