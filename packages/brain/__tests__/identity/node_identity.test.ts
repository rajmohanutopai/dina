/**
 * ensureNodeIdentity — composition tests over mocked fetch.
 *
 * Covers:
 *   - Fast path: existing session returned untouched.
 *   - Slow path: PLC registration + createAccount with our DID.
 *   - Guards: missing / wrong-length inputs rejected before any I/O.
 *   - Safety: PDS returning a different DID surfaces as a typed error.
 *   - Fallthrough: bad-password / 5xx errors are NOT coerced into account creation.
 */

import { ensureNodeIdentity } from '../../src/identity/node_identity';
import { PDSAccountError } from '../../src/pds/account';
import { randomBytes } from '@noble/ciphers/utils.js';

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

// Fixed seeds so tests are deterministic.
const SIGNING_SEED = new Uint8Array(32).fill(0x42);
const ROTATION_SEED = new Uint8Array(32).fill(0x7f);

const HANDLE = 'busdriver.test-pds.dinakernel.com';
const PASSWORD = 'hunter2';
const PDS_URL = 'https://test-pds.dinakernel.com';
const PLC_URL = 'https://plc.directory';

describe('ensureNodeIdentity — input validation', () => {
  const base = {
    handle: HANDLE,
    password: PASSWORD,
    pdsUrl: PDS_URL,
    signingSeed: SIGNING_SEED,
    rotationSeed: ROTATION_SEED,
  };

  it('rejects empty handle', async () => {
    await expect(ensureNodeIdentity({ ...base, handle: '' })).rejects.toThrow(/handle/);
  });

  it('rejects empty password', async () => {
    await expect(ensureNodeIdentity({ ...base, password: '' })).rejects.toThrow(/password/);
  });

  it('rejects empty pdsUrl', async () => {
    await expect(ensureNodeIdentity({ ...base, pdsUrl: '' })).rejects.toThrow(/pdsUrl/);
  });

  it('rejects signing seed of wrong length', async () => {
    await expect(ensureNodeIdentity({ ...base, signingSeed: new Uint8Array(31) })).rejects.toThrow(
      /signingSeed/,
    );
  });

  it('rejects rotation seed of wrong length', async () => {
    await expect(ensureNodeIdentity({ ...base, rotationSeed: new Uint8Array(16) })).rejects.toThrow(
      /rotationSeed/,
    );
  });
});

describe('ensureNodeIdentity — fast path (account exists)', () => {
  it('returns the existing session and skips PLC + createAccount', async () => {
    const calls: string[] = [];
    const fetchFn = mockFetch((url) => {
      calls.push(url);
      if (url.includes('createSession')) {
        return okJson({
          accessJwt: 'access-xyz',
          refreshJwt: 'refresh-xyz',
          handle: HANDLE,
          did: 'did:plc:existing-busdriver',
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const ident = await ensureNodeIdentity({
      handle: HANDLE,
      password: PASSWORD,
      pdsUrl: PDS_URL,
      plcUrl: PLC_URL,
      signingSeed: SIGNING_SEED,
      rotationSeed: ROTATION_SEED,
      fetch: fetchFn,
    });

    expect(ident.did).toBe('did:plc:existing-busdriver');
    expect(ident.accountCreated).toBe(false);
    expect(ident.plcRegistered).toBe(false);
    expect(ident.pdsSession.accessJwt).toBe('access-xyz');
    // Public key derived from the provided seed — same input always the same output.
    expect(ident.signingKeypair.publicKey).toBeInstanceOf(Uint8Array);
    expect(ident.signingKeypair.publicKey.length).toBe(32);
    // Only one network call happened.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('createSession');
  });
});

describe('ensureNodeIdentity — slow path (new account)', () => {
  it('registers PLC and creates account when createSession reports AccountNotFound', async () => {
    const calls: string[] = [];
    const seen: Record<string, unknown>[] = [];
    let expectedDID = '';

    const fetchFn = mockFetch((url, init) => {
      calls.push(url);
      if (url.includes('createSession')) {
        return errorJson(400, 'AccountNotFound');
      }
      if (url.includes('plc.directory')) {
        // PLC registration POST — the URL ends with /did:plc:<id>. We
        // capture that id so the createAccount step gets the same DID.
        const match = url.match(/did:plc:[a-z0-9]+$/);
        expectedDID = match ? match[0] : '';
        return new Response('', { status: 200 });
      }
      if (url.includes('createAccount')) {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        seen.push(body);
        return okJson({
          accessJwt: 'fresh-access',
          refreshJwt: 'fresh-refresh',
          handle: HANDLE,
          did: expectedDID,
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const ident = await ensureNodeIdentity({
      handle: HANDLE,
      password: PASSWORD,
      pdsUrl: PDS_URL,
      plcUrl: PLC_URL,
      msgboxEndpoint: 'wss://test-mailbox.dinakernel.com',
      email: 'busdriver@example.com',
      signingSeed: SIGNING_SEED,
      rotationSeed: ROTATION_SEED,
      fetch: fetchFn,
    });

    expect(ident.accountCreated).toBe(true);
    expect(ident.plcRegistered).toBe(true);
    expect(ident.did).toBe(expectedDID);
    expect(ident.did.startsWith('did:plc:')).toBe(true);
    expect(ident.pdsSession.accessJwt).toBe('fresh-access');

    // The DID we registered with PLC is what we handed to createAccount.
    expect(seen[0].did).toBe(expectedDID);
    expect(seen[0].handle).toBe(HANDLE);
    expect(seen[0].email).toBe('busdriver@example.com');
    // Call sequence: createSession (miss) → PLC registration → createAccount.
    expect(calls.map((c) => new URL(c).pathname).join(' / ')).toMatch(
      /createSession.*plc.*createAccount/s,
    );
  });

  it('throws when the PDS returns a different DID than the one we registered', async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes('createSession')) return errorJson(400, 'AccountNotFound');
      if (url.includes('plc.directory')) return new Response('', { status: 200 });
      if (url.includes('createAccount')) {
        return okJson({
          accessJwt: 'a',
          refreshJwt: 'r',
          handle: HANDLE,
          did: 'did:plc:some-unexpected-did-the-pds-minted',
        });
      }
      throw new Error('unexpected');
    });

    await expect(
      ensureNodeIdentity({
        handle: HANDLE,
        password: PASSWORD,
        pdsUrl: PDS_URL,
        plcUrl: PLC_URL,
        signingSeed: SIGNING_SEED,
        rotationSeed: ROTATION_SEED,
        fetch: fetchFn,
      }),
    ).rejects.toMatchObject({
      name: 'PDSAccountError',
    });
  });
});

describe('ensureNodeIdentity — safety: do not coerce errors into account creation', () => {
  it('propagates wrong-password (InvalidPassword) without attempting createAccount', async () => {
    const calls: string[] = [];
    const fetchFn = mockFetch((url) => {
      calls.push(url);
      if (url.includes('createSession')) {
        return errorJson(401, 'AuthenticationRequired', 'invalid password');
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    await expect(
      ensureNodeIdentity({
        handle: HANDLE,
        password: 'wrong',
        pdsUrl: PDS_URL,
        plcUrl: PLC_URL,
        signingSeed: SIGNING_SEED,
        rotationSeed: ROTATION_SEED,
        fetch: fetchFn,
      }),
    ).rejects.toBeInstanceOf(PDSAccountError);

    expect(calls.every((c) => c.includes('createSession'))).toBe(true);
  });

  it('propagates 5xx without attempting account creation', async () => {
    const calls: string[] = [];
    const fetchFn = mockFetch((url) => {
      calls.push(url);
      if (url.includes('createSession')) return errorJson(503, 'InternalError');
      throw new Error(`unexpected URL: ${url}`);
    });

    await expect(
      ensureNodeIdentity({
        handle: HANDLE,
        password: PASSWORD,
        pdsUrl: PDS_URL,
        plcUrl: PLC_URL,
        signingSeed: SIGNING_SEED,
        rotationSeed: ROTATION_SEED,
        fetch: fetchFn,
      }),
    ).rejects.toBeInstanceOf(PDSAccountError);

    expect(calls.length).toBe(1);
  });
});

describe('ensureNodeIdentity — determinism', () => {
  it('same signing seed → same did:plc', async () => {
    // With fixed seeds and the same MsgBox endpoint/handle the DID that
    // PLC derives is stable. Two runs should produce identical DIDs.
    const seed1 = new Uint8Array(32).fill(0x11);
    const seed2 = new Uint8Array(32).fill(0x22);

    async function resolveDID(signingSeed: Uint8Array): Promise<string> {
      let did = '';
      const fetchFn = mockFetch((url) => {
        if (url.includes('createSession')) return errorJson(400, 'AccountNotFound');
        if (url.includes('plc.directory')) {
          did = (url.match(/did:plc:[a-z0-9]+$/) ?? [''])[0];
          return new Response('', { status: 200 });
        }
        if (url.includes('createAccount')) {
          return okJson({ accessJwt: 'a', refreshJwt: 'r', handle: HANDLE, did });
        }
        throw new Error('unexpected');
      });
      const ident = await ensureNodeIdentity({
        handle: HANDLE,
        password: PASSWORD,
        pdsUrl: PDS_URL,
        plcUrl: PLC_URL,
        signingSeed,
        rotationSeed: ROTATION_SEED,
        fetch: fetchFn,
      });
      return ident.did;
    }

    const a = await resolveDID(seed1);
    const b = await resolveDID(seed1);
    const c = await resolveDID(seed2);
    expect(a).toBe(b); // determinism on same seed
    expect(a).not.toBe(c); // different seeds → different DIDs
  });
});

describe('ensureNodeIdentity — random seed smoke', () => {
  it('accepts random 32-byte seeds end-to-end', async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes('createSession')) return errorJson(400, 'AccountNotFound');
      if (url.includes('plc.directory')) return new Response('', { status: 200 });
      if (url.includes('createAccount')) {
        const body = JSON.parse('{}');
        return okJson({
          accessJwt: 'a',
          refreshJwt: 'r',
          handle: HANDLE,
          did: 'did:plc:placeholder',
        });
      }
      throw new Error('unexpected');
    });
    // Our test fetch returns did:plc:placeholder regardless of the PLC
    // registration URL's actual DID, which triggers the safety check. Use
    // a fetch variant that respects the registered DID.
    const fetchFn2 = mockFetch((url) => {
      if (url.includes('createSession')) return errorJson(400, 'AccountNotFound');
      if (url.includes('plc.directory')) {
        (fetchFn2 as unknown as { _registeredDID?: string })._registeredDID = (url.match(
          /did:plc:[a-z0-9]+$/,
        ) ?? [''])[0];
        return new Response('', { status: 200 });
      }
      if (url.includes('createAccount')) {
        const did = (fetchFn2 as unknown as { _registeredDID?: string })._registeredDID!;
        return okJson({ accessJwt: 'a', refreshJwt: 'r', handle: HANDLE, did });
      }
      throw new Error('unexpected');
    });
    const ident = await ensureNodeIdentity({
      handle: HANDLE,
      password: PASSWORD,
      pdsUrl: PDS_URL,
      plcUrl: PLC_URL,
      signingSeed: randomBytes(32),
      rotationSeed: randomBytes(32),
      fetch: fetchFn2,
    });
    expect(ident.did.startsWith('did:plc:')).toBe(true);
    expect(fetchFn).toBeDefined(); // silence unused
  });
});
