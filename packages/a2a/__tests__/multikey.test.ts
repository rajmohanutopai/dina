/**
 * Multikey encodings for the two keys a Dina node's DID document carries
 * for A2A: checked against the encodings Core and did:key already use, and
 * against a P-256 key derived with @noble/curves.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';

import {
  base58btcDecode,
  base58btcEncode,
  ed25519FromMultikey,
  ed25519Multikey,
  p256FromMultikey,
  p256Multikey,
} from '../src';

describe('base58btc', () => {
  it.each([
    [new Uint8Array([]), ''],
    [new Uint8Array([0]), '1'],
    [new Uint8Array([0, 0, 1]), '112'],
    [new TextEncoder().encode('hello world'), 'StV1DL6CwTryKyV'],
  ])('round-trips %j', (bytes, text) => {
    expect(base58btcEncode(bytes)).toBe(text);
    expect(base58btcDecode(text)).toEqual(bytes);
  });

  it('refuses a character outside the alphabet', () => {
    expect(base58btcDecode('0OIl')).toBeNull();
  });
});

describe('multikeys', () => {
  it('Ed25519: the z6Mk form did:key uses, both ways', () => {
    const pub = ed25519.getPublicKey(new Uint8Array(32).fill(7));
    const mk = ed25519Multikey(pub);
    expect(mk.startsWith('z6Mk')).toBe(true);
    expect(ed25519FromMultikey(mk)).toEqual(pub);
  });

  it('P-256: the zDn form, a compressed point, both ways', () => {
    const pub = p256.getPublicKey(new Uint8Array(32).fill(9), true);
    const mk = p256Multikey(pub);
    expect(mk.startsWith('zDn')).toBe(true);
    expect(p256FromMultikey(mk)).toEqual(pub);
  });

  it('reads nothing from the other kind, a wrong length, or a non-z multibase', () => {
    const ed = ed25519Multikey(ed25519.getPublicKey(new Uint8Array(32).fill(7)));
    const pp = p256Multikey(p256.getPublicKey(new Uint8Array(32).fill(9), true));
    expect(p256FromMultikey(ed)).toBeNull();
    expect(ed25519FromMultikey(pp)).toBeNull();
    expect(ed25519FromMultikey(`m${ed.slice(1)}`)).toBeNull();
    expect(ed25519FromMultikey(ed.slice(0, -2))).toBeNull();
    expect(() => p256Multikey(new Uint8Array(65))).toThrow();
  });
});
