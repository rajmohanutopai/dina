/**
 * T2.30 — Identity service: DID create on PLC directory.
 *
 * Tests use mock fetch — no real PLC directory calls.
 *
 * Source: ARCHITECTURE.md Task 2.30
 */

import {
  buildCreationOperation,
  signOperation,
  derivePLCDID,
  createDIDPLC,
  resolveDIDPLC,
  type PLCCreateParams,
} from '../../src/identity/directory';
import { TEST_ED25519_SEED } from '@dina/test-harness';

function createMockFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const mockFetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  return { mockFetch, calls };
}

const defaultParams: PLCCreateParams = {
  signingKey: TEST_ED25519_SEED,
  rotationSeed: TEST_ED25519_SEED,
  msgboxEndpoint: 'wss://mailbox.dinakernel.com/ws',
};

describe('PLC Directory — DID Create (2.30)', () => {
  describe('buildCreationOperation', () => {
    it('builds a valid creation operation', () => {
      const { operation, signingPubKey, rotationPubKey } = buildCreationOperation(defaultParams);

      expect(operation.type).toBe('plc_operation');
      expect(operation.prev).toBeNull();
      expect(operation.verificationMethods).toBeDefined();
      expect(operation.rotationKeys).toBeDefined();
      expect(operation.rotationKeys as string[]).toHaveLength(1);
      expect(signingPubKey).toHaveLength(32);
      expect(rotationPubKey.length).toBeGreaterThanOrEqual(33); // compressed secp256k1
    });

    it('includes messaging service when endpoint provided', () => {
      const { operation } = buildCreationOperation(defaultParams);
      const services = operation.services as Record<string, unknown>;
      // PLC prepends `#` to service keys when resolving to a DID doc,
      // so we store the bare name; the doc exposes `#dina-messaging`.
      expect(services['dina-messaging']).toEqual({
        type: 'DinaMsgBox',
        endpoint: 'wss://mailbox.dinakernel.com/ws',
      });
    });

    it('omits messaging service when no endpoint', () => {
      const { operation } = buildCreationOperation({
        ...defaultParams,
        msgboxEndpoint: undefined,
      });
      const services = operation.services as Record<string, unknown>;
      expect(services['dina-messaging']).toBeUndefined();
    });

    it('includes handle as alsoKnownAs when provided', () => {
      const { operation } = buildCreationOperation({
        ...defaultParams,
        handle: 'alice.dina.social',
      });
      expect(operation.alsoKnownAs).toContain('at://alice.dina.social');
    });

    it('publishes `dina_signing` Ed25519 verification method (not `atproto` — PDS owns that)', () => {
      const { operation } = buildCreationOperation(defaultParams);
      const vm = operation.verificationMethods as Record<string, string>;
      // Key layout matches main-dina: `#atproto` is PDS-managed and
      // added via a later PDS-signed update op. Genesis carries only
      // Dina's own Ed25519 key.
      expect(vm.dina_signing).toMatch(/^did:key:z6Mk/);
      expect(vm.atproto).toBeUndefined();
    });

    it('uses secp256k1 rotation key (not Ed25519 z6Mk prefix)', () => {
      const { operation } = buildCreationOperation(defaultParams);
      const rotKeys = operation.rotationKeys as string[];
      expect(rotKeys[0]).toMatch(/^did:key:z/);
      expect(rotKeys[0]).not.toMatch(/^did:key:z6Mk/); // secp256k1, not Ed25519
    });
  });

  describe('signOperation', () => {
    it('signs the operation with secp256k1 rotation key → base64url 64-byte sig', () => {
      const { operation } = buildCreationOperation(defaultParams);
      // signOperation expects the 32-byte secp256k1 PRIVATE key; use
      // any 32 bytes for this shape check.
      const rotationPriv = new Uint8Array(32).fill(7);
      const { signedOperation, operationHash } = signOperation(operation, rotationPriv);

      expect(signedOperation.sig).toBeDefined();
      expect(typeof signedOperation.sig).toBe('string');
      // 64 raw bytes → base64url-no-pad = 86 chars; characters are
      // [A-Za-z0-9_-].
      expect(signedOperation.sig as string).toMatch(/^[A-Za-z0-9_-]{86}$/);
      expect(operationHash.length).toBe(64); // SHA-256 hex
    });

    it('preserves all original fields', () => {
      const { operation } = buildCreationOperation(defaultParams);
      const { signedOperation } = signOperation(operation, TEST_ED25519_SEED);

      expect(signedOperation.type).toBe('plc_operation');
      expect(signedOperation.verificationMethods).toEqual(operation.verificationMethods);
      expect(signedOperation.rotationKeys).toEqual(operation.rotationKeys);
    });

    it('produces deterministic signature for same input', () => {
      const { operation } = buildCreationOperation(defaultParams);
      const { signedOperation: sig1 } = signOperation(operation, TEST_ED25519_SEED);
      const { signedOperation: sig2 } = signOperation(operation, TEST_ED25519_SEED);

      expect(sig1.sig).toBe(sig2.sig);
    });
  });

  describe('derivePLCDID', () => {
    it('derives a did:plc from signed operation', () => {
      const { operation } = buildCreationOperation(defaultParams);
      const { signedOperation } = signOperation(operation, TEST_ED25519_SEED);
      const did = derivePLCDID(signedOperation);

      expect(did).toMatch(/^did:plc:[a-z2-7]{24}$/);
    });

    it('is deterministic (same operation → same DID)', () => {
      const { operation } = buildCreationOperation(defaultParams);
      const { signedOperation } = signOperation(operation, TEST_ED25519_SEED);

      const did1 = derivePLCDID(signedOperation);
      const did2 = derivePLCDID(signedOperation);

      expect(did1).toBe(did2);
    });

    it('different keys → different DID', () => {
      const { operation: op1 } = buildCreationOperation(defaultParams);
      const { signedOperation: signed1 } = signOperation(op1, TEST_ED25519_SEED);

      const otherSeed = new Uint8Array(32);
      otherSeed[0] = 0xff;
      const { operation: op2 } = buildCreationOperation({
        ...defaultParams,
        signingKey: otherSeed,
        rotationSeed: otherSeed,
      });
      const { signedOperation: signed2 } = signOperation(op2, otherSeed);

      expect(derivePLCDID(signed1)).not.toBe(derivePLCDID(signed2));
    });
  });

  describe('createDIDPLC', () => {
    it('creates DID offline (no fetch)', async () => {
      const result = await createDIDPLC(defaultParams);

      expect(result.did).toMatch(/^did:plc:/);
      expect(result.didKey).toMatch(/^did:key:z6Mk/);
      expect(result.publicKeyMultibase).toMatch(/^z6Mk/);
      expect(result.rotationKeyHex.length).toBeGreaterThan(0);
      expect(result.operationHash.length).toBe(64);
    });

    it('registers on PLC directory when fetch provided', async () => {
      const { mockFetch, calls } = createMockFetch({ did: 'did:plc:test' });

      const result = await createDIDPLC(defaultParams, {
        plcURL: 'https://plc.directory',
        fetch: mockFetch,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('did:plc:');
      expect(calls[0].method).toBe('POST');
      expect(result.did).toMatch(/^did:plc:/);
    });

    it('throws on PLC registration failure', async () => {
      const { mockFetch } = createMockFetch({ error: 'conflict' }, 409);

      await expect(
        createDIDPLC(defaultParams, {
          fetch: mockFetch,
        }),
      ).rejects.toThrow('registration failed');
    });

    it('is deterministic (same seed → same DID)', async () => {
      const result1 = await createDIDPLC(defaultParams);
      const result2 = await createDIDPLC(defaultParams);

      expect(result1.did).toBe(result2.did);
      expect(result1.didKey).toBe(result2.didKey);
    });
  });

  describe('resolveDIDPLC', () => {
    it('fetches DID document from PLC directory', async () => {
      const doc = { id: 'did:plc:test123', '@context': ['https://www.w3.org/ns/did/v1'] };
      const { mockFetch, calls } = createMockFetch(doc);

      const result = await resolveDIDPLC('did:plc:test123', { fetch: mockFetch });

      expect(result.id).toBe('did:plc:test123');
      expect(calls[0].url).toBe('https://plc.directory/did:plc:test123');
    });

    it('throws on 404', async () => {
      const { mockFetch } = createMockFetch({}, 404);
      await expect(resolveDIDPLC('did:plc:missing', { fetch: mockFetch })).rejects.toThrow(
        'HTTP 404',
      );
    });
  });
});
