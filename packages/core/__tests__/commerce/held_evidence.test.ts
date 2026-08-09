/**
 * §12.7/§16.2 — held evidence a supplier can actually check.
 *
 * WHY THIS FILE EXISTS. Every other test in this directory stubs the
 * verifier with `() => true`, which is right for them: they are about
 * what a supplier DOES with evidence it trusts. Nothing tested whether
 * the trust was earned. It could not: the old callback received a record
 * and a hash of that record, so the only implementations possible were
 * "always true" and "always false".
 *
 * These cases drive the real verifier and the real binding checks, and
 * every one of them is a way a buyer could have lied. `never_received`
 * is the single answer that authorizes resubmitting an order, so each
 * lie that gets through is a duplicate order.
 */

import {
  BUYER_DID,
  SUPPLIER_DID,
  SUPPLIER_PUBLIC_KEY,
  makeHeldEvidence,
  realHeldEvidenceVerifier,
  supplierKeyResolver,
} from './helpers';

import { makeHeldEvidenceVerifier } from '../../src/commerce/held_evidence_verifier';

const OTHER_KEY = new Uint8Array(32).fill(9);

/** A status-shaped record. Only the digest matters to these checks. */
const RECORD = { status_digest: 'ab'.repeat(32), state: 'accepted' };

describe('held-evidence verifier (the cryptography)', () => {
  it('accepts a signature this supplier really made', () => {
    const evidence = makeHeldEvidence(RECORD);
    expect(
      realHeldEvidenceVerifier({
        envelope: evidence.envelope,
        signature: evidence.signature,
        supplierDid: SUPPLIER_DID,
      }),
    ).toBe(true);
  });

  it('rejects a signature made by another key', () => {
    // The buyer forges: right envelope, right record, wrong signer. This is
    // the case the previous shape could not distinguish from the real thing.
    const evidence = makeHeldEvidence(RECORD, { signingKey: OTHER_KEY });
    expect(
      realHeldEvidenceVerifier({
        envelope: evidence.envelope,
        signature: evidence.signature,
        supplierDid: SUPPLIER_DID,
      }),
    ).toBe(false);
  });

  it('rejects a genuine signature over DIFFERENT bytes', () => {
    // Signature from one message, envelope from another. Both real; the
    // pairing is the lie.
    const real = makeHeldEvidence(RECORD);
    const other = makeHeldEvidence({ status_digest: 'cd'.repeat(32) }, { body: '{"other":1}' });
    expect(
      realHeldEvidenceVerifier({
        envelope: other.envelope,
        signature: real.signature,
        supplierDid: SUPPLIER_DID,
      }),
    ).toBe(false);
  });

  it('rejects a tampered body under a real signature', () => {
    const evidence = makeHeldEvidence(RECORD);
    expect(
      realHeldEvidenceVerifier({
        envelope: { ...evidence.envelope, body: '{"state":"delivered"}' },
        signature: evidence.signature,
        supplierDid: SUPPLIER_DID,
      }),
    ).toBe(false);
  });

  it('rejects when the supplier key cannot be resolved', () => {
    // FAIL CLOSED. A node that cannot find its own key must not conclude the
    // evidence is good; it must conclude it cannot tell.
    const verifier = makeHeldEvidenceVerifier(() => null);
    const evidence = makeHeldEvidence(RECORD);
    expect(
      verifier({
        envelope: evidence.envelope,
        signature: evidence.signature,
        supplierDid: SUPPLIER_DID,
      }),
    ).toBe(false);
  });

  it('rejects a malformed signature instead of throwing', () => {
    // This runs inside a decision that refuses non-disclosingly. An exception
    // escaping would tell the caller its evidence was at least well-formed.
    const evidence = makeHeldEvidence(RECORD);
    for (const signature of ['', 'zz', 'ab', 'ab'.repeat(31), 'not-hex-at-all']) {
      expect(
        realHeldEvidenceVerifier({
          envelope: evidence.envelope,
          signature,
          supplierDid: SUPPLIER_DID,
        }),
      ).toBe(false);
    }
  });

  it('resolves only the supplier it knows', () => {
    expect(supplierKeyResolver(SUPPLIER_DID)).toEqual(SUPPLIER_PUBLIC_KEY);
    expect(supplierKeyResolver(BUYER_DID)).toBeNull();
  });
});
