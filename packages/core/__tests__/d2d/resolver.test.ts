/**
 * T6.1 — DID resolver: fetch DID Documents with TTL cache.
 *
 * Tests use mock fetch — no real network calls.
 *
 * Source: ARCHITECTURE.md Task 6.1
 */

import { DIDResolver, type ResolvedDID } from '../../src/d2d/resolver';
import { getPublicKey } from '../../src/crypto/ed25519';
import { deriveDIDKey, publicKeyToMultibase } from '../../src/identity/did';
import { buildDIDDocument } from '../../src/identity/did_document';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const pubKey = getPublicKey(TEST_ED25519_SEED);
const testDID = deriveDIDKey(pubKey);
const testMultibase = publicKeyToMultibase(pubKey);

/** Build a valid PLC DID Document for testing. */
function buildPlcDocument(did: string, msgboxEndpoint?: string) {
  return buildDIDDocument(did, testMultibase, msgboxEndpoint);
}

/** Create a mock fetch returning a DID Document. */
function createMockFetch(doc: unknown, status = 200) {
  const calls: string[] = [];
  const mockFetch = jest.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => doc,
      text: async () => JSON.stringify(doc),
    } as unknown as Response;
  });
  return { mockFetch, calls };
}

describe('DIDResolver', () => {
  describe('did:key resolution (local)', () => {
    it('resolves did:key without network call', async () => {
      const { mockFetch } = createMockFetch({});
      const resolver = new DIDResolver({ fetch: mockFetch });

      const result = await resolver.resolve(testDID);

      expect(result.did).toBe(testDID);
      expect(result.source).toBe('local');
      expect(result.document.id).toBe(testDID);
      expect(result.document.verificationMethod).toHaveLength(1);
      expect(result.document.verificationMethod[0].publicKeyMultibase).toMatch(/^z6Mk/);
      expect(mockFetch).not.toHaveBeenCalled(); // no network
    });

    it('returns null messaging service for did:key (no endpoint)', async () => {
      const resolver = new DIDResolver({ fetch: createMockFetch({}).mockFetch });
      const result = await resolver.resolve(testDID);
      expect(result.messagingService).toBeNull();
    });
  });

  describe('did:plc resolution (network)', () => {
    it('fetches from PLC directory', async () => {
      const plcDid = 'did:plc:abc123';
      const doc = buildPlcDocument(plcDid, 'wss://mailbox.dinakernel.com/ws');
      const { mockFetch, calls } = createMockFetch(doc);

      const resolver = new DIDResolver({
        plcDirectory: 'https://plc.directory',
        fetch: mockFetch,
      });

      const result = await resolver.resolve(plcDid);

      expect(result.did).toBe(plcDid);
      expect(result.source).toBe('network');
      expect(result.document.id).toBe(plcDid);
      expect(calls[0]).toBe('https://plc.directory/did:plc:abc123');
    });

    it('extracts messaging service endpoint', async () => {
      const plcDid = 'did:plc:abc123';
      const doc = buildPlcDocument(plcDid, 'wss://mailbox.dinakernel.com/ws');
      const resolver = new DIDResolver({ fetch: createMockFetch(doc).mockFetch });

      const result = await resolver.resolve(plcDid);

      expect(result.messagingService).toEqual({
        type: 'DinaMsgBox',
        endpoint: 'wss://mailbox.dinakernel.com/ws',
      });
    });

    it('returns null messaging service when no #dina-messaging', async () => {
      const plcDid = 'did:plc:noservice';
      const doc = buildPlcDocument(plcDid); // no msgbox endpoint
      const resolver = new DIDResolver({ fetch: createMockFetch(doc).mockFetch });

      const result = await resolver.resolve(plcDid);
      expect(result.messagingService).toBeNull();
    });

    it('throws on 404 (DID not found)', async () => {
      const { mockFetch } = createMockFetch({}, 404);
      const resolver = new DIDResolver({ fetch: mockFetch });

      await expect(resolver.resolve('did:plc:nonexistent')).rejects.toThrow(
        'not found on PLC directory',
      );
    });

    it('throws on server error', async () => {
      const { mockFetch } = createMockFetch({}, 500);
      const resolver = new DIDResolver({ fetch: mockFetch });

      await expect(resolver.resolve('did:plc:error')).rejects.toThrow('HTTP 500');
    });

    it('throws on DID mismatch', async () => {
      const doc = buildPlcDocument('did:plc:wrong');
      const resolver = new DIDResolver({ fetch: createMockFetch(doc).mockFetch });

      await expect(resolver.resolve('did:plc:expected')).rejects.toThrow('does not match');
    });
  });

  describe('TTL cache', () => {
    it('returns cached result on second call', async () => {
      const plcDid = 'did:plc:cached';
      const doc = buildPlcDocument(plcDid);
      const { mockFetch } = createMockFetch(doc);

      const resolver = new DIDResolver({ fetch: mockFetch, ttlMs: 60_000 });

      const first = await resolver.resolve(plcDid);
      expect(first.source).toBe('network');

      const second = await resolver.resolve(plcDid);
      expect(second.source).toBe('cache');
      expect(mockFetch).toHaveBeenCalledTimes(1); // only one network call
    });

    it('expires entries after TTL', async () => {
      const plcDid = 'did:plc:expiring';
      const doc = buildPlcDocument(plcDid);
      const { mockFetch } = createMockFetch(doc);

      const resolver = new DIDResolver({ fetch: mockFetch, ttlMs: 1 }); // 1ms TTL

      await resolver.resolve(plcDid);

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 10));

      const second = await resolver.resolve(plcDid);
      expect(second.source).toBe('network');
      expect(mockFetch).toHaveBeenCalledTimes(2); // re-fetched
    });

    it('caches did:key locally', async () => {
      const resolver = new DIDResolver({ fetch: createMockFetch({}).mockFetch });

      const first = await resolver.resolve(testDID);
      const second = await resolver.resolve(testDID);

      expect(first.source).toBe('local');
      expect(second.source).toBe('cache');
    });

    it('invalidate removes from cache', async () => {
      const plcDid = 'did:plc:inv';
      const doc = buildPlcDocument(plcDid);
      const { mockFetch } = createMockFetch(doc);

      const resolver = new DIDResolver({ fetch: mockFetch, ttlMs: 60_000 });

      await resolver.resolve(plcDid);
      resolver.invalidate(plcDid);

      const second = await resolver.resolve(plcDid);
      expect(second.source).toBe('network');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('clearCache empties all entries', async () => {
      const resolver = new DIDResolver({ fetch: createMockFetch({}).mockFetch });
      await resolver.resolve(testDID);

      const stats = resolver.cacheStats();
      expect(stats.size).toBe(1);

      resolver.clearCache();
      expect(resolver.cacheStats().size).toBe(0);
    });
  });

  describe('resolveMessagingEndpoint', () => {
    it('returns endpoint for DID with messaging service', async () => {
      const plcDid = 'did:plc:msg';
      const doc = buildPlcDocument(plcDid, 'wss://relay.example.com/ws');
      const resolver = new DIDResolver({ fetch: createMockFetch(doc).mockFetch });

      const endpoint = await resolver.resolveMessagingEndpoint(plcDid);
      expect(endpoint).toEqual({ type: 'DinaMsgBox', endpoint: 'wss://relay.example.com/ws' });
    });

    it('returns null for DID without messaging service', async () => {
      const plcDid = 'did:plc:nomsg';
      const doc = buildPlcDocument(plcDid);
      const resolver = new DIDResolver({ fetch: createMockFetch(doc).mockFetch });

      const endpoint = await resolver.resolveMessagingEndpoint(plcDid);
      expect(endpoint).toBeNull();
    });
  });

  describe('error handling', () => {
    it('throws for empty DID', async () => {
      const resolver = new DIDResolver({ fetch: createMockFetch({}).mockFetch });
      await expect(resolver.resolve('')).rejects.toThrow('DID is required');
    });

    it('throws for unsupported DID method', async () => {
      const resolver = new DIDResolver({ fetch: createMockFetch({}).mockFetch });
      await expect(resolver.resolve('did:web:example.com')).rejects.toThrow(
        'unsupported DID method',
      );
    });
  });
});
