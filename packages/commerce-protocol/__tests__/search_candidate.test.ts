/**
 * §10.5 search candidates, pinned by a frozen vector.
 *
 * WHY THIS VECTOR IS DIFFERENT FROM THE OTHERS. Every other frozen vector
 * pins what a PUBLISHER emits. This one pins what a CONSUMER returns — the
 * catalog AppView — and the AppView is a separate deployment that cannot
 * import this package. So the vector is the only thing keeping its projection
 * and this validator agreeing: the AppView asserts it produces exactly
 * `candidate`, and this asserts the validator accepts that object and refuses
 * each `invalid` case with the stated string.
 *
 * A red test here means one side moved. Fix the code, never the vector.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateCommerceSearchCandidate } from '../src/search';

interface CandidateVectors {
  candidate: unknown;
  invalid: { name: string; value: unknown; expect: string }[];
}

const vectors = JSON.parse(
  readFileSync(join(__dirname, '..', 'conformance', 'vectors', 'search_candidate.json'), 'utf8'),
) as CandidateVectors;

describe('§10.5 search candidate', () => {
  it('accepts the frozen candidate', () => {
    expect(validateCommerceSearchCandidate(vectors.candidate)).toBeNull();
  });

  it.each(vectors.invalid.map((c) => [c.name, c] as const))(
    'refuses %s with the frozen string',
    (_name, testCase) => {
      // The STRING, not merely the fact of refusal: an operator reading logs
      // from two implementations must see the same words for the same fault.
      expect(validateCommerceSearchCandidate(testCase.value)).toBe(testCase.expect);
    },
  );

  it('refuses a candidate that is not an object at all', () => {
    for (const value of [null, undefined, 'candidate', 42, []]) {
      expect(validateCommerceSearchCandidate(value)).not.toBeNull();
    }
  });

  it('accepts a candidate with no price and no expiry', () => {
    // Absence is a legitimate claim: not every catalog publishes an indicative
    // price, and a snapshot with no `valid_until` never expires. Requiring
    // them would push implementations to invent a zero.
    const bare = { ...(vectors.candidate as Record<string, unknown>) };
    delete bare.indicative_price;
    delete bare.valid_until;
    expect(validateCommerceSearchCandidate(bare)).toBeNull();
  });

  it('refuses a non-UTC timestamp', () => {
    // An offset canonicalizes to different bytes, so two implementations would
    // disagree about freshness for the same instant.
    const shifted = {
      ...(vectors.candidate as Record<string, unknown>),
      generated_at: '2026-08-08T09:00:00.000+05:30',
    };
    expect(validateCommerceSearchCandidate(shifted)).not.toBeNull();
  });
});
