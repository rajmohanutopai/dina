/**
 * The phone's policy socket over a fake native module: every policy decision
 * the TypeScript half owns (U6, UCP plan §3.3-3.4). The native halves are
 * checked on device by the self-test.
 */
import { jest } from '@jest/globals';

import {
  createNativePolicySocket,
  type DinaNetNative,
  type NativePinnedRequest,
  type NativePinnedResult,
} from '../src/policy_socket';

import type { PolicySocketRequest } from '@dina/net-policy';

const b64 = (s: string) => Buffer.from(s).toString('base64');

function request(over: Partial<PolicySocketRequest> = {}): PolicySocketRequest {
  return {
    method: 'POST',
    url: 'https://shop.example/ucp/checkout-sessions',
    headers: {
      'content-type': 'application/json',
      'ucp-agent': 'profile="https://p.example/.well-known/ucp"',
    },
    body: new TextEncoder().encode('{"line_items":[]}'),
    accept: 'json',
    minTls: 'TLSv1.3',
    readAuthErrorBodies: false,
    maxResponseBytes: 1024,
    timeoutMs: 5_000,
    ...over,
  };
}

function okAnswer(
  over: Partial<Extract<NativePinnedResult, { ok: true }>> = {},
): NativePinnedResult {
  return {
    ok: true,
    status: 201,
    headers: [
      ['Content-Type', 'application/json'],
      ['Signature-Input', 'sig1=("@status")'],
    ],
    bodyBase64: b64('{"id":"c1"}'),
    connectedAddress: '203.0.114.7',
    ...over,
  };
}

function fake(answers: string[] | Error, result: NativePinnedResult | Error = okAnswer()) {
  const calls: NativePinnedRequest[] = [];
  const native: DinaNetNative = {
    resolveHost: jest.fn(async () => {
      if (answers instanceof Error) throw answers;
      return answers;
    }),
    fetchPinned: jest.fn(async (r: NativePinnedRequest) => {
      calls.push(r);
      if (result instanceof Error) throw result;
      return result;
    }),
  };
  return { socket: createNativePolicySocket(native), native, calls };
}

describe('vetting before any byte leaves', () => {
  it('connects only to the vetted address, with the socket owning its headers', async () => {
    const { socket, calls } = fake(['203.0.114.7', '2606:4700::1']);
    const r = await socket(
      request({ headers: { host: 'evil.example', accept: 'text/html', 'x-ok': '1' } }),
    );
    expect(r).toMatchObject({ ok: true, status: 201, connectedAddress: '203.0.114.7' });
    const sent = calls[0] as NativePinnedRequest;
    expect(sent.address).toBe('203.0.114.7');
    expect(sent.headers).toEqual([
      ['x-ok', '1'],
      ['accept', 'application/json'],
      ['accept-encoding', 'identity'],
    ]);
    expect(Buffer.from(sent.bodyBase64 as string, 'base64').toString()).toBe('{"line_items":[]}');
  });

  it.each([
    ['one private answer among public ones', ['203.0.114.7', '10.0.0.1']],
    ['loopback', ['127.0.0.1']],
    ['metadata', ['169.254.169.254']],
    ['benchmarking (an old gap)', ['198.18.0.1']],
    ['6to4 wrapping loopback (an old gap)', ['2002:7f00:1::1']],
    ['NAT64 wrapping a private address', ['64:ff9b::a00:1']],
    ['an unparseable answer', ['not-an-ip']],
  ])('refuses %s with nothing sent', async (_n, answers) => {
    const { socket, native } = fake(answers);
    expect(await socket(request())).toEqual({ ok: false, error: 'address_blocked', sent: false });
    expect(native.fetchPinned).not.toHaveBeenCalled();
  });

  it('allows a NAT64-synthesised public address (IPv6-only carrier networks)', async () => {
    const { socket } = fake(
      ['64:ff9b::cb00:7207'],
      okAnswer({ connectedAddress: '64:ff9b::cb00:7207' }),
    );
    expect(await socket(request())).toMatchObject({ ok: true });
  });

  it('reports DNS failure and empty answers as dns_failed, not sent', async () => {
    expect(await fake(new Error('nx')).socket(request())).toEqual({
      ok: false,
      error: 'dns_failed',
      sent: false,
    });
    expect(await fake([]).socket(request())).toEqual({
      ok: false,
      error: 'dns_failed',
      sent: false,
    });
  });

  it('refuses a non-https URL or userinfo without resolving', async () => {
    const { socket, native } = fake(['203.0.114.7']);
    expect(await socket(request({ url: 'http://shop.example/' }))).toEqual({
      ok: false,
      error: 'io_error',
      sent: false,
    });
    expect(await socket(request({ url: 'https://u:p@shop.example/' }))).toEqual({
      ok: false,
      error: 'io_error',
      sent: false,
    });
    expect(native.resolveHost).not.toHaveBeenCalled();
  });
});

describe('several vetted answers', () => {
  it('moves to the next address only when a connection never opened', async () => {
    const tried: string[] = [];
    const native: DinaNetNative = {
      resolveHost: async () => ['203.0.114.7', '203.0.114.8'],
      fetchPinned: async (r) => {
        tried.push(r.address);
        return r.address === '203.0.114.7'
          ? { ok: false, error: 'connect_failed', sent: false }
          : okAnswer({ connectedAddress: '203.0.114.8' });
      },
    };
    expect(await createNativePolicySocket(native)(request())).toMatchObject({
      ok: true,
      connectedAddress: '203.0.114.8',
    });
    expect(tried).toEqual(['203.0.114.7', '203.0.114.8']);
  });

  it('never retries once anything may have been sent', async () => {
    const tried: string[] = [];
    const native: DinaNetNative = {
      resolveHost: async () => ['203.0.114.7', '203.0.114.8'],
      fetchPinned: async (r) => {
        tried.push(r.address);
        return { ok: false, error: 'io_error', sent: true };
      },
    };
    expect(await createNativePolicySocket(native)(request())).toEqual({
      ok: false,
      error: 'io_error',
      sent: true,
    });
    expect(tried).toEqual(['203.0.114.7']);
  });

  it('bounds resolution by the request deadline', async () => {
    const native: DinaNetNative = {
      resolveHost: () => new Promise(() => undefined),
      fetchPinned: async () => okAnswer(),
    };
    expect(await createNativePolicySocket(native)(request({ timeoutMs: 20 }))).toEqual({
      ok: false,
      error: 'dns_failed',
      sent: false,
    });
  });
});

describe('after the exchange', () => {
  it('refuses an answer from an address other than the vetted one', async () => {
    const { socket } = fake(['203.0.114.7'], okAnswer({ connectedAddress: '203.0.114.8' }));
    expect(await socket(request())).toEqual({ ok: false, error: 'address_blocked', sent: true });
  });

  it('passes native failures through with their sent flag; a throw counts as sent', async () => {
    expect(
      await fake(['203.0.114.7'], { ok: false, error: 'tls_failed', sent: false }).socket(
        request(),
      ),
    ).toEqual({
      ok: false,
      error: 'tls_failed',
      sent: false,
    });
    expect(await fake(['203.0.114.7'], new Error('boom')).socket(request())).toEqual({
      ok: false,
      error: 'io_error',
      sent: true,
    });
  });

  it.each([301, 302, 307, 308])('refuses a %i redirect', async (status) => {
    const { socket } = fake(
      ['203.0.114.7'],
      okAnswer({ status, headers: [['location', 'https://x.example/']], bodyBase64: '' }),
    );
    expect(await socket(request())).toEqual({ ok: false, error: 'redirect_refused', sent: true });
  });

  it('a 304 is a result only when If-None-Match was sent', async () => {
    const answer = okAnswer({ status: 304, headers: [['etag', '"v1"']], bodyBase64: '' });
    expect(
      await fake(['203.0.114.7'], answer).socket(request({ method: 'GET', body: undefined })),
    ).toMatchObject({
      ok: false,
      error: 'redirect_refused',
    });
    const { socket, calls } = fake(['203.0.114.7'], answer);
    expect(
      await socket(request({ method: 'GET', body: undefined, ifNoneMatch: '"v1"' })),
    ).toMatchObject({ ok: true, status: 304 });
    expect((calls[0] as NativePinnedRequest).headers).toContainEqual(['if-none-match', '"v1"']);
  });

  it('refuses a compressed body and an unexpected media type', async () => {
    expect(
      await fake(
        ['203.0.114.7'],
        okAnswer({
          headers: [
            ['content-type', 'application/json'],
            ['content-encoding', 'gzip'],
          ],
        }),
      ).socket(request()),
    ).toEqual({ ok: false, error: 'bad_content_type', sent: true });
    expect(
      await fake(['203.0.114.7'], okAnswer({ headers: [['content-type', 'text/html']] })).socket(
        request(),
      ),
    ).toEqual({
      ok: false,
      error: 'bad_content_type',
      sent: true,
    });
  });

  it('accepts SSE only for json-or-sse', async () => {
    const sse = okAnswer({
      status: 200,
      headers: [['content-type', 'text/event-stream']],
      bodyBase64: b64('data: {}\n\n'),
    });
    expect(await fake(['203.0.114.7'], sse).socket(request())).toMatchObject({
      ok: false,
      error: 'bad_content_type',
    });
    expect(
      await fake(['203.0.114.7'], sse).socket(request({ accept: 'json-or-sse' })),
    ).toMatchObject({ ok: true });
  });

  it('discards 401/403 bodies unless asked, and keeps WWW-Authenticate', async () => {
    const challenge = okAnswer({
      status: 401,
      headers: [
        ['www-authenticate', 'Bearer error="invalid_token"'],
        ['content-type', 'application/json'],
      ],
      bodyBase64: b64('{"code":"identity_required"}'),
    });
    const dropped = await fake(['203.0.114.7'], challenge).socket(request());
    expect(dropped).toMatchObject({ ok: true, status: 401, bodyBytes: new Uint8Array(0) });
    const read = await fake(['203.0.114.7'], challenge).socket(
      request({ readAuthErrorBodies: true }),
    );
    expect(read.ok && Buffer.from(read.bodyBytes).toString()).toBe('{"code":"identity_required"}');
    expect(read.ok && read.rawHeaders).toContainEqual([
      'www-authenticate',
      'Bearer error="invalid_token"',
    ]);
  });

  it('enforces the body cap and the raw-header cap', async () => {
    expect(
      await fake(['203.0.114.7'], okAnswer({ bodyBase64: b64('x'.repeat(2000)) })).socket(
        request(),
      ),
    ).toEqual({
      ok: false,
      error: 'too_large',
      sent: true,
    });
    const many = Array.from({ length: 129 }, (_, i) => [`h${i}`, 'v'] as [string, string]);
    expect(await fake(['203.0.114.7'], okAnswer({ headers: many })).socket(request())).toEqual({
      ok: false,
      error: 'too_large',
      sent: true,
    });
  });

  it('a status-only request never reads the body', async () => {
    const { socket, calls } = fake(
      ['203.0.114.7'],
      okAnswer({ status: 200, bodyBase64: '', headers: [] }),
    );
    expect(await socket(request({ accept: 'status' }))).toMatchObject({
      ok: true,
      status: 200,
      bodyBytes: new Uint8Array(0),
    });
    expect((calls[0] as NativePinnedRequest).readBody).toBe(false);
  });

  it('lower-cases header names it hands back', async () => {
    const r = await fake(['203.0.114.7']).socket(request());
    expect(r.ok && r.rawHeaders).toEqual([
      ['content-type', 'application/json'],
      ['signature-input', 'sig1=("@status")'],
    ]);
  });
});

describe('review round (U6)', () => {
  it.each([
    ['CRLF in a header value', { headers: { authorization: 'Bearer a\r\nX-Injected: 1' } }],
    ['a non-ASCII header value', { headers: { 'x-a': 'café' } }],
    ['a GET with a body', { method: 'GET' as const }],
  ])('refuses %s before any lookup, with nothing sent', async (_n, over) => {
    const { socket, native } = fake(['203.0.114.7']);
    expect(await socket(request(over))).toEqual({ ok: false, error: 'io_error', sent: false });
    expect(native.resolveHost).not.toHaveBeenCalled();
  });

  it('judges an answer under the network NAT64 prefix (RFC 7050) by the IPv4 inside', async () => {
    const carrier = (inner: string) => `2a00:1450:64:1::${inner}`;
    const nativeFor = (answer: string): DinaNetNative => ({
      resolveHost: async (host) => (host === 'ipv4only.arpa' ? [carrier('192.0.0.170')] : [answer]),
      fetchPinned: async () => okAnswer({ connectedAddress: answer }),
    });
    expect(await createNativePolicySocket(nativeFor(carrier('10.0.0.1')))(request())).toEqual({
      ok: false,
      error: 'address_blocked',
      sent: false,
    });
    expect(
      await createNativePolicySocket(nativeFor(carrier('169.254.169.254')))(request()),
    ).toMatchObject({
      ok: false,
      error: 'address_blocked',
    });
    expect(await createNativePolicySocket(nativeFor(carrier('8.8.8.8')))(request())).toMatchObject({
      ok: true,
    });
  });

  it('a failed ipv4only.arpa lookup only means no prefix', async () => {
    const native: DinaNetNative = {
      resolveHost: async (host) => {
        if (host === 'ipv4only.arpa') throw new Error('nx');
        return ['203.0.114.7'];
      },
      fetchPinned: async () => okAnswer(),
    };
    expect(await createNativePolicySocket(native)(request())).toMatchObject({ ok: true });
  });

  it('checks encoding only for a body that is used: a status-only or discarded 401 answer with gzip is a result', async () => {
    const gz = (status: number) =>
      okAnswer({
        status,
        headers: [
          ['content-encoding', 'gzip'],
          ['content-type', 'text/html'],
        ],
        bodyBase64: '',
      });
    expect(
      await fake(['203.0.114.7'], gz(200)).socket(request({ accept: 'status' })),
    ).toMatchObject({ ok: true, status: 200 });
    expect(await fake(['203.0.114.7'], gz(401)).socket(request())).toMatchObject({
      ok: true,
      status: 401,
    });
  });

  it('tells the native side whether 401/403 bodies are wanted', async () => {
    const { socket, calls } = fake(['203.0.114.7']);
    await socket(request({ readAuthErrorBodies: true }));
    expect(calls[0]?.readAuthErrorBodies).toBe(true);
  });

  it('checks the media type whenever a body is read, even an empty one; a 204 has none', async () => {
    expect(
      await fake(
        ['203.0.114.7'],
        okAnswer({ status: 200, headers: [['content-type', 'text/html']], bodyBase64: '' }),
      ).socket(request()),
    ).toEqual({ ok: false, error: 'bad_content_type', sent: true });
    expect(
      await fake(['203.0.114.7'], okAnswer({ status: 204, headers: [], bodyBase64: '' })).socket(
        request(),
      ),
    ).toMatchObject({
      ok: true,
      status: 204,
    });
  });

  it('refuses a transfer coding other than chunked', async () => {
    expect(
      await fake(
        ['203.0.114.7'],
        okAnswer({
          headers: [
            ['content-type', 'application/json'],
            ['transfer-encoding', 'gzip, chunked'],
          ],
        }),
      ).socket(request()),
    ).toEqual({ ok: false, error: 'bad_content_type', sent: true });
    expect(
      await fake(
        ['203.0.114.7'],
        okAnswer({
          headers: [
            ['content-type', 'application/json'],
            ['transfer-encoding', 'chunked'],
          ],
        }),
      ).socket(request()),
    ).toMatchObject({ ok: true });
  });
});
