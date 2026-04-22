/**
 * Task 5.9 (half A) — Ed25519 signer tests.
 */

import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';

import {
  createEd25519Signer,
  verifyEd25519,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SEED_BYTES,
  ED25519_SIGNATURE_BYTES,
} from '../src/brain/ed25519_signer';

function sampleSeed(byte = 0x7): Uint8Array {
  const out = new Uint8Array(ED25519_SEED_BYTES);
  for (let i = 0; i < ED25519_SEED_BYTES; i++) out[i] = (byte + i) & 0xff;
  return out;
}

describe('constants (task 5.9a)', () => {
  it('ED25519 sizes match the spec', () => {
    expect(ED25519_SEED_BYTES).toBe(32);
    expect(ED25519_PUBLIC_KEY_BYTES).toBe(32);
    expect(ED25519_SIGNATURE_BYTES).toBe(64);
  });
});

describe('createEd25519Signer construction (task 5.9a)', () => {
  it('rejects non-Uint8Array seed', () => {
    expect(() =>
      createEd25519Signer('secret' as unknown as Uint8Array),
    ).toThrow(/Uint8Array/);
  });

  it.each([0, 31, 33, 64])('rejects seed of wrong length: %d bytes', (len) => {
    expect(() => createEd25519Signer(new Uint8Array(len))).toThrow(/32 bytes/);
  });

  it('accepts a valid 32-byte seed', () => {
    const signer = createEd25519Signer(sampleSeed());
    expect(typeof signer.sign).toBe('function');
    expect(typeof signer.publicKey).toBe('function');
  });
});

describe('signing (task 5.9a)', () => {
  it('produces a 64-byte signature', () => {
    const signer = createEd25519Signer(sampleSeed());
    const sig = signer.sign(new TextEncoder().encode('hello'));
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.byteLength).toBe(ED25519_SIGNATURE_BYTES);
  });

  it('is deterministic — same seed + message → same signature', () => {
    const signer = createEd25519Signer(sampleSeed(0x42));
    const msg = new TextEncoder().encode('determinism');
    const sig1 = signer.sign(msg);
    const sig2 = signer.sign(msg);
    expect(Array.from(sig1)).toEqual(Array.from(sig2));
  });

  it('different messages produce different signatures', () => {
    const signer = createEd25519Signer(sampleSeed());
    const a = signer.sign(new TextEncoder().encode('a'));
    const b = signer.sign(new TextEncoder().encode('b'));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('different seeds produce different signatures for the same message', () => {
    const s1 = createEd25519Signer(sampleSeed(0x01));
    const s2 = createEd25519Signer(sampleSeed(0x02));
    const msg = new TextEncoder().encode('m');
    expect(Array.from(s1.sign(msg))).not.toEqual(Array.from(s2.sign(msg)));
  });

  it('rejects non-Uint8Array message', () => {
    const signer = createEd25519Signer(sampleSeed());
    expect(() => signer.sign('hi' as unknown as Uint8Array)).toThrow(/Uint8Array/);
  });

  it('signs an empty message (valid per RFC 8032)', () => {
    const signer = createEd25519Signer(sampleSeed());
    const sig = signer.sign(new Uint8Array(0));
    expect(sig.byteLength).toBe(ED25519_SIGNATURE_BYTES);
  });
});

describe('publicKey (task 5.9a)', () => {
  it('returns 32 bytes', () => {
    const signer = createEd25519Signer(sampleSeed());
    const pub = signer.publicKey();
    expect(pub).toBeInstanceOf(Uint8Array);
    expect(pub.byteLength).toBe(ED25519_PUBLIC_KEY_BYTES);
  });

  it('deterministic — same seed always derives same public key', () => {
    const s1 = createEd25519Signer(sampleSeed());
    const s2 = createEd25519Signer(sampleSeed());
    expect(Array.from(s1.publicKey())).toEqual(Array.from(s2.publicKey()));
  });

  it('different seeds produce different public keys', () => {
    const s1 = createEd25519Signer(sampleSeed(0x11));
    const s2 = createEd25519Signer(sampleSeed(0x22));
    expect(Array.from(s1.publicKey())).not.toEqual(Array.from(s2.publicKey()));
  });

  it('returns a COPY — caller mutation does not affect subsequent calls', () => {
    const signer = createEd25519Signer(sampleSeed());
    const pub1 = signer.publicKey();
    pub1[0] = 0xff;
    const pub2 = signer.publicKey();
    expect(pub2[0]).not.toBe(0xff);
  });
});

describe('verifyEd25519 round-trip (task 5.9a)', () => {
  it('sign then verify with matching pubkey → true', () => {
    const signer = createEd25519Signer(sampleSeed());
    const msg = new TextEncoder().encode('round-trip');
    const sig = signer.sign(msg);
    expect(verifyEd25519(signer.publicKey(), msg, sig)).toBe(true);
  });

  it('verify with wrong pubkey → false', () => {
    const s1 = createEd25519Signer(sampleSeed(0x01));
    const s2 = createEd25519Signer(sampleSeed(0x02));
    const msg = new TextEncoder().encode('m');
    const sig = s1.sign(msg);
    expect(verifyEd25519(s2.publicKey(), msg, sig)).toBe(false);
  });

  it('verify with tampered message → false', () => {
    const signer = createEd25519Signer(sampleSeed());
    const msg = new TextEncoder().encode('original');
    const sig = signer.sign(msg);
    const tampered = new TextEncoder().encode('tampered');
    expect(verifyEd25519(signer.publicKey(), tampered, sig)).toBe(false);
  });

  it('verify with tampered signature → false', () => {
    const signer = createEd25519Signer(sampleSeed());
    const msg = new TextEncoder().encode('m');
    const sig = signer.sign(msg);
    sig[0] ^= 0xff; // flip first byte
    expect(verifyEd25519(signer.publicKey(), msg, sig)).toBe(false);
  });

  it('wrong-length public key or signature → false without throwing', () => {
    const signer = createEd25519Signer(sampleSeed());
    const msg = new TextEncoder().encode('m');
    const sig = signer.sign(msg);
    expect(verifyEd25519(new Uint8Array(31), msg, sig)).toBe(false);
    expect(verifyEd25519(new Uint8Array(33), msg, sig)).toBe(false);
    expect(verifyEd25519(signer.publicKey(), msg, new Uint8Array(63))).toBe(false);
    expect(verifyEd25519(signer.publicKey(), msg, new Uint8Array(65))).toBe(false);
  });

  it('rejects non-Uint8Array inputs without throwing', () => {
    const signer = createEd25519Signer(sampleSeed());
    expect(verifyEd25519('x' as unknown as Uint8Array, new Uint8Array(), new Uint8Array(64))).toBe(false);
    expect(verifyEd25519(signer.publicKey(), 'x' as unknown as Uint8Array, new Uint8Array(64))).toBe(false);
    expect(verifyEd25519(signer.publicKey(), new Uint8Array(), 'x' as unknown as Uint8Array)).toBe(false);
  });

  it('interop: verifies signatures produced by node:crypto generateKeyPair', () => {
    // Proves our verifier accepts externally-generated Ed25519 keys
    // (not just ones we built via seed-PKCS8) — interop sanity.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
    const pubRaw = new Uint8Array(Buffer.from(pubJwk.x, 'base64url'));
    const msg = new TextEncoder().encode('interop');
    const sig = new Uint8Array(nodeSign(null, Buffer.from(msg), privateKey));
    expect(verifyEd25519(pubRaw, msg, sig)).toBe(true);
  });
});
