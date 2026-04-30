/**
 * PLC submitter tests (TN-IDENT-006).
 *
 * Covers: success paths, classification of 4xx vs 5xx, network-error
 * retry, exponential backoff timing, exhaustion error shape, input
 * validation.
 *
 * The submitter takes injected `fetch` + `sleep` so this whole suite
 * runs in synchronous wall-clock time even though the real submitter
 * waits seconds between retries.
 */

import {
  computePLCBackoff,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  PLCSubmitError,
  submitPlcOperation,
} from '../../src';

interface FakeFetchCall {
  url: string;
  body: string;
}

function makeFakeFetch(responses: ({ status: number; body?: string } | Error)[]): {
  fetch: typeof globalThis.fetch;
  calls: FakeFetchCall[];
} {
  const calls: FakeFetchCall[] = [];
  let i = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const body = (init?.body as string) ?? '';
    calls.push({ url, body });
    const r = responses[i++ % responses.length];
    if (r instanceof Error) throw r;
    return new Response(r.body ?? '', { status: r.status });
  };
  return { fetch, calls };
}

function noopSleep(ms: number): Promise<void> {
  capturedSleeps.push(ms);
  return Promise.resolve();
}
let capturedSleeps: number[] = [];
beforeEach(() => {
  capturedSleeps = [];
});

const SIGNED_OP = { type: 'plc_operation', prev: null, sig: 'fake' };
const DID = 'did:plc:example1234567890ab';

// -----------------------------------------------------------------------

describe('computePLCBackoff', () => {
  it('produces 500ms / 1s / 2s / 4s / 8s with default base', () => {
    expect(computePLCBackoff(1)).toBe(500);
    expect(computePLCBackoff(2)).toBe(1000);
    expect(computePLCBackoff(3)).toBe(2000);
    expect(computePLCBackoff(4)).toBe(4000);
    expect(computePLCBackoff(5)).toBe(8000);
  });

  it('scales by injected base', () => {
    expect(computePLCBackoff(1, 100)).toBe(100);
    expect(computePLCBackoff(3, 100)).toBe(400);
  });

  it('rejects non-positive integer attempt counts', () => {
    expect(() => computePLCBackoff(0)).toThrow(/positive integer/);
    expect(() => computePLCBackoff(-1)).toThrow(/positive integer/);
    expect(() => computePLCBackoff(1.5)).toThrow(/positive integer/);
  });
});

describe('submitPlcOperation — success path', () => {
  it('succeeds on first 200 response', async () => {
    const { fetch, calls } = makeFakeFetch([{ status: 200, body: '{"ok":true}' }]);
    const result = await submitPlcOperation(
      { did: DID, signedOperation: SIGNED_OP },
      { fetch, sleep: noopSleep },
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(result.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(capturedSleeps).toEqual([]); // no backoff on first-try success
  });

  it('returns null body when response is empty', async () => {
    const { fetch } = makeFakeFetch([{ status: 200, body: '' }]);
    const result = await submitPlcOperation(
      { did: DID, signedOperation: SIGNED_OP },
      { fetch, sleep: noopSleep },
    );
    expect(result.body).toBeNull();
  });

  it('returns null body when response is not JSON', async () => {
    const { fetch } = makeFakeFetch([{ status: 200, body: 'plain text' }]);
    const result = await submitPlcOperation(
      { did: DID, signedOperation: SIGNED_OP },
      { fetch, sleep: noopSleep },
    );
    expect(result.body).toBeNull();
  });

  it('POSTs JSON to <plcURL>/<did>', async () => {
    const { fetch, calls } = makeFakeFetch([{ status: 200 }]);
    await submitPlcOperation(
      { did: DID, signedOperation: SIGNED_OP },
      { fetch, sleep: noopSleep, plcURL: 'https://plc.test' },
    );
    expect(calls[0].url).toBe(`https://plc.test/${DID}`);
    expect(JSON.parse(calls[0].body)).toEqual(SIGNED_OP);
  });

  it('strips trailing slashes from the configured plcURL', async () => {
    const { fetch, calls } = makeFakeFetch([{ status: 200 }]);
    await submitPlcOperation(
      { did: DID, signedOperation: SIGNED_OP },
      { fetch, sleep: noopSleep, plcURL: 'https://plc.test///' },
    );
    expect(calls[0].url).toBe(`https://plc.test/${DID}`);
  });
});

describe('submitPlcOperation — 4xx classification', () => {
  it('throws PLCSubmitError(client) on HTTP 400 — does NOT retry', async () => {
    const { fetch, calls } = makeFakeFetch([{ status: 400, body: 'bad sig' }]);
    await expect(
      submitPlcOperation(
        { did: DID, signedOperation: SIGNED_OP },
        { fetch, sleep: noopSleep },
      ),
    ).rejects.toMatchObject({
      kind: 'client',
      status: 400,
      responseText: 'bad sig',
      attempts: 1,
    });
    expect(calls).toHaveLength(1);
    expect(capturedSleeps).toEqual([]);
  });

  it('throws PLCSubmitError(client) on HTTP 401, 403, 404, 409, 422', async () => {
    for (const status of [401, 403, 404, 409, 422]) {
      const { fetch } = makeFakeFetch([{ status, body: 'nope' }]);
      const err = await submitPlcOperation(
        { did: DID, signedOperation: SIGNED_OP },
        { fetch, sleep: noopSleep },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(PLCSubmitError);
      expect((err as PLCSubmitError).kind).toBe('client');
      expect((err as PLCSubmitError).status).toBe(status);
    }
  });
});

describe('submitPlcOperation — 5xx + network retry', () => {
  it('retries on HTTP 500, succeeds on second attempt', async () => {
    const { fetch, calls } = makeFakeFetch([
      { status: 500, body: 'server overload' },
      { status: 200, body: '{}' },
    ]);
    const result = await submitPlcOperation(
      { did: DID, signedOperation: SIGNED_OP },
      { fetch, sleep: noopSleep },
    );
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(capturedSleeps).toEqual([500]); // one backoff between attempts 1 → 2
  });

  it('retries on network error (fetch throws)', async () => {
    const { fetch, calls } = makeFakeFetch([
      new Error('ECONNREFUSED'),
      { status: 200 },
    ]);
    const result = await submitPlcOperation(
      { did: DID, signedOperation: SIGNED_OP },
      { fetch, sleep: noopSleep },
    );
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(capturedSleeps).toEqual([500]);
  });

  it('retries on unexpected non-2xx-non-4xx-non-5xx (e.g. 3xx)', async () => {
    const { fetch } = makeFakeFetch([
      { status: 302, body: 'see other' },
      { status: 200 },
    ]);
    const result = await submitPlcOperation(
      { did: DID, signedOperation: SIGNED_OP },
      { fetch, sleep: noopSleep },
    );
    expect(result.attempts).toBe(2);
  });

  it('exhausts attempts after maxAttempts retries — throws PLCSubmitError(exhausted)', async () => {
    // 5 successive 503s means 5 attempts, 4 backoffs, then throw.
    const { fetch, calls } = makeFakeFetch([
      { status: 503, body: 'down' },
      { status: 503, body: 'down' },
      { status: 503, body: 'down' },
      { status: 503, body: 'down' },
      { status: 503, body: 'down' },
    ]);
    const err = await submitPlcOperation(
      { did: DID, signedOperation: SIGNED_OP },
      { fetch, sleep: noopSleep },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PLCSubmitError);
    expect((err as PLCSubmitError).kind).toBe('exhausted');
    expect((err as PLCSubmitError).attempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect((err as PLCSubmitError).status).toBe(503);
    expect(calls).toHaveLength(DEFAULT_MAX_ATTEMPTS);
    // 4 backoffs between 5 attempts: 500, 1000, 2000, 4000.
    expect(capturedSleeps).toEqual([500, 1000, 2000, 4000]);
  });

  it('respects custom maxAttempts', async () => {
    const { fetch, calls } = makeFakeFetch([
      { status: 503 },
      { status: 503 },
      { status: 503 },
    ]);
    const err = await submitPlcOperation(
      { did: DID, signedOperation: SIGNED_OP },
      { fetch, sleep: noopSleep, maxAttempts: 3 },
    ).catch((e) => e);
    expect((err as PLCSubmitError).attempts).toBe(3);
    expect(calls).toHaveLength(3);
    expect(capturedSleeps).toEqual([500, 1000]);
  });

  it('respects custom backoffBaseMs', async () => {
    const { fetch } = makeFakeFetch([
      { status: 503 },
      { status: 200 },
    ]);
    await submitPlcOperation(
      { did: DID, signedOperation: SIGNED_OP },
      { fetch, sleep: noopSleep, backoffBaseMs: 10 },
    );
    expect(capturedSleeps).toEqual([10]);
  });

  it('mixed 5xx then network error then success — counted as 3 attempts', async () => {
    const { fetch, calls } = makeFakeFetch([
      { status: 502 },
      new Error('ETIMEDOUT'),
      { status: 200 },
    ]);
    const result = await submitPlcOperation(
      { did: DID, signedOperation: SIGNED_OP },
      { fetch, sleep: noopSleep },
    );
    expect(result.attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });
});

describe('submitPlcOperation — defaults', () => {
  it('uses DEFAULT_MAX_ATTEMPTS and DEFAULT_BACKOFF_BASE_MS', () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
    expect(DEFAULT_BACKOFF_BASE_MS).toBe(500);
  });
});

describe('submitPlcOperation — input validation', () => {
  it('rejects empty / non-string did', async () => {
    const { fetch } = makeFakeFetch([{ status: 200 }]);
    for (const bad of ['', undefined as unknown as string, 123 as unknown as string]) {
      await expect(
        submitPlcOperation(
          { did: bad, signedOperation: SIGNED_OP },
          { fetch, sleep: noopSleep },
        ),
      ).rejects.toMatchObject({ kind: 'invalid_input' });
    }
  });

  it('rejects DIDs missing the did:plc: prefix', async () => {
    const { fetch } = makeFakeFetch([{ status: 200 }]);
    await expect(
      submitPlcOperation(
        { did: 'did:key:zABC', signedOperation: SIGNED_OP },
        { fetch, sleep: noopSleep },
      ),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('rejects DIDs containing path-traversal characters', async () => {
    const { fetch } = makeFakeFetch([{ status: 200 }]);
    for (const bad of [
      'did:plc:abc/def',
      'did:plc:abc?param=1',
      'did:plc:abc#frag',
      'did:plc:abc def',
    ]) {
      await expect(
        submitPlcOperation(
          { did: bad, signedOperation: SIGNED_OP },
          { fetch, sleep: noopSleep },
        ),
      ).rejects.toMatchObject({ kind: 'invalid_input' });
    }
  });

  it('rejects non-positive maxAttempts', async () => {
    const { fetch } = makeFakeFetch([{ status: 200 }]);
    await expect(
      submitPlcOperation(
        { did: DID, signedOperation: SIGNED_OP },
        { fetch, sleep: noopSleep, maxAttempts: 0 },
      ),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('throws invalid_input when no fetch is available', async () => {
    // Saving and restoring globalThis.fetch is the cleanest way to
    // simulate "no fetch in this runtime" (Node ≤ 17 had this).
    const orig = globalThis.fetch;
    delete (globalThis as { fetch?: unknown }).fetch;
    try {
      await expect(
        submitPlcOperation({ did: DID, signedOperation: SIGNED_OP }, {}),
      ).rejects.toMatchObject({ kind: 'invalid_input' });
    } finally {
      globalThis.fetch = orig;
    }
  });
});
