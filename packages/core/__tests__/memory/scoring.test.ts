/**
 * Working-memory scoring + stemming tests (WM-CORE-04).
 *
 * Pins the two load-bearing invariants from §5 / §6.2 of
 * `WORKING_MEMORY_DESIGN.md`:
 *
 *   - `computeSalience` implements the EWMA formula exactly, with a
 *     clock-skew clamp and the mixing coefficient from `domain.ts`.
 *   - `stemLite` handles the small English suffix set the repository's
 *     tier-2 alias lookup depends on, so "tax plan", "tax plans", and
 *     "tax planning" collapse onto one canonical row.
 *
 * Reference numbers match the Go test file
 * `core/test/memory_test.go::TestMemory_TouchDecaysThenIncrements` to
 * 1e-6 (see `decaysAfter14DaysMatchesGoReference`).
 */

import { computeSalience, isConsonant, stemLite } from '../../src/memory/scoring';
import {
  TOPIC_SHORT_MIX,
  TOPIC_TAU_LONG_DAYS,
  TOPIC_TAU_SHORT_DAYS,
  type Topic,
} from '../../src/memory/domain';

function mkTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    topic: 'x',
    kind: 'theme',
    last_update: 0,
    s_short: 0,
    s_long: 0,
    ...overrides,
  };
}

describe('computeSalience', () => {
  it('returns 0 for a zero-filled row', () => {
    expect(computeSalience(mkTopic(), 0)).toBe(0);
  });

  it('at dt=0 yields s_long + TOPIC_SHORT_MIX * s_short', () => {
    const now = 1_700_000_000;
    const row = mkTopic({ last_update: now, s_short: 4, s_long: 10 });
    expect(computeSalience(row, now)).toBeCloseTo(10 + 0.3 * 4, 9);
  });

  it('applies exponential decay on both scales independently', () => {
    // After 14 days (one short-tau): s_short drops to 1/e;
    // s_long decays by exp(-14/180).
    const last = 0;
    const row = mkTopic({ last_update: last, s_short: 1, s_long: 1 });
    const nowUnix = last + TOPIC_TAU_SHORT_DAYS * 86_400; // exactly 14 days later
    const expected =
      1 * Math.exp(-TOPIC_TAU_SHORT_DAYS / TOPIC_TAU_LONG_DAYS) +
      TOPIC_SHORT_MIX * 1 * Math.exp(-1);
    expect(computeSalience(row, nowUnix)).toBeCloseTo(expected, 9);
  });

  it('matches the Go reference after a 14-day gap (TestMemory_TouchDecaysThenIncrements)', () => {
    // Stored state: s_short = s_long = 1, last_update = t0.
    // Observe at t0 + 14 days.
    // Expected salience: s_long * exp(-14/180) + 0.3 * s_short * exp(-14/14)
    const t0 = 1_700_000_000;
    const row = mkTopic({ last_update: t0, s_short: 1, s_long: 1 });
    const got = computeSalience(row, t0 + 14 * 86_400);
    const want = Math.exp(-14 / 180) + 0.3 * Math.exp(-1);
    // 1e-6 precision mirrors the Go assertion.
    expect(Math.abs(got - want)).toBeLessThan(1e-6);
  });

  it('clamps negative dt to 0 (clock-skew guard)', () => {
    // Simulated skew: stored last_update in the FUTURE relative to `now`.
    // Salience must equal the "dt=0" value, not explode or underflow.
    const now = 1_700_000_000;
    const row = mkTopic({ last_update: now + 10 * 86_400, s_short: 2, s_long: 5 });
    expect(computeSalience(row, now)).toBeCloseTo(5 + 0.3 * 2, 9);
  });

  it('a one-year dormant row ranks strictly below a bursty recent row', () => {
    const now = 1_700_000_000;
    // Dormant anchor: strong s_long, untouched for a year.
    const dormant = mkTopic({
      last_update: now - 365 * 86_400,
      s_short: 0,
      s_long: 10,
    });
    // Bursty recent: low s_long but just touched a few times.
    const recent = mkTopic({
      last_update: now,
      s_short: 3,
      s_long: 1,
    });
    expect(computeSalience(recent, now)).toBeGreaterThan(computeSalience(dormant, now));
  });
});

describe('stemLite — general', () => {
  it('lowercases + trims', () => {
    expect(stemLite('  HDFC  ')).toBe('hdfc');
  });

  it('returns input unchanged when no suffix matches', () => {
    expect(stemLite('plan')).toBe('plan');
  });

  it('returns input unchanged when the input is too short to strip (safety floor)', () => {
    // len("sings") = 5, suf "s" needs len > 3 → stripped to "sing"? Check:
    // 5 > 3 → strips "s" → "sing" (our 3-char floor is the Go one).
    expect(stemLite('sings')).toBe('sing');
    // len("cat") = 3, suf "s" needs len > 3 → NOT stripped → "cat".
    expect(stemLite('cat')).toBe('cat');
  });

  it('does not mutate inputs already at minimum length', () => {
    // "was" stays "was" (len 3 not > 3).
    expect(stemLite('was')).toBe('was');
  });
});

describe('stemLite — -ing / -ings (tier A, with doubled-consonant collapse)', () => {
  it('strips -ing and collapses doubled consonant: planning → plan', () => {
    expect(stemLite('planning')).toBe('plan');
  });

  it('strips -ings and collapses doubled consonant: plannings → plan', () => {
    expect(stemLite('plannings')).toBe('plan');
  });

  it('strips -ing with NO collapse when the revealed tail is not a doubled consonant: reading → read', () => {
    expect(stemLite('reading')).toBe('read');
  });

  it('strips -ing with NO collapse when the revealed letter is a vowel: seeing → see', () => {
    expect(stemLite('seeing')).toBe('see');
  });

  it('tax planning → tax plan (the headline scenario)', () => {
    expect(stemLite('tax planning')).toBe('tax plan');
  });

  it('UPPERCASE is folded before the stem: PLANNING → plan', () => {
    expect(stemLite('PLANNING')).toBe('plan');
  });

  it('does not go below the length floor: sing (len 4) > ing (3+2=5)? 4 > 5 false → unchanged', () => {
    // `len(s) > len(suf) + 2` → 4 > 5 is false, so "sing" stays.
    expect(stemLite('sing')).toBe('sing');
  });
});

describe('stemLite — -ers / -er / -s (tier B, plain strip)', () => {
  it('strips -s: plans → plan', () => {
    expect(stemLite('plans')).toBe('plan');
  });

  it('strips -er: planner → plann', () => {
    // Tier B has NO doubled-consonant collapse — this is intentional,
    // matches the Go port. Upgrading is a V2 concern.
    expect(stemLite('planner')).toBe('plann');
  });

  it('strips -ers: planners → plann', () => {
    expect(stemLite('planners')).toBe('plann');
  });

  it('prefers -ers over -er when both could match (longest-suffix first)', () => {
    // "buyers": tier B iterates 'ers' first. 6 > 5 → "buy".
    expect(stemLite('buyers')).toBe('buy');
  });

  it('prefers -er over -s', () => {
    // "richer": -er (6 > 4) wins over -s.
    expect(stemLite('richer')).toBe('rich');
  });
});

describe('stemLite — tier ordering', () => {
  it('tier A (-ings) wins over tier B (-s) when both could match: ratings → rat', () => {
    // "ratings" ends with "-ings" (tier A) AND with "-s" (tier B).
    // Tier A runs first, so strip "-ings" → "rat". Doubled-consonant
    // check on "rat": last two chars 'at' are not a doubled consonant
    // (one is a vowel), so no collapse → "rat". If tier B had won
    // we'd have stripped "-s" → "rating".
    expect(stemLite('ratings')).toBe('rat');
  });
});

describe('isConsonant', () => {
  it('returns true for lowercase consonants', () => {
    for (const c of ['b', 'c', 'd', 'f', 'g', 'n', 'p', 'r', 's', 't', 'z']) {
      expect(isConsonant(c.charCodeAt(0))).toBe(true);
    }
  });

  it('returns false for lowercase vowels (including y)', () => {
    for (const c of ['a', 'e', 'i', 'o', 'u', 'y']) {
      expect(isConsonant(c.charCodeAt(0))).toBe(false);
    }
  });

  it('returns false for uppercase letters (only lowercase matters — stemLite lowercases first)', () => {
    for (const c of ['A', 'B', 'Z']) {
      expect(isConsonant(c.charCodeAt(0))).toBe(false);
    }
  });

  it('returns false for non-letter characters', () => {
    for (const c of [' ', '-', '0', '9', '!']) {
      expect(isConsonant(c.charCodeAt(0))).toBe(false);
    }
  });
});
