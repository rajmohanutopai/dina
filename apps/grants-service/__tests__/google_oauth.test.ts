/**
 * Google service-account token minter — the RS256 assertion is verified
 * against a real generated keypair, and the token-exchange caching /
 * coalescing / failure paths are pinned with an injected fetch.
 */

import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';

import {
  GoogleAccessTokenMinter,
  buildServiceAccountAssertion,
} from '../src/google_oauth';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SCOPE = 'https://www.googleapis.com/auth/playintegrity';

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

describe('buildServiceAccountAssertion', () => {
  it('produces a JWT whose RS256 signature verifies against the SA public key', () => {
    const jwt = buildServiceAccountAssertion({
      clientEmail: 'sa@proj.iam.gserviceaccount.com',
      privateKeyPem: PEM,
      scope: SCOPE,
      nowMs: 1_750_000_000_000,
    });
    const [header, claims, sig] = jwt.split('.');
    const ok = cryptoVerify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      publicKey,
      b64urlToBuf(sig),
    );
    expect(ok).toBe(true);

    const decoded = JSON.parse(b64urlToBuf(claims).toString()) as Record<string, unknown>;
    expect(decoded).toMatchObject({
      iss: 'sa@proj.iam.gserviceaccount.com',
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_750_000_000,
      exp: 1_750_000_000 + 3600,
    });
    const head = JSON.parse(b64urlToBuf(header).toString()) as Record<string, unknown>;
    expect(head).toEqual({ alg: 'RS256', typ: 'JWT' });
  });
});

function minter(
  fetchImpl: typeof fetch,
  now: () => number,
): GoogleAccessTokenMinter {
  return new GoogleAccessTokenMinter({
    serviceAccount: { clientEmail: 'sa@proj.iam.gserviceaccount.com', privateKeyPem: PEM },
    scope: SCOPE,
    fetchImpl,
    now,
  });
}

describe('GoogleAccessTokenMinter', () => {
  it('exchanges the assertion and returns the access token', async () => {
    let seenBody = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seenBody = String(init.body);
      return new Response(JSON.stringify({ access_token: 'ya29.abc', expires_in: 3600 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const token = await minter(fetchImpl, () => 1_750_000_000_000).getAccessToken();
    expect(token).toBe('ya29.abc');
    expect(seenBody).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(seenBody).toContain('assertion=');
  });

  it('caches the token and does not re-exchange until near expiry', async () => {
    let calls = 0;
    let clock = 1_750_000_000_000;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ access_token: `t${String(calls)}`, expires_in: 3600 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const m = minter(fetchImpl, () => clock);
    expect(await m.getAccessToken()).toBe('t1');
    clock += 60_000; // well inside the hour
    expect(await m.getAccessToken()).toBe('t1');
    expect(calls).toBe(1);
    clock += 3600_000; // past expiry
    expect(await m.getAccessToken()).toBe('t2');
    expect(calls).toBe(2);
  });

  it('coalesces concurrent mints onto one exchange', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ access_token: 'shared', expires_in: 3600 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const m = minter(fetchImpl, () => 1_750_000_000_000);
    const [a, b] = await Promise.all([m.getAccessToken(), m.getAccessToken()]);
    expect(a).toBe('shared');
    expect(b).toBe('shared');
    expect(calls).toBe(1);
  });

  it('throws on a non-200 exchange (caller maps to transient)', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 400 })) as unknown as typeof fetch;
    await expect(minter(fetchImpl, () => 1).getAccessToken()).rejects.toThrow(/HTTP 400/);
  });

  it('throws when the exchange omits an access_token', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
    await expect(minter(fetchImpl, () => 1).getAccessToken()).rejects.toThrow(/no access_token/);
  });
});
