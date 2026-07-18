/**
 * ISVC-4 — frozen Core delivery evaluation order (§9.1). Pure.
 */

import { ceilingRank, computeFinalTier } from '../../src/run/delivery';

describe('computeFinalTier (§9.1)', () => {
  it('action gets the Core Tier-2 base (Brain not consulted)', () => {
    const r = computeFinalTier({ kind: 'action', brainCandidate: 3, priorityCeiling: 'solicited', timedOut: false });
    // even a Tier-3 "candidate" is ignored for actions
    expect(r).toEqual({ tier: 2, tier_source: 'action_base' });
  });

  it('owner engagement ceiling quiets an action to briefing (step 2)', () => {
    const r = computeFinalTier({ kind: 'action', brainCandidate: null, priorityCeiling: 'engagement', timedOut: false });
    expect(r).toEqual({ tier: 3, tier_source: 'action_base' });
  });

  it('informational takes the Brain candidate', () => {
    const r = computeFinalTier({ kind: 'informational', brainCandidate: 2, priorityCeiling: 'solicited', timedOut: false });
    expect(r).toEqual({ tier: 2, tier_source: 'brain_candidate' });
  });

  it('a Brain candidate can never RAISE loudness above the ceiling (quieter-of)', () => {
    // candidate says Tier-2 (louder) but ceiling is engagement(3) → clamp to 3
    const r = computeFinalTier({ kind: 'informational', brainCandidate: 2, priorityCeiling: 'engagement', timedOut: false });
    expect(r?.tier).toBe(3);
  });

  it('Brain routing an informational message to briefing (candidate=3) is honored', () => {
    const r = computeFinalTier({ kind: 'informational', brainCandidate: 3, priorityCeiling: 'solicited', timedOut: false });
    expect(r).toEqual({ tier: 3, tier_source: 'brain_candidate' });
  });

  it('classify timeout finalizes an informational message at the ceiling', () => {
    const r = computeFinalTier({ kind: 'informational', brainCandidate: null, priorityCeiling: 'solicited', timedOut: true });
    expect(r).toEqual({ tier: 2, tier_source: 'classify_timeout_ceiling' });
  });

  it('an informational message that is neither classified nor timed out is not finalizable', () => {
    expect(
      computeFinalTier({ kind: 'informational', brainCandidate: null, priorityCeiling: 'solicited', timedOut: false }),
    ).toBeNull();
  });

  it('ceilingRank: larger = quieter', () => {
    expect(ceilingRank('fiduciary')).toBe(1);
    expect(ceilingRank('solicited')).toBe(2);
    expect(ceilingRank('engagement')).toBe(3);
  });
});
