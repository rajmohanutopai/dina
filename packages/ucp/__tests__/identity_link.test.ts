import { sha256 } from '@noble/hashes/sha2.js';

import {
  authorizationServerMetadataUrls,
  authorizationUrl,
  codeTokenRequest,
  deriveScopes,
  NEVER_ASKED_SCOPES,
  type IdentityLinkingConfig,
  isPkceVerifier,
  pkceChallenge,
  protectedResourceMetadataUrl,
  readAuthorizationServerMetadata,
  readBearerChallenge,
  readCallback,
  readIdentityLinkingConfig,
  readProtectedResourceMetadata,
  readTokenResponse,
  refreshTokenRequest,
  revocationRequest,
} from '../src/identity_link';

const ISSUER = 'https://auth.shop.example';
const META = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  revocation_endpoint: `${ISSUER}/revoke`,
  code_challenge_methods_supported: ['S256'],
  authorization_response_iss_parameter_supported: true,
  token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
  scopes_supported: ['dev.ucp.shopping.order:read'],
};

describe('the merchant’s identity-linking config and the scopes Dina asks for', () => {
  const config = readIdentityLinkingConfig({
    scopes: {
      'dev.ucp.shopping.order:read': {
        description: { plain: 'See your orders', html: '<b>x</b>' },
      },
      'dev.ucp.shopping.order:manage': { description: 'a bare string is not the schema’s form' },
      'dev.ucp.shopping.checkout:manage': {},
      'dev.ucp.shopping.checkout:complete_high_value': { min_acr: 'x' },
      'com.example.loyalty:points': {},
    },
    providers: { 'com.example.idp': [{ type: 'oauth2', auth_url: 'https://idp.example' }] },
  });

  it('reads the scopes, keeping descriptions and ignoring unknown policy fields', () => {
    expect(config?.scopes.get('dev.ucp.shopping.order:read')).toEqual({
      description: 'See your orders',
    });
    expect(config?.scopes.get('dev.ucp.shopping.checkout:complete_high_value')).toEqual({});
    // `types/description.json` is an object; a bare string is not read, and html never.
    expect(config?.scopes.get('dev.ucp.shopping.order:manage')).toEqual({});
  });

  it('asks only for listed scopes that gate what Dina calls, for negotiated capabilities; never order:manage', () => {
    if (config === null) throw new Error('no config');
    const negotiated = new Set(['dev.ucp.shopping.order', 'dev.ucp.shopping.catalog.search']);
    expect(deriveScopes(config, negotiated)).toEqual(['dev.ucp.shopping.order:read']);
    expect(deriveScopes(config, new Set([...negotiated, 'dev.ucp.shopping.checkout']))).toEqual([
      'dev.ucp.shopping.checkout:manage',
      'dev.ucp.shopping.order:read',
    ]);
    // A custom scope only when a challenge names it, and only when listed.
    expect(
      deriveScopes(config, new Set(['dev.ucp.shopping.checkout']), [
        'dev.ucp.shopping.checkout:complete_high_value',
        'dev.ucp.shopping.checkout:invented',
      ]),
    ).toEqual([
      'dev.ucp.shopping.checkout:complete_high_value',
      'dev.ucp.shopping.checkout:manage',
    ]);
  });

  it('never asks for order:manage, even when a challenge names it and the merchant lists it', () => {
    expect(
      deriveScopes(config as IdentityLinkingConfig, new Set(['dev.ucp.shopping.order']), [
        'dev.ucp.shopping.order:read',
        'dev.ucp.shopping.order:manage',
      ]),
    ).toEqual(['dev.ucp.shopping.order:read']);
    expect(NEVER_ASKED_SCOPES.has('dev.ucp.shopping.order:manage')).toBe(true);
  });

  it.each([
    ['no scopes map', {}],
    ['a malformed scope token', { scopes: { 'Order:Read': {} } }],
    ['a policy that is not an object', { scopes: { 'dev.ucp.shopping.order:read': true } }],
  ])('refuses %s', (_n, value) => {
    expect(readIdentityLinkingConfig(value)).toBeNull();
  });
});

describe('discovery', () => {
  it('builds the well-known URLs with the segment inserted before the path', () => {
    expect(protectedResourceMetadataUrl('https://shop.example')).toBe(
      'https://shop.example/.well-known/oauth-protected-resource',
    );
    expect(protectedResourceMetadataUrl('https://shop.example/api')).toBe(
      'https://shop.example/.well-known/oauth-protected-resource/api',
    );
    expect(authorizationServerMetadataUrls('https://auth.example/tenant1')).toEqual({
      rfc8414: 'https://auth.example/.well-known/oauth-authorization-server/tenant1',
      oidc: 'https://auth.example/tenant1/.well-known/openid-configuration',
    });
    expect(authorizationServerMetadataUrls('https://auth.example')).toEqual({
      rfc8414: 'https://auth.example/.well-known/oauth-authorization-server',
      oidc: 'https://auth.example/.well-known/openid-configuration',
    });
  });

  it('reads the issuer from protected-resource metadata about this resource only', () => {
    expect(
      readProtectedResourceMetadata(
        { resource: 'https://shop.example', authorization_servers: ['http://x', ISSUER] },
        'https://shop.example',
      ),
    ).toEqual({ ok: true, value: ISSUER });
    expect(
      readProtectedResourceMetadata(
        { resource: 'https://other.example', authorization_servers: [ISSUER] },
        'https://shop.example',
      ),
    ).toEqual({ ok: false, reason: 'resource_mismatch' });
    expect(
      readProtectedResourceMetadata({ resource: 'https://shop.example' }, 'https://shop.example'),
    ).toEqual({
      ok: false,
      reason: 'no_authorization_servers',
    });
  });

  it('accepts a server a public client can use', () => {
    expect(readAuthorizationServerMetadata(META, ISSUER)).toEqual({
      ok: true,
      value: {
        issuer: ISSUER,
        authorizationEndpoint: `${ISSUER}/authorize`,
        tokenEndpoint: `${ISSUER}/token`,
        revocationEndpoint: `${ISSUER}/revoke`,
        scopesSupported: ['dev.ucp.shopping.order:read'],
      },
    });
  });

  it.each([
    [
      'an issuer that differs only by a trailing slash (no normalising)',
      { issuer: `${ISSUER}/` },
      'issuer_mismatch',
    ],
    [
      'an http token endpoint',
      { token_endpoint: 'http://auth.shop.example/token' },
      'endpoints_invalid',
    ],
    ['no S256', { code_challenge_methods_supported: ['plain'] }, 'no_s256'],
    [
      'no iss response parameter',
      { authorization_response_iss_parameter_supported: false },
      'no_iss_parameter',
    ],
    [
      'no public-client authentication',
      { token_endpoint_auth_methods_supported: ['client_secret_basic'] },
      'no_public_client',
    ],
    [
      'a revocation endpoint that is not https',
      { revocation_endpoint: 'ftp://x' },
      'endpoints_invalid',
    ],
  ])('refuses before any redirect: %s', (_n, over, reason) => {
    expect(readAuthorizationServerMetadata({ ...META, ...over }, ISSUER)).toEqual({
      ok: false,
      reason,
    });
  });
});

describe('the flow', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

  it('PKCE S256 matches RFC 7636’s appendix B', () => {
    expect(pkceChallenge(verifier, (b) => sha256(b))).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    expect(isPkceVerifier(verifier)).toBe(true);
    expect(isPkceVerifier('short')).toBe(false);
  });

  it('builds the authorization URL with exactly the scopes, the state and the challenge', () => {
    const url = new URL(
      authorizationUrl({
        authorizationEndpoint: `${ISSUER}/authorize?tenant=t1`,
        clientId: 'https://profiles.example/abc/.well-known/ucp',
        redirectUri: 'https://node.example/ucp/oauth/callback',
        scopes: ['dev.ucp.shopping.order:read'],
        state: 'st-1',
        codeChallenge: 'ch',
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tenant: 't1',
      response_type: 'code',
      client_id: 'https://profiles.example/abc/.well-known/ucp',
      redirect_uri: 'https://node.example/ucp/oauth/callback',
      scope: 'dev.ucp.shopping.order:read',
      state: 'st-1',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  it.each<[string, Record<string, string>, unknown]>([
    [
      'a code with the right state and iss',
      { code: 'c1', state: 's', iss: ISSUER },
      { ok: true, code: 'c1' },
    ],
    [
      'the owner said no',
      { error: 'access_denied', state: 's', iss: ISSUER },
      { ok: false, reason: 'denied', error: 'access_denied' },
    ],
    ['a wrong state', { code: 'c1', state: 'x', iss: ISSUER }, { ok: false, reason: 'discard' }],
    ['no iss (a mix-up)', { code: 'c1', state: 's' }, { ok: false, reason: 'discard' }],
    [
      'another issuer',
      { code: 'c1', state: 's', iss: 'https://evil.example' },
      { ok: false, reason: 'discard' },
    ],
    [
      'an error from another issuer',
      { error: 'access_denied', state: 's', iss: 'https://evil.example' },
      { ok: false, reason: 'discard' },
    ],
    ['no code', { state: 's', iss: ISSUER }, { ok: false, reason: 'discard' }],
  ])('reads a callback: %s', (_n, params, want) => {
    expect(readCallback(params, { state: 's', issuer: ISSUER })).toEqual(want);
  });

  it('forms the token, refresh and revocation requests as a public client (client_id in the body, no secret)', () => {
    expect(
      Object.fromEntries(
        new URLSearchParams(
          codeTokenRequest({ code: 'c', redirectUri: 'r', codeVerifier: 'v', clientId: 'id' }),
        ),
      ),
    ).toEqual({
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'r',
      code_verifier: 'v',
      client_id: 'id',
    });
    expect(refreshTokenRequest({ refreshToken: 'rt', clientId: 'id' })).toBe(
      'grant_type=refresh_token&refresh_token=rt&client_id=id',
    );
    expect(revocationRequest({ token: 't', hint: 'refresh_token', clientId: 'id' })).toBe(
      'token=t&token_type_hint=refresh_token&client_id=id',
    );
  });

  it.each<[string, number, unknown, unknown]>([
    [
      'tokens',
      200,
      {
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r',
        scope: 'x:read y:read',
      },
      {
        ok: true,
        tokens: {
          accessToken: 'a',
          expiresIn: 3600,
          refreshToken: 'r',
          scopes: ['x:read', 'y:read'],
        },
      },
    ],
    [
      'a lower-case token type',
      200,
      { access_token: 'a', token_type: 'bearer' },
      { ok: true, tokens: { accessToken: 'a' } },
    ],
    [
      'another token type',
      200,
      { access_token: 'a', token_type: 'DPoP' },
      { ok: false, error: 'malformed' },
    ],
    ['no access token', 200, { token_type: 'Bearer' }, { ok: false, error: 'malformed' }],
    [
      'a zero expiry',
      200,
      { access_token: 'a', token_type: 'Bearer', expires_in: 0 },
      { ok: false, error: 'malformed' },
    ],
    ['invalid_grant', 400, { error: 'invalid_grant' }, { ok: false, error: 'invalid_grant' }],
    ['not JSON', 500, 'x', { ok: false, error: 'malformed' }],
  ])('reads a token answer: %s', (_n, status, value, want) => {
    expect(readTokenResponse(status, value)).toEqual(want);
  });
});

describe('Bearer challenges (RFC 6750 §3)', () => {
  it.each<[string, string | undefined, unknown]>([
    ['none', undefined, null],
    ['another scheme only', 'Basic realm="x"', null],
    [
      'identity required, no token sent',
      'Bearer realm="https://auth.shop.example", resource_metadata="https://shop.example/.well-known/oauth-protected-resource"',
      {
        realm: 'https://auth.shop.example',
        resourceMetadata: 'https://shop.example/.well-known/oauth-protected-resource',
      },
    ],
    [
      'an invalid token',
      'Bearer realm="r", error="invalid_token", error_description="expired"',
      { realm: 'r', error: 'invalid_token' },
    ],
    [
      'insufficient scope',
      'Bearer error="insufficient_scope", scope="dev.ucp.shopping.order:read dev.ucp.shopping.cart:manage"',
      {
        error: 'insufficient_scope',
        scopes: ['dev.ucp.shopping.order:read', 'dev.ucp.shopping.cart:manage'],
      },
    ],
    [
      'unquoted values and a quoted comma',
      'Bearer error=invalid_token, realm="a, b"',
      { error: 'invalid_token', realm: 'a, b' },
    ],
    [
      'after another challenge',
      'Basic realm="x", Bearer error="invalid_token"',
      { error: 'invalid_token' },
    ],
    [
      'before another challenge',
      'Bearer error="invalid_token", Basic realm="x"',
      { error: 'invalid_token' },
    ],
  ])('%s', (_n, header, want) => {
    expect(readBearerChallenge(header)).toEqual(want);
  });
});
