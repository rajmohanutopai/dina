/**
 * Edit-flow data layer tests (TN-MOB-025).
 *
 * Pins:
 *   - `deriveEditWarning(0)` is null — no surprise modal when nothing breaks.
 *   - Singular vs plural copy at cosigCount 1 vs ≥ 2.
 *   - Plan §8.6 wording survives (cosigCount appears in the body;
 *     "release" verb appears so a copy edit can't accidentally
 *     downgrade the warning to a soft "you may need to re-ask").
 *   - Negative / non-finite counts coerce to 0 (defensive; no panicky
 *     modal from bad wire data).
 *   - `buildEditPlan` rejects empty / non-atproto `originalUri` —
 *     a missing URI silently coerced to "create new" would lose
 *     history.
 *
 * Pure function — runs under plain Jest, no RN deps.
 */

import { buildEditPlan, deriveEditWarning } from '../../src/trust/edit_flow';

import type { Attestation } from '@dina/protocol';

function attestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    subject: { type: 'product', name: 'Aeron Chair' },
    category: 'office_furniture',
    sentiment: 'positive',
    text: 'Updated body',
    createdAt: '2026-04-29T12:00:00Z',
    ...overrides,
  };
}

// ─── deriveEditWarning ────────────────────────────────────────────────────

describe('deriveEditWarning', () => {
  it('returns null when cosigCount is 0 (no warning needed)', () => {
    expect(deriveEditWarning(0)).toBeNull();
  });

  it('returns singular copy for cosigCount 1', () => {
    const w = deriveEditWarning(1);
    if (w === null) throw new Error('expected warning at cosigCount=1');
    expect(w.kind).toBe('cosig_release');
    expect(w.cosigCount).toBe(1);
    expect(w.body).toContain('1 cosignature');
    expect(w.body).not.toContain('cosignatures'); // not plural
    expect(w.body).toContain('the cosigner');
  });

  it('returns plural copy for cosigCount 2+', () => {
    const w = deriveEditWarning(3);
    if (w === null) throw new Error('expected warning at cosigCount=3');
    expect(w.cosigCount).toBe(3);
    expect(w.body).toContain('3 cosignatures');
    expect(w.body).toContain('the cosigners');
  });

  it('preserves the plan §8.6 "release" verb (regression guard against soft-edit copy)', () => {
    const w1 = deriveEditWarning(1);
    const w5 = deriveEditWarning(5);
    if (w1 === null || w5 === null) throw new Error('expected warnings');
    expect(w1.body).toMatch(/release/i);
    expect(w5.body).toMatch(/release/i);
  });

  it('proceed CTA is explicit ("Edit anyway") not generic ("OK")', () => {
    const w = deriveEditWarning(2);
    if (w === null) throw new Error('expected warning at cosigCount=2');
    expect(w.proceedLabel).toBe('Edit anyway');
    expect(w.cancelLabel).toBe('Keep as is');
  });

  it('coerces negative / non-finite counts to 0 (defensive)', () => {
    expect(deriveEditWarning(-1)).toBeNull();
    expect(deriveEditWarning(Number.NaN)).toBeNull();
    expect(deriveEditWarning(Number.POSITIVE_INFINITY)).toBeNull();
    expect(deriveEditWarning(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('floors non-integer counts (a card never says "1.7 cosignatures")', () => {
    const w = deriveEditWarning(2.7);
    if (w === null) throw new Error('expected warning at cosigCount=2.7');
    expect(w.cosigCount).toBe(2);
    expect(w.body).toContain('2 cosignatures');
  });
});

// ─── buildEditPlan ────────────────────────────────────────────────────────

describe('buildEditPlan', () => {
  const baseUri = 'at://did:plc:author/com.dina.trust.attestation/abc123';

  it('returns the delete URI + new record + warning bundle', () => {
    const updated = attestation({ text: 'I changed my mind' });
    const plan = buildEditPlan({
      originalUri: baseUri,
      updatedRecord: updated,
      cosigCount: 0,
    });
    expect(plan.deleteUri).toBe(baseUri);
    expect(plan.republishRecord).toBe(updated); // identity preserved
    expect(plan.warning).toBeNull();
  });

  it('threads the warning through when cosigCount > 0', () => {
    const plan = buildEditPlan({
      originalUri: baseUri,
      updatedRecord: attestation(),
      cosigCount: 2,
    });
    if (plan.warning === null) throw new Error('expected warning when cosigCount=2');
    expect(plan.warning.kind).toBe('cosig_release');
    expect(plan.warning.cosigCount).toBe(2);
  });

  it('rejects empty / non-string originalUri', () => {
    const updated = attestation();
    expect(() =>
      buildEditPlan({ originalUri: '', updatedRecord: updated, cosigCount: 0 }),
    ).toThrow();
    expect(() =>
      // @ts-expect-error — runtime guard for callers ignoring TS
      buildEditPlan({ originalUri: undefined, updatedRecord: updated, cosigCount: 0 }),
    ).toThrow();
  });

  it('rejects non-atproto originalUri (caller bug — would lose history)', () => {
    expect(() =>
      buildEditPlan({
        originalUri: 'https://example.com/whatever',
        updatedRecord: attestation(),
        cosigCount: 0,
      }),
    ).toThrow(/atproto URI/);
  });
});
