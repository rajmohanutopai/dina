/**
 * PLG-5 — evaluatePluginIntent (PLUGIN_ARCHITECTURE.md §8).
 *
 * Deterministic table + clamps; every rule gets a direct assertion and
 * the ordering claims (BRAIN_DENIED before risk lookup; payment blocked
 * at EVERY ring; declared may only raise) are each pinned.
 */

import {
  PLUGIN_ACTION_FLOORS,
  PLUGIN_FIRST_N,
  evaluatePluginIntent,
  type PluginIntentInput,
} from '../../src/gatekeeper/intent';

function input(overrides: Partial<PluginIntentInput> = {}): PluginIntentInput {
  return {
    actionClass: 'read',
    capabilityId: 'com.acme.flightwatch.watch',
    capabilityKind: 'custom',
    publisherRing: 'verified',
    touchesSensitivePersona: false,
    touchesLockedPersona: false,
    priorInvocations: 10,
    hasStandingApproval: false,
    ...overrides,
  };
}

describe('floors (§8)', () => {
  it('pins the floor table', () => {
    expect(PLUGIN_ACTION_FLOORS).toEqual({
      read: 'SAFE',
      quote: 'SAFE',
      booking: 'HIGH',
      write: 'HIGH',
      agentic: 'HIGH',
      payment: 'BLOCKED',
    });
  });

  it('canonical read/quote are SAFE and silent (params-egress still gates downstream)', () => {
    for (const actionClass of ['read', 'quote']) {
      const d = evaluatePluginIntent(input({ actionClass, capabilityKind: 'canonical' }));
      expect(d.riskLevel).toBe('SAFE');
      expect(d.mode).toBe('silent');
      expect(d.audit).toBe(false);
    }
  });

  it('custom ids never floor below MODERATE — declared class is a consent label, not proof', () => {
    const d = evaluatePluginIntent(input({ actionClass: 'read', capabilityKind: 'custom' }));
    expect(d.riskLevel).toBe('MODERATE');
    expect(d.mode).toBe('card');
  });

  it('a custom read runs silently ONLY after a standing approval (§8)', () => {
    const d = evaluatePluginIntent(
      input({ actionClass: 'read', capabilityKind: 'custom', hasStandingApproval: true }),
    );
    expect(d.mode).toBe('silent');
    expect(d.audit).toBe(true); // silent-via-grant still audited
  });

  it('booking/write/agentic floor HIGH', () => {
    for (const actionClass of ['booking', 'write', 'agentic']) {
      const d = evaluatePluginIntent(input({ actionClass, capabilityKind: 'canonical' }));
      expect(d.riskLevel).toBe('HIGH');
      expect(d.mode).toBe('card');
    }
  });

  it('payment is BLOCKED at every ring, forever — even verified_actioned with a standing approval', () => {
    for (const ring of ['unverified', 'verified', 'verified_actioned'] as const) {
      const d = evaluatePluginIntent(
        input({
          actionClass: 'payment',
          publisherRing: ring,
          hasStandingApproval: true,
          capabilityKind: 'canonical',
        }),
      );
      expect(d.riskLevel).toBe('BLOCKED');
      expect(d.allowed).toBe(false);
      expect(d.mode).toBe('blocked');
    }
  });

  it('unknown action class fails safe to MODERATE (§8: ?? MODERATE)', () => {
    const d = evaluatePluginIntent(input({ actionClass: 'levitate' }));
    expect(d.riskLevel).toBe('MODERATE');
    expect(d.mode).toBe('card');
  });
});

describe('ordering claims', () => {
  it('BRAIN_DENIED runs before risk lookup — a capability id naming did_sign blocks outright', () => {
    const d = evaluatePluginIntent(
      input({
        capabilityId: 'com.evil.wallet.did_sign',
        actionClass: 'read',
        capabilityKind: 'canonical',
      }),
    );
    expect(d.riskLevel).toBe('BLOCKED');
    expect(d.reason).toContain('brain-denied');
  });

  it('locked personas are never in scope — block before any floor math (§11)', () => {
    const d = evaluatePluginIntent(
      input({ touchesLockedPersona: true, hasStandingApproval: true }),
    );
    expect(d.mode).toBe('blocked');
  });

  it('declared risk may only RAISE: declared SAFE on booking stays HIGH; declared HIGH on read raises', () => {
    const lowball = evaluatePluginIntent(
      input({ actionClass: 'booking', declaredRisk: 'SAFE', capabilityKind: 'canonical' }),
    );
    expect(lowball.riskLevel).toBe('HIGH');

    const honest = evaluatePluginIntent(
      input({ actionClass: 'read', declaredRisk: 'HIGH', capabilityKind: 'canonical' }),
    );
    expect(honest.riskLevel).toBe('HIGH');
  });

  it('AUDIT D5: an out-of-enum declared risk fails toward BLOCKED, never LOWERS the floor to a garbage level', () => {
    // maxRisk used to return the garbage string (RISK_ORDER[garbage] is
    // undefined; n >= undefined is always false), so a HIGH floor could
    // be "lowered" to an invalid level and run silent.
    const d = evaluatePluginIntent(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      input({
        actionClass: 'read',
        capabilityKind: 'canonical',
        declaredRisk: 'totally-safe-trust-me' as any,
      }),
    );
    expect(d.mode).toBe('blocked');
    expect(d.riskLevel).toBe('BLOCKED');
  });
});

describe('clamps', () => {
  it('unverified publisher: nothing runs silent (SAFE → MODERATE)', () => {
    const d = evaluatePluginIntent(
      input({ actionClass: 'read', capabilityKind: 'canonical', publisherRing: 'unverified' }),
    );
    expect(d.riskLevel).toBe('MODERATE');
    expect(d.mode).toBe('card');
  });

  it('sensitive-persona scope cards EVERY invocation — a standing approval never silences it', () => {
    const d = evaluatePluginIntent(
      input({
        actionClass: 'read',
        capabilityKind: 'canonical',
        touchesSensitivePersona: true,
        hasStandingApproval: true,
        priorInvocations: 100,
      }),
    );
    expect(d.riskLevel).toBe('HIGH');
    expect(d.mode).toBe('card');
  });
});

describe('first-N rule (§8)', () => {
  const base = {
    actionClass: 'booking',
    capabilityKind: 'canonical' as const,
    hasStandingApproval: true,
  };

  it(`invocations 1..${PLUGIN_FIRST_N} card despite a standing approval`, () => {
    for (let prior = 0; prior < PLUGIN_FIRST_N; prior++) {
      const d = evaluatePluginIntent(input({ ...base, priorInvocations: prior }));
      expect(d.mode).toBe('card');
      expect(d.firstNCard).toBe(true);
    }
  });

  it(`invocation ${PLUGIN_FIRST_N + 1} onward runs silent under the approval`, () => {
    const d = evaluatePluginIntent(input({ ...base, priorInvocations: PLUGIN_FIRST_N }));
    expect(d.mode).toBe('silent');
    expect(d.firstNCard).toBe(false);
    expect(d.audit).toBe(true);
  });

  it('without an approval, HIGH cards regardless of invocation count', () => {
    const d = evaluatePluginIntent(
      input({ ...base, hasStandingApproval: false, priorInvocations: 50 }),
    );
    expect(d.mode).toBe('card');
    expect(d.firstNCard).toBe(false);
  });
});

describe('privacy-class clamp (Round-6 #2)', () => {
  it('a non-public privacy_class raises the floor — a canonical read is no longer silent', () => {
    // Baseline: canonical read is SAFE + silent.
    expect(
      evaluatePluginIntent(input({ actionClass: 'read', capabilityKind: 'canonical' })).mode,
    ).toBe('silent');
    // `personal` → MODERATE (never silent).
    const personal = evaluatePluginIntent(
      input({ actionClass: 'read', capabilityKind: 'canonical', privacyClass: 'personal' }),
    );
    expect(personal.riskLevel).toBe('MODERATE');
    expect(personal.mode).toBe('card');
    // `sensitive` / `regulated` → HIGH (explicit approval).
    for (const privacyClass of ['sensitive', 'regulated']) {
      const d = evaluatePluginIntent(
        input({ actionClass: 'read', capabilityKind: 'canonical', privacyClass }),
      );
      expect(d.riskLevel).toBe('HIGH');
      expect(d.mode).toBe('card');
    }
    // `public` (or unset) → no clamp; stays SAFE + silent.
    expect(
      evaluatePluginIntent(
        input({ actionClass: 'read', capabilityKind: 'canonical', privacyClass: 'public' }),
      ).mode,
    ).toBe('silent');
  });

  it('round-7 #1: sensitive/regulated cards EVERY time — a standing approval past first-N never silences it', () => {
    for (const privacyClass of ['sensitive', 'regulated']) {
      const d = evaluatePluginIntent(
        input({
          actionClass: 'read',
          capabilityKind: 'canonical',
          privacyClass,
          hasStandingApproval: true,
          priorInvocations: PLUGIN_FIRST_N + 5, // well past first-N
          touchesSensitivePersona: false,
        }),
      );
      expect(d.riskLevel).toBe('HIGH');
      expect(d.mode).toBe('card'); // NOT silent, despite standing approval
    }
    // `personal` (MODERATE) is still silence-able via a standing approval.
    expect(
      evaluatePluginIntent(
        input({
          actionClass: 'read',
          capabilityKind: 'canonical',
          privacyClass: 'personal',
          hasStandingApproval: true,
          priorInvocations: PLUGIN_FIRST_N + 5,
        }),
      ).mode,
    ).toBe('silent');
  });
});
