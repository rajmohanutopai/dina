/**
 * Property-based tests for `computeTrustScore` (TN-TEST-009).
 *
 * The example-based tests in `01-scorer-algorithms.test.ts` pin
 * specific (input → output) pairs at the values the formula produces
 * today. Those break loudly when constants drift, which is good — but
 * they don't tell us anything about the *invariants* the formula MUST
 * preserve regardless of constants:
 *
 *   - The overall score is always in [0, 1].
 *   - Each component is always in [0, 1].
 *   - The function is deterministic / idempotent: same input → same
 *     output, no hidden mutation.
 *   - Adding a critical flag never *increases* the score.
 *   - Increasing `vouchCount` never *decreases* the vouch component.
 *   - Increasing `inboundEdgeCount` never *decreases* the network
 *     component.
 *   - Crossing the coordination tombstone threshold never *increases*
 *     the score.
 *   - Adding signals (any kind) never *decreases* `confidence`.
 *
 * These are THE invariants the formula has to keep no matter how the
 * weights evolve in V2 or V3. If a refactor accidentally lets the
 * score escape [0, 1], or makes vouches subtractive, we catch it
 * across hundreds of pseudo-random inputs instead of hoping someone
 * thought to write the right concrete test case.
 *
 * **Why hand-rolled instead of `fast-check`**: adding a dev-dep is a
 * noticeable repo change; the property surface here is small and a
 * deterministic seeded RNG covers it. The test runs ~200 randomised
 * inputs per property in a few ms.
 *
 * **Determinism**: the RNG is seeded with a fixed value so a flaky
 * run is impossible — every CI run sees the same 200 inputs in the
 * same order. If a property fails, the failing input is printed so
 * the bug is reproducible without re-seeding.
 */

import { describe, expect, it } from 'vitest'

import {
  computeTrustScore,
  computeSentiment,
  computeVouch,
  computeReviewer,
  computeNetwork,
  computeConfidence,
  type TrustScoreInput,
} from '@/scorer/algorithms/trust-score'
import { CONSTANTS } from '@/config/constants'

/**
 * Mulberry32 — a tiny, deterministic 32-bit PRNG.
 * Public-domain reference implementation; ~6 lines, decent uniformity
 * across short sequences. Good enough for fuzzing 200 inputs per
 * property — we are not running cryptographic tests.
 */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEED = 0xdeadbeef
const ITERATIONS = 200

/** Helper: build a random valid TrustScoreInput. */
function randomInput(rand: () => number): TrustScoreInput {
  const numAttestations = Math.floor(rand() * 25)
  const sentiments = ['positive', 'neutral', 'negative']
  const flagSeverities: string[] = []
  const numFlags = Math.floor(rand() * 4)
  const severityChoices = ['critical', 'serious', 'warning']
  for (let i = 0; i < numFlags; i++) {
    flagSeverities.push(severityChoices[Math.floor(rand() * severityChoices.length)]!)
  }

  const totalAttestationsBy = Math.floor(rand() * 200)
  const tombstoneCount = Math.floor(rand() * Math.max(1, totalAttestationsBy + 5))
  const withEvidenceCount = Math.floor(rand() * Math.max(1, totalAttestationsBy + 1))

  const attestationsAbout = Array.from({ length: numAttestations }, () => {
    const ageDays = rand() * 400
    return {
      sentiment: sentiments[Math.floor(rand() * sentiments.length)]!,
      recordCreatedAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000),
      evidenceJson: rand() < 0.4 ? [{ url: 'https://example.com/proof' }] : null,
      hasCosignature: rand() < 0.2,
      isVerified: rand() < 0.3,
      authorTrustScore: rand() < 0.2 ? null : rand(),
      authorHasInboundVouch: rand() < 0.7,
    }
  })

  return {
    attestationsAbout,
    vouchCount: Math.floor(rand() * 50),
    highConfidenceVouches: Math.floor(rand() * 10),
    endorsementCount: Math.floor(rand() * 30),
    activeFlagCount: numFlags,
    flagSeverities,
    totalAttestationsBy,
    revocationCount: Math.floor(rand() * Math.max(1, totalAttestationsBy + 1)),
    tombstoneCount,
    helpfulReactions: Math.floor(rand() * 100),
    unhelpfulReactions: Math.floor(rand() * 100),
    withEvidenceCount,
    inboundEdgeCount: Math.floor(rand() * 200),
    delegationInboundCount: Math.floor(rand() * 20),
  }
}

/** Repeatedly drive the property under test with deterministic RNG. */
function forEach(name: string, run: (input: TrustScoreInput, i: number) => void) {
  it(name, () => {
    const rand = mulberry32(SEED)
    for (let i = 0; i < ITERATIONS; i++) {
      const input = randomInput(rand)
      try {
        run(input, i)
      } catch (e) {
        // Print the offending input verbatim so the failure is
        // reproducible without re-seeding.
        const detail = JSON.stringify(input, (_, v) => (v instanceof Date ? v.toISOString() : v), 2)
        throw new Error(`Property failed at iteration ${i}.\nInput:\n${detail}\n\nOriginal: ${(e as Error).message}`)
      }
    }
  })
}

describe('computeTrustScore — range invariants', () => {
  forEach('overall score is always in [0, 1]', (input) => {
    const out = computeTrustScore(input)
    expect(out.overallScore).toBeGreaterThanOrEqual(0)
    expect(out.overallScore).toBeLessThanOrEqual(1)
    expect(Number.isFinite(out.overallScore)).toBe(true)
  })

  forEach('every component is always in [0, 1]', (input) => {
    const out = computeTrustScore(input)
    for (const [name, value] of Object.entries(out.components)) {
      expect(Number.isFinite(value), `${name} not finite`).toBe(true)
      expect(value, `${name} below 0`).toBeGreaterThanOrEqual(0)
      expect(value, `${name} above 1`).toBeLessThanOrEqual(1)
    }
  })

  forEach('confidence is always in [0, 1]', (input) => {
    const out = computeTrustScore(input)
    expect(out.confidence).toBeGreaterThanOrEqual(0)
    expect(out.confidence).toBeLessThanOrEqual(1)
  })

  forEach('component sub-functions individually stay in [0, 1]', (input) => {
    expect(computeSentiment(input)).toBeGreaterThanOrEqual(0)
    expect(computeSentiment(input)).toBeLessThanOrEqual(1)
    expect(computeVouch(input)).toBeGreaterThanOrEqual(0)
    expect(computeVouch(input)).toBeLessThanOrEqual(1)
    expect(computeReviewer(input)).toBeGreaterThanOrEqual(0)
    expect(computeReviewer(input)).toBeLessThanOrEqual(1)
    expect(computeNetwork(input)).toBeGreaterThanOrEqual(0)
    expect(computeNetwork(input)).toBeLessThanOrEqual(1)
  })
})

describe('computeTrustScore — idempotency / determinism', () => {
  forEach('same input → identical output (no hidden mutation)', (input) => {
    // Pass a fixed `now` so the recency-decay exponent (which reads
    // the clock via daysSince) is deterministic across the two
    // calls. Without pinning the clock, two consecutive invocations
    // drift by ~1e-15 in the exp() factor as Date.now() advances —
    // which breaks `.toBe()` equality. The test's intent is "no
    // hidden state mutation", not "function is wall-clock pure".
    const FIXED_NOW = 1_777_500_000_000
    const a = computeTrustScore(input, FIXED_NOW)
    const b = computeTrustScore(input, FIXED_NOW)
    expect(b.overallScore).toBe(a.overallScore)
    expect(b.components).toEqual(a.components)
    expect(b.confidence).toBe(a.confidence)
  })
})

describe('computeTrustScore — monotonicity', () => {
  forEach('adding a critical flag never INCREASES the score', (input) => {
    const without = computeTrustScore({ ...input, flagSeverities: [] })
    const withFlag = computeTrustScore({ ...input, flagSeverities: ['critical'] })
    expect(withFlag.overallScore).toBeLessThanOrEqual(without.overallScore + 1e-9)
  })

  forEach('crossing the coordination tombstone threshold never INCREASES the score', (input) => {
    const below = computeTrustScore({
      ...input,
      tombstoneCount: CONSTANTS.COORDINATION_TOMBSTONE_THRESHOLD - 1,
      totalAttestationsBy: CONSTANTS.COORDINATION_TOMBSTONE_THRESHOLD * 2,
    })
    const above = computeTrustScore({
      ...input,
      tombstoneCount: CONSTANTS.COORDINATION_TOMBSTONE_THRESHOLD,
      totalAttestationsBy: CONSTANTS.COORDINATION_TOMBSTONE_THRESHOLD * 2,
    })
    expect(above.overallScore).toBeLessThanOrEqual(below.overallScore + 1e-9)
  })

  forEach('increasing vouchCount never DECREASES the vouch component', (input) => {
    const less = computeVouch({ ...input, vouchCount: 1 })
    const more = computeVouch({ ...input, vouchCount: 50 })
    expect(more).toBeGreaterThanOrEqual(less - 1e-9)
  })

  forEach('increasing inboundEdgeCount never DECREASES the network component', (input) => {
    const less = computeNetwork({ ...input, inboundEdgeCount: 1, delegationInboundCount: 0 })
    const more = computeNetwork({ ...input, inboundEdgeCount: 100, delegationInboundCount: 0 })
    expect(more).toBeGreaterThanOrEqual(less - 1e-9)
  })

  forEach('adding signals never DECREASES confidence', (input) => {
    const fewer = computeConfidence({
      ...input,
      attestationsAbout: input.attestationsAbout.slice(0, 1),
      vouchCount: 0,
      endorsementCount: 0,
      totalAttestationsBy: 0,
    })
    const more = computeConfidence({
      ...input,
      vouchCount: input.vouchCount + 50,
    })
    expect(more).toBeGreaterThanOrEqual(fewer - 1e-9)
  })
})

describe('computeTrustScore — boundary safety', () => {
  it('zero-signal input produces a valid score (no NaN, in [0, 1])', () => {
    const out = computeTrustScore({
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
    })
    expect(Number.isFinite(out.overallScore)).toBe(true)
    expect(out.overallScore).toBeGreaterThanOrEqual(0)
    expect(out.overallScore).toBeLessThanOrEqual(1)
    expect(out.confidence).toBe(0)
  })

  it('extreme positive input still respects [0, 1] ceiling', () => {
    const out = computeTrustScore({
      attestationsAbout: Array.from({ length: 500 }, () => ({
        sentiment: 'positive',
        recordCreatedAt: new Date(),
        evidenceJson: [{ url: 'x' }],
        hasCosignature: true,
        isVerified: true,
        authorTrustScore: 1.0,
        authorHasInboundVouch: true,
      })),
      vouchCount: 10000,
      highConfidenceVouches: 1000,
      endorsementCount: 1000,
      activeFlagCount: 0,
      flagSeverities: [],
      totalAttestationsBy: 1000,
      revocationCount: 0,
      tombstoneCount: 0,
      helpfulReactions: 1000,
      unhelpfulReactions: 0,
      withEvidenceCount: 1000,
      inboundEdgeCount: 100000,
      delegationInboundCount: 1000,
    })
    expect(out.overallScore).toBeLessThanOrEqual(1)
  })

  it('extreme negative input still respects [0, 1] floor', () => {
    const out = computeTrustScore({
      attestationsAbout: Array.from({ length: 500 }, () => ({
        sentiment: 'negative',
        recordCreatedAt: new Date(),
        evidenceJson: null,
        hasCosignature: false,
        isVerified: false,
        authorTrustScore: 1.0,
        authorHasInboundVouch: true,
      })),
      vouchCount: 0,
      highConfidenceVouches: 0,
      endorsementCount: 0,
      activeFlagCount: 10,
      flagSeverities: ['critical', 'critical', 'critical', 'serious', 'serious'],
      totalAttestationsBy: 100,
      revocationCount: 100,
      tombstoneCount: CONSTANTS.COORDINATION_TOMBSTONE_THRESHOLD * 2,
      helpfulReactions: 0,
      unhelpfulReactions: 1000,
      withEvidenceCount: 0,
      inboundEdgeCount: 0,
      delegationInboundCount: 0,
    })
    expect(out.overallScore).toBeGreaterThanOrEqual(0)
  })

  it('NaN-bearing authorTrustScore does not poison the overall score (boundary defence)', () => {
    // This is a defensive check: if upstream code ever passes NaN
    // (e.g., division by zero on a freshly-bootstrapped row), the
    // final score must still be a real number in [0, 1] thanks to
    // the `Number.isFinite` guard at the end of `computeTrustScore`.
    const out = computeTrustScore({
      attestationsAbout: [
        {
          sentiment: 'positive',
          recordCreatedAt: new Date(),
          evidenceJson: null,
          hasCosignature: false,
          isVerified: false,
          authorTrustScore: NaN,
          authorHasInboundVouch: true,
        },
      ],
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
    })
    expect(Number.isFinite(out.overallScore)).toBe(true)
    expect(out.overallScore).toBeGreaterThanOrEqual(0)
    expect(out.overallScore).toBeLessThanOrEqual(1)
  })
})
