/**
 * Task 4.75 — EWMA salience verification.
 *
 * Pins the mathematical contract of `@dina/core.computeSalience` so a
 * future refactor of the scoring formula can't silently drift the
 * shape of working memory. The constants (`TOPIC_TAU_SHORT_DAYS = 14`,
 * `TOPIC_TAU_LONG_DAYS = 180`, `TOPIC_SHORT_MIX = 0.3`) are load-
 * bearing — changing them changes the meaning of every salience
 * comparison, so we pin both the constants themselves and the
 * mathematical relationships they encode.
 *
 * Mirrors the invariants documented in `packages/core/src/memory/
 * scoring.ts` and `WORKING_MEMORY_DESIGN.md` §5.
 */

import {
  computeSalience,
  TOPIC_SHORT_MIX,
  TOPIC_TAU_LONG_DAYS,
  TOPIC_TAU_SHORT_DAYS,
  type Topic,
} from '@dina/core';

const SECONDS_PER_DAY = 86_400;

function topic(
  partial: Partial<Topic> & Pick<Topic, 's_short' | 's_long' | 'last_update'>,
): Topic {
  return {
    topic: partial.topic ?? 'tax',
    kind: partial.kind ?? 'theme',
    last_update: partial.last_update,
    s_short: partial.s_short,
    s_long: partial.s_long,
    ...(partial.sample_item_id !== undefined
      ? { sample_item_id: partial.sample_item_id }
      : {}),
  };
}

/** Allow tiny float drift from the Math.exp() inside computeSalience. */
const EPS = 1e-9;

describe('computeSalience — EWMA verification (task 4.75)', () => {
  describe('constants', () => {
    it('TOPIC_TAU_SHORT_DAYS = 14 (fortnight half-life of short-term spike)', () => {
      expect(TOPIC_TAU_SHORT_DAYS).toBe(14);
    });
    it('TOPIC_TAU_LONG_DAYS = 180 (six-month anchor)', () => {
      expect(TOPIC_TAU_LONG_DAYS).toBe(180);
    });
    it('TOPIC_SHORT_MIX = 0.3 (short-term weight in the mix)', () => {
      expect(TOPIC_SHORT_MIX).toBe(0.3);
    });
  });

  describe('dt = 0 — no decay', () => {
    it('returns s_long + TOPIC_SHORT_MIX * s_short', () => {
      const now = 1_700_000_000;
      const s = computeSalience(
        topic({ s_short: 2, s_long: 5, last_update: now }),
        now,
      );
      expect(s).toBeCloseTo(5 + 0.3 * 2, 9);
    });

    it('is 0 for a freshly-reset row', () => {
      expect(
        computeSalience(
          topic({ s_short: 0, s_long: 0, last_update: 100 }),
          100,
        ),
      ).toBe(0);
    });
  });

  describe('dt = tau_short (14 days) — short component drops to 1/e', () => {
    it('short component drops to 1/e ≈ 0.3679', () => {
      const last = 1_700_000_000;
      const now = last + TOPIC_TAU_SHORT_DAYS * SECONDS_PER_DAY;
      const s = computeSalience(
        topic({ s_short: 1, s_long: 0, last_update: last }),
        now,
      );
      // s_long = 0 so only the short branch contributes.
      // short branch at dt = tau_short = 14/14 → e^(-1) ≈ 0.3679
      // scaled by TOPIC_SHORT_MIX = 0.3 → 0.11036...
      const expected = TOPIC_SHORT_MIX * Math.exp(-1);
      expect(s).toBeCloseTo(expected, 9);
    });

    it('long component is nearly intact at dt = tau_short', () => {
      const last = 1_700_000_000;
      const now = last + TOPIC_TAU_SHORT_DAYS * SECONDS_PER_DAY;
      const s = computeSalience(
        topic({ s_short: 0, s_long: 1, last_update: last }),
        now,
      );
      // long branch: exp(-14/180) ≈ 0.9253
      expect(s).toBeCloseTo(Math.exp(-14 / 180), 9);
      expect(s).toBeGreaterThan(0.9);
    });
  });

  describe('dt = tau_long (180 days) — long component drops to 1/e', () => {
    it('long component drops to 1/e ≈ 0.3679', () => {
      const last = 1_700_000_000;
      const now = last + TOPIC_TAU_LONG_DAYS * SECONDS_PER_DAY;
      const s = computeSalience(
        topic({ s_short: 0, s_long: 1, last_update: last }),
        now,
      );
      expect(s).toBeCloseTo(Math.exp(-1), 9);
    });

    it('short component is effectively gone at dt = tau_long', () => {
      const last = 1_700_000_000;
      const now = last + TOPIC_TAU_LONG_DAYS * SECONDS_PER_DAY;
      const s = computeSalience(
        topic({ s_short: 1, s_long: 0, last_update: last }),
        now,
      );
      // short branch at dt/tau_short = 180/14 ≈ 12.86 → e^(-12.86) ≈ 2.6e-6
      // scaled by 0.3 → ~8e-7. Effectively zero.
      expect(s).toBeLessThan(1e-6);
    });
  });

  describe('negative dt — clamp to 0 (clock drift / DST / tests)', () => {
    it('returns s_long + TOPIC_SHORT_MIX * s_short when now < last_update', () => {
      const last = 1_700_000_100;
      const now = 1_700_000_000; // 100 seconds in the past
      const s = computeSalience(
        topic({ s_short: 2, s_long: 5, last_update: last }),
        now,
      );
      expect(s).toBeCloseTo(5 + 0.3 * 2, 9);
    });
  });

  describe('stale topic — anchored long, drained short', () => {
    it('a topic last touched 3 months ago keeps ~61% of s_long and ~0.03% of s_short contribution', () => {
      const last = 1_700_000_000;
      const dtDays = 90;
      const now = last + dtDays * SECONDS_PER_DAY;
      const sLong = 1;
      const sShort = 1;
      const s = computeSalience(
        topic({ s_short: sShort, s_long: sLong, last_update: last }),
        now,
      );

      const longFactor = Math.exp(-dtDays / TOPIC_TAU_LONG_DAYS);
      const shortFactor = Math.exp(-dtDays / TOPIC_TAU_SHORT_DAYS);
      expect(longFactor).toBeGreaterThan(0.6);
      expect(longFactor).toBeLessThan(0.62);
      // short contrib is tiny because dt/tau_short ≈ 6.43
      const shortContrib = TOPIC_SHORT_MIX * shortFactor;
      expect(shortContrib).toBeLessThan(0.001);
      expect(s).toBeCloseTo(sLong * longFactor + sShort * shortContrib, 9);
    });
  });

  describe('monotonic-under-time invariant', () => {
    it('for a fixed row, salience weakly decreases as `nowUnix` grows', () => {
      const last = 1_700_000_000;
      const row = topic({ s_short: 3, s_long: 4, last_update: last });
      let prev = computeSalience(row, last);
      for (let d = 1; d <= 365; d += 1) {
        const now = last + d * SECONDS_PER_DAY;
        const cur = computeSalience(row, now);
        expect(cur).toBeLessThanOrEqual(prev + EPS);
        prev = cur;
      }
    });
  });

  describe('linearity in s_short / s_long', () => {
    it('scaling both counters by k scales salience by k (exact)', () => {
      const last = 1_700_000_000;
      const now = last + 30 * SECONDS_PER_DAY;
      const base = computeSalience(
        topic({ s_short: 1, s_long: 2, last_update: last }),
        now,
      );
      const scaled = computeSalience(
        topic({ s_short: 5, s_long: 10, last_update: last }),
        now,
      );
      expect(scaled).toBeCloseTo(5 * base, 9);
    });

    it('salience is non-negative for any non-negative inputs', () => {
      const last = 1_700_000_000;
      for (const [s_short, s_long, dtDays] of [
        [0, 0, 0],
        [10, 0, 7],
        [0, 10, 365],
        [5, 5, 30],
      ] as const) {
        const now = last + dtDays * SECONDS_PER_DAY;
        expect(
          computeSalience(topic({ s_short, s_long, last_update: last }), now),
        ).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('half-life parity (design-doc §5 worked example)', () => {
    it('fresh touch (dt=0) yields s_long + 0.3 * s_short', () => {
      const now = 1_700_000_000;
      const s = computeSalience(
        topic({ s_short: 1, s_long: 1, last_update: now }),
        now,
      );
      expect(s).toBeCloseTo(1.3, 9);
    });

    it('one short-tau later (dt=14d), salience = s_long*exp(-14/180) + 0.3*s_short*exp(-1)', () => {
      const last = 1_700_000_000;
      const now = last + 14 * SECONDS_PER_DAY;
      const s = computeSalience(
        topic({ s_short: 1, s_long: 1, last_update: last }),
        now,
      );
      const expected = Math.exp(-14 / 180) + 0.3 * Math.exp(-1);
      expect(s).toBeCloseTo(expected, 9);
    });
  });
});
