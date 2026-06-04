/**
 * ATProto OAuth client — discovery + PAR (DPoP nonce retry) + token
 * exchange, with a mocked authorization server. Verifies the DPoP proof
 * is a valid ES256 JWT and that the sub===DID proof-of-control guard
 * holds. No network, no native modules.
 */

import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  startOAuth,
  completeOAuth,
  oauthClientConfig,
  generateDpopKey,
  type FetchLike,
} from '../../src/services/atproto_oauth';

const DID = 'did:plc:linkedbsky9876';
const HANDLE = 'alice.bsky.social';
const PDS = 'https://pds.example';
const ISSUER = 'https://bsky.social';
const OAUTH_CLIENT = 'https://test-mobile.dinakernel.com';

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = globalThis.atob ? globalThis.atob(b) : Buffer.from(b, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function jsonResponse(status: number, body: unknown, dpopNonce?: string) {
  const headers = new Map<string, string>();
  if (dpopNonce !== undefined) headers.set('dpop-nonce', dpopNonce);
  return {
    status,
    headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function makeAuthServer(opts: { tokenSub: string }) {
  const calls: Recorded[] = [];
  let parCount = 0;
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body });
    if (url === `${PDS}/.well-known/oauth-protected-resource`) {
      return jsonResponse(200, { authorization_servers: [ISSUER] });
    }
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return jsonResponse(200, {
        issuer: ISSUER,
        pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
      });
    }
    if (url === `${ISSUER}/oauth/par`) {
      parCount += 1;
      // First PAR: demand a nonce (400). Second: success (201).
      if (parCount === 1) {
        return jsonResponse(400, { error: 'use_dpop_nonce' }, 'server-nonce-abc');
      }
      return jsonResponse(201, { request_uri: 'urn:ietf:params:oauth:request_uri:demo', expires_in: 60 });
    }
    if (url === `${ISSUER}/oauth/token`) {
      return jsonResponse(
        200,
        {
          access_token: 'at-token',
          refresh_token: 'rt-token',
          token_type: 'DPoP',
          sub: opts.tokenSub,
          scope: 'atproto',
        },
        'server-nonce-xyz',
      );
    }
    return jsonResponse(404, { error: 'not_found' });
  };
  return { fetchFn, calls, parCalls: () => parCount };
}

const resolve = (async () => ({
  did: DID,
  handle: HANDLE,
  pdsUrl: PDS,
  rotationKeys: [],
  alsoKnownAs: [`at://${HANDLE}`],
  verificationMethods: {},
  services: {},
})) as never;

describe('oauthClientConfig', () => {
  it('derives client_id + reverse-domain native redirect from the OAuth client host', () => {
    const cfg = oauthClientConfig(OAUTH_CLIENT);
    expect(cfg.clientId).toBe('https://test-mobile.dinakernel.com/oauth/client-metadata.json');
    expect(cfg.redirectUri).toBe('com.dinakernel.test-mobile:/oauth/callback');
  });
});

describe('generateDpopKey', () => {
  it('produces a P-256 JWK with 32-byte x/y coordinates', () => {
    const k = generateDpopKey();
    expect(k.jwk.kty).toBe('EC');
    expect(k.jwk.crv).toBe('P-256');
    expect(b64urlDecode(k.jwk.x).length).toBe(32);
    expect(b64urlDecode(k.jwk.y).length).toBe(32);
  });
});

describe('startOAuth', () => {
  it('discovers, retries PAR on DPoP nonce, and returns an authorize URL with a valid DPoP proof', async () => {
    const srv = makeAuthServer({ tokenSub: DID });
    const { authorizeUrl, session } = await startOAuth('alice.bsky.social', {
      fetchFn: srv.fetchFn,
      oauthClientUrl: OAUTH_CLIENT,
      nowSec: 1_780_000_000,
      resolve,
    });

    expect(session.did).toBe(DID);
    expect(authorizeUrl.startsWith(`${ISSUER}/oauth/authorize?`)).toBe(true);
    expect(authorizeUrl).toContain('request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Ademo');
    expect(authorizeUrl).toContain(encodeURIComponent(session.clientId));

    // PAR was retried once (nonce challenge → success).
    expect(srv.parCalls()).toBe(2);

    // SECURITY: identity-only scope. The PAR requests `atproto`, NEVER the
    // broad `transition:generic` (app-password-like PDS access) — that would
    // contradict the "No other access required" read-only-link promise.
    const parBody = String(
      srv.calls.filter((c) => c.url.endsWith('/oauth/par'))[1]?.body ?? '',
    );
    expect(parBody).toMatch(/(^|&)scope=atproto(&|$)/);
    expect(parBody).not.toContain('transition');

    // The retried PAR carried a DPoP proof that (a) is a valid ES256 JWT
    // over its signing input, and (b) echoes the server nonce.
    const parCalls = srv.calls.filter((c) => c.url.endsWith('/oauth/par'));
    const proof = parCalls[1].headers.DPoP;
    expect(typeof proof).toBe('string');
    const [h, pl, sig] = proof.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(pl)));
    expect(header.typ).toBe('dpop+jwt');
    expect(header.alg).toBe('ES256');
    expect(payload.htm).toBe('POST');
    expect(payload.htu).toBe(`${ISSUER}/oauth/par`);
    expect(payload.nonce).toBe('server-nonce-abc');
    // Verify the ES256 signature against the embedded JWK.
    const pub = new Uint8Array([0x04, ...b64urlDecode(header.jwk.x), ...b64urlDecode(header.jwk.y)]);
    const digest = sha256(new TextEncoder().encode(`${h}.${pl}`));
    expect(p256.verify(b64urlDecode(sig), digest, pub, { prehash: false })).toBe(true);
  });
});

describe('completeOAuth', () => {
  async function startSession(tokenSub: string) {
    const srv = makeAuthServer({ tokenSub });
    const { session } = await startOAuth('alice.bsky.social', {
      fetchFn: srv.fetchFn,
      oauthClientUrl: OAUTH_CLIENT,
      nowSec: 1_780_000_000,
      resolve,
    });
    return { srv, session };
  }

  it('exchanges the code for DPoP-bound tokens and returns the PROVEN did', async () => {
    const { srv, session } = await startSession(DID);
    const result = await completeOAuth(
      session,
      { code: 'auth-code-123', state: session.state },
      { fetchFn: srv.fetchFn, nowSec: 1_780_000_010 },
    );
    expect(result.did).toBe(DID);
    expect(result.handle).toBe(HANDLE);
    expect(result.accessToken).toBe('at-token');
    expect(result.refreshToken).toBe('rt-token');
    expect(result.dpopKeyJwk.crv).toBe('P-256');

    // token request carried the carried-forward DPoP nonce from PAR.
    const tokenCall = srv.calls.find((c) => c.url.endsWith('/oauth/token'));
    expect(tokenCall).toBeDefined();
    const payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode((tokenCall?.headers.DPoP ?? '').split('.')[1])),
    );
    expect(payload.htm).toBe('POST');
    expect(payload.htu).toBe(`${ISSUER}/oauth/token`);
  });

  it('rejects a state mismatch (CSRF guard)', async () => {
    const { srv, session } = await startSession(DID);
    await expect(
      completeOAuth(session, { code: 'x', state: 'wrong' }, { fetchFn: srv.fetchFn, nowSec: 1 }),
    ).rejects.toThrow(/state mismatch/i);
  });

  it('rejects when token sub does not match the resolved DID (proof-of-control)', async () => {
    const { srv, session } = await startSession('did:plc:someoneelse');
    await expect(
      completeOAuth(
        session,
        { code: 'auth-code-123', state: session.state },
        { fetchFn: srv.fetchFn, nowSec: 2 },
      ),
    ).rejects.toThrow(/does not match resolved DID/);
  });
});
