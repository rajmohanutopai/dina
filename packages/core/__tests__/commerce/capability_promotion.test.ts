/**
 * Capability promotion (§11.1, §11.3 — WS-10.6).
 *
 * §11.1 is the case for taking §11.3 literally: the existing official
 * `price_check` uses a floating-point price, and `order_status` has no pinned
 * schemas at all. Both were promoted by somebody who felt the semantics were
 * stable. So the tests here are about the gate refusing, and about the
 * additive rule refusing hardest of all.
 */

import {
  MIN_ANSWERS_PER_PROVIDER,
  MIN_INDEPENDENT_PROVIDERS,
  MIN_OBSERVATION_WINDOW_MS,
  REQUIRED_FAILURE_CODES,
  applyPromotion,
  evaluatePromotion,
  resolveCapabilityId,
  type OfficialCapability,
  type PromotionEvidence,
  type ProviderObservation,
} from '../../src/commerce/capability_promotion';

const NOW = Date.parse('2026-08-08T09:00:00.000Z');
const SCHEMA = 'sha256:' + 'a'.repeat(64);

function observation(overrides: Partial<ProviderObservation> = {}): ProviderObservation {
  return {
    providerDid: 'did:plc:supplier-one',
    schemaHash: SCHEMA,
    answeredCount: MIN_ANSWERS_PER_PROVIDER,
    failureCodes: [...REQUIRED_FAILURE_CODES],
    cardFallbackRendered: true,
    firstSeenAtMs: NOW - MIN_OBSERVATION_WINDOW_MS,
    lastSeenAtMs: NOW,
    ...overrides,
  };
}

function evidence(overrides: Partial<PromotionEvidence> = {}): PromotionEvidence {
  return {
    customCapabilityId: 'com.dinakernel.commerce.quote',
    proposedOfficialId: 'commerce.quote',
    observations: [observation(), observation({ providerDid: 'did:plc:supplier-two' })],
    actionClass: 'read',
    privacyClass: 'business_public',
    publicExposure: 'listed providers answer any buyer',
    subjectAuthorization: 'the buyer must hold a quote grant',
    observedRateLimitPerMinute: 30,
    ...overrides,
  };
}

const verdictFor = (e: PromotionEvidence, official: OfficialCapability[] = []) =>
  evaluatePromotion({ evidence: e, official, nowMs: NOW });

function refusals(e: PromotionEvidence, official: OfficialCapability[] = []): string[] {
  const verdict = verdictFor(e, official);
  return verdict.eligible ? [] : verdict.findings.map((f) => f.refusal);
}

describe('a capability that has earned it', () => {
  it('is eligible, and the custom id survives as an alias (§11.3)', () => {
    const verdict = verdictFor(evidence());
    expect(verdict.eligible).toBe(true);
    if (!verdict.eligible) return;
    expect(verdict.official).toEqual({
      capabilityId: 'commerce.quote',
      schemaHash: SCHEMA,
      actionClass: 'read',
      privacyClass: 'business_public',
      // ADDITIVE: dropping the custom id would break every install already
      // calling it.
      aliases: ['com.dinakernel.commerce.quote'],
    });
  });
});

describe('§11.3 seven proofs, each refused on its own', () => {
  it('refuses one provider — that is an API, not a contract', () => {
    expect(refusals(evidence({ observations: [observation()] }))).toContain('single_provider');
  });

  it('refuses two observations from ONE provider wearing two rows', () => {
    // Independence is counted by DID, not by row count.
    expect(refusals(evidence({ observations: [observation(), observation()] }))).toContain(
      'single_provider',
    );
  });

  it('refuses providers answering different pinned schemas', () => {
    expect(
      refusals(
        evidence({
          observations: [
            observation(),
            observation({
              providerDid: 'did:plc:supplier-two',
              schemaHash: 'sha256:' + 'b'.repeat(64),
            }),
          ],
        }),
      ),
    ).toContain('schema_not_stable');
  });

  it('refuses a provider observed too few times', () => {
    expect(
      refusals(
        evidence({
          observations: [
            observation({ answeredCount: MIN_ANSWERS_PER_PROVIDER - 1 }),
            observation({ providerDid: 'did:plc:supplier-two' }),
          ],
        }),
      ),
    ).toContain('insufficient_observation');
  });

  it('refuses behaviour that has not held for a release cycle', () => {
    expect(
      refusals(
        evidence({
          observations: [
            observation({ firstSeenAtMs: NOW - MIN_OBSERVATION_WINDOW_MS + 1 }),
            observation({ providerDid: 'did:plc:supplier-two' }),
          ],
        }),
      ),
    ).toContain('observation_window_too_short');
  });

  it('refuses an undeclared action or privacy class', () => {
    expect(refusals(evidence({ actionClass: '' }))).toContain('class_not_declared');
    expect(refusals(evidence({ privacyClass: '' }))).toContain('class_not_declared');
  });

  it('refuses undeclared exposure or subject authorization', () => {
    expect(refusals(evidence({ publicExposure: '' }))).toContain('exposure_not_declared');
    expect(refusals(evidence({ subjectAuthorization: '' }))).toContain('exposure_not_declared');
  });

  it('refuses an answer that does not render on the generic card', () => {
    expect(
      refusals(
        evidence({
          observations: [
            observation({ cardFallbackRendered: false }),
            observation({ providerDid: 'did:plc:supplier-two' }),
          ],
        }),
      ),
    ).toContain('card_fallback_missing');
  });

  it('refuses a provider that never distinguished refusal from unavailability', () => {
    // "You may not" and "not right now" lead a buyer to different next steps.
    expect(
      refusals(
        evidence({
          observations: [
            observation({ failureCodes: ['refused'] }),
            observation({ providerDid: 'did:plc:supplier-two' }),
          ],
        }),
      ),
    ).toContain('failure_codes_not_interoperable');
  });

  it('refuses when rate-limit behaviour was never observed', () => {
    expect(refusals(evidence({ observedRateLimitPerMinute: 0 }))).toContain(
      'no_rate_limit_evidence',
    );
  });

  it('reports EVERY failing proof, not the first', () => {
    // An operator fixing a promotion one refusal at a time gives up.
    const found = refusals(
      evidence({
        observations: [observation({ answeredCount: 1, cardFallbackRendered: false })],
        actionClass: '',
        observedRateLimitPerMinute: 0,
      }),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        'single_provider',
        'insufficient_observation',
        'class_not_declared',
        'card_fallback_missing',
        'no_rate_limit_evidence',
      ]),
    );
  });
});

describe('the additive rule (§11.3)', () => {
  const officialQuote: OfficialCapability = {
    capabilityId: 'commerce.quote',
    schemaHash: SCHEMA,
    actionClass: 'read',
    privacyClass: 'business_public',
    aliases: ['com.dinakernel.commerce.quote'],
  };

  it('refuses a promotion that would change an existing schema', () => {
    // This is `price_check` happening again: an official id quietly meaning
    // something its callers cannot use.
    const found = refusals(
      evidence({
        observations: [
          observation({ schemaHash: 'sha256:' + 'c'.repeat(64) }),
          observation({
            providerDid: 'did:plc:supplier-two',
            schemaHash: 'sha256:' + 'c'.repeat(64),
          }),
        ],
      }),
      [officialQuote],
    );
    expect(found).toContain('would_reinterpret_existing');
  });

  it('refuses a promotion that would change an action or privacy class', () => {
    expect(refusals(evidence({ actionClass: 'effect' }), [officialQuote])).toContain(
      'would_reinterpret_existing',
    );
    expect(refusals(evidence({ privacyClass: 'private' }), [officialQuote])).toContain(
      'would_reinterpret_existing',
    );
  });

  it('permits re-promoting the SAME contract, and does not duplicate the alias', () => {
    const verdict = verdictFor(evidence(), [officialQuote]);
    expect(verdict.eligible).toBe(true);
    if (!verdict.eligible) return;
    expect(verdict.official.aliases).toEqual(['com.dinakernel.commerce.quote']);
  });

  it('adds a second alias without dropping the first', () => {
    const verdict = verdictFor(evidence({ customCapabilityId: 'com.example.quote' }), [
      officialQuote,
    ]);
    expect(verdict.eligible).toBe(true);
    if (!verdict.eligible) return;
    expect(verdict.official.aliases).toEqual([
      'com.dinakernel.commerce.quote',
      'com.example.quote',
    ]);
  });

  it('refuses a custom id already aliased to a DIFFERENT official capability', () => {
    // One custom id aliasing two official ones means a caller gets different
    // semantics depending on which resolver they hit.
    const found = refusals(evidence({ proposedOfficialId: 'commerce.quote.v2' }), [officialQuote]);
    expect(found).toContain('alias_already_bound');
  });

  it('does not compare against one competitor when the schemas disagree', () => {
    // Providers disagree, AND one of their hashes happens to match what is
    // already official. Comparing against that one would hide the additive
    // finding behind `schema_not_stable`: an operator would fix the providers,
    // re-promote, and only then discover the promotion also reinterprets.
    const found = refusals(
      evidence({
        observations: [
          observation({ schemaHash: SCHEMA }),
          observation({
            providerDid: 'did:plc:supplier-two',
            schemaHash: 'sha256:' + 'd'.repeat(64),
          }),
        ],
      }),
      [{ ...officialQuote, schemaHash: SCHEMA }],
    );
    expect(found).toContain('schema_not_stable');
    // BOTH findings, because both are true and the operator needs both.
    expect(found).toContain('would_reinterpret_existing');
  });

  it('checks the additive rule even when the evidence is otherwise perfect', () => {
    const verdict = verdictFor(evidence({ actionClass: 'effect' }), [officialQuote]);
    expect(verdict.eligible).toBe(false);
  });
});

describe('applying a promotion', () => {
  const existing: OfficialCapability = {
    capabilityId: 'commerce.order',
    schemaHash: SCHEMA,
    actionClass: 'effect',
    privacyClass: 'business_public',
    aliases: [],
  };

  it('returns a new catalog and leaves the old one untouched', () => {
    const before = [existing];
    const verdict = verdictFor(evidence());
    expect(verdict.eligible).toBe(true);
    if (!verdict.eligible) return;
    const after = applyPromotion(before, verdict.official);
    // A promotion an owner rejected must leave nothing behind.
    expect(before).toEqual([existing]);
    expect(after.map((c) => c.capabilityId)).toEqual(['commerce.order', 'commerce.quote']);
  });

  it('replaces rather than duplicates when the id is already there', () => {
    const verdict = verdictFor(evidence());
    expect(verdict.eligible).toBe(true);
    if (!verdict.eligible) return;
    const once = applyPromotion([], verdict.official);
    const twice = applyPromotion(once, verdict.official);
    expect(twice).toEqual(once);
  });
});

describe('resolving an id through its aliases', () => {
  const catalog: OfficialCapability[] = [
    {
      capabilityId: 'commerce.quote',
      schemaHash: SCHEMA,
      actionClass: 'read',
      privacyClass: 'business_public',
      aliases: ['com.dinakernel.commerce.quote'],
    },
  ];

  it('resolves an official id directly', () => {
    expect(resolveCapabilityId(catalog, 'commerce.quote')).toEqual({
      capabilityId: 'commerce.quote',
      viaAlias: false,
    });
  });

  it('resolves a custom id and SAYS it was an alias', () => {
    // §11.3's "never silently reinterpreted" has a read side: the caller must
    // be able to see the translation rather than have it hidden.
    expect(resolveCapabilityId(catalog, 'com.dinakernel.commerce.quote')).toEqual({
      capabilityId: 'commerce.quote',
      viaAlias: true,
    });
  });

  it('answers null for an id nobody claims', () => {
    expect(resolveCapabilityId(catalog, 'commerce.nothing')).toBeNull();
  });
});

describe('the constants say why they are what they are', () => {
  it('needs at least two independent providers', () => {
    expect(MIN_INDEPENDENT_PROVIDERS).toBeGreaterThanOrEqual(2);
  });

  it('observes for at least a release cycle', () => {
    expect(MIN_OBSERVATION_WINDOW_MS).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000);
  });

  it('requires both a refusal and an unavailability code', () => {
    expect([...REQUIRED_FAILURE_CODES].sort()).toEqual(['refused', 'unavailable']);
  });
});
