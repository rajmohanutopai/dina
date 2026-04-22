/**
 * Task 5.28 — token accounting + limits tests.
 */

import {
  TokenLedger,
  type ConsumeInput,
  type ConsumeResult,
  type TokenLedgerEvent,
  type TokenLimit,
} from '../src/brain/token_ledger';

function fixedClock(ms: number) {
  let now = ms;
  return {
    nowMsFn: () => now,
    advance: (d: number) => {
      now += d;
    },
    set: (m: number) => {
      now = m;
    },
  };
}

/** 2026-04-22 00:00 UTC. */
const APRIL_22_2026 = Date.UTC(2026, 3, 22);

const sampleConsume: ConsumeInput = {
  persona: 'work',
  provider: 'anthropic',
  model: 'claude',
  input: 100,
  output: 200,
};

describe('TokenLedger (task 5.28)', () => {
  describe('construction validation', () => {
    it('rejects non-positive maxTotal', () => {
      expect(
        () =>
          new TokenLedger({
            limits: [
              { scope: 'persona', period: 'daily', maxTotal: 0, persona: 'x' },
            ],
          }),
      ).toThrow(/maxTotal must be/);
    });

    it('rejects invalid period', () => {
      expect(
        () =>
          new TokenLedger({
            limits: [
              {
                scope: 'persona',
                period: 'hourly' as unknown as 'daily',
                maxTotal: 100,
                persona: 'x',
              },
            ],
          }),
      ).toThrow(/must be "daily" or "monthly"/);
    });

    it.each([
      ['persona without persona', { scope: 'persona', period: 'daily', maxTotal: 100 }],
      ['provider without provider', { scope: 'provider', period: 'daily', maxTotal: 100 }],
      [
        'persona_provider without persona',
        { scope: 'persona_provider', period: 'daily', maxTotal: 100, provider: 'p' },
      ],
    ])('rejects %s', (_label, limit) => {
      expect(
        () => new TokenLedger({ limits: [limit as unknown as TokenLimit] }),
      ).toThrow();
    });
  });

  describe('consume — single persona limit', () => {
    it('accepts a request under the limit and reports remaining', () => {
      const clock = fixedClock(APRIL_22_2026);
      const ledger = new TokenLedger({
        nowMsFn: clock.nowMsFn,
        limits: [
          { scope: 'persona', period: 'daily', maxTotal: 1000, persona: 'work' },
        ],
      });
      const result = ledger.consume(sampleConsume) as Extract<
        ConsumeResult,
        { ok: true }
      >;
      expect(result.ok).toBe(true);
      expect(result.remaining.persona).toBe(700); // 1000 - 300
    });

    it('rejects a request that would exceed the limit', () => {
      const clock = fixedClock(APRIL_22_2026);
      const ledger = new TokenLedger({
        nowMsFn: clock.nowMsFn,
        limits: [
          { scope: 'persona', period: 'daily', maxTotal: 400, persona: 'work' },
        ],
      });
      ledger.consume(sampleConsume); // uses 300
      // Second consume (another 300) would exceed 400.
      const result = ledger.consume(sampleConsume) as Extract<
        ConsumeResult,
        { ok: false }
      >;
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('persona_limit');
      expect(result.limit).toBe(400);
      expect(result.consumed).toBe(300);
      expect(result.attempted).toBe(600);
    });

    it('rejection does NOT mutate the bucket (atomic)', () => {
      const clock = fixedClock(APRIL_22_2026);
      const ledger = new TokenLedger({
        nowMsFn: clock.nowMsFn,
        limits: [
          { scope: 'persona', period: 'daily', maxTotal: 400, persona: 'work' },
        ],
      });
      ledger.consume(sampleConsume); // uses 300
      ledger.consume(sampleConsume); // rejected
      // The next smaller consume should still succeed — bucket is still 300, not 600.
      const result = ledger.consume({
        ...sampleConsume,
        input: 50,
        output: 50,
      }) as Extract<ConsumeResult, { ok: true }>;
      expect(result.ok).toBe(true);
      expect(result.remaining.persona).toBe(0); // 400 - 400 exactly
    });

    it('consume for a persona with NO matching limit is always ok (empty `remaining`)', () => {
      const clock = fixedClock(APRIL_22_2026);
      const ledger = new TokenLedger({
        nowMsFn: clock.nowMsFn,
        limits: [
          { scope: 'persona', period: 'daily', maxTotal: 100, persona: 'work' },
        ],
      });
      const result = ledger.consume({
        persona: 'health',
        provider: 'anthropic',
        model: 'claude',
        input: 999_999,
        output: 1,
      }) as Extract<ConsumeResult, { ok: true }>;
      expect(result.ok).toBe(true);
      expect(Object.keys(result.remaining)).toEqual([]);
    });
  });

  describe('consume — multiple limit scopes', () => {
    it('all applicable limits are updated on success', () => {
      const clock = fixedClock(APRIL_22_2026);
      const ledger = new TokenLedger({
        nowMsFn: clock.nowMsFn,
        limits: [
          { scope: 'persona', period: 'daily', maxTotal: 1000, persona: 'work' },
          { scope: 'provider', period: 'daily', maxTotal: 2000, provider: 'anthropic' },
          {
            scope: 'persona_provider',
            period: 'daily',
            maxTotal: 500,
            persona: 'work',
            provider: 'anthropic',
          },
        ],
      });
      const result = ledger.consume(sampleConsume) as Extract<
        ConsumeResult,
        { ok: true }
      >;
      expect(result.ok).toBe(true);
      expect(result.remaining).toEqual({
        persona: 700, // 1000 - 300
        provider: 1700, // 2000 - 300
        persona_provider: 200, // 500 - 300
      });
    });

    it('rejects when ANY applicable limit would overflow', () => {
      const clock = fixedClock(APRIL_22_2026);
      const ledger = new TokenLedger({
        nowMsFn: clock.nowMsFn,
        limits: [
          { scope: 'persona', period: 'daily', maxTotal: 10_000, persona: 'work' },
          {
            scope: 'persona_provider',
            period: 'daily',
            maxTotal: 100,
            persona: 'work',
            provider: 'anthropic',
          },
        ],
      });
      const result = ledger.consume(sampleConsume) as Extract<
        ConsumeResult,
        { ok: false }
      >;
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('persona_provider_limit');
    });
  });

  describe('period boundary', () => {
    it('daily bucket resets across UTC midnight', () => {
      const clock = fixedClock(APRIL_22_2026);
      const ledger = new TokenLedger({
        nowMsFn: clock.nowMsFn,
        limits: [
          { scope: 'persona', period: 'daily', maxTotal: 300, persona: 'work' },
        ],
      });
      ledger.consume(sampleConsume); // uses 300 on day 1
      // Second consume same day → rejected.
      const reject = ledger.consume(sampleConsume);
      expect(reject.ok).toBe(false);
      // Advance past midnight UTC → fresh bucket.
      clock.advance(24 * 60 * 60 * 1000);
      const fresh = ledger.consume(sampleConsume);
      expect(fresh.ok).toBe(true);
    });

    it('monthly bucket resets on the 1st', () => {
      const clock = fixedClock(APRIL_22_2026);
      const ledger = new TokenLedger({
        nowMsFn: clock.nowMsFn,
        limits: [
          { scope: 'provider', period: 'monthly', maxTotal: 300, provider: 'anthropic' },
        ],
      });
      ledger.consume(sampleConsume); // April
      const reject = ledger.consume(sampleConsume); // April still
      expect(reject.ok).toBe(false);
      // Advance into May.
      clock.set(Date.UTC(2026, 4, 1));
      const fresh = ledger.consume(sampleConsume);
      expect(fresh.ok).toBe(true);
    });
  });

  describe('preview', () => {
    it('reports usage + remaining without mutating', () => {
      const clock = fixedClock(APRIL_22_2026);
      const ledger = new TokenLedger({
        nowMsFn: clock.nowMsFn,
        limits: [
          { scope: 'persona', period: 'daily', maxTotal: 1000, persona: 'work' },
        ],
      });
      ledger.consume(sampleConsume);
      const pv1 = ledger.preview('work', 'anthropic');
      expect(pv1.usage.total).toBe(300);
      expect(pv1.remaining.persona).toBe(700);
      const pv2 = ledger.preview('work', 'anthropic');
      // Preview is idempotent — calling again doesn't move anything.
      expect(pv2.usage.total).toBe(300);
      expect(pv2.remaining.persona).toBe(700);
    });

    it('zero usage for persona with no prior consumption', () => {
      const ledger = new TokenLedger({
        limits: [
          { scope: 'persona', period: 'daily', maxTotal: 1000, persona: 'work' },
        ],
      });
      expect(ledger.preview('work', 'anthropic').usage.total).toBe(0);
    });
  });

  describe('consume input validation', () => {
    it.each([
      ['empty persona', { ...sampleConsume, persona: '' }],
      ['empty provider', { ...sampleConsume, provider: '' }],
      ['empty model', { ...sampleConsume, model: '' }],
      ['negative input', { ...sampleConsume, input: -1 }],
      ['negative output', { ...sampleConsume, output: -1 }],
      ['NaN input', { ...sampleConsume, input: NaN }],
    ])('rejects %s', (_label, input) => {
      const ledger = new TokenLedger({ limits: [] });
      expect(() => ledger.consume(input)).toThrow();
    });
  });

  describe('events', () => {
    it('fires consumed on success', () => {
      const events: TokenLedgerEvent[] = [];
      const ledger = new TokenLedger({
        limits: [{ scope: 'persona', period: 'daily', maxTotal: 1000, persona: 'work' }],
        onEvent: (e) => events.push(e),
      });
      ledger.consume(sampleConsume);
      expect(events[0]).toMatchObject({
        kind: 'consumed',
        persona: 'work',
        provider: 'anthropic',
        input: 100,
        output: 200,
      });
    });

    it('fires rejected on overflow', () => {
      const events: TokenLedgerEvent[] = [];
      const ledger = new TokenLedger({
        limits: [{ scope: 'persona', period: 'daily', maxTotal: 100, persona: 'work' }],
        onEvent: (e) => events.push(e),
      });
      ledger.consume(sampleConsume); // first → rejected (exceeds 100)
      expect(events.some((e) => e.kind === 'rejected')).toBe(true);
    });
  });

  describe('reset + snapshot', () => {
    it('reset clears every bucket', () => {
      const ledger = new TokenLedger({
        limits: [{ scope: 'persona', period: 'daily', maxTotal: 1000, persona: 'work' }],
      });
      ledger.consume(sampleConsume);
      ledger.reset();
      expect(ledger.preview('work', 'anthropic').usage.total).toBe(0);
    });

    it('snapshot returns live buckets as copies', () => {
      const clock = fixedClock(APRIL_22_2026);
      const ledger = new TokenLedger({
        nowMsFn: clock.nowMsFn,
        limits: [
          { scope: 'persona', period: 'daily', maxTotal: 1000, persona: 'work' },
          { scope: 'provider', period: 'monthly', maxTotal: 5000, provider: 'anthropic' },
        ],
      });
      ledger.consume(sampleConsume);
      const snap = ledger.snapshot();
      expect(snap).toHaveLength(2);
      // Mutation doesn't affect the ledger.
      snap[0]!.usage.total = 999_999;
      expect(ledger.preview('work', 'anthropic').usage.total).toBe(300);
    });
  });
});
