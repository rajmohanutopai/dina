/**
 * Core's UCP outbound port: the URL check before the socket, a Core-held
 * deadline, and headers narrowed at once (UCP plan §3.3).
 */
import { coveredHeaderFields, setUcpPolicySocket, ucpFetch } from '../../../src/commerce/ucp/fetch';

import type { PolicySocketRequest, PolicySocketResult } from '@dina/net-policy';

const request = (over: Partial<PolicySocketRequest> = {}): PolicySocketRequest => ({
  method: 'GET',
  url: 'https://shop.example/.well-known/ucp',
  headers: {},
  accept: 'json',
  minTls: 'TLSv1.3',
  readAuthErrorBodies: false,
  maxResponseBytes: 1024,
  timeoutMs: 1000,
  ...over,
});

const answer = (rawHeaders: [string, string][]): PolicySocketResult => ({
  ok: true,
  status: 200,
  bodyBytes: new TextEncoder().encode('{}'),
  rawHeaders,
  connectedAddress: '203.0.114.7',
});

afterEach(() => setUcpPolicySocket(null));

describe('ucpFetch', () => {
  it('is unavailable with no socket installed, and refuses a bad URL before any socket', async () => {
    expect(await ucpFetch(request())).toEqual({ ok: false, error: 'unavailable', sent: false });
    let called = false;
    setUcpPolicySocket(async () => ((called = true), answer([])));
    for (const url of [
      'http://shop.example/',
      'https://u:p@shop.example/',
      'https://127.0.0.1/',
      'https://[::1]/',
    ]) {
      expect(await ucpFetch(request({ url }))).toEqual({
        ok: false,
        error: 'url_refused',
        sent: false,
      });
    }
    expect(called).toBe(false);
  });

  it('narrows headers at once: the allow-list for Core, cookies never', async () => {
    setUcpPolicySocket(async () =>
      answer([
        ['content-type', 'application/json'],
        ['set-cookie', 'session=secret'],
        ['etag', '"v1"'],
      ]),
    );
    const r = await ucpFetch(request());
    expect(r).toMatchObject({
      ok: true,
      headers: { 'content-type': 'application/json', etag: '"v1"' },
    });
    expect(r.ok && r.signedHeaders).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('collects exactly the fields a signature covers, as received', async () => {
    setUcpPolicySocket(async () =>
      answer([
        ['content-type', 'application/json'],
        ['content-digest', 'sha-256=:x:'],
        ['date', 'Sun, 04 Oct 2026 10:00:00 GMT'],
        ['signature-input', 'sig1=("@status" "content-digest" "content-type" "date");keyid="k"'],
        ['signature', 'sig1=:AAAA:'],
      ]),
    );
    const r = await ucpFetch(request());
    expect(r.ok && r.signedHeaders).toEqual({
      ok: true,
      headers: {
        'content-digest': 'sha-256=:x:',
        'content-type': 'application/json',
        date: 'Sun, 04 Oct 2026 10:00:00 GMT',
      },
    });
  });

  it('says why when a covered field is missing', async () => {
    setUcpPolicySocket(async () =>
      answer([
        ['signature-input', 'sig1=("@status" "content-length");keyid="k"'],
        ['signature', 'sig1=:AAAA:'],
      ]),
    );
    const r = await ucpFetch(request());
    expect(r.ok && r.signedHeaders).toEqual({
      ok: false,
      reason: 'missing',
      field: 'content-length',
    });
  });

  it('holds its own deadline; a socket that overruns it, or throws, counts as possibly sent', async () => {
    setUcpPolicySocket(() => new Promise(() => undefined));
    expect(await ucpFetch(request({ timeoutMs: 20 }))).toEqual({
      ok: false,
      error: 'timeout',
      sent: true,
    });
    setUcpPolicySocket(async () => {
      throw new Error('boom');
    });
    expect(await ucpFetch(request())).toEqual({ ok: false, error: 'io_error', sent: true });
  });

  it('passes socket failures through with their sent flag', async () => {
    setUcpPolicySocket(async () => ({ ok: false, error: 'address_blocked', sent: false }));
    expect(await ucpFetch(request())).toEqual({ ok: false, error: 'address_blocked', sent: false });
  });

  it('a signature header too large to keep is still a signature: it is reported as one that cannot be checked (dual review R1-5)', async () => {
    const huge = 'x'.repeat(4097);
    setUcpPolicySocket(async () =>
      answer([
        ['content-type', 'application/json'],
        ['signature', huge],
        ['signature-input', huge],
      ]),
    );
    const r = await ucpFetch(request());
    if (!r.ok) throw new Error('fetch');
    expect(r.headers['signature']).toBeUndefined();
    expect(r.signedHeaders).toEqual({ ok: false, reason: 'too_large' });
    // Only one of the two kept: also a signature that cannot be checked.
    setUcpPolicySocket(async () => answer([['signature', 'sig1=:AA==:']]));
    const half = await ucpFetch(request());
    if (!half.ok) throw new Error('fetch');
    expect(half.signedHeaders).toEqual({ ok: false, reason: 'too_large' });
    // Neither: unsigned.
    setUcpPolicySocket(async () => answer([['content-type', 'application/json']]));
    const plain = await ucpFetch(request());
    if (!plain.ok) throw new Error('fetch');
    expect(plain.signedHeaders).toBeUndefined();
  });

  it('reads covered fields from every signature, skipping derived components', () => {
    expect(coveredHeaderFields('a=("@status" "date"), b=("content-type" "date")')).toEqual([
      'date',
      'content-type',
    ]);
    expect(coveredHeaderFields('not a dictionary (')).toBeNull();
  });
});
