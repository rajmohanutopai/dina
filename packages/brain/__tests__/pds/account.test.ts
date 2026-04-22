/**
 * PDSAccountClient tests — mocked-fetch coverage of the XRPC surface.
 *
 * Live-infrastructure tests (hitting test-pds.dinakernel.com) live in the
 * integration suite and are env-var gated so they don't run by default.
 */

import { PDSAccountClient, PDSAccountError } from '../../src/pds/account';

type MockFetch = jest.Mock<Promise<Response>, [input: string | URL | Request, init?: RequestInit]>;

function mockFetch(
  impl: (url: string, init: RequestInit) => Response | Promise<Response>,
): MockFetch {
  return jest.fn(async (input, init) => impl(String(input), init ?? {})) as unknown as MockFetch;
}

function okJson(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorJson(status: number, error: string, message?: string): Response {
  return new Response(JSON.stringify(message !== undefined ? { error, message } : { error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const VALID_SESSION = {
  accessJwt: 'access-jwt-xyz',
  refreshJwt: 'refresh-jwt-xyz',
  handle: 'busdriver.test-pds.dinakernel.com',
  did: 'did:plc:busdriver42',
};

describe('PDSAccountClient — construction', () => {
  it('rejects empty pdsUrl', () => {
    expect(() => new PDSAccountClient({ pdsUrl: '' })).toThrow(/pdsUrl/);
  });

  it('rejects non-positive timeoutMs', () => {
    expect(() => new PDSAccountClient({ pdsUrl: 'https://pds', timeoutMs: 0 })).toThrow(
      /timeoutMs/,
    );
  });

  it('strips trailing slash from pdsUrl', async () => {
    const fetchFn = mockFetch(() => okJson({ availableUserDomains: [] }));
    const client = new PDSAccountClient({ pdsUrl: 'https://pds.example/', fetch: fetchFn });
    await client.describeServer();
    expect(fetchFn.mock.calls[0][0]).toBe(
      'https://pds.example/xrpc/com.atproto.server.describeServer',
    );
  });
});

describe('PDSAccountClient.describeServer', () => {
  it('returns the JSON body on 200', async () => {
    const fetchFn = mockFetch(() =>
      okJson({ inviteCodeRequired: true, availableUserDomains: ['.test-pds'] }),
    );
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    const body = await client.describeServer();
    expect(body).toEqual({ inviteCodeRequired: true, availableUserDomains: ['.test-pds'] });
  });

  it('throws PDSAccountError on non-200', async () => {
    const fetchFn = mockFetch(() => errorJson(500, 'InternalError', 'upstream down'));
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    await expect(client.describeServer()).rejects.toMatchObject({
      name: 'PDSAccountError',
      status: 500,
      xrpcError: 'InternalError',
    });
  });
});

describe('PDSAccountClient.createAccount', () => {
  it('posts the JSON envelope and parses the session on 200', async () => {
    const fetchFn = mockFetch(() => okJson(VALID_SESSION));
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    const session = await client.createAccount({
      handle: 'alice.test-pds',
      password: 'hunter2',
      email: 'alice@example.com',
      inviteCode: 'abc-123',
    });
    expect(session).toEqual(VALID_SESSION);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://pds/xrpc/com.atproto.server.createAccount');
    expect(init!.method).toBe('POST');
    const sentBody = JSON.parse(init!.body as string);
    expect(sentBody).toEqual({
      handle: 'alice.test-pds',
      password: 'hunter2',
      email: 'alice@example.com',
      inviteCode: 'abc-123',
    });
  });

  it('forwards self-managed did in the envelope when supplied', async () => {
    const fetchFn = mockFetch(() => okJson(VALID_SESSION));
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    await client.createAccount({
      handle: 'alice.test-pds',
      password: 'hunter2',
      did: 'did:plc:alice-self-managed',
    });
    const sentBody = JSON.parse(fetchFn.mock.calls[0][1]!.body as string);
    expect(sentBody.did).toBe('did:plc:alice-self-managed');
  });

  it('rejects missing handle / password before making a request', async () => {
    const fetchFn = mockFetch(() => okJson({}));
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    await expect(client.createAccount({ handle: '', password: 'x' })).rejects.toMatchObject({
      name: 'PDSAccountError',
    });
    await expect(client.createAccount({ handle: 'x', password: '' })).rejects.toMatchObject({
      name: 'PDSAccountError',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('surfaces XRPC error code on 400', async () => {
    const fetchFn = mockFetch(() => errorJson(400, 'HandleNotAvailable', 'that handle is taken'));
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    await expect(
      client.createAccount({ handle: 'x.test-pds', password: 'p' }),
    ).rejects.toMatchObject({
      name: 'PDSAccountError',
      status: 400,
      xrpcError: 'HandleNotAvailable',
    });
  });

  it('rejects when response omits required session fields', async () => {
    const fetchFn = mockFetch(() => okJson({ accessJwt: 'a', refreshJwt: 'b' })); // missing did/handle
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    await expect(client.createAccount({ handle: 'x', password: 'p' })).rejects.toThrow(
      /missing.*did/,
    );
  });
});

describe('PDSAccountClient.createSession', () => {
  it('posts identifier + password and returns session on 200', async () => {
    const fetchFn = mockFetch(() => okJson(VALID_SESSION));
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    const session = await client.createSession({
      identifier: 'busdriver.test-pds',
      password: 'hunter2',
    });
    expect(session).toEqual(VALID_SESSION);
    const sentBody = JSON.parse(fetchFn.mock.calls[0][1]!.body as string);
    expect(sentBody).toEqual({
      identifier: 'busdriver.test-pds',
      password: 'hunter2',
    });
  });

  it('propagates XRPC AccountNotFound as a typed error', async () => {
    const fetchFn = mockFetch(() => errorJson(400, 'AccountNotFound'));
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    await expect(
      client.createSession({ identifier: 'nobody', password: 'x' }),
    ).rejects.toMatchObject({
      name: 'PDSAccountError',
      status: 400,
      xrpcError: 'AccountNotFound',
    });
  });
});

describe('PDSAccountClient.refreshSession', () => {
  it('sends the refresh JWT as the bearer token', async () => {
    const fetchFn = mockFetch(() =>
      okJson({
        ...VALID_SESSION,
        accessJwt: 'fresh-access',
        refreshJwt: 'new-refresh',
      }),
    );
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    const session = await client.refreshSession('old-refresh-jwt');
    expect(session.accessJwt).toBe('fresh-access');
    const init = fetchFn.mock.calls[0][1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer old-refresh-jwt');
  });

  it('surfaces 401 as PDSAccountError', async () => {
    const fetchFn = mockFetch(() => errorJson(401, 'ExpiredToken'));
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    await expect(client.refreshSession('expired')).rejects.toMatchObject({
      name: 'PDSAccountError',
      status: 401,
      xrpcError: 'ExpiredToken',
    });
  });
});

describe('PDSAccountClient.ensureAccount', () => {
  it('returns {created:false} when createSession succeeds', async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes('createSession')) return okJson(VALID_SESSION);
      throw new Error('unexpected URL: ' + url);
    });
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    const { session, created } = await client.ensureAccount({
      handle: 'busdriver.test-pds',
      password: 'hunter2',
    });
    expect(created).toBe(false);
    expect(session).toEqual(VALID_SESSION);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('falls back to createAccount on AccountNotFound, returns {created:true}', async () => {
    let calls = 0;
    const fetchFn = mockFetch((url) => {
      calls++;
      if (calls === 1) {
        expect(url).toContain('createSession');
        return errorJson(400, 'AccountNotFound');
      }
      expect(url).toContain('createAccount');
      return okJson(VALID_SESSION);
    });
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    const { session, created } = await client.ensureAccount({
      handle: 'newbie.test-pds',
      password: 'hunter2',
    });
    expect(created).toBe(true);
    expect(session).toEqual(VALID_SESSION);
    expect(calls).toBe(2);
  });

  it('propagates a non-missing-account error without calling createAccount', async () => {
    const fetchFn = mockFetch(() => errorJson(500, 'InternalError', 'boom'));
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    await expect(
      client.ensureAccount({
        handle: 'x.test-pds',
        password: 'p',
      }),
    ).rejects.toMatchObject({
      name: 'PDSAccountError',
      status: 500,
    });
    // createSession was the only call; no fallback attempt
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('passes existingDID through when creating the account', async () => {
    const sendBodies: Record<string, unknown>[] = [];
    const fetchFn = mockFetch((url, init) => {
      sendBodies.push(JSON.parse((init.body as string) ?? '{}'));
      if (url.includes('createSession')) return errorJson(400, 'AccountNotFound');
      return okJson(VALID_SESSION);
    });
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    await client.ensureAccount({
      handle: 'alice.test-pds',
      password: 'p',
      existingDID: 'did:plc:alice-self-managed',
    });
    expect(sendBodies[1].did).toBe('did:plc:alice-self-managed');
  });
});

describe('PDSAccountClient — network errors', () => {
  it('wraps fetch throws as PDSAccountError with status=null', async () => {
    const fetchFn = mockFetch(() => {
      throw new Error('connection reset');
    });
    const client = new PDSAccountClient({ pdsUrl: 'https://pds', fetch: fetchFn });
    await expect(client.describeServer()).rejects.toMatchObject({
      name: 'PDSAccountError',
      status: null,
    });
  });
});
