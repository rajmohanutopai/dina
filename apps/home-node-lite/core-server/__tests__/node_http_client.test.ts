/**
 * Task 5.9 (half B) — Node HttpClient adapter tests.
 */

import {
  createNodeHttpClient,
  DEFAULT_HTTP_TIMEOUT_MS,
  NetworkError,
  type HttpRequest,
} from '../src/brain/node_http_client';

function okFetch(body: unknown, status = 200, headers: Record<string, string> = {}): typeof fetch {
  return (async () => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const resHeaders = new Headers({ 'content-type': 'application/json', ...headers });
    return {
      status,
      headers: resHeaders,
      text: async () => text,
      ok: status >= 200 && status < 300,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function throwFetch(err: unknown): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

/** A fetch stub that captures the URL + init it was called with. */
function spyFetch(body: unknown, status = 200): {
  fetchFn: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => text,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('createNodeHttpClient construction (task 5.9b)', () => {
  it('throws when fetch is not a function', () => {
    // Inject a non-function; this proves the guard fires when a runtime
    // lacks globalThis.fetch (Node <18, constrained edge envs).
    expect(() =>
      createNodeHttpClient({ fetchFn: 'not-fetch' as unknown as typeof fetch }),
    ).toThrow(/fetch is not available/);
  });

  it('DEFAULT_HTTP_TIMEOUT_MS is 30s', () => {
    expect(DEFAULT_HTTP_TIMEOUT_MS).toBe(30_000);
  });
});

describe('request validation (task 5.9b)', () => {
  const client = createNodeHttpClient({ fetchFn: okFetch({ ok: true }) });

  it('rejects null request', async () => {
    await expect(client(null as unknown as HttpRequest)).rejects.toThrow(/request/);
  });

  it.each(['FOO', '', null, undefined])(
    'rejects invalid method %s',
    async (method) => {
      await expect(
        client({ method: method as HttpRequest['method'], url: 'http://x' }),
      ).rejects.toThrow(/method/);
    },
  );

  it.each(['', null, undefined, 123])('rejects invalid url %s', async (url) => {
    await expect(
      client({ method: 'GET', url: url as unknown as string }),
    ).rejects.toThrow(/url/);
  });
});

describe('response shape (task 5.9b)', () => {
  it('returns {status, headers, body, text} with JSON parsed', async () => {
    const { fetchFn } = spyFetch({ hello: 'world' }, 200);
    const client = createNodeHttpClient({ fetchFn });
    const res = await client({ method: 'GET', url: 'http://x/y' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hello: 'world' });
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.text).toBe('{"hello":"world"}');
  });

  it('empty body → body=null, text=""', async () => {
    const client = createNodeHttpClient({ fetchFn: okFetch('', 204) });
    const res = await client({ method: 'GET', url: 'http://x' });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(res.text).toBe('');
  });

  it('non-JSON error body → body=null, text preserved, no throw', async () => {
    const client = createNodeHttpClient({ fetchFn: okFetch('Internal Server Error', 500) });
    const res = await client({ method: 'GET', url: 'http://x' });
    expect(res.status).toBe(500);
    expect(res.body).toBeNull();
    expect(res.text).toBe('Internal Server Error');
  });

  it('2xx with invalid JSON → NetworkError body_parse', async () => {
    const client = createNodeHttpClient({ fetchFn: okFetch('not-json', 200) });
    await expect(
      client({ method: 'GET', url: 'http://x' }),
    ).rejects.toMatchObject({ name: 'NetworkError', reason: 'body_parse' });
  });

  it('lower-cases response headers', async () => {
    const client = createNodeHttpClient({ fetchFn: okFetch({}, 200, { 'X-Custom': 'v' }) });
    const res = await client({ method: 'GET', url: 'http://x' });
    expect(res.headers['x-custom']).toBe('v');
    expect(res.headers['X-Custom']).toBeUndefined();
  });
});

describe('request headers + body (task 5.9b)', () => {
  it('sets content-type: application/json when body is present', async () => {
    const { fetchFn, calls } = spyFetch({ ok: true });
    const client = createNodeHttpClient({ fetchFn });
    await client({ method: 'POST', url: 'http://x', body: { n: 1 } });
    const headers = (calls[0]!.init!.headers as Record<string, string>);
    expect(headers['content-type']).toBe('application/json');
    expect(calls[0]!.init!.body).toBe(JSON.stringify({ n: 1 }));
  });

  it('does NOT override caller-supplied content-type (any case)', async () => {
    const { fetchFn, calls } = spyFetch({ ok: true });
    const client = createNodeHttpClient({ fetchFn });
    await client({
      method: 'POST',
      url: 'http://x',
      body: {},
      headers: { 'Content-Type': 'application/vnd.custom+json' },
    });
    const hdrs = (calls[0]!.init!.headers as Record<string, string>);
    const ctKey = Object.keys(hdrs).find((k) => k.toLowerCase() === 'content-type');
    expect(ctKey && hdrs[ctKey]).toBe('application/vnd.custom+json');
  });

  it('does NOT send body on GET/DELETE even if provided', async () => {
    const { fetchFn, calls } = spyFetch({ ok: true });
    const client = createNodeHttpClient({ fetchFn });
    await client({ method: 'GET', url: 'http://x', body: { unsent: true } });
    await client({ method: 'DELETE', url: 'http://x', body: { unsent: true } });
    expect(calls[0]!.init!.body).toBeUndefined();
    expect(calls[1]!.init!.body).toBeUndefined();
  });

  it('always sends accept: application/json by default', async () => {
    const { fetchFn, calls } = spyFetch({ ok: true });
    const client = createNodeHttpClient({ fetchFn });
    await client({ method: 'GET', url: 'http://x' });
    const hdrs = calls[0]!.init!.headers as Record<string, string>;
    expect(hdrs['accept']).toBe('application/json');
  });
});

describe('error classification (task 5.9b)', () => {
  it('ENOTFOUND → NetworkError reason=dns', async () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const client = createNodeHttpClient({ fetchFn: throwFetch(err) });
    await expect(
      client({ method: 'GET', url: 'http://x' }),
    ).rejects.toMatchObject({ name: 'NetworkError', reason: 'dns' });
  });

  it('ECONNREFUSED → NetworkError reason=connection', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const client = createNodeHttpClient({ fetchFn: throwFetch(err) });
    await expect(
      client({ method: 'GET', url: 'http://x' }),
    ).rejects.toMatchObject({ reason: 'connection' });
  });

  it('TLS cert error → NetworkError reason=tls', async () => {
    const err = Object.assign(new Error('CERT_HAS_EXPIRED'), { code: 'CERT_HAS_EXPIRED' });
    const client = createNodeHttpClient({ fetchFn: throwFetch(err) });
    await expect(
      client({ method: 'GET', url: 'http://x' }),
    ).rejects.toMatchObject({ reason: 'tls' });
  });

  it('unknown error → NetworkError reason=unknown with original as cause', async () => {
    const err = new Error('weird');
    const client = createNodeHttpClient({ fetchFn: throwFetch(err) });
    try {
      await client({ method: 'GET', url: 'http://x' });
      fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(NetworkError);
      expect((e as NetworkError).reason).toBe('unknown');
      expect((e as NetworkError).cause).toBe(err);
    }
  });

  it('nested cause.code (undici style) classified correctly', async () => {
    // undici wraps OS errors under `.cause`.
    const err = new Error('fetch failed');
    (err as unknown as { cause: { code: string } }).cause = { code: 'ECONNRESET' };
    const client = createNodeHttpClient({ fetchFn: throwFetch(err) });
    await expect(
      client({ method: 'GET', url: 'http://x' }),
    ).rejects.toMatchObject({ reason: 'connection' });
  });
});

describe('timeout + abort (task 5.9b)', () => {
  it('hits internal timeout → NetworkError reason=timeout', async () => {
    const client = createNodeHttpClient({
      fetchFn: (async (_url: string, init?: RequestInit) => {
        // Respect the abort signal — throw AbortError when signalled.
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
        throw new Error('unreachable'); // pragma: the promise above always rejects
      }) as unknown as typeof fetch,
      defaultTimeoutMs: 20,
    });
    const p = client({ method: 'GET', url: 'http://x' });
    await expect(p).rejects.toMatchObject({ name: 'NetworkError', reason: 'timeout' });
  });

  it('caller abort → NetworkError reason=aborted', async () => {
    const controller = new AbortController();
    const client = createNodeHttpClient({
      fetchFn: (async (_url: string, init?: RequestInit) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
        throw new Error('unreachable');
      }) as unknown as typeof fetch,
    });
    const p = client({ method: 'GET', url: 'http://x', signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(p).rejects.toMatchObject({ reason: 'aborted' });
  });

  it('pre-aborted caller signal rejects immediately', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createNodeHttpClient({
      fetchFn: (async (_url: string, init?: RequestInit) => {
        // Fetch sees a pre-aborted signal + throws AbortError.
        if (init?.signal?.aborted) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        throw new Error('should not reach');
      }) as unknown as typeof fetch,
    });
    await expect(
      client({ method: 'GET', url: 'http://x', signal: controller.signal }),
    ).rejects.toMatchObject({ reason: 'aborted' });
  });
});
