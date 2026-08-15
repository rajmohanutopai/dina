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

import { TEST_ED25519_SEED } from '@dina/test-harness';

import {
  defaultHeldEvidenceKeys,
  makeHeldEvidenceVerifier,
} from '../../src/commerce/held_evidence_verifier';
import { registerPublicKeyResolver, resetMiddlewareState } from '../../src/auth/middleware';
import { getPublicKey } from '../../src/crypto/ed25519';
import { deriveRootSigningKey } from '../../src/crypto/slip0010';
import {
  getCurrentPublicKey,
  getKeyHistory,
  initializeRotation,
  resetRotationState,
  rotateKey,
} from '../../src/identity/rotation';

const OTHER_KEY = new Uint8Array(32).fill(9);
/** A second real keypair, standing in for the generation after a rotation. */
const NEW_GEN_KEY = new Uint8Array(32).fill(11);

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
    const verifier = makeHeldEvidenceVerifier(() => []);
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
    expect(supplierKeyResolver(SUPPLIER_DID)).toEqual([{ publicKey: SUPPLIER_PUBLIC_KEY }]);
    expect(supplierKeyResolver(BUYER_DID)).toEqual([]);
  });
});

/**
 * KEY ROTATION. The verifier used to resolve exactly ONE key — the current
 * one — so the first rotation made every signature this node had already
 * produced unverifiable BY THIS NODE.
 *
 * That is not a cosmetic failure. Evidence a supplier cannot verify becomes
 * `never_received`, and `never_received` is the single answer that
 * authorizes the buyer to resubmit the order. A rotation would have turned
 * every legitimately acknowledged open order into a duplicate: goods shipped
 * twice, money owed twice — for nothing worse than routine key hygiene.
 */
describe('held-evidence verifier across a key rotation', () => {
  /** Two generations of one node's own key, newest first, as the resolver sees them. */
  const ROTATED_KEYS = [{ publicKey: getPublicKey(NEW_GEN_KEY) }, { publicKey: SUPPLIER_PUBLIC_KEY }];

  it('accepts a signature made by a PREVIOUS generation of its own key', () => {
    const verifier = makeHeldEvidenceVerifier((did) => (did === SUPPLIER_DID ? ROTATED_KEYS : []));
    // Signed before the rotation — by the key that is no longer current.
    const evidence = makeHeldEvidence(RECORD);
    expect(
      verifier({
        envelope: evidence.envelope,
        signature: evidence.signature,
        supplierDid: SUPPLIER_DID,
      }),
    ).toBe(true);
  });

  it('accepts a signature made by the CURRENT generation too', () => {
    const verifier = makeHeldEvidenceVerifier((did) => (did === SUPPLIER_DID ? ROTATED_KEYS : []));
    const evidence = makeHeldEvidence(RECORD, { signingKey: NEW_GEN_KEY });
    expect(
      verifier({
        envelope: evidence.envelope,
        signature: evidence.signature,
        supplierDid: SUPPLIER_DID,
      }),
    ).toBe(true);
  });

  it('still rejects a key that was never any generation of this node', () => {
    // The baseline the rotation tolerance must not cost: accepting more of
    // MY OWN keys is not accepting anyone else's.
    const verifier = makeHeldEvidenceVerifier((did) => (did === SUPPLIER_DID ? ROTATED_KEYS : []));
    const evidence = makeHeldEvidence(RECORD, { signingKey: OTHER_KEY });
    expect(
      verifier({
        envelope: evidence.envelope,
        signature: evidence.signature,
        supplierDid: SUPPLIER_DID,
      }),
    ).toBe(false);
  });
});

/**
 * `signer_key_id` — the field the wire type has carried since held evidence
 * was signed, which the verifier ignored completely.
 *
 * It NARROWS. When the buyer names the verification method it saw and this
 * node knows its methods by id, a signature that verifies under some other
 * key is refused rather than accepted under a name the buyer never claimed.
 */
describe('held-evidence verifier and signer_key_id', () => {
  const KEYED = [
    { publicKey: SUPPLIER_PUBLIC_KEY, keyId: 'dina_signing' },
    { publicKey: getPublicKey(NEW_GEN_KEY), keyId: 'backup_signing' },
  ];
  const verifier = makeHeldEvidenceVerifier((did) => (did === SUPPLIER_DID ? KEYED : []));

  it('accepts when the named method is the one that signed', () => {
    const evidence = makeHeldEvidence(RECORD);
    expect(
      verifier({
        envelope: evidence.envelope,
        signature: evidence.signature,
        signerKeyId: 'dina_signing',
        supplierDid: SUPPLIER_DID,
      }),
    ).toBe(true);
  });

  it('accepts the full DID-relative form of the same method', () => {
    const evidence = makeHeldEvidence(RECORD);
    expect(
      verifier({
        envelope: evidence.envelope,
        signature: evidence.signature,
        signerKeyId: `${SUPPLIER_DID}#dina_signing`,
        supplierDid: SUPPLIER_DID,
      }),
    ).toBe(true);
  });

  it('REFUSES a real signature attributed to the wrong method', () => {
    // THE CENTRAL CASE. `backup_signing` did not sign this; `dina_signing`
    // did. Ignoring the field — the old behaviour — accepted it.
    const evidence = makeHeldEvidence(RECORD);
    expect(
      verifier({
        envelope: evidence.envelope,
        signature: evidence.signature,
        signerKeyId: 'backup_signing',
        supplierDid: SUPPLIER_DID,
      }),
    ).toBe(false);
  });

  it('REFUSES a method this node does not publish at all', () => {
    const evidence = makeHeldEvidence(RECORD);
    expect(
      verifier({
        envelope: evidence.envelope,
        signature: evidence.signature,
        signerKeyId: 'a_key_we_never_had',
        supplierDid: SUPPLIER_DID,
      }),
    ).toBe(false);
  });

  it('ignores the id when this node knows no ids, rather than refusing valid evidence', () => {
    // Today's default resolver carries no ids: Dina's PLC layout publishes a
    // single `dina_signing` method whose VALUE is replaced on rotation, so
    // there is nothing to match against. Refusing here would reject good
    // evidence from any peer that populates the field. The signature is
    // still the gate — the case below proves it.
    const evidence = makeHeldEvidence(RECORD);
    expect(
      realHeldEvidenceVerifier({
        envelope: evidence.envelope,
        signature: evidence.signature,
        signerKeyId: 'whatever_the_buyer_says',
        supplierDid: SUPPLIER_DID,
      }),
    ).toBe(true);
    expect(
      realHeldEvidenceVerifier({
        envelope: evidence.envelope,
        signature: makeHeldEvidence(RECORD, { signingKey: OTHER_KEY }).signature,
        signerKeyId: 'dina_signing',
        supplierDid: SUPPLIER_DID,
      }),
    ).toBe(false);
  });
});

/**
 * THE DEFAULT RESOLVER — what both composition roots actually install.
 *
 * `makeHeldEvidenceVerifier()` is called with no argument at the mobile and
 * server boots, so every case above is only as real as this function. The
 * one it replaced returned a single key from the auth registry, which is why
 * rotation broke the whole re-adoption path in production while every
 * injected-resolver test stayed green.
 */
describe('defaultHeldEvidenceKeys', () => {
  const SELF_DID = 'did:plc:selfnode';
  const PEER_DID = 'did:plc:apeer';
  const PEER_PUBLIC_KEY = getPublicKey(new Uint8Array(32).fill(13));

  beforeEach(() => {
    resetRotationState();
    resetMiddlewareState();
    initializeRotation(TEST_ED25519_SEED);
  });

  afterEach(() => {
    resetRotationState();
    resetMiddlewareState();
  });

  function registerSelfAndPeer(): void {
    const current = getCurrentPublicKey();
    registerPublicKeyResolver((did) => {
      if (did === SELF_DID) return current;
      if (did === PEER_DID) return PEER_PUBLIC_KEY;
      return null;
    });
  }

  it('returns EVERY generation for this node, not just the current one', () => {
    rotateKey();
    rotateKey();
    registerSelfAndPeer();
    const keys = defaultHeldEvidenceKeys(SELF_DID);
    expect(keys).toHaveLength(3);
    expect(keys.map((k) => k.publicKey)).toEqual(getKeyHistory().map((g) => g.publicKey));
  });

  it('gives a PEER only its own key, never this node’s generations', () => {
    // The rotation history is derived from this node's seed. Offering it for
    // a peer's DID would accept this node's own signature as if the peer had
    // produced it — a forgery this node signs for itself.
    rotateKey();
    registerSelfAndPeer();
    expect(defaultHeldEvidenceKeys(PEER_DID)).toEqual([{ publicKey: PEER_PUBLIC_KEY }]);
  });

  it('returns nothing for a DID the node cannot resolve', () => {
    registerSelfAndPeer();
    expect(defaultHeldEvidenceKeys('did:plc:stranger')).toEqual([]);
  });

  it('verifies a PRE-ROTATION signature end to end through the default wiring', () => {
    // Signed by generation 0, then the node rotates twice. This is the exact
    // production sequence that used to end in `never_received` — and a
    // duplicate order.
    const genZeroPrivate = deriveRootSigningKey(TEST_ED25519_SEED, 0).privateKey;
    const evidence = makeHeldEvidence(RECORD, { signingKey: genZeroPrivate });
    rotateKey();
    rotateKey();
    registerSelfAndPeer();

    const verifier = makeHeldEvidenceVerifier();
    expect(
      verifier({
        envelope: evidence.envelope,
        signature: evidence.signature,
        supplierDid: SELF_DID,
      }),
    ).toBe(true);
  });
});
