/**
 * Tests for BrainCoreClient's service-config endpoints (BRAIN-P1-AA).
 *
 * Source parity: brain/src/port/core_client.py + brain/src/adapter/core_http.py
 *                (get_service_config, put_service_config).
 */

import { BrainCoreClient, ServiceConfig } from '../../src/core_client/http';
import { TEST_ED25519_SEED } from '@dina/test-harness';

function mockFetch(responses: Array<{ status: number; body?: unknown }>): jest.Mock {
  let i = 0;
  return jest.fn(async () => {
    const r = responses[i] ?? responses[responses.length - 1];
    i = Math.min(i + 1, responses.length - 1);
    return {
      status: r.status,
      text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
    } as Response;
  });
}

const baseConfig = {
  coreURL: 'http://localhost:8100',
  privateKey: TEST_ED25519_SEED,
  did: 'did:key:z6MkBrainService',
};

const validServiceConfig: ServiceConfig = {
  isDiscoverable: true,
  name: 'Bus 42',
  capabilities: {
    eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto' },
  },
};

describe('BrainCoreClient service-config endpoints', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  const makeClient = (fetch: jest.Mock) =>
    new BrainCoreClient({ ...baseConfig, fetch, maxRetries: 0 });

  describe('getServiceConfig', () => {
    it('returns parsed config on 200', async () => {
      const fetch = mockFetch([{ status: 200, body: validServiceConfig }]);
      const client = makeClient(fetch);
      const got = await client.getServiceConfig();
      expect(got).toEqual(validServiceConfig);
      expect(fetch.mock.calls[0][0]).toContain('/v1/service/config');
      expect((fetch.mock.calls[0][1] as RequestInit).method).toBe('GET');
    });

    it('returns null on 404 (no config set)', async () => {
      const fetch = mockFetch([{ status: 404, body: { error: 'not set' } }]);
      const client = makeClient(fetch);
      expect(await client.getServiceConfig()).toBeNull();
    });

    it('throws on unexpected status (202)', async () => {
      const fetch = mockFetch([{ status: 202, body: {} }]);
      const client = makeClient(fetch);
      await expect(client.getServiceConfig()).rejects.toThrow(/unexpected status 202/);
    });

    it('signs the request (sends X-Signature header)', async () => {
      const fetch = mockFetch([{ status: 200, body: validServiceConfig }]);
      const client = makeClient(fetch);
      await client.getServiceConfig();
      const headers = (fetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-Signature']).toBeDefined();
      expect(headers['X-DID']).toBe(baseConfig.did);
    });
  });

  describe('putServiceConfig', () => {
    it('POSTs JSON body and returns on 200', async () => {
      const fetch = mockFetch([{ status: 200, body: { ok: true } }]);
      const client = makeClient(fetch);
      await client.putServiceConfig(validServiceConfig);

      expect(fetch.mock.calls[0][0]).toContain('/v1/service/config');
      const init = fetch.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual(validServiceConfig);
    });

    it('throws with server error message on 400', async () => {
      const fetch = mockFetch([{ status: 400, body: { error: 'name is required' } }]);
      const client = makeClient(fetch);
      await expect(client.putServiceConfig(validServiceConfig)).rejects.toThrow(
        /HTTP 400 — name is required/,
      );
    });

    it('throws with bare status when body lacks error', async () => {
      const fetch = mockFetch([{ status: 400, body: {} }]);
      const client = makeClient(fetch);
      await expect(client.putServiceConfig(validServiceConfig)).rejects.toThrow(/HTTP 400/);
    });

    it('signs the request', async () => {
      const fetch = mockFetch([{ status: 200, body: { ok: true } }]);
      const client = makeClient(fetch);
      await client.putServiceConfig(validServiceConfig);
      const headers = (fetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-Signature']).toBeDefined();
      expect(headers['Content-Type']).toBe('application/json');
    });
  });
});
