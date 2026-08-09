/**
 * Idempotency evidence (§15.5 — WS-9.4).
 *
 * §15.5's closing sentence is the requirement: "No layer may declare
 * idempotency merely because Dina deduplicates its own task row... until a
 * connector proves that with the same key and retention window, automatic
 * resubmission stays disabled."
 *
 * So the first test is the default, and it is the one that matters: a
 * connector nobody probed gets `manual_only`. Everything after it is a way of
 * NOT earning `automatic`.
 */

import {
  DEFAULT_RETENTION_REQUIREMENT,
  EVIDENCE_MAX_AGE_MS,
  MIN_PROBE_GAP_MS,
  evaluateIdempotencyEvidence,
  requiredRetentionMs,
  resubmissionPolicy,
  type IdempotencyEvidence,
  type IdempotencyProbe,
} from '../../src/commerce/idempotency_evidence';

const NOW = Date.parse('2026-08-08T09:00:00.000Z');
const REQUIRED = requiredRetentionMs(DEFAULT_RETENTION_REQUIREMENT);

function probe(overrides: Partial<IdempotencyProbe> = {}): IdempotencyProbe {
  return {
    idempotencyKey: 'idem-1',
    firstExternalRef: 'EXT-100',
    secondExternalRef: 'EXT-100',
    secondCreatedNewOrder: false,
    firstAtMs: NOW - 2 * MIN_PROBE_GAP_MS,
    secondAtMs: NOW - MIN_PROBE_GAP_MS,
    ...overrides,
  };
}

function evidence(overrides: Partial<IdempotencyEvidence> = {}): IdempotencyEvidence {
  return {
    resource: 'erp.primary',
    operation: 'submit_purchase_order',
    declaredRetentionMs: REQUIRED,
    probe: probe(),
    recordedAtMs: NOW - 1_000,
    ...overrides,
  };
}

function verdictFor(e: IdempotencyEvidence | null, nowMs = NOW) {
  return evaluateIdempotencyEvidence({
    evidence: e,
    requirement: DEFAULT_RETENTION_REQUIREMENT,
    nowMs,
  });
}

describe('the default is manual, and it takes an observation to change it', () => {
  it('refuses when no evidence was ever recorded', () => {
    const verdict = verdictFor(null);
    expect(verdict).toEqual({
      proven: false,
      refusal: 'no_probe',
      detail: expect.any(String),
    });
    expect(resubmissionPolicy(verdict)).toBe('manual_only');
  });

  it('refuses a declaration with no observation behind it', () => {
    // §15.5's "merely because" case: the connector SAYS it is idempotent.
    const verdict = verdictFor(evidence({ probe: null }));
    expect(verdict.proven).toBe(false);
    if (!verdict.proven) expect(verdict.refusal).toBe('no_probe');
  });

  it('accepts a probe that showed one order and a long enough memory', () => {
    const verdict = verdictFor(evidence());
    expect(verdict).toEqual({ proven: true, retentionMs: REQUIRED });
    expect(resubmissionPolicy(verdict)).toBe('automatic');
  });

  it('reports the DECLARED window, not the requirement it cleared', () => {
    // A retry decision should be made against what the connector actually
    // promises, which is usually more than the bar.
    const verdict = verdictFor(evidence({ declaredRetentionMs: REQUIRED * 3 }));
    expect(verdict).toEqual({ proven: true, retentionMs: REQUIRED * 3 });
  });
});

describe('ways an observation fails to prove anything', () => {
  it('refuses when the external system made a second order', () => {
    const verdict = verdictFor(evidence({ probe: probe({ secondCreatedNewOrder: true }) }));
    expect(verdict.proven).toBe(false);
    if (!verdict.proven) expect(verdict.refusal).toBe('probe_created_second_order');
  });

  it('refuses when the two attempts resolved to different orders', () => {
    const verdict = verdictFor(evidence({ probe: probe({ secondExternalRef: 'EXT-101' }) }));
    expect(verdict.proven).toBe(false);
    if (!verdict.proven) expect(verdict.refusal).toBe('external_ref_mismatch');
  });

  it('refuses when the connector returned no reference at all', () => {
    // Two empty strings are EQUAL, which a naive comparison would accept. A
    // connector that reports nothing has not shown the attempts converged; it
    // has shown it cannot tell.
    const verdict = verdictFor(
      evidence({ probe: probe({ firstExternalRef: '', secondExternalRef: '' }) }),
    );
    expect(verdict.proven).toBe(false);
    if (!verdict.proven) expect(verdict.refusal).toBe('external_ref_mismatch');
  });

  it('refuses a probe that sent no key', () => {
    const verdict = verdictFor(evidence({ probe: probe({ idempotencyKey: '' }) }));
    expect(verdict.proven).toBe(false);
    if (!verdict.proven) expect(verdict.refusal).toBe('probe_key_unused');
  });

  it('refuses two attempts close enough for an in-flight lock to explain', () => {
    // The retry that matters happens after a crash, when no request-scoped
    // lock survives. Two calls a second apart test the wrong mechanism.
    const verdict = verdictFor(
      evidence({ probe: probe({ firstAtMs: NOW - 1_000, secondAtMs: NOW - 500 }) }),
    );
    expect(verdict.proven).toBe(false);
    if (!verdict.proven) expect(verdict.refusal).toBe('probe_window_too_narrow');
  });

  it('accepts a gap exactly at the minimum and refuses one millisecond under', () => {
    const at = (gap: number): IdempotencyEvidence =>
      evidence({ probe: probe({ firstAtMs: NOW - gap, secondAtMs: NOW }) });
    expect(verdictFor(at(MIN_PROBE_GAP_MS)).proven).toBe(true);
    expect(verdictFor(at(MIN_PROBE_GAP_MS - 1)).proven).toBe(false);
  });
});

describe('the retention window is part of the proof (§15.5)', () => {
  it('refuses a connector that forgets sooner than the required sum', () => {
    const verdict = verdictFor(evidence({ declaredRetentionMs: REQUIRED - 1 }));
    expect(verdict.proven).toBe(false);
    if (!verdict.proven) {
      expect(verdict.refusal).toBe('retention_too_short');
      // The detail names BOTH numbers: an operator told only "too short" has
      // to guess by how much.
      expect(verdict.detail).toContain(String(REQUIRED));
      expect(verdict.detail).toContain(String(REQUIRED - 1));
    }
  });

  it('is the sum of the three parts §15.5 names', () => {
    expect(REQUIRED).toBe(
      DEFAULT_RETENTION_REQUIREMENT.quoteValidityMs +
        DEFAULT_RETENTION_REQUIREMENT.reconciliationWindowMs +
        DEFAULT_RETENTION_REQUIREMENT.commercialRetentionMs,
    );
  });

  it('follows a shorter requirement when the owner configures one', () => {
    // §15.5 says "the CONFIGURED commercial-retention period", so this is a
    // policy number rather than a protocol constant.
    const short = { quoteValidityMs: 1, reconciliationWindowMs: 1, commercialRetentionMs: 1 };
    expect(
      evaluateIdempotencyEvidence({
        evidence: evidence({ declaredRetentionMs: 3 }),
        requirement: short,
        nowMs: NOW,
      }),
    ).toEqual({ proven: true, retentionMs: 3 });
  });
});

describe('evidence goes stale', () => {
  it('refuses an observation older than what it is trusted for', () => {
    const verdict = verdictFor(evidence({ recordedAtMs: NOW - EVIDENCE_MAX_AGE_MS - 1 }), NOW);
    expect(verdict.proven).toBe(false);
    if (!verdict.proven) expect(verdict.refusal).toBe('evidence_expired');
  });

  it('still trusts an observation exactly at the limit', () => {
    expect(verdictFor(evidence({ recordedAtMs: NOW - EVIDENCE_MAX_AGE_MS }), NOW).proven).toBe(
      true,
    );
  });

  it('reports the missing observation before the stale one', () => {
    // Order of checks is the order an operator wants to hear about them: a
    // connector with no probe AND an old record should be told to probe, not
    // told its absent probe expired.
    const verdict = verdictFor(
      evidence({ probe: null, recordedAtMs: NOW - EVIDENCE_MAX_AGE_MS - 1 }),
    );
    expect(verdict.proven).toBe(false);
    if (!verdict.proven) expect(verdict.refusal).toBe('no_probe');
  });
});
