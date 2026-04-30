/**
 * Conformance test pinning AppView's `computeTrustScore` against the
 * frozen reference fixture in `packages/protocol/conformance/vectors/
 * trust_score_v1.json` (TN-TEST-001 / TN-PROTO-005).
 *
 * **Why this test matters**: AppView is NOT a workspace member (top-
 * level `appview/` directory), so it cannot `import '@dina/protocol'`.
 * Its `scorer/algorithms/trust-score.ts` is a hand-mirrored port of
 * `packages/protocol/src/trust/score_v1.ts`. Without a fixture-pinned
 * test, the two implementations could drift silently — different
 * weights, a different recency-decay constant, a missing flag-severity
 * branch. This test reads the protocol's frozen vectors at runtime
 * and asserts AppView produces the exact same `overallScore +
 * components + confidence` for every case.
 *
 * **Translation layer**: the protocol uses `recordCreatedAtMs: number`
 * and `evidenceCount: number` on the wire (numeric / portable across
 * runtimes); AppView's TrustScoreInput uses `recordCreatedAt: Date`
 * and `evidenceJson: unknown[] | null` (matches the SQL row shape it
 * reads). Translation runs once per case in a typed helper —
 * documented invariants:
 *   - `recordCreatedAtMs: T` ↔ `new Date(T)`
 *   - `evidenceCount: N` ↔ `evidenceJson: N > 0 ? Array(N) : null`
 *   - flag severities + counts pass through unchanged.
 *
 * **Time mock**: the fixture uses `nowMs = 2026-04-22T12:00:00.000Z`
 * to fix the recency-decay term. AppView's `daysSince()` calls
 * `Date.now()` directly, so we use vitest's `vi.setSystemTime` to
 * pin Date.now to the fixture timestamp before each case.
 *
 * **Floating-point tolerance**: scores are floats produced by a
 * sequence of `Math.exp` / multiplication / division. JS IEEE 754
 * arithmetic is deterministic across runtimes, so direct equality
 * works — pinned by `toBeCloseTo(..., 12)` which is well within IEEE
 * 754 double precision (≈15 significant digits). Drift in the 12th
 * digit would surface as a real algorithm change, not a precision
 * artefact.
 *
 * **Fixture-driven test count**: each case in the JSON becomes one
 * `it.each` row, so adding a new case to the fixture automatically
 * extends this test without code change. The test itself never
 * mutates the fixture; if AppView's algorithm intentionally diverges
 * from the protocol reference (which would be a semver-major event),
 * the fix is to bump the conformance level + re-freeze the fixture
 * with the new expected outputs, NOT to weaken this test.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import {
  computeTrustScore,
  type TrustScoreInput,
} from '@/scorer/algorithms/trust-score'

// ── Fixture types (mirror packages/protocol/src/trust/score_v1.ts) ──

interface FixtureAttestation {
  sentiment: 'positive' | 'neutral' | 'negative'
  recordCreatedAtMs: number
  evidenceCount: number
  hasCosignature: boolean
  isVerified: boolean
  authorTrustScore: number | null
  authorHasInboundVouch: boolean
}

interface FixtureInput {
  attestationsAbout: FixtureAttestation[]
  vouchCount: number
  highConfidenceVouches: number
  endorsementCount: number
  activeFlagCount: number
  flagSeverities: string[]
  totalAttestationsBy: number
  revocationCount: number
  tombstoneCount: number
  helpfulReactions: number
  unhelpfulReactions: number
  withEvidenceCount: number
  inboundEdgeCount: number
  delegationInboundCount: number
}

interface FixtureExpected {
  overallScore: number
  components: {
    sentiment: number
    vouch: number
    reviewer: number
    network: number
  }
  confidence: number
}

interface FixtureCase {
  name: string
  notes?: string
  input: FixtureInput
  expected_output: FixtureExpected
}

interface Fixture {
  name: string
  scenario: { now_ms: number }
  cases: FixtureCase[]
}

const FIXTURE_PATH = resolve(
  __dirname,
  '../../../packages/protocol/conformance/vectors/trust_score_v1.json',
)

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))

/**
 * Translate the protocol's portable wire shape into AppView's
 * SQL-row-shaped `TrustScoreInput`.
 *
 * The translation is intentionally narrow — it converts ONLY the
 * shape differences (ms→Date, evidenceCount→evidenceJson). All
 * other fields pass through unchanged. If AppView's input shape
 * grows a field that the fixture doesn't cover, the translation
 * defaults it to a no-signal value (caller can override via the
 * test, but the conformance contract doesn't speak to it).
 */
function translateInput(fixtureInput: FixtureInput): TrustScoreInput {
  return {
    attestationsAbout: fixtureInput.attestationsAbout.map((a) => ({
      sentiment: a.sentiment,
      recordCreatedAt: new Date(a.recordCreatedAtMs),
      // AppView reads `evidenceJson?.length`; any non-empty array
      // triggers the multiplier. The exact array contents are
      // ignored by the algorithm.
      evidenceJson: a.evidenceCount > 0 ? Array(a.evidenceCount).fill('e') : null,
      hasCosignature: a.hasCosignature,
      isVerified: a.isVerified,
      authorTrustScore: a.authorTrustScore,
      authorHasInboundVouch: a.authorHasInboundVouch,
    })),
    vouchCount: fixtureInput.vouchCount,
    highConfidenceVouches: fixtureInput.highConfidenceVouches,
    endorsementCount: fixtureInput.endorsementCount,
    activeFlagCount: fixtureInput.activeFlagCount,
    flagSeverities: fixtureInput.flagSeverities,
    totalAttestationsBy: fixtureInput.totalAttestationsBy,
    revocationCount: fixtureInput.revocationCount,
    tombstoneCount: fixtureInput.tombstoneCount,
    helpfulReactions: fixtureInput.helpfulReactions,
    unhelpfulReactions: fixtureInput.unhelpfulReactions,
    withEvidenceCount: fixtureInput.withEvidenceCount,
    inboundEdgeCount: fixtureInput.inboundEdgeCount,
    delegationInboundCount: fixtureInput.delegationInboundCount,
  }
}

describe('trust-score conformance — TN-TEST-001 / TN-PROTO-005', () => {
  beforeEach(() => {
    // Pin Date.now() to the fixture's frozen `nowMs`. AppView's
    // `daysSince()` uses Date.now() directly; without this mock the
    // recency-decay term would drift with wall-clock time and the
    // expected scores would never match.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(fixture.scenario.now_ms))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fixture metadata pins the file we expect', () => {
    // Guard against accidentally pointing at a stale fixture file:
    // the name + at-least-one-case must match.
    expect(fixture.name).toBe('trust_score_v1')
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it.each(fixture.cases)(
    'case "$name" matches frozen reference output',
    (testCase) => {
      const input = translateInput(testCase.input)
      const result = computeTrustScore(input)
      // 12 decimal places — well within IEEE 754 double precision
      // (~15 significant digits). Drift larger than this is a real
      // algorithm change, not a precision artefact.
      expect(result.overallScore).toBeCloseTo(
        testCase.expected_output.overallScore,
        12,
      )
      expect(result.components.sentiment).toBeCloseTo(
        testCase.expected_output.components.sentiment,
        12,
      )
      expect(result.components.vouch).toBeCloseTo(
        testCase.expected_output.components.vouch,
        12,
      )
      expect(result.components.reviewer).toBeCloseTo(
        testCase.expected_output.components.reviewer,
        12,
      )
      expect(result.components.network).toBeCloseTo(
        testCase.expected_output.components.network,
        12,
      )
      expect(result.confidence).toBeCloseTo(
        testCase.expected_output.confidence,
        12,
      )
    },
  )

  it('outputs always satisfy the [0, 1] invariant', () => {
    // Cross-cutting property test — the score formula must NEVER
    // produce a value outside [0, 1] regardless of inputs. The
    // clamp() at the end of computeTrustScore is the safeguard;
    // this test pins it across the full fixture sweep.
    for (const testCase of fixture.cases) {
      const result = computeTrustScore(translateInput(testCase.input))
      expect(result.overallScore).toBeGreaterThanOrEqual(0)
      expect(result.overallScore).toBeLessThanOrEqual(1)
      expect(result.confidence).toBeGreaterThanOrEqual(0)
      expect(result.confidence).toBeLessThanOrEqual(1)
    }
  })
})
