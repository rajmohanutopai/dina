/**
 * Task 4.27 — VerifyPairingIdentityBinding tests.
 */

import { deriveDIDKey, publicKeyToMultibase } from '@dina/core';
import { Crypto } from '@dina/adapters-node';
import { verifyPairingIdentityBinding } from '../src/auth/pairing_identity_binding';

async function derivedKeypair() {
  const crypto = new Crypto();
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i;
  const k = await crypto.ed25519DerivePath(seed, "m/9999'/0'/0'");
  return {
    pubKey: k.publicKey,
    multibase: publicKeyToMultibase(k.publicKey),
    did: deriveDIDKey(k.publicKey),
  };
}

describe('verifyPairingIdentityBinding (task 4.27)', () => {
  it('accepts an envelope whose from_did matches did:key derived from body.public_key_multibase', async () => {
    const { multibase, did } = await derivedKeypair();
    const res = verifyPairingIdentityBinding({
      envelopeFromDid: did,
      bodyPublicKeyMultibase: multibase,
    });
    expect(res).toEqual({ ok: true, did });
  });

  it('rejects empty envelopeFromDid', async () => {
    const { multibase } = await derivedKeypair();
    const res = verifyPairingIdentityBinding({
      envelopeFromDid: '',
      bodyPublicKeyMultibase: multibase,
    });
    expect(res).toEqual({ ok: false, reason: 'missing_from_did' });
  });

  it('rejects empty bodyPublicKeyMultibase', async () => {
    const { did } = await derivedKeypair();
    const res = verifyPairingIdentityBinding({
      envelopeFromDid: did,
      bodyPublicKeyMultibase: '',
    });
    expect(res).toEqual({ ok: false, reason: 'missing_public_key' });
  });

  it('rejects malformed multibase with detail', async () => {
    const { did } = await derivedKeypair();
    const res = verifyPairingIdentityBinding({
      envelopeFromDid: did,
      bodyPublicKeyMultibase: 'not-a-valid-multibase',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('malformed_public_key');
      expect(res.detail).toBeDefined();
    }
  });

  it('rejects DID substitution attack: envelope claims a different DID than the key-derived one', async () => {
    const { multibase } = await derivedKeypair();
    const res = verifyPairingIdentityBinding({
      envelopeFromDid: 'did:plc:substituted-identity',
      bodyPublicKeyMultibase: multibase,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('did_mismatch');
      expect(res.detail).toContain('did:plc:substituted-identity');
    }
  });

  it('rejects DID substitution: two different keypairs — claiming keypair A\'s DID with keypair B\'s pubkey', async () => {
    const crypto = new Crypto();

    const seedA = new Uint8Array(32).fill(0x0a);
    const kA = await crypto.ed25519DerivePath(seedA, "m/9999'/0'/0'");
    const didA = deriveDIDKey(kA.publicKey);

    const seedB = new Uint8Array(32).fill(0x0b);
    const kB = await crypto.ed25519DerivePath(seedB, "m/9999'/0'/0'");
    const multibaseB = publicKeyToMultibase(kB.publicKey);

    const res = verifyPairingIdentityBinding({
      envelopeFromDid: didA, // claims A's DID
      bodyPublicKeyMultibase: multibaseB, // but ships B's pubkey
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('did_mismatch');
  });

  it('canonical DID is returned on success for downstream use', async () => {
    const { multibase, did } = await derivedKeypair();
    const res = verifyPairingIdentityBinding({
      envelopeFromDid: did,
      bodyPublicKeyMultibase: multibase,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.did).toBe(did);
      expect(res.did.startsWith('did:key:')).toBe(true);
    }
  });
});
