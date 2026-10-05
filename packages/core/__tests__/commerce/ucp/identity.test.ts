/** The node's UCP identity: the label and the request-signing key (UCP plan §3.1, §3.5). */
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { es256Thumbprint, LABEL_PATTERN } from '@dina/ucp';

import {
  deriveUcpIdentity,
  deriveUcpLabel,
  getUcpIdentity,
  installUcpIdentity,
  setUcpSigningGeneration,
} from '../../../src/commerce/ucp/identity';
import { deriveP256SigningKey } from '../../../src/crypto/slip0010';

const seed = Uint8Array.from(
  Buffer.from('b0a1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c7d8e9f', 'hex'),
);

describe('the profile label', () => {
  it('is frozen for the test seed (also computed by an independent HKDF script)', () => {
    expect(deriveUcpLabel(seed)).toBe('4gxyfleffvfeqyzkoeo4ibf54e');
    expect(LABEL_PATTERN.test(deriveUcpLabel(seed))).toBe(true);
  });
  it('depends on the seed alone', () => {
    expect(deriveUcpLabel(seed)).toBe(deriveUcpLabel(Uint8Array.from(seed)));
    expect(deriveUcpLabel(new Uint8Array(32).fill(1))).not.toBe(deriveUcpLabel(seed));
    expect(() => deriveUcpLabel(new Uint8Array(8))).toThrow(/too short/);
  });
});

describe('the request-signing key', () => {
  const identity = deriveUcpIdentity(seed, 0);

  it('none until a generation is named: a node that does not know its key signs nothing (U7, §3.5)', () => {
    const fresh = deriveUcpIdentity(seed);
    expect(fresh.signingKey()).toBeNull();
    expect(() => fresh.key).toThrow(/no active signing key/);
    fresh.useGeneration(1);
    expect(fresh.signingKey()?.generation).toBe(1);
    fresh.forgetGeneration();
    expect(fresh.signingKey()).toBeNull();
  });

  it('publishes an ES256 JWK whose kid is its RFC 7638 thumbprint', () => {
    expect(identity.key.jwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(identity.key.jwk.kid).toBe(
      es256Thumbprint(identity.key.jwk.x, identity.key.jwk.y, sha256),
    );
    expect(identity.key.generation).toBe(0);
  });

  it('signs raw 64-byte r||s that the published key verifies', () => {
    const base = new TextEncoder().encode('"@method": POST');
    const sig = identity.key.sign(base);
    expect(sig).toHaveLength(64);
    const point = new Uint8Array([
      0x04,
      ...Buffer.from(identity.key.jwk.x, 'base64url'),
      ...Buffer.from(identity.key.jwk.y, 'base64url'),
    ]);
    expect(p256.verify(sig, base, point, { lowS: false })).toBe(true);
  });

  it('is never the A2A card key', () => {
    const a2aPublic = p256.getPublicKey(deriveP256SigningKey(seed, 0).privateKey, false);
    expect(Buffer.from(a2aPublic.slice(1, 33)).toString('base64url')).not.toBe(identity.key.jwk.x);
  });

  it('moves with the generation; the label does not', () => {
    const next = deriveUcpIdentity(seed, 1);
    expect(next.key.jwk.kid).not.toBe(identity.key.jwk.kid);
    expect(next.label).toBe(identity.label);
  });

  it('derives any generation on demand and signs with the one made active (U7)', () => {
    const id = deriveUcpIdentity(seed, 0);
    expect(id.keyAt(1).jwk).toEqual(deriveUcpIdentity(seed, 1).key.jwk);
    expect(id.key.generation).toBe(0);
    id.useGeneration(2);
    expect(id.key.jwk).toEqual(deriveUcpIdentity(seed, 2).key.jwk);
    // The caller may wipe its seed buffer after unlock: later generations still derive.
    const wiped = seed.slice();
    const held = deriveUcpIdentity(wiped);
    wiped.fill(0);
    expect(held.keyAt(3).jwk).toEqual(deriveUcpIdentity(seed, 3).key.jwk);
    expect(held.label).toBe(identity.label);
  });

  it('an identity installed after the publisher named a generation signs with it (a phone unlocked again)', () => {
    setUcpSigningGeneration(4);
    try {
      const id = deriveUcpIdentity(seed);
      installUcpIdentity(id);
      expect(id.key.generation).toBe(4);
      setUcpSigningGeneration(5);
      expect(getUcpIdentity()?.key.generation).toBe(5);
    } finally {
      setUcpSigningGeneration(null);
      installUcpIdentity(null);
    }
    // Forgotten (a wiped node): an identity installed now knows no key.
    const fresh = deriveUcpIdentity(seed);
    installUcpIdentity(fresh);
    expect(fresh.signingKey()).toBeNull();
    installUcpIdentity(null);
  });

  it('is installed and cleared in memory only', () => {
    installUcpIdentity(identity);
    expect(getUcpIdentity()?.label).toBe('4gxyfleffvfeqyzkoeo4ibf54e');
    installUcpIdentity(null);
    expect(getUcpIdentity()).toBeNull();
  });
});
