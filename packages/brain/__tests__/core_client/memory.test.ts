/**
 * Brain Core Client — memory endpoints (WM-BRAIN-08).
 *
 * Exercises `memoryTouch` + `memoryToc` against a mocked fetch
 * (same pattern as `core_client/http.test.ts`). Verifies:
 *   - URL construction (path constants, query string encoding).
 *   - Request body shape (omitting empty optional fields so Core's
 *     "do not overwrite with empty" invariant is honoured at the
 *     wire layer, not just at the service layer).
 *   - Response parsing (tolerates both well-formed and empty 2xx
 *     responses).
 *   - Error propagation (503/500 throws via `throwForStatus`).
 */

import { BrainCoreClient } from '../../src/core_client/http';
import { TEST_ED25519_SEED } from '@dina/test-harness';
import { MEMORY_TOC, MEMORY_TOPIC_TOUCH } from '../../../core/src/server/routes/paths';

function mockFetch(
  status: number,
  body: unknown = {},
): jest.Mock & { calls: jest.Mock['mock']['calls'] } {
  const fn = jest.fn(
    async () =>
      ({
        status,
        text: async () => JSON.stringify(body),
      }) as Response,
  );
  return fn as jest.Mock & { calls: jest.Mock['mock']['calls'] };
}

const baseConfig = {
  coreURL: 'http://localhost:8100',
  privateKey: TEST_ED25519_SEED,
  did: 'did:key:z6MkBrainService',
  maxRetries: 0,
};

describe('BrainCoreClient.memoryTouch', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('POSTs to /v1/memory/topic/touch with persona + topic + kind', async () => {
    const fetch = mockFetch(200, { status: 'ok', canonical: 'Dr Carl' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    const res = await client.memoryTouch({
      persona: 'health',
      topic: 'Dr Carl',
      kind: 'entity',
    });
    expect(res).toEqual({ status: 'ok', canonical: 'Dr Carl', reason: undefined });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toContain(MEMORY_TOPIC_TOUCH);
    expect(init?.method).toBe('POST');
    // Body is a JSON string (signedRequest stringifies before fetch).
    const body = JSON.parse(init!.body as string);
    expect(body.persona).toBe('health');
    expect(body.topic).toBe('Dr Carl');
    expect(body.kind).toBe('entity');
    // Empty optionals were OMITTED (not sent as undefined / null).
    expect('sample_item_id' in body).toBe(false);
  });

  it('forwards sample_item_id when supplied', async () => {
    const fetch = mockFetch(200, { status: 'ok', canonical: 'Dr Carl' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await client.memoryTouch({
      persona: 'health',
      topic: 'Dr Carl',
      kind: 'entity',
      sampleItemId: 'item-1',
    });
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body.sample_item_id).toBe('item-1');
  });

  it('OMITS sample_item_id when caller passes an empty string ("do not overwrite with empty")', async () => {
    const fetch = mockFetch(200, { status: 'ok' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await client.memoryTouch({
      persona: 'health',
      topic: 'x',
      kind: 'entity',
      sampleItemId: '',
    });
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect('sample_item_id' in body).toBe(false);
  });

  it('parses a skipped response (locked persona)', async () => {
    const fetch = mockFetch(200, { status: 'skipped', reason: 'persona not open' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    const res = await client.memoryTouch({
      persona: 'locked',
      topic: 'x',
      kind: 'theme',
    });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('persona not open');
    expect(res.canonical).toBeUndefined();
  });

  it('defaults status to "ok" when server omits it on 2xx', async () => {
    // Defensive: if a future Core sends back `{}` on 204/empty, we
    // don't return `undefined` to callers.
    const fetch = mockFetch(200, {});
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    const res = await client.memoryTouch({
      persona: 'health',
      topic: 'x',
      kind: 'theme',
    });
    expect(res.status).toBe('ok');
  });

  it('throws on 5xx', async () => {
    // 5xx is thrown by signedRequest before throwForStatus runs,
    // so the error text is the generic "BrainCoreClient: HTTP 503".
    const fetch = mockFetch(503, { error: 'memory service not wired' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await expect(
      client.memoryTouch({ persona: 'health', topic: 'x', kind: 'theme' }),
    ).rejects.toThrow(/503/);
  });
});

describe('BrainCoreClient.memoryToc', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  const entryShape = {
    persona: 'health',
    topic: 'Dr Carl',
    kind: 'entity' as const,
    salience: 1.3,
    last_update: 1_700_000_000,
  };

  it('GETs /v1/memory/toc without query string when called with no args', async () => {
    const fetch = mockFetch(200, { entries: [entryShape], limit: 50 });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    const entries = await client.memoryToc();
    expect(entries).toEqual([entryShape]);
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain(MEMORY_TOC);
    expect(url).not.toContain('?');
    expect(fetch.mock.calls[0][1]?.method).toBe('GET');
  });

  it('encodes personas as comma-separated `persona` query param', async () => {
    const fetch = mockFetch(200, { entries: [] });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await client.memoryToc({ personas: ['health', 'finance', 'general'] });
    const url = String(fetch.mock.calls[0][0]);
    // URLSearchParams escapes the comma as %2C — either form is acceptable.
    expect(url).toMatch(/persona=health(,|%2C)finance(,|%2C)general/);
  });

  it('omits personas param when array is empty', async () => {
    const fetch = mockFetch(200, { entries: [] });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await client.memoryToc({ personas: [] });
    const url = String(fetch.mock.calls[0][0]);
    expect(url).not.toContain('persona=');
  });

  it('passes limit as a string', async () => {
    const fetch = mockFetch(200, { entries: [] });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await client.memoryToc({ limit: 10 });
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain('limit=10');
  });

  it('combines personas + limit in a single query string', async () => {
    const fetch = mockFetch(200, { entries: [] });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await client.memoryToc({ personas: ['health'], limit: 25 });
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain('persona=health');
    expect(url).toContain('limit=25');
  });

  it('returns [] when the response body has no entries field', async () => {
    const fetch = mockFetch(200, {});
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    const entries = await client.memoryToc();
    expect(entries).toEqual([]);
  });

  it('returns [] when entries is not an array (defensive coercion)', async () => {
    const fetch = mockFetch(200, { entries: 'not-an-array' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    const entries = await client.memoryToc();
    expect(entries).toEqual([]);
  });

  it('throws on 5xx', async () => {
    const fetch = mockFetch(503, { error: 'memory service not wired' });
    const client = new BrainCoreClient({ ...baseConfig, fetch });
    await expect(client.memoryToc()).rejects.toThrow(/503/);
  });
});
