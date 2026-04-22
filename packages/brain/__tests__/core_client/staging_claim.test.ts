/**
 * T3.12 — Staging processor claim: Brain calls Core POST /v1/staging/claim.
 *
 * Source: ARCHITECTURE.md Task 3.12
 */

import { BrainCoreClient } from '../../src/core_client/http';
import { TEST_ED25519_SEED } from '@dina/test-harness';
import { getPublicKey } from '../../../core/src/crypto/ed25519';
import { deriveDIDKey } from '../../../core/src/identity/did';

const pubKey = getPublicKey(TEST_ED25519_SEED);
const did = deriveDIDKey(pubKey);

/** Create a mock fetch that returns canned responses. */
function createMockFetch(responses: Array<{ status: number; body: unknown }>) {
  let callIndex = 0;
  const calls: Array<{ url: string; method: string; body?: string }> = [];

  const mockFetch = async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    calls.push({
      url: urlStr,
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
    });

    const resp = responses[Math.min(callIndex++, responses.length - 1)];
    return {
      status: resp.status,
      ok: resp.status >= 200 && resp.status < 300,
      text: async () => JSON.stringify(resp.body),
      json: async () => resp.body,
      headers: new Headers({ 'content-type': 'application/json' }),
    } as unknown as globalThis.Response;
  };

  return { mockFetch, calls };
}

describe('BrainCoreClient — Staging Claim', () => {
  it('calls POST /v1/staging/claim with default limit=10', async () => {
    const items = [
      { id: 'stg-1', source: 'email', data: { summary: 'Test email' } },
      { id: 'stg-2', source: 'calendar', data: { summary: 'Meeting' } },
    ];
    const { mockFetch, calls } = createMockFetch([{ status: 200, body: { items } }]);

    const client = new BrainCoreClient({
      coreURL: 'http://localhost:8100',
      privateKey: TEST_ED25519_SEED,
      did,
      fetch: mockFetch as any,
    });

    const result = await client.claimStagingItems();
    expect(result).toHaveLength(2);
    expect(calls[0].url).toContain('/v1/staging/claim?limit=10');
    expect(calls[0].method).toBe('POST');
  });

  it('respects custom limit', async () => {
    const { mockFetch, calls } = createMockFetch([{ status: 200, body: { items: [] } }]);

    const client = new BrainCoreClient({
      coreURL: 'http://localhost:8100',
      privateKey: TEST_ED25519_SEED,
      did,
      fetch: mockFetch as any,
    });

    await client.claimStagingItems(5);
    expect(calls[0].url).toContain('limit=5');
  });

  it('returns empty array when no items available', async () => {
    const { mockFetch } = createMockFetch([{ status: 200, body: { items: [] } }]);

    const client = new BrainCoreClient({
      coreURL: 'http://localhost:8100',
      privateKey: TEST_ED25519_SEED,
      did,
      fetch: mockFetch as any,
    });

    const result = await client.claimStagingItems();
    expect(result).toHaveLength(0);
  });

  it('handles missing items field gracefully', async () => {
    const { mockFetch } = createMockFetch([{ status: 200, body: {} }]);

    const client = new BrainCoreClient({
      coreURL: 'http://localhost:8100',
      privateKey: TEST_ED25519_SEED,
      did,
      fetch: mockFetch as any,
    });

    const result = await client.claimStagingItems();
    expect(result).toHaveLength(0);
  });
});

describe('BrainCoreClient — Staging Resolve', () => {
  it('calls POST /v1/staging/resolve with item data', async () => {
    const { mockFetch, calls } = createMockFetch([{ status: 200, body: { status: 'stored' } }]);

    const client = new BrainCoreClient({
      coreURL: 'http://localhost:8100',
      privateKey: TEST_ED25519_SEED,
      did,
      fetch: mockFetch as any,
    });

    const result = await client.resolveStagingItem('stg-1', 'general', { summary: 'Test' });
    expect(result).toEqual({ status: 'stored' });
    expect(calls[0].url).toContain('/v1/staging/resolve');
    expect(calls[0].method).toBe('POST');
  });
});

describe('BrainCoreClient — Staging Fail', () => {
  it('calls POST /v1/staging/fail', async () => {
    const { mockFetch, calls } = createMockFetch([{ status: 200, body: { ok: true } }]);

    const client = new BrainCoreClient({
      coreURL: 'http://localhost:8100',
      privateKey: TEST_ED25519_SEED,
      did,
      fetch: mockFetch as any,
    });

    await client.failStagingItem('stg-1', 'Classification error');
    expect(calls[0].url).toContain('/v1/staging/fail');
  });
});

describe('BrainCoreClient — Staging Extend Lease', () => {
  it('calls POST /v1/staging/extend-lease', async () => {
    const { mockFetch, calls } = createMockFetch([{ status: 200, body: { ok: true } }]);

    const client = new BrainCoreClient({
      coreURL: 'http://localhost:8100',
      privateKey: TEST_ED25519_SEED,
      did,
      fetch: mockFetch as any,
    });

    await client.extendStagingLease('stg-1', 300);
    expect(calls[0].url).toContain('/v1/staging/extend-lease');
  });
});
