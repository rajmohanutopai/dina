/**
 * Task 6.23 — trust decision helpers tests.
 */

import {
  ACTION_CAUTION_SCORE,
  ACTION_PROCEED_CONFIDENCE,
  ACTION_PROCEED_SCORE,
  ACTION_VERIFY_SCORE,
  CONTEXT_MULTIPLIERS,
  FLAG_PENALTY_PER_FLAG,
  LEVEL_HIGH,
  LEVEL_LOW,
  LEVEL_MODERATE,
  RING_BOOST_DIRECT,
  RING_BOOST_TWO_HOP,
  bandAction,
  bandLevel,
  decideTrust,
} from '../src/appview/trust_decision';

describe('bandLevel (task 6.23)', () => {
  it.each([
    [0.95, 'high'],
    [0.8, 'high'],
    [0.79, 'moderate'],
    [0.5, 'moderate'],
    [0.49, 'low'],
    [0.3, 'low'],
    [0.29, 'very-low'],
    [0, 'very-low'],
  ])('score=%s → %s', (score, expected) => {
    expect(bandLevel(score)).toBe(expected);
  });

  it('exported thresholds match the band boundaries', () => {
    expect(bandLevel(LEVEL_HIGH)).toBe('high');
    expect(bandLevel(LEVEL_HIGH - 0.001)).toBe('moderate');
    expect(bandLevel(LEVEL_MODERATE)).toBe('moderate');
    expect(bandLevel(LEVEL_MODERATE - 0.001)).toBe('low');
    expect(bandLevel(LEVEL_LOW)).toBe('low');
    expect(bandLevel(LEVEL_LOW - 0.001)).toBe('very-low');
  });
});

describe('bandAction (task 6.23)', () => {
  it('proceed requires BOTH score >= 0.70 AND confidence >= 0.40', () => {
    expect(bandAction(0.7, 0.4)).toBe('proceed');
    // High score, low confidence → downgrade to caution.
    expect(bandAction(0.95, 0.39)).toBe('caution');
    // Low score with high confidence → still not proceed.
    expect(bandAction(0.69, 1.0)).toBe('caution');
  });

  it.each([
    [0.7, 0.4, 'proceed'],
    [0.65, 0.9, 'caution'],
    [0.4, 0.9, 'caution'],
    [0.39, 0.9, 'verify'],
    [0.2, 0.9, 'verify'],
    [0.19, 0.9, 'avoid'],
    [0, 0, 'avoid'],
  ])('score=%s confidence=%s → %s', (score, confidence, expected) => {
    expect(bandAction(score, confidence)).toBe(expected);
  });

  it('exported threshold constants match band boundaries', () => {
    expect(bandAction(ACTION_PROCEED_SCORE, ACTION_PROCEED_CONFIDENCE)).toBe('proceed');
    expect(bandAction(ACTION_CAUTION_SCORE, 0)).toBe('caution');
    expect(bandAction(ACTION_VERIFY_SCORE, 0)).toBe('verify');
    expect(bandAction(ACTION_VERIFY_SCORE - 0.001, 0)).toBe('avoid');
  });
});

describe('decideTrust — unknown input', () => {
  it('both score+confidence null → action=verify, level=unknown', () => {
    const d = decideTrust({ score: null, confidence: null });
    expect(d.action).toBe('verify');
    expect(d.level).toBe('unknown');
    expect(d.score).toBe(0);
    expect(d.confidence).toBe(0);
    expect(d.reasons[0]).toMatch(/no trust data/);
  });

  it('score present but confidence null → treated as confidence=0', () => {
    const d = decideTrust({ score: 0.9, confidence: null });
    expect(d.action).toBe('caution'); // high score but no confidence
    expect(d.level).toBe('high');
  });

  it('score null but confidence present → treated as score=0 (avoid)', () => {
    const d = decideTrust({ score: null, confidence: 0.9 });
    expect(d.action).toBe('avoid');
    expect(d.level).toBe('very-low');
  });
});

describe('decideTrust — happy path', () => {
  it('high score + high confidence + direct ring + read context → proceed', () => {
    const d = decideTrust({
      score: 0.85,
      confidence: 0.75,
      ring: 1,
      context: 'read',
    });
    expect(d.action).toBe('proceed');
    expect(d.level).toBe('high');
    expect(d.reasons).toContain('direct trust connection');
  });

  it('moderate score + ring=2 → caution (no proceed because confidence low)', () => {
    const d = decideTrust({
      score: 0.6,
      confidence: 0.3,
      ring: 2,
      context: 'read',
    });
    expect(d.action).toBe('caution');
    expect(d.reasons).toContain('2-hop trust connection');
  });

  it('ring=3 (stranger) gets no boost', () => {
    const without = decideTrust({ score: 0.7, confidence: 0.5, ring: 3 });
    const noRing = decideTrust({ score: 0.7, confidence: 0.5 });
    expect(without.score).toBeCloseTo(noRing.score, 10);
  });
});

describe('decideTrust — flag penalty', () => {
  it('1 flag multiplies score by 0.6', () => {
    const base = decideTrust({ score: 0.8, confidence: 0.9, flagCount: 0 });
    const one = decideTrust({ score: 0.8, confidence: 0.9, flagCount: 1 });
    expect(one.score).toBeCloseTo(base.score * FLAG_PENALTY_PER_FLAG, 6);
    expect(one.reasons).toContain('1 open flag on subject');
  });

  it('2 flags compound (× 0.6²)', () => {
    const two = decideTrust({ score: 0.8, confidence: 0.9, flagCount: 2 });
    expect(two.score).toBeCloseTo(0.8 * FLAG_PENALTY_PER_FLAG ** 2, 6);
    expect(two.reasons).toContain('2 open flags on subject');
  });

  it('enough flags can demote proceed → avoid', () => {
    // 0.9 × 0.6^4 ≈ 0.117 → avoid
    const d = decideTrust({ score: 0.9, confidence: 0.9, flagCount: 4 });
    expect(d.action).toBe('avoid');
  });

  it('negative flagCount is clamped to 0', () => {
    const d = decideTrust({ score: 0.5, confidence: 0.5, flagCount: -5 });
    expect(d.score).toBeCloseTo(0.5, 10);
  });
});

describe('decideTrust — context multiplier', () => {
  it('transaction context tightens threshold (× 0.9)', () => {
    const read = decideTrust({ score: 0.8, confidence: 0.5, context: 'read' });
    const tx = decideTrust({ score: 0.8, confidence: 0.5, context: 'transaction' });
    expect(tx.score).toBeCloseTo(read.score * CONTEXT_MULTIPLIERS.transaction, 6);
  });

  it('share-pii and autonomous-action tighten progressively', () => {
    const read = decideTrust({ score: 0.9, confidence: 0.9, context: 'read' });
    const pii = decideTrust({ score: 0.9, confidence: 0.9, context: 'share-pii' });
    const auto = decideTrust({ score: 0.9, confidence: 0.9, context: 'autonomous-action' });
    expect(pii.score).toBeCloseTo(read.score * CONTEXT_MULTIPLIERS['share-pii'], 6);
    expect(auto.score).toBeCloseTo(read.score * CONTEXT_MULTIPLIERS['autonomous-action'], 6);
    expect(auto.score).toBeLessThan(pii.score);
    expect(pii.score).toBeLessThan(read.score);
  });

  it('context=read is the default when omitted', () => {
    const explicit = decideTrust({ score: 0.5, confidence: 0.5, context: 'read' });
    const omitted = decideTrust({ score: 0.5, confidence: 0.5 });
    expect(explicit.score).toBeCloseTo(omitted.score, 10);
  });

  it('boundary: exactly proceed on read, demoted to caution on transaction', () => {
    // score=0.8 × 0.9 = 0.72 → still >= 0.7 so proceed remains.
    // Need a score that's on the proceed threshold for read + below for tx.
    // 0.7 / 0.9 ≈ 0.778 — let's pick 0.7 exactly.
    const read = decideTrust({ score: 0.7, confidence: 0.5, context: 'read' });
    expect(read.action).toBe('proceed');
    const tx = decideTrust({ score: 0.7, confidence: 0.5, context: 'transaction' });
    // 0.7 × 0.9 = 0.63 → caution (< 0.70 for proceed; >= 0.40 for caution).
    expect(tx.action).toBe('caution');
  });
});

describe('decideTrust — ring boost', () => {
  it('direct (ring=1) multiplies by 1.15 (capped at 1)', () => {
    const direct = decideTrust({ score: 0.5, confidence: 0.5, ring: 1 });
    expect(direct.score).toBeCloseTo(0.5 * RING_BOOST_DIRECT, 6);
  });

  it('2-hop multiplies by 1.05 (capped at 1)', () => {
    const twoHop = decideTrust({ score: 0.5, confidence: 0.5, ring: 2 });
    expect(twoHop.score).toBeCloseTo(0.5 * RING_BOOST_TWO_HOP, 6);
  });

  it('direct boost caps at 1.0 (does not overflow)', () => {
    const d = decideTrust({ score: 0.95, confidence: 0.9, ring: 1 });
    expect(d.score).toBeLessThanOrEqual(1);
    expect(d.action).toBe('proceed');
  });
});

describe('decideTrust — clamping + invalid input', () => {
  it('score > 1 clamps to 1', () => {
    const d = decideTrust({ score: 5 as number, confidence: 0.9 });
    expect(d.score).toBeLessThanOrEqual(1);
  });

  it('score < 0 clamps to 0', () => {
    const d = decideTrust({ score: -5 as number, confidence: 0.9 });
    expect(d.score).toBe(0);
    expect(d.action).toBe('avoid');
  });

  it('NaN score clamps to 0', () => {
    const d = decideTrust({ score: NaN, confidence: 0.9 });
    expect(d.score).toBe(0);
  });

  it('confidence clamps to [0,1]', () => {
    const hi = decideTrust({ score: 0.7, confidence: 5 });
    expect(hi.confidence).toBe(1);
    const lo = decideTrust({ score: 0.7, confidence: -1 });
    expect(lo.confidence).toBe(0);
  });

  // ── ±Infinity clamp coverage ────────────────────────────────────────
  // The previous tests only covered NaN; production uses
  // `!Number.isFinite(n)` which catches NaN AND ±Infinity. A
  // future refactor to `Number.isNaN(n)` would silently let
  // Infinity poison the comparator (Infinity * 0.6 = Infinity →
  // bandLevel(Infinity) returns 'high', flipping a malformed input
  // into a "proceed" verdict in the worst case). Pin the contract.

  it.each([
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('score=%s clamps to 0 (avoid)', (_label, value) => {
    const d = decideTrust({ score: value, confidence: 0.9 });
    expect(d.score).toBe(0);
    expect(d.action).toBe('avoid');
    expect(d.level).toBe('very-low');
  });

  it.each([
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('confidence=%s clamps to 0', (_label, value) => {
    const d = decideTrust({ score: 0.9, confidence: value });
    expect(d.confidence).toBe(0);
    // High score with confidence=0 → caution (proceed needs confidence ≥ 0.4).
    expect(d.action).toBe('caution');
  });

  it('flagCount=+Infinity collapses score toward 0 (no NaN poisoning, no reason-string corruption)', () => {
    // `Math.max(0, Infinity) === Infinity`, then `0.6 ** Infinity === 0`
    // which clean-zeroes the score. The branch DOES enter (Infinity > 0
    // is true) so reason emission must not crash on the toString
    // serialisation. Regression-pin against a refactor that uses
    // `flagCount.toFixed()` (would throw on Infinity).
    const d = decideTrust({
      score: 0.95,
      confidence: 0.95,
      flagCount: Number.POSITIVE_INFINITY,
    });
    expect(d.score).toBe(0);
    expect(d.action).toBe('avoid');
    // Reason includes the flag count without crashing.
    expect(d.reasons.some((r) => /flag/.test(r))).toBe(true);
  });

  it('flagCount=NaN does NOT enter the penalty branch (NaN > 0 is false)', () => {
    // `Math.max(0, NaN) === NaN`, then `NaN > 0` is false — the
    // if-branch is skipped, score is unchanged, no reason is pushed.
    // Pin the safe-degradation contract: malformed flagCount silently
    // becomes "no flags" rather than poisoning the score.
    const d = decideTrust({
      score: 0.9,
      confidence: 0.9,
      flagCount: Number.NaN,
    });
    expect(d.score).toBeCloseTo(0.9, 2);
    expect(d.action).toBe('proceed');
    // No flag reason was emitted (branch was skipped).
    expect(d.reasons.some((r) => /flag/.test(r))).toBe(false);
  });
});

// ── Module-level invariants ────────────────────────────────────────────
// Constants exported from this module are read by every decideTrust
// call across the process. They MUST be frozen at runtime so a buggy
// caller can't mutate the shared map and poison subsequent decisions.
// `Readonly<>` on the type alone is a compile-time constraint and
// gives no runtime protection.

describe('CONTEXT_MULTIPLIERS — runtime freeze invariant', () => {
  it('the multiplier map is Object.frozen at module load', () => {
    expect(Object.isFrozen(CONTEXT_MULTIPLIERS)).toBe(true);
  });

  it('mutation attempts do not change the multiplier value', () => {
    // In strict mode (Node ESM modules + Jest with TS) the assignment
    // throws a TypeError; in sloppy mode it silently no-ops. Either
    // way the value MUST not change — that's the load-bearing
    // invariant. Use a try/catch so the test passes under both.
    const before = CONTEXT_MULTIPLIERS.read;
    try {
      (CONTEXT_MULTIPLIERS as { read: number }).read = 99;
    } catch {
      /* strict-mode TypeError is the documented signal */
    }
    expect(CONTEXT_MULTIPLIERS.read).toBe(before);
  });

  it('subsequent decideTrust call is unaffected by a (failed) mutation attempt', () => {
    // The reason the freeze matters: shared module state across
    // calls. Counter-pin: even if a buggy caller TRIES to mutate
    // (caught above), a subsequent decideTrust must still use the
    // documented multiplier (read=1.0, no adjustment).
    try {
      (CONTEXT_MULTIPLIERS as { read: number }).read = 99;
    } catch {
      /* swallow */
    }
    // 0.7 × 1.0 (read) = 0.7 → proceed at confidence 0.5.
    const d = decideTrust({ score: 0.7, confidence: 0.5, context: 'read' });
    expect(d.score).toBeCloseTo(0.7, 5);
    expect(d.action).toBe('proceed');
  });

  it('every documented context key is present and finite', () => {
    // Defence against a refactor that removed a key (would make
    // `decideTrust({context: '<missing>'})` look up `undefined` and
    // multiply by NaN). The closed enum + every value finite is the
    // load-bearing pair.
    const keys = Object.keys(CONTEXT_MULTIPLIERS).sort();
    expect(keys).toEqual(['autonomous-action', 'read', 'share-pii', 'transaction']);
    for (const k of keys) {
      const v = CONTEXT_MULTIPLIERS[k as keyof typeof CONTEXT_MULTIPLIERS];
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('decideTrust — reasons', () => {
  it('reasons[0] is always the score/confidence summary', () => {
    const d = decideTrust({ score: 0.7, confidence: 0.5 });
    expect(d.reasons[0]).toMatch(/score=\d\.\d{2}\s+confidence=\d\.\d{2}/);
  });

  it('flag + ring + context reasons appear in order applied', () => {
    const d = decideTrust({
      score: 0.6,
      confidence: 0.5,
      flagCount: 1,
      ring: 2,
      context: 'transaction',
    });
    const labels = d.reasons.slice(1); // skip score/confidence summary
    expect(labels).toContain('1 open flag on subject');
    expect(labels).toContain('2-hop trust connection');
    expect(labels).toContain('context=transaction adjustment');
  });
});

describe('decideTrust — pre-flight + autonomous-action realistic scenarios', () => {
  it('service-query pre-flight: 0.75 trust / 0.6 conf / ring=2 / read → proceed', () => {
    const d = decideTrust({ score: 0.75, confidence: 0.6, ring: 2, context: 'read' });
    expect(d.action).toBe('proceed');
  });

  it('same subject in autonomous-action context → caution (safer gate)', () => {
    const d = decideTrust({
      score: 0.75,
      confidence: 0.6,
      ring: 2,
      context: 'autonomous-action',
    });
    // 0.75 × 1.05 × 0.80 = 0.63 → caution
    expect(d.action).toBe('caution');
  });

  it('shady subject (flag + low ring) in transaction → avoid', () => {
    const d = decideTrust({
      score: 0.4,
      confidence: 0.3,
      flagCount: 2,
      ring: null,
      context: 'transaction',
    });
    // 0.4 × 0.6² × 0.9 = 0.13 → avoid
    expect(d.action).toBe('avoid');
  });
});
