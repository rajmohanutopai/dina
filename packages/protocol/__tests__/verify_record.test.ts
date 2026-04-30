/**
 * Trust-record commit signature verifier tests (TN-AUTH-002).
 *
 * Pins the resolution chain rules + closed-default failure mode:
 *
 *   - Happy path: namespace resolves → multikey decodes → verify
 *     callback returns true → result is true.
 *   - Any earlier failure → false (never throws). Includes:
 *     - missing/empty namespace
 *     - namespace not in `assertionMethod`
 *     - malformed `publicKeyMultibase`
 *     - decoder returns null
 *     - decoder throws
 *     - verify callback returns false
 *     - verify callback throws
 *     - empty / wrong-typed bytes
 *   - Verifier passes the resolved key + the canonical bytes +
 *     signature through to the injected callback unchanged
 *     (no double-signing, no byte mutation).
 *   - The verifier rejects a key whose namespace is registered ONLY
 *     under `verificationMethod[]` but NOT under `assertionMethod[]`
 *     — the assertion-method gate is what makes a key trust-capable.
 *
 * Pure function — runs under plain Jest, no runtime deps.
 */

import {
  verifyRecordCommit,
  type MultikeyDecodeFn,
  type VerifyRecordCommitInput,
} from '../src/identity/verify_record';

import type { DIDDocument, VerificationMethod } from '../src/types/plc_document';
import type { Ed25519VerifyFn } from '../src/validators';

const DID = 'did:plc:author';
const KEY_BYTES = new Uint8Array(32).fill(7);
const RECORD_BYTES = new TextEncoder().encode('canonical-record-bytes');
const SIG_BYTES = new Uint8Array(64).fill(11);

function vm(fragment: string, multibase = 'z6MkExample'): VerificationMethod {
  return {
    id: `${DID}#${fragment}`,
    type: 'Multikey',
    controller: DID,
    publicKeyMultibase: multibase,
  };
}

function doc(overrides: Partial<DIDDocument> = {}): DIDDocument {
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: DID,
    verificationMethod: [vm('namespace_0', 'z6MkNs0')],
    authentication: [],
    assertionMethod: [`${DID}#namespace_0`],
    service: [],
    ...overrides,
  };
}

/** Stub decoder that returns the fixed key bytes for the expected multibase. */
function makeDecoder(expected = 'z6MkNs0'): MultikeyDecodeFn {
  return (mb) => (mb === expected ? KEY_BYTES : null);
}

interface Recorder {
  calls: { pubKey: Uint8Array; message: Uint8Array; signature: Uint8Array }[];
  fn: Ed25519VerifyFn;
}
function recordingVerify(returns: boolean): Recorder {
  const r: Recorder = {
    calls: [],
    fn: (publicKey, message, signature) => {
      r.calls.push({ pubKey: publicKey, message, signature });
      return returns;
    },
  };
  return r;
}

function input(overrides: Partial<VerifyRecordCommitInput> = {}): VerifyRecordCommitInput {
  return {
    authorDoc: doc(),
    namespace: 'namespace_0',
    recordCanonicalBytes: RECORD_BYTES,
    signatureBytes: SIG_BYTES,
    verify: recordingVerify(true).fn,
    decodeMultikey: makeDecoder(),
    ...overrides,
  };
}

// ─── Happy path ───────────────────────────────────────────────────────────

describe('verifyRecordCommit — happy path', () => {
  it('returns true when namespace resolves and verify returns true', () => {
    const r = recordingVerify(true);
    expect(verifyRecordCommit(input({ verify: r.fn }))).toBe(true);
    expect(r.calls).toHaveLength(1);
  });

  it('passes the resolved key + canonical bytes + signature unchanged to verify', () => {
    const r = recordingVerify(true);
    verifyRecordCommit(input({ verify: r.fn }));
    expect(r.calls).toHaveLength(1);
    const c = r.calls[0];
    if (c === undefined) throw new Error('expected one call');
    expect(c.pubKey).toBe(KEY_BYTES);
    expect(c.message).toBe(RECORD_BYTES);
    expect(c.signature).toBe(SIG_BYTES);
  });

  it('accepts the namespace as a fragment-with-hash ref', () => {
    expect(verifyRecordCommit(input({ namespace: '#namespace_0' }))).toBe(true);
  });

  it('accepts the namespace as a fully-qualified DID URL', () => {
    expect(verifyRecordCommit(input({ namespace: `${DID}#namespace_0` }))).toBe(true);
  });
});

// ─── Verify callback false / throws ───────────────────────────────────────

describe('verifyRecordCommit — verify callback', () => {
  it('returns false when verify returns false', () => {
    const r = recordingVerify(false);
    expect(verifyRecordCommit(input({ verify: r.fn }))).toBe(false);
    expect(r.calls).toHaveLength(1); // attempted exactly once
  });

  it('returns false (never throws) when verify throws', () => {
    const verify: Ed25519VerifyFn = () => {
      throw new Error('crypto blew up');
    };
    expect(verifyRecordCommit(input({ verify }))).toBe(false);
  });

  it('returns false when verify returns a non-boolean truthy value (strict ===)', () => {
    // @ts-expect-error — covers callers that don't strictly return boolean
    const verify: Ed25519VerifyFn = () => 1;
    expect(verifyRecordCommit(input({ verify }))).toBe(false);
  });
});

// ─── Resolution failures ──────────────────────────────────────────────────

describe('verifyRecordCommit — namespace resolution', () => {
  it('returns false when namespace is empty', () => {
    expect(verifyRecordCommit(input({ namespace: '' }))).toBe(false);
  });

  it('returns false when namespace is not a string', () => {
    // @ts-expect-error — runtime guard
    expect(verifyRecordCommit(input({ namespace: 42 }))).toBe(false);
  });

  it('returns false when namespace is not in assertionMethod', () => {
    expect(verifyRecordCommit(input({ namespace: 'namespace_404' }))).toBe(false);
  });

  it('returns false when DID doc has no assertionMethod field at all', () => {
    const d: DIDDocument = doc();
    delete (d as { assertionMethod?: unknown }).assertionMethod;
    expect(verifyRecordCommit(input({ authorDoc: d }))).toBe(false);
  });

  it('rejects a key listed in verificationMethod[] but NOT in assertionMethod[]', () => {
    // The assertion-method gate is what makes a key trust-capable; a
    // root-only auth key must not validate trust records.
    const d = doc({
      verificationMethod: [vm('namespace_0', 'z6MkNs0'), vm('root', 'z6MkRoot')],
      assertionMethod: [`${DID}#namespace_0`], // root NOT here
    });
    expect(verifyRecordCommit(input({ authorDoc: d, namespace: 'root' }))).toBe(false);
  });
});

// ─── Multibase decoder failures ───────────────────────────────────────────

describe('verifyRecordCommit — multikey decode', () => {
  it('returns false when decoder returns null', () => {
    const decode: MultikeyDecodeFn = () => null;
    expect(verifyRecordCommit(input({ decodeMultikey: decode }))).toBe(false);
  });

  it('returns false (never throws) when decoder throws', () => {
    const decode: MultikeyDecodeFn = () => {
      throw new Error('bad multibase');
    };
    expect(verifyRecordCommit(input({ decodeMultikey: decode }))).toBe(false);
  });

  it('returns false when decoder returns an empty Uint8Array', () => {
    const decode: MultikeyDecodeFn = () => new Uint8Array(0);
    expect(verifyRecordCommit(input({ decodeMultikey: decode }))).toBe(false);
  });

  it('returns false when decoder returns a non-Uint8Array (defensive)', () => {
    // @ts-expect-error — runtime guard against careless implementations
    const decode: MultikeyDecodeFn = () => [1, 2, 3];
    expect(verifyRecordCommit(input({ decodeMultikey: decode }))).toBe(false);
  });

  it('returns false when the matching VM has empty publicKeyMultibase', () => {
    const d = doc({
      verificationMethod: [vm('namespace_0', '')],
      assertionMethod: [`${DID}#namespace_0`],
    });
    expect(verifyRecordCommit(input({ authorDoc: d }))).toBe(false);
  });
});

// ─── Bytes input validation ───────────────────────────────────────────────

describe('verifyRecordCommit — bytes input', () => {
  it('returns false when recordCanonicalBytes is empty', () => {
    expect(verifyRecordCommit(input({ recordCanonicalBytes: new Uint8Array(0) }))).toBe(false);
  });

  it('returns false when signatureBytes is empty', () => {
    expect(verifyRecordCommit(input({ signatureBytes: new Uint8Array(0) }))).toBe(false);
  });

  it('returns false when recordCanonicalBytes is not a Uint8Array', () => {
    expect(
      // @ts-expect-error — runtime guard
      verifyRecordCommit(input({ recordCanonicalBytes: 'string' })),
    ).toBe(false);
  });

  it('returns false when signatureBytes is not a Uint8Array', () => {
    expect(
      // @ts-expect-error — runtime guard
      verifyRecordCommit(input({ signatureBytes: [1, 2, 3] })),
    ).toBe(false);
  });
});

// ─── Closed-default invariant ─────────────────────────────────────────────

describe('verifyRecordCommit — closed-default invariant', () => {
  it('does not call verify when namespace resolution fails', () => {
    const r = recordingVerify(true);
    verifyRecordCommit(input({ namespace: 'namespace_404', verify: r.fn }));
    expect(r.calls).toHaveLength(0);
  });

  it('does not call verify when decoder fails', () => {
    const r = recordingVerify(true);
    verifyRecordCommit(input({ decodeMultikey: () => null, verify: r.fn }));
    expect(r.calls).toHaveLength(0);
  });

  it('does not call decoder when bytes are invalid (early reject)', () => {
    let decoderCalled = false;
    const decode: MultikeyDecodeFn = (mb) => {
      decoderCalled = true;
      return mb === 'z6MkNs0' ? KEY_BYTES : null;
    };
    verifyRecordCommit(
      input({ recordCanonicalBytes: new Uint8Array(0), decodeMultikey: decode }),
    );
    expect(decoderCalled).toBe(false);
  });
});
