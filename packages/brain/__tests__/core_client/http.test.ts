/**
 * T2B.3 — Brain→Core HTTP client: typed API, error handling, retry, PII scrub.
 *
 * Category B: contract test.
 *
 * Source: brain/tests/test_core_client.py
 */

import { BrainCoreClient } from '../../src/core_client/http';
import { TEST_ED25519_SEED } from '@dina/test-harness';

/** Create a mock fetch that returns a fixed response. */
function mockFetch(status: number, body: unknown = {}): jest.Mock {
  return jest.fn(
    async () =>
      ({
        status,
        text: async () => JSON.stringify(body),
      }) as Response,
  );
}

/** Create a mock fetch that throws a connection error. */
function mockFetchError(msg = 'ECONNREFUSED'): jest.Mock {
  return jest.fn(async () => {
    throw new Error(msg);
  });
}

const baseConfig = {
  coreURL: 'http://localhost:8100',
  privateKey: TEST_ED25519_SEED,
  did: 'did:key:z6MkBrainService',
};

describe('Brain Core Client', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });
  const makeClient = (overrides?: Partial<{ coreURL: string; did: string; fetch: jest.Mock }>) =>
    new BrainCoreClient({
      ...baseConfig,
      coreURL: overrides?.coreURL ?? baseConfig.coreURL,
      did: overrides?.did ?? baseConfig.did,
      fetch: overrides?.fetch ?? mockFetch(200),
      maxRetries: 0, // no retries in unit tests — faster
    });

  describe('construction', () => {
    it('accepts valid config', () => {
      expect(() => makeClient()).not.toThrow();
    });

    it('rejects empty coreURL', () => {
      expect(() => makeClient({ coreURL: '' })).toThrow('coreURL is required');
    });

    it('rejects empty DID', () => {
      expect(() => makeClient({ did: '' })).toThrow('did is required');
    });
  });

  describe('typed API', () => {
    it('readVaultItem calls Core GET', async () => {
      const fetch = mockFetch(200, { id: 'item-001', summary: 'Test' });
      const client = makeClient({ fetch });
      const result = await client.readVaultItem('general', 'item-001');
      expect(result).toEqual({ id: 'item-001', summary: 'Test' });
      expect(fetch.mock.calls[0][0]).toContain('/v1/vault/item/item-001');
      expect(fetch.mock.calls[0][0]).toContain('persona=general');
    });

    it('writeVaultItem calls Core POST', async () => {
      const fetch = mockFetch(200, { id: 'new-001' });
      const client = makeClient({ fetch });
      const id = await client.writeVaultItem('general', { type: 'note', summary: 'test' });
      expect(id).toBe('new-001');
      expect(fetch.mock.calls[0][0]).toContain('/v1/vault/store');
    });

    it('searchVault calls Core POST with query', async () => {
      const fetch = mockFetch(200, { items: [{ id: 'a' }, { id: 'b' }] });
      const client = makeClient({ fetch });
      const results = await client.searchVault('general', 'meeting', 10);
      expect(results).toHaveLength(2);
      const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.text).toBe('meeting');
      expect(body.limit).toBe(10);
    });

    it('writeScratchpad calls Core POST', async () => {
      const fetch = mockFetch(200);
      const client = makeClient({ fetch });
      await client.writeScratchpad('task-001', 1, { progress: 'step1' });
      const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.taskId).toBe('task-001');
      expect(body.step).toBe(1);
    });

    it('readScratchpad returns checkpoint', async () => {
      const fetch = mockFetch(200, { step: 3, context: { done: true } });
      const client = makeClient({ fetch });
      const result = await client.readScratchpad('task-001');
      expect(result).toEqual({ step: 3, context: { done: true } });
    });

    it('readScratchpad returns null on 404', async () => {
      const fetch = mockFetch(404, null);
      const client = makeClient({ fetch });
      const result = await client.readScratchpad('task-missing');
      expect(result).toBeNull();
    });

    it('sendMessage calls Core POST', async () => {
      const fetch = mockFetch(200);
      const client = makeClient({ fetch });
      await client.sendMessage('did:plc:recipient', 'social.update', { text: 'hi' });
      const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.recipient_did).toBe('did:plc:recipient');
      expect(body.type).toBe('social.update');
    });
  });

  describe('error handling', () => {
    it('retries on 500 response', async () => {
      let callCount = 0;
      const fetch = jest.fn(async () => {
        callCount++;
        if (callCount <= 2) return { status: 500, text: async () => '{}' } as Response;
        return { status: 200, text: async () => '{"ok":true}' } as Response;
      });
      const client = new BrainCoreClient({ ...baseConfig, fetch, maxRetries: 3 });
      const promise = client.readVaultItem('general', 'item');
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
        jest.advanceTimersByTime(5000);
      }
      const result = await promise;
      expect(result).toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('does NOT retry on 401 (fatal auth error)', async () => {
      const fetch = mockFetch(401, { error: 'unauthorized' });
      const client = new BrainCoreClient({ ...baseConfig, fetch, maxRetries: 3 });
      await expect(client.readVaultItem('general', 'item')).rejects.toThrow('401');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on 403', async () => {
      const fetch = mockFetch(403, { error: 'forbidden' });
      const client = new BrainCoreClient({ ...baseConfig, fetch, maxRetries: 3 });
      await expect(client.readVaultItem('general', 'item')).rejects.toThrow('403');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('connection error is retried then throws', async () => {
      const fetch = mockFetchError();
      const client = new BrainCoreClient({ ...baseConfig, fetch, maxRetries: 1 });
      const promise = client.searchVault('general', 'test');
      for (let i = 0; i < 3; i++) {
        await Promise.resolve();
        jest.advanceTimersByTime(5000);
      }
      await expect(promise).rejects.toThrow('ECONNREFUSED');
      expect(fetch).toHaveBeenCalledTimes(2); // 1 + 1 retry
    });
  });

  describe('PII integration', () => {
    it('piiScrub calls Core Tier 1 scrubber', async () => {
      const fetch = mockFetch(200, {
        scrubbed: 'Email [EMAIL_1] about the meeting',
        entities: [{ token: '[EMAIL_1]', type: 'EMAIL', value: 'john@example.com' }],
      });
      const client = makeClient({ fetch });
      const result = await client.piiScrub('Email john@example.com about the meeting');
      expect(result.scrubbed).toContain('[EMAIL_1]');
      expect(result.entities).toHaveLength(1);
    });
  });

  describe('health check', () => {
    it('isHealthy returns true on 200', async () => {
      const fetch = mockFetch(200);
      const client = makeClient({ fetch });
      expect(await client.isHealthy()).toBe(true);
    });

    it('isHealthy returns false on error', async () => {
      const fetch = mockFetchError();
      const client = new BrainCoreClient({ ...baseConfig, fetch, maxRetries: 0 });
      expect(await client.isHealthy()).toBe(false);
    });
  });

  describe('auth headers', () => {
    it('every request has Ed25519 auth headers', async () => {
      const fetch = mockFetch(200);
      const client = makeClient({ fetch });
      await client.readVaultItem('general', 'item-001');
      const headers = (fetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-DID']).toBe('did:key:z6MkBrainService');
      expect(headers['X-Timestamp']).toBeTruthy();
      expect(headers['X-Nonce']).toMatch(/^[0-9a-f]+$/);
      expect(headers['X-Signature']).toMatch(/^[0-9a-f]+$/);
      expect(headers['X-Request-ID']).toMatch(/^req-/);
    });

    it('uses external requestId when set via setRequestId()', async () => {
      const fetch = mockFetch(200);
      const client = makeClient({ fetch });
      client.setRequestId('req-trace-abc123');
      await client.readVaultItem('general', 'item-001');
      const headers = (fetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-Request-ID']).toBe('req-trace-abc123');
    });

    it('uses auto-generated requestId when setRequestId(null)', async () => {
      const fetch = mockFetch(200);
      const client = makeClient({ fetch });
      client.setRequestId('req-temp');
      client.setRequestId(null); // clear it
      await client.readVaultItem('general', 'item-001');
      const headers = (fetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-Request-ID']).toMatch(/^req-[0-9a-f]+$/);
      expect(headers['X-Request-ID']).not.toBe('req-temp');
    });
  });
});
