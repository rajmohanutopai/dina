/**
 * Unit tests for the trust_score_v1 reference (TN-PROTO-004).
 *
 * Tests behaviour at the function level — the vector regression test
 * in `conformance_vectors.test.ts` pins specific (input, output)
 * pairs; this file pins formula properties and shape invariants.
 */

import {
  SCORE_V1_CONSTANTS,
  computeConfidenceV1,
  computeNetworkV1,
  computeReviewerV1,
  computeScoreV1,
  computeSentimentV1,
  computeVouchV1,
  type ScoreV1Input,
} from '../src/trust/score_v1';

const NOW_MS = Date.UTC(2026, 4 - 1, 22, 12, 0, 0);
const DAY = 86_400_000;

function emptyInput(): ScoreV1Input {
  return {
    attestationsAbout: [],
    vouchCount: 0,
    highConfidenceVouches: 0,
    endorsementCount: 0,
    activeFlagCount: 0,
    flagSeverities: [],
    totalAttestationsBy: 0,
    revocationCount: 0,
    tombstoneCount: 0,
    helpfulReactions: 0,
    unhelpfulReactions: 0,
    withEvidenceCount: 0,
    inboundEdgeCount: 0,
    delegationInboundCount: 0,
  };
}

describe('SCORE_V1_CONSTANTS', () => {
  it('component weights sum to 1.0', () => {
    const C = SCORE_V1_CONSTANTS;
    const sum =
      C.SENTIMENT_WEIGHT + C.VOUCH_WEIGHT + C.REVIEWER_WEIGHT + C.NETWORK_WEIGHT;
    expect(sum).toBeCloseTo(1.0, 12);
  });

  it('is frozen — runtime mutation is rejected', () => {
    expect(() => {
      // @ts-expect-error — testing the freeze
      SCORE_V1_CONSTANTS.DAMPING_FACTOR = 0.5;
    }).toThrow();
  });

  it('numeric tiers are monotonic', () => {
    const C = SCORE_V1_CONSTANTS;
    expect(C.CONF_T1).toBeLessThan(C.CONF_T2);
    expect(C.CONF_T2).toBeLessThan(C.CONF_T3);
    expect(C.CONF_T3).toBeLessThan(C.CONF_T4);
    expect(C.CONF_NONE).toBeLessThan(C.CONF_LOW);
    expect(C.CONF_LOW).toBeLessThan(C.CONF_FAIR);
    expect(C.CONF_FAIR).toBeLessThan(C.CONF_OK);
    expect(C.CONF_OK).toBeLessThan(C.CONF_HIGH);
    expect(C.CONF_HIGH).toBeLessThan(C.CONF_VERY_HIGH);
  });

  it('flag severity factors are < 1.0 (always penalising) and ordered', () => {
    const C = SCORE_V1_CONSTANTS;
    expect(C.FLAG_CRITICAL_FACTOR).toBeLessThan(C.FLAG_SERIOUS_FACTOR);
    expect(C.FLAG_SERIOUS_FACTOR).toBeLessThan(C.FLAG_WARNING_FACTOR);
    expect(C.FLAG_WARNING_FACTOR).toBeLessThan(1);
  });
});

describe('computeSentimentV1', () => {
  it('empty atts returns 0.5', () => {
    expect(computeSentimentV1(emptyInput(), NOW_MS)).toBe(0.5);
  });

  it('all unvouched authors → all zero weights → falls back to 0.5', () => {
    const input = emptyInput();
    input.attestationsAbout = [
      {
        sentiment: 'positive',
        recordCreatedAtMs: NOW_MS,
        evidenceCount: 0,
        hasCosignature: false,
        isVerified: false,
        authorTrustScore: 0.99,
        authorHasInboundVouch: false,
      },
    ];
    expect(computeSentimentV1(input, NOW_MS)).toBe(0.5);
  });

  it('future-dated record is clamped to ageDays=0 (recency=1)', () => {
    const input = emptyInput();
    input.attestationsAbout = [
      {
        sentiment: 'positive',
        recordCreatedAtMs: NOW_MS + 30 * DAY, // 30 days in the future
        evidenceCount: 0,
        hasCosignature: false,
        isVerified: false,
        authorTrustScore: 0.5,
        authorHasInboundVouch: true,
      },
    ];
    // Single positive attestation → sentiment = 1.0 regardless of weight magnitude.
    expect(computeSentimentV1(input, NOW_MS)).toBe(1.0);
  });

  it('negative atts contribute to the denominator only', () => {
    const input = emptyInput();
    input.attestationsAbout = [
      {
        sentiment: 'negative',
        recordCreatedAtMs: NOW_MS,
        evidenceCount: 0,
        hasCosignature: false,
        isVerified: false,
        authorTrustScore: 1.0,
        authorHasInboundVouch: true,
      },
    ];
    expect(computeSentimentV1(input, NOW_MS)).toBe(0); // 0 / 1 = 0
  });

  it('neutral atts contribute weight × 0.5 to numerator', () => {
    const input = emptyInput();
    input.attestationsAbout = [
      {
        sentiment: 'neutral',
        recordCreatedAtMs: NOW_MS,
        evidenceCount: 0,
        hasCosignature: false,
        isVerified: false,
        authorTrustScore: 1.0,
        authorHasInboundVouch: true,
      },
    ];
    expect(computeSentimentV1(input, NOW_MS)).toBe(0.5);
  });
});

describe('computeVouchV1', () => {
  it('zero vouches returns floor 0.1', () => {
    expect(computeVouchV1(emptyInput())).toBe(0.1);
  });

  it('saturates at 1.0 with many vouches and many high-conf vouches', () => {
    const input = { ...emptyInput(), vouchCount: 1000, highConfidenceVouches: 1000 };
    expect(computeVouchV1(input)).toBe(1.0);
  });

  it('high-confidence bonus is capped at 0.2', () => {
    // vouchCount=0 short-circuits to 0.1, so use vouchCount=1 to exercise
    // the bonus path. log2(2)/log2(11) ≈ 0.289; bonus saturates at 0.2.
    const input = { ...emptyInput(), vouchCount: 1, highConfidenceVouches: 1000 };
    const expected =
      Math.log2(2) / Math.log2(11) + SCORE_V1_CONSTANTS.HIGH_CONF_BONUS_CAP;
    expect(computeVouchV1(input)).toBeCloseTo(expected, 12);
  });
});

describe('computeReviewerV1', () => {
  it('zero attestations returns 0.0', () => {
    expect(computeReviewerV1(emptyInput())).toBe(0);
  });

  it('helpfulReactions=0 + unhelpfulReactions=0 uses default ratio 0.5', () => {
    const input = {
      ...emptyInput(),
      totalAttestationsBy: 10,
    };
    // base 0.3 + 0.5*0.35 + 0*0.25 - 0*2 = 0.475
    expect(computeReviewerV1(input)).toBeCloseTo(0.475, 12);
  });

  it('high deletion rate clamps result to 0', () => {
    const input = {
      ...emptyInput(),
      totalAttestationsBy: 10,
      tombstoneCount: 9, // deletionRate = 0.9 → -1.8 penalty
    };
    expect(computeReviewerV1(input)).toBe(0);
  });
});

describe('computeNetworkV1', () => {
  it('zero edges returns 0.0', () => {
    expect(computeNetworkV1(emptyInput())).toBe(0);
  });

  it('saturates at 1.0 with many inbound edges', () => {
    const input = { ...emptyInput(), inboundEdgeCount: 10_000 };
    expect(computeNetworkV1(input)).toBe(1.0);
  });

  it('delegation bonus is capped at 0.2', () => {
    const input = { ...emptyInput(), delegationInboundCount: 1000 };
    // edge signal is 0 (no inbound edges), so just the bonus.
    expect(computeNetworkV1(input)).toBe(0.2);
  });
});

describe('computeConfidenceV1', () => {
  it('ladder: 0 → 0.0, 1 → 0.2, 5 → 0.4, 15 → 0.6, 50 → 0.8, 200 → 0.95', () => {
    expect(computeConfidenceV1(emptyInput())).toBe(0);
    expect(computeConfidenceV1({ ...emptyInput(), vouchCount: 1 })).toBe(0.2);
    expect(computeConfidenceV1({ ...emptyInput(), vouchCount: 5 })).toBe(0.4);
    expect(computeConfidenceV1({ ...emptyInput(), vouchCount: 15 })).toBe(0.6);
    expect(computeConfidenceV1({ ...emptyInput(), vouchCount: 50 })).toBe(0.8);
    expect(computeConfidenceV1({ ...emptyInput(), vouchCount: 200 })).toBe(0.95);
  });
});

describe('computeScoreV1', () => {
  it('flag severities compound multiplicatively', () => {
    const input: ScoreV1Input = { ...emptyInput(), flagSeverities: ['warning', 'serious'] };
    const single = computeScoreV1({ ...emptyInput(), flagSeverities: ['warning'] }, NOW_MS);
    const both = computeScoreV1(input, NOW_MS);
    // both = single * (0.6 / 1) — but damping changes the relationship; assert
    // the raw chain instead by working backwards from the damping formula.
    const C = SCORE_V1_CONSTANTS;
    const rawSingle = (single.overallScore - (1 - C.DAMPING_FACTOR) * C.BASE_SCORE) / C.DAMPING_FACTOR;
    const rawBoth = (both.overallScore - (1 - C.DAMPING_FACTOR) * C.BASE_SCORE) / C.DAMPING_FACTOR;
    expect(rawBoth).toBeCloseTo(rawSingle * C.FLAG_SERIOUS_FACTOR, 12);
  });

  it('info-severity flag is non-penalising (forward-compat with future severities)', () => {
    const baseline = computeScoreV1(emptyInput(), NOW_MS);
    const withInfo = computeScoreV1(
      { ...emptyInput(), flagSeverities: ['info'] },
      NOW_MS,
    );
    expect(withInfo.overallScore).toBe(baseline.overallScore);
  });

  it('tombstone penalty applies once at threshold', () => {
    const C = SCORE_V1_CONSTANTS;
    const justUnder = computeScoreV1(
      { ...emptyInput(), tombstoneCount: C.COORDINATION_TOMBSTONE_THRESHOLD - 1 },
      NOW_MS,
    );
    const atThreshold = computeScoreV1(
      { ...emptyInput(), tombstoneCount: C.COORDINATION_TOMBSTONE_THRESHOLD },
      NOW_MS,
    );
    const wayOver = computeScoreV1(
      { ...emptyInput(), tombstoneCount: 100 },
      NOW_MS,
    );

    // Below-threshold: no penalty applied.
    expect(justUnder.overallScore).toBeGreaterThan(atThreshold.overallScore);
    // Penalty applies once — count beyond threshold doesn't compound.
    const rawAt = (atThreshold.overallScore - (1 - C.DAMPING_FACTOR) * C.BASE_SCORE) / C.DAMPING_FACTOR;
    const rawOver = (wayOver.overallScore - (1 - C.DAMPING_FACTOR) * C.BASE_SCORE) / C.DAMPING_FACTOR;
    expect(rawAt).toBeCloseTo(rawOver, 12);
  });

  it('overallScore stays in [0, 1] for adversarial inputs', () => {
    const adversarial: ScoreV1Input = {
      attestationsAbout: [],
      vouchCount: Number.MAX_SAFE_INTEGER,
      highConfidenceVouches: Number.MAX_SAFE_INTEGER,
      endorsementCount: 0,
      activeFlagCount: 0,
      flagSeverities: [],
      totalAttestationsBy: Number.MAX_SAFE_INTEGER,
      revocationCount: 0,
      tombstoneCount: 0,
      helpfulReactions: Number.MAX_SAFE_INTEGER,
      unhelpfulReactions: 0,
      withEvidenceCount: Number.MAX_SAFE_INTEGER,
      inboundEdgeCount: Number.MAX_SAFE_INTEGER,
      delegationInboundCount: Number.MAX_SAFE_INTEGER,
    };
    const out = computeScoreV1(adversarial, NOW_MS);
    expect(out.overallScore).toBeGreaterThanOrEqual(0);
    expect(out.overallScore).toBeLessThanOrEqual(1);
  });

  it('NaN-producing input is caught by Number.isFinite guard → BASE_SCORE survives', () => {
    // Authoring a NaN: divide-by-zero in reviewer is impossible (early-return
    // when totalAttestationsBy=0), so feed an attestation with NaN ts.
    const input = emptyInput();
    input.attestationsAbout = [
      {
        sentiment: 'positive',
        recordCreatedAtMs: Number.NaN,
        evidenceCount: 0,
        hasCosignature: false,
        isVerified: false,
        authorTrustScore: 0.5,
        authorHasInboundVouch: true,
      },
    ];
    const out = computeScoreV1(input, NOW_MS);
    // weight goes NaN → weightedTotal is NaN → fallback path triggers
    expect(Number.isFinite(out.overallScore)).toBe(true);
    expect(out.overallScore).toBeGreaterThanOrEqual(0);
    expect(out.overallScore).toBeLessThanOrEqual(1);
  });

  it('idempotency: same input produces same output every call', () => {
    const input = emptyInput();
    input.vouchCount = 7;
    input.highConfidenceVouches = 2;
    input.inboundEdgeCount = 12;
    const a = computeScoreV1(input, NOW_MS);
    const b = computeScoreV1(input, NOW_MS);
    expect(a).toEqual(b);
  });
});
