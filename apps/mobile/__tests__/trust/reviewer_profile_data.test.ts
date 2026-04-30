/**
 * Tests for `src/trust/reviewer_profile_data.ts` (TN-MOB-015).
 *
 * Pure data-layer derivation: TrustProfile → display-ready projection.
 * The screen layer (`app/trust/reviewer/[did].tsx`) renders these
 * values directly; this file pins:
 *   - score-display + band derivation across the unrated / [0,1] range
 *   - hasNumericScore threshold (Plan §8.3.1: N≥3 attestations)
 *   - per-sentiment count passthrough
 *   - helpfulRatio + corroborationRate `[0,1]→[0,100]` clamping
 *   - lastActive relative-time bucket boundaries
 *   - activeDomains passthrough
 */

import {
  deriveReviewerProfileDisplay,
  formatLastActive,
} from '../../src/trust/reviewer_profile_data';

import type { TrustProfile } from '@dina/core';

function makeProfile(overrides: Partial<TrustProfile> = {}): TrustProfile {
  return {
    did: 'did:plc:abcdefghijklmnopqrstuvwx',
    overallTrustScore: 0.85,
    attestationSummary: { total: 10, positive: 7, neutral: 2, negative: 1 },
    vouchCount: 3,
    endorsementCount: 5,
    reviewerStats: {
      totalAttestationsBy: 10,
      corroborationRate: 0.7,
      evidenceRate: 0.4,
      helpfulRatio: 0.92,
    },
    activeDomains: ['github.com', 'amazon.com'],
    lastActive: 1714400000000,
    ...overrides,
  };
}

describe('deriveReviewerProfileDisplay — score derivation', () => {
  it('high score (≥0.8) → band high, numeric label, hasNumericScore=true', () => {
    const d = deriveReviewerProfileDisplay(makeProfile({ overallTrustScore: 0.85 }));
    expect(d.band).toBe('high');
    expect(d.scoreDisplay).toBe(85);
    expect(d.scoreLabel).toBe('85');
    expect(d.hasNumericScore).toBe(true);
  });

  it('moderate score (0.5..0.8) → band moderate', () => {
    const d = deriveReviewerProfileDisplay(makeProfile({ overallTrustScore: 0.6 }));
    expect(d.band).toBe('moderate');
    expect(d.scoreDisplay).toBe(60);
  });

  it('low score (0.3..0.5) → band low', () => {
    const d = deriveReviewerProfileDisplay(makeProfile({ overallTrustScore: 0.4 }));
    expect(d.band).toBe('low');
    expect(d.scoreDisplay).toBe(40);
  });

  it('very-low score (<0.3) → band very-low', () => {
    const d = deriveReviewerProfileDisplay(makeProfile({ overallTrustScore: 0.1 }));
    expect(d.band).toBe('very-low');
    expect(d.scoreDisplay).toBe(10);
  });

  it('null score → unrated band, em-dash label, hasNumericScore=false', () => {
    const d = deriveReviewerProfileDisplay(makeProfile({ overallTrustScore: null }));
    expect(d.band).toBe('unrated');
    expect(d.scoreDisplay).toBeNull();
    expect(d.scoreLabel).toBe('—');
    expect(d.hasNumericScore).toBe(false);
  });

  it('hasNumericScore=false when total < 3 even with a valid score (Plan §8.3.1 cold-start)', () => {
    const d = deriveReviewerProfileDisplay(
      makeProfile({
        overallTrustScore: 0.85,
        attestationSummary: { total: 2, positive: 2, neutral: 0, negative: 0 },
      }),
    );
    expect(d.band).toBe('high');
    expect(d.scoreDisplay).toBe(85);
    expect(d.hasNumericScore).toBe(false);
  });

  it('hasNumericScore=true at the exact N=3 boundary', () => {
    const d = deriveReviewerProfileDisplay(
      makeProfile({
        overallTrustScore: 0.55,
        attestationSummary: { total: 3, positive: 2, neutral: 1, negative: 0 },
      }),
    );
    expect(d.hasNumericScore).toBe(true);
  });
});

describe('deriveReviewerProfileDisplay — counts + domains passthrough', () => {
  it('passes through per-sentiment counts', () => {
    const d = deriveReviewerProfileDisplay(
      makeProfile({
        attestationSummary: { total: 30, positive: 20, neutral: 7, negative: 3 },
      }),
    );
    expect(d.totalAttestations).toBe(30);
    expect(d.positiveCount).toBe(20);
    expect(d.neutralCount).toBe(7);
    expect(d.negativeCount).toBe(3);
  });

  it('passes through vouch + endorsement counts', () => {
    const d = deriveReviewerProfileDisplay(
      makeProfile({ vouchCount: 12, endorsementCount: 7 }),
    );
    expect(d.vouchCount).toBe(12);
    expect(d.endorsementCount).toBe(7);
  });

  it('passes through activeDomains as-is', () => {
    const domains = ['github.com', 'arxiv.org', 'amazon.com'];
    const d = deriveReviewerProfileDisplay(makeProfile({ activeDomains: domains }));
    expect(d.activeDomains).toEqual(domains);
  });

  it('handles empty activeDomains', () => {
    const d = deriveReviewerProfileDisplay(makeProfile({ activeDomains: [] }));
    expect(d.activeDomains).toEqual([]);
  });
});

describe('deriveReviewerProfileDisplay — rate display clamping', () => {
  it('helpful + corroboration rate convert [0,1] → [0,100] integer', () => {
    const d = deriveReviewerProfileDisplay(
      makeProfile({
        reviewerStats: {
          totalAttestationsBy: 10,
          corroborationRate: 0.736,
          evidenceRate: 0,
          helpfulRatio: 0.5,
        },
      }),
    );
    expect(d.helpfulRatioDisplay).toBe(50);
    // 0.736 * 100 = 73.6 → rounds to 74
    expect(d.corroborationRateDisplay).toBe(74);
  });

  it('NaN / Infinity rates → null (no NaN% renders)', () => {
    const d = deriveReviewerProfileDisplay(
      makeProfile({
        reviewerStats: {
          totalAttestationsBy: 10,
          corroborationRate: NaN,
          evidenceRate: 0,
          helpfulRatio: Infinity,
        },
      }),
    );
    expect(d.helpfulRatioDisplay).toBeNull();
    expect(d.corroborationRateDisplay).toBeNull();
  });

  it('out-of-range rates clamp to [0,100]', () => {
    const d = deriveReviewerProfileDisplay(
      makeProfile({
        reviewerStats: {
          totalAttestationsBy: 10,
          corroborationRate: -0.5, // negative — clamps to 0
          evidenceRate: 0,
          helpfulRatio: 1.5, // >1 — clamps to 1.0 → 100
        },
      }),
    );
    expect(d.corroborationRateDisplay).toBe(0);
    expect(d.helpfulRatioDisplay).toBe(100);
  });
});

describe('formatLastActive', () => {
  const NOW = 1_700_000_000_000;

  it('null → "never"', () => {
    expect(formatLastActive(null, NOW)).toBe('never');
  });

  it('future timestamp → "never" (defensive)', () => {
    expect(formatLastActive(NOW + 60_000, NOW)).toBe('never');
  });

  it('< 1 minute → "just now"', () => {
    expect(formatLastActive(NOW - 30_000, NOW)).toBe('just now');
    expect(formatLastActive(NOW - 59_999, NOW)).toBe('just now');
  });

  it('1..59 minutes → "<n>m ago"', () => {
    expect(formatLastActive(NOW - 60_000, NOW)).toBe('1m ago');
    expect(formatLastActive(NOW - 30 * 60_000, NOW)).toBe('30m ago');
    expect(formatLastActive(NOW - 59 * 60_000, NOW)).toBe('59m ago');
  });

  it('1..23 hours → "<n>h ago"', () => {
    expect(formatLastActive(NOW - 60 * 60_000, NOW)).toBe('1h ago');
    expect(formatLastActive(NOW - 23 * 60 * 60_000, NOW)).toBe('23h ago');
  });

  it('1..6 days → "<n>d ago"', () => {
    expect(formatLastActive(NOW - 24 * 60 * 60_000, NOW)).toBe('1d ago');
    expect(formatLastActive(NOW - 6 * 24 * 60 * 60_000, NOW)).toBe('6d ago');
  });

  it('1..3 weeks → "<n>w ago"', () => {
    expect(formatLastActive(NOW - 7 * 24 * 60 * 60_000, NOW)).toBe('1w ago');
    expect(formatLastActive(NOW - 21 * 24 * 60 * 60_000, NOW)).toBe('3w ago');
  });

  it('1 month → "1 month ago" (singular)', () => {
    // 30 days = 1 month per the bucket (>= 4 weeks)
    expect(formatLastActive(NOW - 30 * 24 * 60 * 60_000, NOW)).toBe('1 month ago');
  });

  it('multiple months → "<n> months ago" (plural)', () => {
    expect(formatLastActive(NOW - 90 * 24 * 60 * 60_000, NOW)).toBe('3 months ago');
  });
});
