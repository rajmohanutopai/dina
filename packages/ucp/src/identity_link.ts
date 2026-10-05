/**
 * Linking an account at a merchant (UCP plan §3.17, U4; spec
 * common/identity-linking): the pure half. No I/O and no clock; hashing is
 * injected. Core does the fetching, stores pending links and tokens, and
 * runs the flow.
 *
 *  - The merchant's `dev.ucp.common.identity_linking` config: its `scopes`
 *    map (each a hard gate). `providers` (the Accelerated IdP Flow, a MAY)
 *    is not used: direct OAuth on the business domain is always available
 *    (identity-linking §"Identity Providers"), and Dina is a public client.
 *  - The scopes Dina asks for: those the merchant lists, for a capability
 *    negotiated, that gate an operation Dina calls (catalog reads, cart and
 *    checkout `manage`, order `read`); never more (spec "MUST request only
 *    the derived scope set"). A scope a challenge names is added only when
 *    the merchant lists it.
 *  - Discovery: protected-resource metadata (RFC 9728) names the issuer (its
 *    absence means the merchant's own origin); authorization-server metadata
 *    by RFC 8414 with path insertion, then OIDC on 404 only; the `issuer`
 *    matched byte for byte. Dina refuses to link, before any redirect, unless
 *    the server supports S256, the `iss` response parameter (RFC 9207) and
 *    `none` client authentication (a public client MUST use it).
 *  - The flow: authorization code with PKCE S256, `state`, and the `iss`
 *    check on the callback; the token request and answers; Bearer
 *    challenges (RFC 6750) read for `error`, `scope` and `resource_metadata`.
 */

import { base64urlEncode, isPlainObject } from '@dina/a2a';

import type { Sha256Fn } from './signatures';

/** The well-known scopes that gate operations Dina calls (each capability's spec). */
export const DINA_SCOPES: ReadonlySet<string> = new Set([
  'dev.ucp.shopping.catalog.search:read',
  'dev.ucp.shopping.catalog.lookup:read',
  'dev.ucp.shopping.cart:manage',
  'dev.ucp.shopping.checkout:manage',
  'dev.ucp.shopping.order:read',
]);

/** A scope token: `{capability}:{scope}` (identity_linking.json `scope_token`). */
const SCOPE_TOKEN =
  /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9_])?)+:[a-z][a-z0-9_]*$/;

export interface IdentityLinkingConfig {
  /**
   * Scope token → its plain-text description, when the merchant gave one
   * (`types/description.json`: `plain`; `html` and `markdown` are never rendered).
   */
  scopes: ReadonlyMap<string, { description?: string }>;
}

/** The merchant's identity-linking config; null when it is not one (no linking with it). */
export function readIdentityLinkingConfig(config: unknown): IdentityLinkingConfig | null {
  if (!isPlainObject(config) || !isPlainObject(config.scopes)) return null;
  const scopes = new Map<string, { description?: string }>();
  for (const [token, policy] of Object.entries(config.scopes)) {
    if (!SCOPE_TOKEN.test(token) || !isPlainObject(policy)) return null;
    const d = policy.description;
    const plain = isPlainObject(d) && typeof d.plain === 'string' ? d.plain : undefined;
    scopes.set(token, plain !== undefined ? { description: plain } : {});
  }
  return { scopes };
}

/** The capability a scope token belongs to. */
export function scopeCapability(token: string): string {
  return token.slice(0, token.lastIndexOf(':'));
}

/**
 * The scopes to ask for: listed by the merchant, for a negotiated
 * capability, and either gating an operation Dina calls or named by a
 * challenge (`extra`). Sorted, so the same need asks the same way.
 */
/**
 * Scopes Dina never asks for, whoever names them: they grant what Dina never
 * does (cancelling or returning an order). A challenge that needs one is one
 * Dina does not answer.
 */
export const NEVER_ASKED_SCOPES: ReadonlySet<string> = new Set(['dev.ucp.shopping.order:manage']);

export function deriveScopes(
  config: IdentityLinkingConfig,
  negotiated: ReadonlySet<string>,
  extra: readonly string[] = [],
): string[] {
  const wanted = new Set([...DINA_SCOPES, ...extra].filter((s) => !NEVER_ASKED_SCOPES.has(s)));
  return [...config.scopes.keys()]
    .filter((s) => wanted.has(s) && negotiated.has(scopeCapability(s)))
    .sort();
}

// ------------------------------------------------------------ discovery

const httpsUrl = (v: unknown): URL | null => {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.username === '' && u.password === '' && u.hash === ''
      ? u
      : null;
  } catch {
    return null;
  }
};

/** Where a resource's protected-resource metadata lives (RFC 9728 §3.1, path inserted). */
export function protectedResourceMetadataUrl(resource: string): string {
  const u = new URL(resource);
  const path = u.pathname === '/' ? '' : u.pathname;
  return `${u.origin}/.well-known/oauth-protected-resource${path}`;
}

export type MetadataRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * The issuer a protected resource names (RFC 9728): its `resource` must be
 * the one asked about, and the first https `authorization_servers` entry is
 * used.
 */
export function readProtectedResourceMetadata(
  value: unknown,
  resource: string,
): MetadataRead<string> {
  if (!isPlainObject(value)) return { ok: false, reason: 'not_object' };
  if (value.resource !== resource) return { ok: false, reason: 'resource_mismatch' };
  const servers = value.authorization_servers;
  if (!Array.isArray(servers)) return { ok: false, reason: 'no_authorization_servers' };
  const first = servers.find((s) => httpsUrl(s) !== null);
  return typeof first === 'string'
    ? { ok: true, value: first }
    : { ok: false, reason: 'no_authorization_servers' };
}

/**
 * The two places an issuer's metadata may live, in order: RFC 8414 with the
 * well-known segment inserted before the issuer's path, then OIDC discovery
 * (asked only when the first answers 404).
 */
export function authorizationServerMetadataUrls(issuer: string): { rfc8414: string; oidc: string } {
  const u = new URL(issuer);
  const path = u.pathname === '/' ? '' : u.pathname;
  return {
    rfc8414: `${u.origin}/.well-known/oauth-authorization-server${path}`,
    oidc: `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
  };
}

export interface AuthorizationServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  scopesSupported?: readonly string[];
}

/** Why a merchant cannot be linked as a public client; shown to the owner before any redirect. */
export type LinkRefusal =
  | 'issuer_mismatch'
  | 'endpoints_invalid'
  | 'no_s256'
  | 'no_iss_parameter'
  | 'no_public_client';

/**
 * An authorization server's metadata, checked: `issuer` byte for byte (no
 * normalising), https endpoints, and what a public client needs (S256,
 * the `iss` response parameter, `none` at the token endpoint).
 */
export function readAuthorizationServerMetadata(
  value: unknown,
  issuer: string,
): { ok: true; value: AuthorizationServer } | { ok: false; reason: LinkRefusal | 'not_object' } {
  if (!isPlainObject(value)) return { ok: false, reason: 'not_object' };
  if (value.issuer !== issuer) return { ok: false, reason: 'issuer_mismatch' };
  const authz = httpsUrl(value.authorization_endpoint);
  const token = httpsUrl(value.token_endpoint);
  if (authz === null || token === null) return { ok: false, reason: 'endpoints_invalid' };
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  if (!list(value.code_challenge_methods_supported).includes('S256'))
    return { ok: false, reason: 'no_s256' };
  if (value.authorization_response_iss_parameter_supported !== true)
    return { ok: false, reason: 'no_iss_parameter' };
  if (!list(value.token_endpoint_auth_methods_supported).includes('none'))
    return { ok: false, reason: 'no_public_client' };
  const revoke =
    value.revocation_endpoint === undefined ? null : httpsUrl(value.revocation_endpoint);
  if (value.revocation_endpoint !== undefined && revoke === null)
    return { ok: false, reason: 'endpoints_invalid' };
  const scopes = Array.isArray(value.scopes_supported) ? list(value.scopes_supported) : undefined;
  return {
    ok: true,
    value: {
      issuer,
      authorizationEndpoint: authz.href,
      tokenEndpoint: token.href,
      ...(revoke !== null ? { revocationEndpoint: revoke.href } : {}),
      ...(scopes !== undefined ? { scopesSupported: scopes } : {}),
    },
  };
}

// ------------------------------------------------------------ the flow

/** The PKCE S256 challenge for a verifier (RFC 7636 §4.2). */
export function pkceChallenge(verifier: string, sha256: Sha256Fn): string {
  return base64urlEncode(sha256(new TextEncoder().encode(verifier)));
}

/** A PKCE verifier is 43–128 characters of the unreserved set (RFC 7636 §4.1). */
export function isPkceVerifier(v: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
}

export interface AuthorizationRequest {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
}

/** The authorization URL the owner opens (RFC 6749 §4.1.1 with PKCE). */
export function authorizationUrl(req: AuthorizationRequest): string {
  const u = new URL(req.authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', req.clientId);
  u.searchParams.set('redirect_uri', req.redirectUri);
  u.searchParams.set('scope', req.scopes.join(' '));
  u.searchParams.set('state', req.state);
  u.searchParams.set('code_challenge', req.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.href;
}

export type CallbackRead =
  | { ok: true; code: string }
  /** The owner said no at the merchant, or the merchant refused: nothing to exchange. */
  | { ok: false; reason: 'denied'; error: string }
  /** Not this flow's answer (wrong `state` or `iss`, or malformed): discarded. */
  | { ok: false; reason: 'discard' };

/**
 * The authorization response (RFC 6749 §4.1.2, RFC 9207): `state` must be
 * the one sent, and `iss` the server's issuer exactly, on an error as on a
 * code; anything else is discarded.
 */
export function readCallback(
  params: Readonly<Record<string, string | undefined>>,
  expected: { state: string; issuer: string },
): CallbackRead {
  if (params.state !== expected.state || params.iss !== expected.issuer)
    return { ok: false, reason: 'discard' };
  if (typeof params.error === 'string' && params.error !== '')
    return { ok: false, reason: 'denied', error: params.error.slice(0, 64) };
  const code = params.code;
  if (typeof code !== 'string' || code === '' || code.length > 2048)
    return { ok: false, reason: 'discard' };
  return { ok: true, code };
}

/** The token request for a code (form-encoded; `none` authentication: `client_id` in the body). */
export function codeTokenRequest(input: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientId: string;
}): string {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    client_id: input.clientId,
  }).toString();
}

/** The token request for a refresh (RFC 6749 §6). */
export function refreshTokenRequest(input: { refreshToken: string; clientId: string }): string {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  }).toString();
}

/** The revocation request for a token (RFC 7009 §2.1). */
export function revocationRequest(input: {
  token: string;
  hint: 'access_token' | 'refresh_token';
  clientId: string;
}): string {
  return new URLSearchParams({
    token: input.token,
    token_type_hint: input.hint,
    client_id: input.clientId,
  }).toString();
}

export interface TokenSet {
  accessToken: string;
  /** Seconds; absent when the server did not say. */
  expiresIn?: number;
  refreshToken?: string;
  /** The scopes granted, when the server said (it may grant fewer than asked). */
  scopes?: string[];
}

export type TokenRead = { ok: true; tokens: TokenSet } | { ok: false; error: string };

/** A token endpoint's answer (RFC 6749 §5.1, §5.2): tokens, or the error it names. */
export function readTokenResponse(status: number, value: unknown): TokenRead {
  if (!isPlainObject(value)) return { ok: false, error: 'malformed' };
  if (status !== 200)
    return {
      ok: false,
      error: typeof value.error === 'string' ? value.error.slice(0, 64) : 'malformed',
    };
  const { access_token: access, token_type: type, expires_in: expires } = value;
  if (typeof access !== 'string' || access === '' || access.length > 8192)
    return { ok: false, error: 'malformed' };
  if (typeof type !== 'string' || type.toLowerCase() !== 'bearer')
    return { ok: false, error: 'malformed' };
  if (expires !== undefined && !(Number.isSafeInteger(expires) && (expires as number) > 0))
    return { ok: false, error: 'malformed' };
  const refresh = value.refresh_token;
  if (
    refresh !== undefined &&
    (typeof refresh !== 'string' || refresh === '' || refresh.length > 8192)
  )
    return { ok: false, error: 'malformed' };
  const scope = value.scope;
  if (scope !== undefined && typeof scope !== 'string') return { ok: false, error: 'malformed' };
  return {
    ok: true,
    tokens: {
      accessToken: access,
      ...(expires !== undefined ? { expiresIn: expires as number } : {}),
      ...(typeof refresh === 'string' ? { refreshToken: refresh } : {}),
      ...(typeof scope === 'string' ? { scopes: scope.split(' ').filter((x) => x !== '') } : {}),
    },
  };
}

// ------------------------------------------------------------ challenges

export interface BearerChallenge {
  realm?: string;
  /** `invalid_token`, `insufficient_scope`, `invalid_request`, …; absent when no token was sent. */
  error?: string;
  scopes?: string[];
  resourceMetadata?: string;
}

/**
 * The Bearer challenge in a `WWW-Authenticate` header (RFC 6750 §3); null
 * when there is none. Auth-params are `name=value` or `name="quoted"`; a
 * header may carry several challenges, and only the Bearer one is read.
 */
export function readBearerChallenge(header: string | undefined): BearerChallenge | null {
  if (header === undefined) return null;
  const at = header.search(/(^|[\s,])Bearer(\s|$)/i);
  if (at < 0) return null;
  let rest = header.slice(at).replace(/^[\s,]*Bearer/i, '');
  const params: Record<string, string> = {};
  for (;;) {
    const m = /^\s*,?\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]*))/.exec(
      rest,
    );
    if (m === null) break;
    const name = (m[1] as string).toLowerCase();
    // The next challenge's scheme ends this one.
    if (params[name] !== undefined) break;
    params[name] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : (m[3] ?? '');
    rest = rest.slice(m[0].length);
    if (/^\s*,?\s*[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*\s+[A-Za-z]/.test(rest)) break;
  }
  return {
    ...(params.realm !== undefined ? { realm: params.realm } : {}),
    ...(params.error !== undefined ? { error: params.error } : {}),
    ...(params.scope !== undefined
      ? { scopes: params.scope.split(' ').filter((x) => x !== '') }
      : {}),
    ...(params.resource_metadata !== undefined
      ? { resourceMetadata: params.resource_metadata }
      : {}),
  };
}
