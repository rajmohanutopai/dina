/**
 * Task 4.59 — PLC startup drift check tests.
 */

import {
  generateMnemonic,
  mnemonicToSeed,
  publicKeyToMultibase,
} from '@dina/core';
import { deriveIdentity } from '../src/identity/derivations';
import {
  PlcProbeError,
  plcProbe,
  plcProbeOrThrow,
  type PlcProbeRejection,
} from '../src/identity/plc_probe';

function freshIdentity() {
  return deriveIdentity({ masterSeed: mnemonicToSeed(generateMnemonic()) });
}

const TEST_DID = 'did:plc:homenode-test-abc';

/** Build a PLC-flat-form DID doc ("verificationMethods" map). */
function plcFlatDoc(signingPub: Uint8Array, vmId = 'dina_signing') {
  const mb = publicKeyToMultibase(signingPub);
  return {
    verificationMethods: {
      [vmId]: `did:key:${mb}`,
    },
  };
}

/** Build a W3C-array-form DID doc ("verificationMethod" array). */
function w3cArrayDoc(signingPub: Uint8Array, did: string, vmId = 'dina_signing') {
  const mb = publicKeyToMultibase(signingPub);
  return {
    verificationMethod: [
      {
        id: `${did}#${vmId}`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: mb,
      },
    ],
  };
}

describe('plcProbe (task 4.59)', () => {
  describe('happy path', () => {
    it('returns ok for matching key (PLC flat-form doc)', async () => {
      const id = freshIdentity();
      const result = await plcProbe({
        did: TEST_DID,
        expectedSigningPub: id.root.publicKey,
        resolveFn: async () => plcFlatDoc(id.root.publicKey),
      });
      expect(result).toEqual({ ok: true });
    });

    it('returns ok for matching key (W3C array-form doc)', async () => {
      const id = freshIdentity();
      const result = await plcProbe({
        did: TEST_DID,
        expectedSigningPub: id.root.publicKey,
        resolveFn: async () => w3cArrayDoc(id.root.publicKey, TEST_DID),
      });
      expect(result).toEqual({ ok: true });
    });

    it('honours verificationMethodId override', async () => {
      const id = freshIdentity();
      const result = await plcProbe({
        did: TEST_DID,
        expectedSigningPub: id.root.publicKey,
        resolveFn: async () => plcFlatDoc(id.root.publicKey, 'dina_messaging'),
        verificationMethodId: 'dina_messaging',
      });
      expect(result).toEqual({ ok: true });
    });
  });

  describe('rejection paths', () => {
    it.each([
      ['missing DID', ''],
      ['non-DID input', 'not-a-did'],
    ])('rejects %s with not_found', async (_label, did) => {
      const id = freshIdentity();
      const result = await plcProbe({
        did,
        expectedSigningPub: id.root.publicKey,
        resolveFn: async () => plcFlatDoc(id.root.publicKey),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.detail.reason).toBe('not_found');
    });

    it('rejects bad expectedSigningPub length', async () => {
      const result = await plcProbe({
        did: TEST_DID,
        expectedSigningPub: new Uint8Array(16),
        resolveFn: async () => ({}),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.detail.reason).toBe('key_mismatch');
    });

    it('resolveFn throwing 404 maps to not_found', async () => {
      const id = freshIdentity();
      const result = await plcProbe({
        did: TEST_DID,
        expectedSigningPub: id.root.publicKey,
        resolveFn: async () => {
          throw new Error('PLC resolve failed: HTTP 404');
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.detail.reason).toBe('not_found');
    });

    it('resolveFn throwing network error maps to network_error', async () => {
      const id = freshIdentity();
      const result = await plcProbe({
        did: TEST_DID,
        expectedSigningPub: id.root.publicKey,
        resolveFn: async () => {
          throw new Error('ECONNREFUSED');
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.detail.reason).toBe('network_error');
        expect(result.detail.cause).toContain('ECONNREFUSED');
      }
    });

    it('non-object response maps to malformed_doc', async () => {
      const id = freshIdentity();
      const result = await plcProbe({
        did: TEST_DID,
        expectedSigningPub: id.root.publicKey,
        resolveFn: async () => 'not an object',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.detail.reason).toBe('malformed_doc');
    });

    it('missing verification method → missing_verification_method', async () => {
      const id = freshIdentity();
      const result = await plcProbe({
        did: TEST_DID,
        expectedSigningPub: id.root.publicKey,
        resolveFn: async () => ({ verificationMethods: {} }),
      });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.detail.reason).toBe('missing_verification_method');
    });

    it('different key published → key_mismatch with both did:keys in detail', async () => {
      const local = freshIdentity();
      const remote = freshIdentity();
      const result = await plcProbe({
        did: TEST_DID,
        expectedSigningPub: local.root.publicKey,
        resolveFn: async () => plcFlatDoc(remote.root.publicKey),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.detail.reason).toBe('key_mismatch');
        expect(result.detail.local).toMatch(/^did:key:z/);
        expect(result.detail.remote).toMatch(/^did:key:z/);
        expect(result.detail.local).not.toBe(result.detail.remote);
      }
    });

    it('W3C-array-form doc with non-Ed25519 public keys is rejected (malformed multibase)', async () => {
      const id = freshIdentity();
      const result = await plcProbe({
        did: TEST_DID,
        expectedSigningPub: id.root.publicKey,
        resolveFn: async () => ({
          verificationMethod: [
            {
              id: `${TEST_DID}#dina_signing`,
              type: 'Multikey',
              publicKeyMultibase: 'zNotReallyValid',
            },
          ],
        }),
      });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.detail.reason).toBe('missing_verification_method');
    });
  });

  describe('rejection reason enum', () => {
    it('all rejection reasons are distinguishable', () => {
      const all: PlcProbeRejection[] = [
        'not_found',
        'network_error',
        'malformed_doc',
        'missing_verification_method',
        'key_mismatch',
      ];
      expect(new Set(all).size).toBe(all.length);
    });
  });
});

describe('plcProbeOrThrow (task 4.59)', () => {
  it('resolves on success', async () => {
    const id = freshIdentity();
    await expect(
      plcProbeOrThrow({
        did: TEST_DID,
        expectedSigningPub: id.root.publicKey,
        resolveFn: async () => plcFlatDoc(id.root.publicKey),
      }),
    ).resolves.toBeUndefined();
  });

  it('throws PlcProbeError on rejection + attaches detail', async () => {
    const local = freshIdentity();
    const remote = freshIdentity();
    try {
      await plcProbeOrThrow({
        did: TEST_DID,
        expectedSigningPub: local.root.publicKey,
        resolveFn: async () => plcFlatDoc(remote.root.publicKey),
      });
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PlcProbeError);
      if (err instanceof PlcProbeError) {
        expect(err.detail.reason).toBe('key_mismatch');
        expect(err.detail.did).toBe(TEST_DID);
      }
    }
  });
});
