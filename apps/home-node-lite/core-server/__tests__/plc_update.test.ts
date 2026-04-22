/**
 * Task 4.60 — PLC update operation tests.
 */

import {
  deriveRotationKey,
  publicKeyToMultibase,
  generateMnemonic,
  mnemonicToSeed,
} from '@dina/core';
import { base58 } from '@scure/base';
import { deriveIdentity } from '../src/identity/derivations';
import {
  buildUpdateOperation,
  buildSigningKeyRotation,
  updateDIDPLC,
  type PLCUpdateParams,
} from '../src/identity/plc_update';

function freshIdentity() {
  return deriveIdentity({ masterSeed: mnemonicToSeed(generateMnemonic()) });
}

/** Build a secp256k1 rotation-key did:key from a 32-byte seed + generation. */
function rotationDidKey(seed: Uint8Array, gen = 0): string {
  const { publicKey } = deriveRotationKey(seed, gen);
  const prefix = new Uint8Array([0xe7, 0x01]);
  const payload = new Uint8Array(prefix.length + publicKey.length);
  payload.set(prefix, 0);
  payload.set(publicKey, prefix.length);
  return `did:key:z${base58.encode(payload)}`;
}

function sampleSeed(): Uint8Array {
  const s = new Uint8Array(32);
  for (let i = 0; i < s.length; i++) s[i] = i + 1;
  return s;
}

const TEST_DID = 'did:plc:testupdatetarget123';
const PREV_CID = 'bafy2bzace-prev-example';

describe('buildUpdateOperation (task 4.60)', () => {
  function validParams(): PLCUpdateParams {
    const rotSeed = sampleSeed();
    return {
      did: TEST_DID,
      prev: PREV_CID,
      verificationMethods: {
        dina_signing: 'did:key:z6MkqXabcdef',
      },
      rotationKeys: [rotationDidKey(rotSeed)],
      signerRotationSeed: rotSeed,
    };
  }

  describe('happy path', () => {
    it('emits type=plc_operation with all required fields', () => {
      const op = buildUpdateOperation(validParams());
      expect(op['type']).toBe('plc_operation');
      expect(op['prev']).toBe(PREV_CID);
      expect(op['verificationMethods']).toEqual({
        dina_signing: 'did:key:z6MkqXabcdef',
      });
      expect(op['rotationKeys']).toEqual(validParams().rotationKeys);
      expect(op['alsoKnownAs']).toEqual([]);
      expect(op['services']).toEqual({});
    });

    it('copies alsoKnownAs + services when provided', () => {
      const op = buildUpdateOperation({
        ...validParams(),
        alsoKnownAs: ['at://rajmohan.bsky.social'],
        services: {
          'dina-messaging': {
            type: 'DinaMsgBox',
            endpoint: 'wss://relay.example/ws',
          },
        },
      });
      expect(op['alsoKnownAs']).toEqual(['at://rajmohan.bsky.social']);
      expect(op['services']).toEqual({
        'dina-messaging': {
          type: 'DinaMsgBox',
          endpoint: 'wss://relay.example/ws',
        },
      });
    });

    it('defensive-copies arrays/objects from params', () => {
      const rotKeys = [rotationDidKey(sampleSeed())];
      const params: PLCUpdateParams = { ...validParams(), rotationKeys: rotKeys };
      const op = buildUpdateOperation(params);
      // Mutate source array — must not affect stored op.
      rotKeys.push('did:key:zOther');
      expect((op['rotationKeys'] as string[]).length).toBe(1);
    });
  });

  describe('validation', () => {
    it('rejects non-did:plc input', () => {
      expect(() =>
        buildUpdateOperation({ ...validParams(), did: 'did:key:z' }),
      ).toThrow(/did must start with "did:plc:"/);
    });

    it('rejects empty prev', () => {
      expect(() =>
        buildUpdateOperation({ ...validParams(), prev: '' }),
      ).toThrow(/prev is required/);
    });

    it('rejects empty rotationKeys', () => {
      expect(() =>
        buildUpdateOperation({ ...validParams(), rotationKeys: [] }),
      ).toThrow(/rotationKeys must be non-empty/);
    });

    it('rejects non-didkey rotation key', () => {
      expect(() =>
        buildUpdateOperation({
          ...validParams(),
          rotationKeys: ['not-a-didkey'],
        }),
      ).toThrow(/must be a did:key string/);
    });

    it('rejects non-didkey verificationMethod value', () => {
      expect(() =>
        buildUpdateOperation({
          ...validParams(),
          verificationMethods: { dina_signing: 'raw-key' },
        }),
      ).toThrow(/must be a did:key string/);
    });

    it('rejects non-string verificationMethod key', () => {
      expect(() =>
        buildUpdateOperation({
          ...validParams(),
          verificationMethods: { '': 'did:key:z' },
        }),
      ).toThrow(/must be non-empty strings/);
    });

    it('rejects non-object verificationMethods', () => {
      expect(() =>
        buildUpdateOperation({
          ...validParams(),
          verificationMethods: null as unknown as Record<string, string>,
        }),
      ).toThrow(/must be a record/);
    });
  });
});

describe('updateDIDPLC (task 4.60)', () => {
  it('signs the op with the current rotation key', async () => {
    const rotSeed = sampleSeed();
    const result = await updateDIDPLC({
      did: TEST_DID,
      prev: PREV_CID,
      verificationMethods: { dina_signing: 'did:key:z6Mk' + 'a'.repeat(40) },
      rotationKeys: [rotationDidKey(rotSeed)],
      signerRotationSeed: rotSeed,
    });
    expect(result.did).toBe(TEST_DID);
    expect(typeof result.operationHash).toBe('string');
    expect(result.operationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.signedOperation['sig']).toBeDefined();
    expect(typeof result.signedOperation['sig']).toBe('string');
  });

  it('rejects when signer is NOT in rotationKeys', async () => {
    const otherSeed = new Uint8Array(32);
    for (let i = 0; i < otherSeed.length; i++) otherSeed[i] = 0xaa;
    await expect(
      updateDIDPLC({
        did: TEST_DID,
        prev: PREV_CID,
        verificationMethods: { dina_signing: 'did:key:z' + 'x'.repeat(40) },
        rotationKeys: [rotationDidKey(sampleSeed())], // NOT the signer
        signerRotationSeed: otherSeed,
      }),
    ).rejects.toThrow(/is not in rotationKeys/);
  });

  it('rejects wrong-length signerRotationSeed', async () => {
    await expect(
      updateDIDPLC({
        did: TEST_DID,
        prev: PREV_CID,
        verificationMethods: { dina_signing: 'did:key:z' + 'x'.repeat(40) },
        rotationKeys: [],
        signerRotationSeed: new Uint8Array(16),
      }),
    ).rejects.toThrow(/must be 32 bytes/);
  });

  it('POSTs to PLC directory when config.fetch is wired', async () => {
    const rotSeed = sampleSeed();
    const posts: Array<{ url: string; body: unknown }> = [];
    const fakeFetch: typeof globalThis.fetch = async (url, init) => {
      posts.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return { ok: true, status: 200, text: async () => '' } as Response;
    };

    const result = await updateDIDPLC(
      {
        did: TEST_DID,
        prev: PREV_CID,
        verificationMethods: { dina_signing: 'did:key:z' + 'y'.repeat(40) },
        rotationKeys: [rotationDidKey(rotSeed)],
        signerRotationSeed: rotSeed,
      },
      { fetch: fakeFetch, plcURL: 'https://plc.test' },
    );

    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(`https://plc.test/${TEST_DID}`);
    expect((posts[0]!.body as Record<string, unknown>)['type']).toBe('plc_operation');
    expect(result.signedOperation).toEqual(posts[0]!.body);
  });

  it('throws when PLC directory rejects the POST', async () => {
    const rotSeed = sampleSeed();
    const fakeFetch: typeof globalThis.fetch = async () =>
      ({
        ok: false,
        status: 400,
        text: async () => 'invalid prev cid',
      } as Response);

    await expect(
      updateDIDPLC(
        {
          did: TEST_DID,
          prev: PREV_CID,
          verificationMethods: { dina_signing: 'did:key:z' + 'a'.repeat(40) },
          rotationKeys: [rotationDidKey(rotSeed)],
          signerRotationSeed: rotSeed,
        },
        { fetch: fakeFetch },
      ),
    ).rejects.toThrow(/HTTP 400.*invalid prev cid/);
  });

  it('honours rotation generation', async () => {
    const rotSeed = sampleSeed();
    const currentGen = 2;
    const result = await updateDIDPLC({
      did: TEST_DID,
      prev: PREV_CID,
      verificationMethods: { dina_signing: 'did:key:z' + 'b'.repeat(40) },
      rotationKeys: [rotationDidKey(rotSeed, currentGen)],
      signerRotationSeed: rotSeed,
      signerRotationGeneration: currentGen,
    });
    expect(result.did).toBe(TEST_DID);
  });
});

describe('buildSigningKeyRotation (task 4.60 convenience)', () => {
  it('builds an update that rotates only the signing key', () => {
    const id = freshIdentity();
    const rotSeed = sampleSeed();
    const params = buildSigningKeyRotation({
      did: TEST_DID,
      prev: PREV_CID,
      newSigningPubKey: id.root.publicKey,
      rotationKeys: [rotationDidKey(rotSeed)],
      signerRotationSeed: rotSeed,
    });
    expect(params.did).toBe(TEST_DID);
    expect(params.verificationMethods).toEqual({
      dina_signing: `did:key:${publicKeyToMultibase(id.root.publicKey)}`,
    });
    expect(params.rotationKeys).toEqual([rotationDidKey(rotSeed)]);
  });

  it('rejects wrong-length newSigningPubKey', () => {
    const rotSeed = sampleSeed();
    expect(() =>
      buildSigningKeyRotation({
        did: TEST_DID,
        prev: PREV_CID,
        newSigningPubKey: new Uint8Array(16),
        rotationKeys: [rotationDidKey(rotSeed)],
        signerRotationSeed: rotSeed,
      }),
    ).toThrow(/must be 32 bytes/);
  });

  it('preserves existing services + alsoKnownAs unchanged', () => {
    const id = freshIdentity();
    const rotSeed = sampleSeed();
    const params = buildSigningKeyRotation({
      did: TEST_DID,
      prev: PREV_CID,
      newSigningPubKey: id.root.publicKey,
      rotationKeys: [rotationDidKey(rotSeed)],
      signerRotationSeed: rotSeed,
      services: {
        'dina-messaging': { type: 'DinaMsgBox', endpoint: 'wss://x' },
      },
      alsoKnownAs: ['at://example'],
    });
    expect(params.services).toEqual({
      'dina-messaging': { type: 'DinaMsgBox', endpoint: 'wss://x' },
    });
    expect(params.alsoKnownAs).toEqual(['at://example']);
  });

  it('omits `services` / `alsoKnownAs` when not supplied (exactOptionalPropertyTypes)', () => {
    const id = freshIdentity();
    const rotSeed = sampleSeed();
    const params = buildSigningKeyRotation({
      did: TEST_DID,
      prev: PREV_CID,
      newSigningPubKey: id.root.publicKey,
      rotationKeys: [rotationDidKey(rotSeed)],
      signerRotationSeed: rotSeed,
    });
    expect('services' in params).toBe(false);
    expect('alsoKnownAs' in params).toBe(false);
  });
});
