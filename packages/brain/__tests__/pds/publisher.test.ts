/**
 * Tests for PDSPublisher (AT Protocol PDS XRPC client).
 *
 * Source parity: brain/src/adapter/pds_publisher.py (putRecord / deleteRecord
 * / ensureSession / did).
 *
 * AT Protocol error convention: non-2xx responses carry a JSON body like
 * `{"error": "InvalidRequest", "message": "…"}`. Our client folds that into
 * `PDSPublisherError { status, xrpcError }` so callers can match on the
 * structured code instead of parsing strings.
 */

import { PDSPublisher, PDSPublisherError } from '../../src/pds/publisher';

type FetchFn = typeof globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetch(responses: Array<Response | Error | ((req: Recorded) => Response | Error)>): {
  fetchFn: FetchFn;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    const hdrs: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) {
      for (const [k, v] of Object.entries(rawHeaders)) hdrs[k.toLowerCase()] = v;
    }
    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;
    const rec = { url, headers: hdrs, body };
    calls.push(rec);

    const entry = responses[i];
    i = Math.min(i + 1, responses.length - 1);
    const resolved = typeof entry === 'function' ? entry(rec) : entry;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  };
  return { fetchFn, calls };
}

const PDS = 'https://pds.test';
const HANDLE = 'busdriver.dinakernel.com';
const PASSWORD = 'app-password-123';
const DID = 'did:plc:busdriver';
const JWT = 'jwt-abc.def.ghi';

function sessionOK(): Response {
  return jsonResponse(200, { accessJwt: JWT, did: DID });
}

describe('PDSPublisher', () => {
  describe('construction', () => {
    it('requires pdsUrl / handle / password', () => {
      expect(() => new PDSPublisher({ pdsUrl: '', handle: HANDLE, password: PASSWORD })).toThrow(
        /pdsUrl/,
      );
      expect(() => new PDSPublisher({ pdsUrl: PDS, handle: '', password: PASSWORD })).toThrow(
        /handle/,
      );
      expect(() => new PDSPublisher({ pdsUrl: PDS, handle: HANDLE, password: '' })).toThrow(
        /password/,
      );
    });

    it('rejects non-positive session TTL and timeout', () => {
      expect(
        () =>
          new PDSPublisher({ pdsUrl: PDS, handle: HANDLE, password: PASSWORD, sessionTtlMs: 0 }),
      ).toThrow(/sessionTtlMs/);
      expect(
        () => new PDSPublisher({ pdsUrl: PDS, handle: HANDLE, password: PASSWORD, timeoutMs: 0 }),
      ).toThrow(/timeoutMs/);
    });

    it('strips trailing slash from pdsUrl', async () => {
      const { fetchFn, calls } = makeFetch([
        sessionOK(),
        jsonResponse(200, { uri: 'u', cid: 'c' }),
      ]);
      const p = new PDSPublisher({
        pdsUrl: 'https://pds.test/',
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });
      await p.putRecord('com.dina.service.profile', 'self', {});
      expect(calls[0].url.startsWith('https://pds.test/xrpc/')).toBe(true);
      expect(calls[0].url.startsWith('https://pds.test//xrpc/')).toBe(false);
    });

    it('did starts as null', () => {
      const p = new PDSPublisher({ pdsUrl: PDS, handle: HANDLE, password: PASSWORD });
      expect(p.did).toBeNull();
    });
  });

  describe('ensureSession (lazy)', () => {
    it('does not create session until first write', async () => {
      const { fetchFn, calls } = makeFetch([]);
      new PDSPublisher({ pdsUrl: PDS, handle: HANDLE, password: PASSWORD, fetch: fetchFn });
      expect(calls).toHaveLength(0);
    });

    it('creates session on first write and caches it', async () => {
      const { fetchFn, calls } = makeFetch([
        sessionOK(),
        jsonResponse(200, { uri: 'at://did/col/rkey', cid: 'cid1' }),
        jsonResponse(200, { uri: 'at://did/col/rkey', cid: 'cid2' }),
      ]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });

      await p.putRecord('col', 'rkey', { v: 1 });
      await p.putRecord('col', 'rkey', { v: 2 });

      expect(calls[0].url).toContain('createSession');
      expect(calls[1].url).toContain('putRecord');
      expect(calls[2].url).toContain('putRecord');
      expect(calls).toHaveLength(3); // one session + two puts
      expect(p.did).toBe(DID);
    });

    it('refreshes after sessionTtlMs', async () => {
      let now = 1_700_000_000_000;
      const { fetchFn, calls } = makeFetch([
        sessionOK(),
        jsonResponse(200, { uri: 'u1', cid: 'c1' }),
        sessionOK(),
        jsonResponse(200, { uri: 'u2', cid: 'c2' }),
      ]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
        nowFn: () => now,
        sessionTtlMs: 1_000,
      });

      await p.putRecord('col', 'r', {});
      now += 1_500;
      await p.putRecord('col', 'r', {});

      expect(calls.filter((c) => c.url.includes('createSession'))).toHaveLength(2);
    });

    it('collapses concurrent callers into one login', async () => {
      let sessionResolvers: Array<(r: Response) => void> = [];
      let sessionCalls = 0;
      const fetchFn: FetchFn = async (input) => {
        const url = String(input);
        if (url.includes('createSession')) {
          sessionCalls += 1;
          return new Promise<Response>((resolve) => sessionResolvers.push(resolve));
        }
        return jsonResponse(200, { uri: 'u', cid: 'c' });
      };
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });

      const a = p.putRecord('col', 'r1', {});
      const b = p.putRecord('col', 'r2', {});
      // Give both microtasks time to register on the in-flight session.
      await Promise.resolve();
      await Promise.resolve();

      expect(sessionCalls).toBe(1);
      sessionResolvers[0](sessionOK());
      await Promise.all([a, b]);
    });

    it('401 on a write invalidates the session', async () => {
      const { fetchFn, calls } = makeFetch([
        sessionOK(),
        jsonResponse(401, { error: 'AuthRequired' }),
        sessionOK(),
        jsonResponse(200, { uri: 'u', cid: 'c' }),
      ]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });

      await expect(p.putRecord('col', 'r', {})).rejects.toBeInstanceOf(PDSPublisherError);
      // Retry: session is re-created because invalidate ran on 401.
      await p.putRecord('col', 'r', {});

      expect(calls.filter((c) => c.url.includes('createSession'))).toHaveLength(2);
    });

    it('createSession failure bubbles up', async () => {
      const { fetchFn } = makeFetch([jsonResponse(400, { error: 'InvalidPassword' })]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });

      const err = await p.putRecord('col', 'r', {}).catch((e) => e);
      expect(err).toBeInstanceOf(PDSPublisherError);
      expect((err as PDSPublisherError).status).toBe(400);
      expect((err as PDSPublisherError).xrpcError).toBe('InvalidPassword');
    });

    it('createSession missing accessJwt/did is treated as malformed', async () => {
      const { fetchFn } = makeFetch([jsonResponse(200, { did: DID })]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });

      await expect(p.putRecord('col', 'r', {})).rejects.toThrow(/accessJwt|did/);
    });
  });

  describe('putRecord', () => {
    it('posts correct body and Authorization', async () => {
      const { fetchFn, calls } = makeFetch([
        sessionOK(),
        jsonResponse(200, { uri: 'at://did/col/rkey', cid: 'bafybeic' }),
      ]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });

      const result = await p.putRecord('com.dina.service.profile', 'self', {
        $type: 'com.dina.service.profile',
        name: 'Bus 42',
      });

      expect(result).toEqual({ uri: 'at://did/col/rkey', cid: 'bafybeic' });
      expect(calls[1].url).toContain('com.atproto.repo.putRecord');
      expect(calls[1].headers['authorization']).toBe(`Bearer ${JWT}`);
      expect(calls[1].body).toEqual({
        repo: DID,
        collection: 'com.dina.service.profile',
        rkey: 'self',
        record: { $type: 'com.dina.service.profile', name: 'Bus 42' },
      });
    });

    it('throws when response missing uri/cid', async () => {
      const { fetchFn } = makeFetch([sessionOK(), jsonResponse(200, { uri: 'u' })]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });

      await expect(p.putRecord('col', 'r', {})).rejects.toThrow(/uri\/cid/);
    });

    it('rejects empty collection / rkey', async () => {
      const { fetchFn } = makeFetch([sessionOK()]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });

      await expect(p.putRecord('', 'r', {})).rejects.toBeInstanceOf(PDSPublisherError);
      await expect(p.putRecord('c', '', {})).rejects.toBeInstanceOf(PDSPublisherError);
    });

    it('surfaces xrpcError in the thrown error', async () => {
      const { fetchFn } = makeFetch([
        sessionOK(),
        jsonResponse(400, { error: 'InvalidSchema', message: 'bad record shape' }),
      ]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });

      const err = await p.putRecord('col', 'r', {}).catch((e) => e);
      expect(err).toBeInstanceOf(PDSPublisherError);
      expect((err as PDSPublisherError).status).toBe(400);
      expect((err as PDSPublisherError).xrpcError).toBe('InvalidSchema');
      expect(err.message).toContain('InvalidSchema');
      expect(err.message).toContain('bad record shape');
    });

    it('converts network error to PDSPublisherError with status=null', async () => {
      const { fetchFn } = makeFetch([sessionOK(), new Error('ECONNRESET')]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });

      const err = await p.putRecord('col', 'r', {}).catch((e) => e);
      expect(err).toBeInstanceOf(PDSPublisherError);
      expect((err as PDSPublisherError).status).toBeNull();
    });
  });

  describe('deleteRecord', () => {
    it('posts to com.atproto.repo.deleteRecord', async () => {
      const { fetchFn, calls } = makeFetch([sessionOK(), jsonResponse(200, {})]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });

      await p.deleteRecord('col', 'rkey');

      expect(calls[1].url).toContain('com.atproto.repo.deleteRecord');
      expect(calls[1].body).toEqual({ repo: DID, collection: 'col', rkey: 'rkey' });
    });

    it('throws on 400', async () => {
      const { fetchFn } = makeFetch([sessionOK(), jsonResponse(400, { error: 'RecordNotFound' })]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });

      await expect(p.deleteRecord('col', 'r')).rejects.toBeInstanceOf(PDSPublisherError);
    });
  });

  describe('deleteRecordIdempotent', () => {
    it('succeeds on 200', async () => {
      const { fetchFn } = makeFetch([sessionOK(), jsonResponse(200, {})]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });
      await expect(p.deleteRecordIdempotent('col', 'r')).resolves.toBeUndefined();
    });

    it('swallows 400 RecordNotFound', async () => {
      const { fetchFn } = makeFetch([
        sessionOK(),
        jsonResponse(400, { error: 'RecordNotFound', message: 'gone' }),
      ]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });
      await expect(p.deleteRecordIdempotent('col', 'r')).resolves.toBeUndefined();
    });

    it('swallows 404', async () => {
      const { fetchFn } = makeFetch([sessionOK(), jsonResponse(404, {})]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });
      await expect(p.deleteRecordIdempotent('col', 'r')).resolves.toBeUndefined();
    });

    it('re-throws on auth failure', async () => {
      const { fetchFn } = makeFetch([sessionOK(), jsonResponse(401, { error: 'AuthRequired' })]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });
      await expect(p.deleteRecordIdempotent('col', 'r')).rejects.toBeInstanceOf(PDSPublisherError);
    });

    it('re-throws on 400 errors that are NOT "gone" (e.g. InvalidRequest)', async () => {
      const { fetchFn } = makeFetch([
        sessionOK(),
        jsonResponse(400, { error: 'InvalidRequest', message: 'bad rkey shape' }),
      ]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });
      const err = await p.deleteRecordIdempotent('col', 'r').catch((e) => e);
      expect(err).toBeInstanceOf(PDSPublisherError);
      expect((err as PDSPublisherError).xrpcError).toBe('InvalidRequest');
    });

    it('re-throws on 5xx', async () => {
      const { fetchFn } = makeFetch([sessionOK(), jsonResponse(500, {})]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });
      await expect(p.deleteRecordIdempotent('col', 'r')).rejects.toBeInstanceOf(PDSPublisherError);
    });
  });

  describe('invalidateSession', () => {
    it('forces a fresh login on the next call', async () => {
      const { fetchFn, calls } = makeFetch([
        sessionOK(),
        jsonResponse(200, { uri: 'u', cid: 'c' }),
        sessionOK(),
        jsonResponse(200, { uri: 'u', cid: 'c' }),
      ]);
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
      });

      await p.putRecord('col', 'r', {});
      p.invalidateSession();
      await p.putRecord('col', 'r', {});

      expect(calls.filter((c) => c.url.includes('createSession'))).toHaveLength(2);
    });
  });

  describe('timeouts', () => {
    it('aborts on slow responses and surfaces PDSPublisherError', async () => {
      let aborted = false;
      const fetchFn: FetchFn = (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        });
      const p = new PDSPublisher({
        pdsUrl: PDS,
        handle: HANDLE,
        password: PASSWORD,
        fetch: fetchFn,
        timeoutMs: 10,
      });
      await expect(p.putRecord('col', 'r', {})).rejects.toBeInstanceOf(PDSPublisherError);
      expect(aborted).toBe(true);
    });
  });
});
