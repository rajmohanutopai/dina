/**
 * ATProto OAuth client — "Login with Bluesky".
 *
 * Public (native) OAuth client per the atproto OAuth spec
 * (atproto.com/specs/oauth): PAR + PKCE-S256 + DPoP-ES256, all
 * mandatory. The point is PROOF that the user controls the DID — Dina
 * receives a DID-bound session (`sub`), NOT control of the account:
 *   - no PLC mutation, no repo write, no record published as them
 *   - no PDS / app password ever entered or stored
 * The verified `bluesky_did` is linked to Dina's own `dina_did`
 * (see `linked_identity_record`).
 *
 * Crypto is pure-JS (RN-safe): `@noble/curves` P-256 for the DPoP
 * keypair + ES256 signing, `@noble/hashes` SHA-256 for PKCE + DPoP
 * proof hashing, `react-native-get-random-values`-backed randomBytes.
 * No web-crypto / jose dependency.
 *
 * The flow is split because consent happens in the system browser:
 *   1. `startOAuth(identifier)` → discover + PAR → returns an authorize
 *      URL + an opaque `OAuthSession` to carry across the redirect.
 *   2. host opens the URL, user approves on Bluesky, redirect comes back
 *      to `com.<host-reversed>:/oauth/callback?code=…&state=…`.
 *   3. `completeOAuth(session, code, state)` → DPoP-bound token exchange
 *      → verifies `sub === resolved DID` → returns the proven link.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

import type { resolveExistingAtprotoIdentity } from './atproto_identity';

/** Read-only handle→did resolver. Injected so this module stays pure
 *  (no RN deps) and runnable in Node test drivers. */
export type IdentityResolver = typeof resolveExistingAtprotoIdentity;

const DEFAULT_APPVIEW = 'https://test-appview.dinakernel.com';

// ── base64url (no padding) ──────────────────────────────────────────
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const b0 = bytes[i];
    const b1 = rem > 1 ? bytes[i + 1] : 0;
    const n = (b0 << 16) | (b1 << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (rem > 1) out += B64[(n >> 6) & 63];
  }
  return out;
}

function b64urlJson(obj: unknown): string {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

// ── DPoP key (ES256 / P-256) ────────────────────────────────────────
export interface DpopKey {
  /** 32-byte P-256 secret key (hex) — opaque session material. */
  secretHex: string;
  /** Public JWK (kty EC, P-256). */
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function generateDpopKey(): DpopKey {
  const kg = p256.keygen();
  const pub = p256.getPublicKey(kg.secretKey, false); // 0x04 || X(32) || Y(32)
  return {
    secretHex: hex(kg.secretKey),
    jwk: {
      kty: 'EC',
      crv: 'P-256',
      x: b64urlEncode(pub.slice(1, 33)),
      y: b64urlEncode(pub.slice(33, 65)),
    },
  };
}

function es256Sign(signingInput: string, secretHex: string): string {
  const digest = sha256(new TextEncoder().encode(signingInput));
  const sig = p256.sign(digest, unhex(secretHex), { prehash: false }); // raw r||s, 64 bytes
  return b64urlEncode(sig);
}

interface DpopClaims {
  htm: string;
  htu: string;
  nonce?: string;
  ath?: string;
  nowSec: number;
}

function buildDpopProof(key: DpopKey, c: DpopClaims): string {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk };
  const payload: Record<string, unknown> = {
    jti: hex(randomBytes(16)),
    htm: c.htm,
    htu: c.htu.split('?')[0].split('#')[0],
    iat: c.nowSec,
  };
  if (c.nonce !== undefined) payload.nonce = c.nonce;
  if (c.ath !== undefined) payload.ath = c.ath;
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  return `${signingInput}.${es256Sign(signingInput, key.secretHex)}`;
}

// ── HTTP with DPoP + one nonce retry ────────────────────────────────
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;

async function dpopFetch(
  fetchFn: FetchLike,
  url: string,
  method: string,
  body: string,
  contentType: string,
  key: DpopKey,
  nonceRef: { nonce?: string },
  nowSec: number,
): Promise<{ status: number; bodyText: string }> {
  const attempt = async (): Promise<{ status: number; bodyText: string; nonce: string | null }> => {
    const proof = buildDpopProof(key, { htm: method, htu: url, nonce: nonceRef.nonce, nowSec });
    const res = await fetchFn(url, {
      method,
      headers: { 'Content-Type': contentType, DPoP: proof },
      body,
    });
    return { status: res.status, bodyText: await res.text(), nonce: res.headers.get('DPoP-Nonce') };
  };
  let r = await attempt();
  // Server demands (or rotates) a nonce → 400 use_dpop_nonce. Retry once.
  if (r.status === 400 && r.nonce && /use_dpop_nonce|nonce/i.test(r.bodyText)) {
    nonceRef.nonce = r.nonce;
    r = await attempt();
  }
  if (r.nonce) nonceRef.nonce = r.nonce;
  return { status: r.status, bodyText: r.bodyText };
}

// ── Discovery ───────────────────────────────────────────────────────
export interface AuthServerInfo {
  did: string;
  handle: string | null;
  pdsUrl: string;
  issuer: string;
  parEndpoint: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

async function getJson(fetchFn: FetchLike, url: string): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, { method: 'GET' });
  if (res.status !== 200) throw new Error(`GET ${url} → ${res.status}`);
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

export async function discoverAuthServer(
  identifier: string,
  opts: { fetchFn: FetchLike; plcURL?: string; resolve: IdentityResolver },
): Promise<AuthServerInfo> {
  const resolved = await opts.resolve(
    identifier,
    opts.plcURL !== undefined ? { plcURL: opts.plcURL } : {},
  );
  const pdsUrl = resolved.pdsUrl.replace(/\/$/, '');
  // Resource server metadata → authorization_servers[0].
  const prm = await getJson(opts.fetchFn, `${pdsUrl}/.well-known/oauth-protected-resource`);
  const authServers = Array.isArray(prm.authorization_servers) ? prm.authorization_servers : [];
  const issuer = String(authServers[0] ?? '').replace(/\/$/, '');
  if (issuer === '') throw new Error('PDS did not advertise an authorization server');
  // Authorization server metadata.
  const asm = await getJson(opts.fetchFn, `${issuer}/.well-known/oauth-authorization-server`);
  const par = String(asm.pushed_authorization_request_endpoint ?? '');
  const authz = String(asm.authorization_endpoint ?? '');
  const token = String(asm.token_endpoint ?? '');
  if (par === '' || authz === '' || token === '') {
    throw new Error('authorization server metadata missing PAR/authorize/token endpoints');
  }
  return {
    did: resolved.did,
    handle: resolved.handle,
    pdsUrl,
    issuer,
    parEndpoint: par,
    authorizationEndpoint: authz,
    tokenEndpoint: token,
  };
}

// ── client_id / redirect derived from the AppView host ──────────────
export function oauthClientConfig(appViewUrl?: string): { clientId: string; redirectUri: string } {
  const base = (appViewUrl ?? process.env.EXPO_PUBLIC_DINA_APPVIEW_URL ?? DEFAULT_APPVIEW).replace(
    /\/$/,
    '',
  );
  const host = base.replace(/^https?:\/\//, '').split('/')[0];
  const scheme = host.split(':')[0].split('.').reverse().join('.');
  return { clientId: `${base}/oauth/client-metadata.json`, redirectUri: `${scheme}:/oauth/callback` };
}

// ── Start: discover + PKCE + DPoP + PAR → authorize URL ─────────────
export interface OAuthSession {
  did: string;
  handle: string | null;
  pdsUrl: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  state: string;
  dpopKey: DpopKey;
  dpopNonce?: string;
}

export interface OAuthStartResult {
  authorizeUrl: string;
  session: OAuthSession;
}

export async function startOAuth(
  identifier: string,
  opts: {
    fetchFn: FetchLike;
    appViewUrl?: string;
    plcURL?: string;
    nowSec: number;
    resolve: IdentityResolver;
  },
): Promise<OAuthStartResult> {
  const info = await discoverAuthServer(identifier, {
    fetchFn: opts.fetchFn,
    resolve: opts.resolve,
    ...(opts.plcURL !== undefined ? { plcURL: opts.plcURL } : {}),
  });
  const { clientId, redirectUri } = oauthClientConfig(opts.appViewUrl);

  // PKCE (S256).
  const codeVerifier = b64urlEncode(randomBytes(32));
  const codeChallenge = b64urlEncode(sha256(new TextEncoder().encode(codeVerifier)));
  const state = b64urlEncode(randomBytes(16));
  const dpopKey = generateDpopKey();
  const nonceRef: { nonce?: string } = {};

  // PAR — pushed authorization request (DPoP-bound, nonce retry).
  const form = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    redirect_uri: redirectUri,
    scope: 'atproto transition:generic',
    login_hint: identifier,
  }).toString();
  const par = await dpopFetch(
    opts.fetchFn,
    info.parEndpoint,
    'POST',
    form,
    'application/x-www-form-urlencoded',
    dpopKey,
    nonceRef,
    opts.nowSec,
  );
  if (par.status !== 201 && par.status !== 200) {
    throw new Error(`PAR failed (${par.status}): ${par.bodyText.slice(0, 200)}`);
  }
  const requestUri = String((JSON.parse(par.bodyText) as { request_uri?: string }).request_uri ?? '');
  if (requestUri === '') throw new Error('PAR response missing request_uri');

  const authorizeUrl = `${info.authorizationEndpoint}?client_id=${encodeURIComponent(
    clientId,
  )}&request_uri=${encodeURIComponent(requestUri)}`;

  return {
    authorizeUrl,
    session: {
      did: info.did,
      handle: info.handle,
      pdsUrl: info.pdsUrl,
      tokenEndpoint: info.tokenEndpoint,
      clientId,
      redirectUri,
      codeVerifier,
      state,
      dpopKey,
      ...(nonceRef.nonce !== undefined ? { dpopNonce: nonceRef.nonce } : {}),
    },
  };
}

// ── Complete: token exchange → verify sub === DID ───────────────────
export interface OAuthResult {
  /** The PROVEN Bluesky DID (token `sub`, equals the resolved DID). */
  did: string;
  handle: string | null;
  /** The linked account's PDS URL (for the link record). */
  pdsUrl: string;
  accessToken: string;
  refreshToken: string | null;
  /** The DPoP key the tokens are bound to (needed for future calls). */
  dpopKeyJwk: DpopKey['jwk'];
}

export async function completeOAuth(
  session: OAuthSession,
  params: { code: string; state: string },
  opts: { fetchFn: FetchLike; nowSec: number },
): Promise<OAuthResult> {
  if (params.state !== session.state) throw new Error('OAuth state mismatch (possible CSRF)');
  const nonceRef: { nonce?: string } = session.dpopNonce !== undefined ? { nonce: session.dpopNonce } : {};
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: session.redirectUri,
    client_id: session.clientId,
    code_verifier: session.codeVerifier,
  }).toString();
  const res = await dpopFetch(
    opts.fetchFn,
    session.tokenEndpoint,
    'POST',
    form,
    'application/x-www-form-urlencoded',
    session.dpopKey,
    nonceRef,
    opts.nowSec,
  );
  if (res.status !== 200) {
    throw new Error(`token exchange failed (${res.status}): ${res.bodyText.slice(0, 200)}`);
  }
  const tok = JSON.parse(res.bodyText) as {
    access_token?: string;
    refresh_token?: string;
    sub?: string;
    token_type?: string;
  };
  const sub = String(tok.sub ?? '');
  // Proof of control: the DID-bound session subject MUST equal the DID
  // we resolved the handle to. Otherwise the user proved control of a
  // different account than they claimed.
  if (sub === '' || sub !== session.did) {
    throw new Error(`token sub (${sub || 'none'}) does not match resolved DID (${session.did})`);
  }
  if (tok.token_type !== undefined && tok.token_type.toLowerCase() !== 'dpop') {
    throw new Error(`expected DPoP-bound token, got token_type=${tok.token_type}`);
  }
  return {
    did: sub,
    handle: session.handle,
    pdsUrl: session.pdsUrl,
    accessToken: String(tok.access_token ?? ''),
    refreshToken: tok.refresh_token !== undefined ? String(tok.refresh_token) : null,
    dpopKeyJwk: session.dpopKey.jwk,
  };
}
