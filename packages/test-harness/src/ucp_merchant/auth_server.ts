/**
 * The mock merchant's authorization server (UCP identity linking; RFC 6749,
 * 7636, 8414, 9207, 9728, 7009), as a careful merchant runs one:
 *
 *  - protected-resource metadata naming the issuer (or none: the merchant's
 *    own origin), and authorization-server metadata, each part switchable
 *    off to test Dina's refusals;
 *  - the authorization endpoint is played by `consent()`: the test is the
 *    owner at the merchant's page, saying yes (or no), and gets the callback
 *    parameters back (`code`, `state`, `iss`);
 *  - the token endpoint checks the PKCE verifier, the exact redirect URI and
 *    the client id; refresh tokens rotate, and reusing an old one revokes
 *    the whole grant (RFC 9700 §4.14.2);
 *  - incremental authorization: a new code for a client that holds a live
 *    grant extends that grant (its tokens carry every scope granted so far);
 *  - revocation (RFC 7009) records what it revoked;
 *  - access tokens expire on the merchant's clock.
 */

import { createHash, randomUUID } from 'node:crypto';

export interface MockAuthOptions {
  /** Scopes the merchant lists in `config.scopes`. */
  scopes: readonly string[];
  /** Serve protected-resource metadata (default yes); off: the merchant's origin is the issuer. */
  protectedResource?: boolean;
  /** Serve RFC 8414 metadata (default yes); off: OIDC discovery only. */
  rfc8414?: boolean;
  /** What a public client needs, each switchable off. */
  s256?: boolean;
  issParameter?: boolean;
  publicClient?: boolean;
  /** Access token lifetime, seconds. */
  accessTtlSeconds?: number;
  /** Advertise a revocation endpoint (default yes). */
  revocation?: boolean;
  /** What the revocation endpoint answers (default 200 and revokes). */
  revokeAnswer?: () => { status: number; body: unknown };
  /** A status for a discovery document instead of serving it. */
  discoveryStatus?: { protectedResource?: number; rfc8414?: number };
  /** `scopes_supported` in the server's metadata (default: the listed scopes). */
  scopesSupported?: readonly string[];
  /** A code for a client that already holds a grant starts a separate grant (default: extends it). */
  separateGrants?: boolean;
  now: () => number;
}

interface Grant {
  clientId: string;
  scopes: string[];
  refreshToken: string;
  /** Refresh tokens already used: presenting one revokes the grant. */
  spent: Set<string>;
  revoked: boolean;
}

export class MockAuthServer {
  /** The issuer: the merchant's origin, with an `/auth` path to test path insertion. */
  issuer = '';
  private readonly codes = new Map<
    string,
    { challenge: string; redirectUri: string; clientId: string; scopes: string[]; used: boolean }
  >();
  private readonly access = new Map<string, { grant: Grant; expiresAt: number }>();
  private readonly grants = new Map<string, Grant>();
  /** Every token revoked (RFC 7009) and every grant revoked for reuse. */
  readonly revoked: string[] = [];
  /** Token endpoint requests, by grant type. */
  readonly tokenRequests: string[] = [];
  /** Every discovery document asked for, by path. */
  readonly discoveryRequests: string[] = [];
  /** Answer the next token request with nothing (its answer lost after the grant ran). */
  loseNextTokenAnswer = false;

  constructor(
    private readonly options: MockAuthOptions,
    private readonly origin: () => string,
  ) {}

  configFor(): { scopes: Record<string, Record<string, never>> } {
    return { scopes: Object.fromEntries(this.options.scopes.map((s) => [s, {}])) };
  }

  private iss(): string {
    return this.options.protectedResource === false ? this.origin() : `${this.origin()}/auth`;
  }

  /** The owner at the merchant's page: a yes gives a code; a no, an error. */
  consent(authorizeUrl: string, answer: 'yes' | 'no' = 'yes'): Record<string, string> {
    const u = new URL(authorizeUrl);
    const p = Object.fromEntries(u.searchParams);
    const state = p.state ?? '';
    if (answer === 'no') return { error: 'access_denied', state, iss: this.iss() };
    if (p.code_challenge_method !== 'S256' || p.response_type !== 'code')
      return { error: 'invalid_request', state, iss: this.iss() };
    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      challenge: p.code_challenge ?? '',
      redirectUri: p.redirect_uri ?? '',
      clientId: p.client_id ?? '',
      scopes: (p.scope ?? '').split(' ').filter((s) => s !== ''),
      used: false,
    });
    return { code, state, iss: this.iss() };
  }

  /** Whether a request's bearer token is live and carries `scope`. */
  authorized(
    authorization: string | undefined,
    scope: string,
  ): 'ok' | 'none' | 'invalid' | 'insufficient' {
    if (authorization === undefined) return 'none';
    const m = /^Bearer (.+)$/.exec(authorization);
    const held = m === null ? undefined : this.access.get(m[1] as string);
    if (held === undefined || held.grant.revoked || held.expiresAt <= this.options.now())
      return 'invalid';
    return held.grant.scopes.includes(scope) ? 'ok' : 'insufficient';
  }

  /** The `WWW-Authenticate` challenge for an answer `authorized` refused. */
  challenge(kind: 'none' | 'invalid' | 'insufficient', scope: string): string {
    const base = `Bearer realm="${this.iss()}", resource_metadata="${this.origin()}/.well-known/oauth-protected-resource"`;
    if (kind === 'invalid') return `${base}, error="invalid_token"`;
    if (kind === 'insufficient') return `${base}, error="insufficient_scope", scope="${scope}"`;
    return base;
  }

  /** The HTTP side: null when the path is not this server's. */
  handle(method: string, path: string, body: string): { status: number; body: unknown } | null {
    const status = this.options.discoveryStatus;
    if (method === 'GET' && path.includes('/.well-known/')) this.discoveryRequests.push(path);
    if (method === 'GET' && path === '/.well-known/oauth-protected-resource') {
      if (status?.protectedResource !== undefined)
        return { status: status.protectedResource, body: { error: 'x' } };
      return this.options.protectedResource === false
        ? { status: 404, body: { error: 'not_found' } }
        : { status: 200, body: { resource: this.origin(), authorization_servers: [this.iss()] } };
    }
    const issuerPath = new URL(this.iss()).pathname.replace(/\/$/, '');
    if (method === 'GET' && path === `/.well-known/oauth-authorization-server${issuerPath}`) {
      if (status?.rfc8414 !== undefined) return { status: status.rfc8414, body: { error: 'x' } };
      return this.options.rfc8414 === false
        ? { status: 404, body: { error: 'not_found' } }
        : { status: 200, body: this.metadata() };
    }
    if (method === 'GET' && path === `${issuerPath}/.well-known/openid-configuration`)
      return { status: 200, body: this.metadata() };
    if (method === 'POST' && path === '/auth/token') return this.token(new URLSearchParams(body));
    if (method === 'POST' && path === '/auth/revoke') {
      const token = new URLSearchParams(body).get('token') ?? '';
      const chosen = this.options.revokeAnswer?.();
      if (chosen !== undefined && chosen.status !== 200) return chosen;
      this.revoked.push(token);
      this.access.delete(token);
      for (const g of this.grants.values()) if (g.refreshToken === token) g.revoked = true;
      return { status: 200, body: {} };
    }
    return null;
  }

  private metadata(): Record<string, unknown> {
    const o = this.options;
    return {
      issuer: this.iss(),
      authorization_endpoint: `${this.origin()}/auth/authorize`,
      token_endpoint: `${this.origin()}/auth/token`,
      ...(o.revocation === false ? {} : { revocation_endpoint: `${this.origin()}/auth/revoke` }),
      code_challenge_methods_supported: o.s256 === false ? ['plain'] : ['S256'],
      authorization_response_iss_parameter_supported: o.issParameter !== false,
      token_endpoint_auth_methods_supported:
        o.publicClient === false ? ['client_secret_basic'] : ['none', 'private_key_jwt'],
      scopes_supported: [...(o.scopesSupported ?? o.scopes)],
    };
  }

  private token(p: URLSearchParams): { status: number; body: unknown } {
    const grantType = p.get('grant_type') ?? '';
    this.tokenRequests.push(grantType);
    const answer = (out: { status: number; body: unknown }) => {
      if (this.loseNextTokenAnswer) {
        this.loseNextTokenAnswer = false;
        throw new Error('answer lost');
      }
      return out;
    };
    if (grantType === 'authorization_code') {
      const code = this.codes.get(p.get('code') ?? '');
      const verifier = p.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        code === undefined ||
        code.used ||
        code.challenge !== challenge ||
        code.redirectUri !== p.get('redirect_uri') ||
        code.clientId !== p.get('client_id')
      )
        return answer({ status: 400, body: { error: 'invalid_grant' } });
      code.used = true;
      // A live grant for this client is extended (incremental authorization), its tokens rotated.
      const prior =
        this.options.separateGrants === true
          ? undefined
          : [...this.grants.values()].find((g) => g.clientId === code.clientId && !g.revoked);
      if (prior !== undefined) {
        prior.scopes = [...new Set([...prior.scopes, ...code.scopes])];
        prior.spent.add(prior.refreshToken);
        prior.refreshToken = `rt-${randomUUID()}`;
        return answer({ status: 200, body: this.issue(prior) });
      }
      const grant: Grant = {
        clientId: code.clientId,
        scopes: code.scopes,
        refreshToken: `rt-${randomUUID()}`,
        spent: new Set(),
        revoked: false,
      };
      this.grants.set(grant.refreshToken, grant);
      return answer({ status: 200, body: this.issue(grant) });
    }
    if (grantType === 'refresh_token') {
      const presented = p.get('refresh_token') ?? '';
      const grant = [...this.grants.values()].find(
        (g) => g.refreshToken === presented || g.spent.has(presented),
      );
      if (grant === undefined || grant.revoked)
        return answer({ status: 400, body: { error: 'invalid_grant' } });
      if (grant.spent.has(presented)) {
        // An old refresh token again: someone else may hold it. The grant ends.
        grant.revoked = true;
        this.revoked.push(`grant:${grant.refreshToken}`);
        return answer({ status: 400, body: { error: 'invalid_grant' } });
      }
      grant.spent.add(presented);
      grant.refreshToken = `rt-${randomUUID()}`;
      return answer({ status: 200, body: this.issue(grant) });
    }
    return answer({ status: 400, body: { error: 'unsupported_grant_type' } });
  }

  private issue(grant: Grant): Record<string, unknown> {
    const accessToken = `at-${randomUUID()}`;
    const ttl = this.options.accessTtlSeconds ?? 3600;
    this.access.set(accessToken, { grant, expiresAt: this.options.now() + ttl * 1000 });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ttl,
      refresh_token: grant.refreshToken,
      scope: grant.scopes.join(' '),
    };
  }
}
