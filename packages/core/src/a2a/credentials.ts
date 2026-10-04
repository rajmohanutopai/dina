/**
 * Real outbound credentials (A2A design §5.3): an API key in a header, a
 * bearer token, or an OAuth 2.0 client (client-credentials grant). Each
 * matches a security scheme the PINNED card declares, so the card — not the
 * owner, not Brain — names the header, and the token endpoint is the one the
 * owner saw when they approved the card.
 *
 * The rules, after the commerce credential store:
 *  - the material leaves through ONE door, `useRemoteCredentialSecret`, which
 *    hands it to a callback and never returns it; views and lists never
 *    select it;
 *  - references are versioned and immutable: rotation makes a NEW reference
 *    with new material, moves the bindings to it (bumping their revisions, so
 *    an approval made under the old one no longer matches), revokes the old
 *    one and deletes its material, in one commit;
 *  - revocation deletes the material (`revokeRemoteCredential`).
 * Material lives in the identity file, under SQLCipher like every other owner
 * secret; a second wrapping would need its key in the same place.
 */

import { a2aDisplayText, base64Encode, canonicalize, isPlainObject, parseStrictJson, type JsonObject } from '@dina/a2a';

import { sha256HexOfText } from './digest';
import { A2A_FETCH_LIMITS, a2aFetch, checkOutboundUrl, type A2ATransportError } from './host_transport';
import { newA2AId } from './ids';

import type { RemoteAgentDeps } from './remote_agents';
import type { A2AStore, RemoteCredentialRow } from './store';

export type SecretKind = 'api_key' | 'bearer' | 'oauth2_client';

/** What a credential may do, as the owner's card renders it; immutable per reference. */
export type CredentialScope =
  | { kind: 'api_key'; scheme: string; header: string }
  | { kind: 'bearer'; scheme: string }
  | { kind: 'oauth2_client'; scheme: string; token_url: string; scopes: string[] };

type Material = { value: string } | { token: string } | { client_id: string; client_secret: string };

export type CreateCredentialOutcome = { ok: true; credential: RemoteCredentialRow } | { ok: false; reason: string };

/** Header names the transport owns, or that would change how the request is framed. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'accept',
  'accept-encoding',
  'user-agent',
  'a2a-version',
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
/** Visible ASCII, no spaces: a secret sent in a header can never break it. */
const SECRET_TEXT = /^[\x21-\x7e]{1,4096}$/;
/** RFC 6749 Appendix A (VSCHAR): a client id or secret may hold spaces; it is form-encoded, never sent raw. */
const CLIENT_TEXT = /^[\x20-\x7e]{1,4096}$/;
const SCOPE_TEXT = /^[\x21-\x7e]{1,200}$/;

function schemesOf(schemesJson: string): Record<string, JsonObject> {
  const parsed = parseStrictJson(schemesJson);
  if (!parsed.ok || !isPlainObject(parsed.value) || !isPlainObject(parsed.value.securitySchemes)) return {};
  const out: Record<string, JsonObject> = {};
  for (const [name, scheme] of Object.entries(parsed.value.securitySchemes)) {
    if (isPlainObject(scheme)) out[name] = scheme as JsonObject;
  }
  return out;
}

function secretField(secret: unknown, key: string, shape: RegExp = SECRET_TEXT): string | null {
  if (!isPlainObject(secret)) return null;
  const value = secret[key];
  return typeof value === 'string' && shape.test(value) && value.trim() !== '' ? value : null;
}

/** The scope and material a request makes for one card scheme, or why not. */
function scopeFor(
  kind: unknown,
  schemeName: string,
  scheme: JsonObject,
  secret: unknown,
  requestedScopes: unknown,
  /** The scopes Dina offers from the card for this scheme (`cardSchemeChoices`): the ones a binding accepts. */
  offeredScopes: readonly string[],
): { scope: CredentialScope; material: Material } | { reason: string } {
  if (kind === 'api_key') {
    const s = scheme.apiKeySecurityScheme;
    if (!isPlainObject(s)) return { reason: 'scheme_kind_mismatch' };
    if (s.location !== 'header') return { reason: 'api_key_not_in_header' };
    const header = typeof s.name === 'string' ? s.name : '';
    if (!HEADER_NAME.test(header) || RESERVED_HEADERS.has(header.toLowerCase())) return { reason: 'api_key_header_refused' };
    const value = secretField(secret, 'value');
    if (value === null) return { reason: 'secret_invalid' };
    return { scope: { kind, scheme: schemeName, header }, material: { value } };
  }
  if (kind === 'bearer') {
    const s = scheme.httpAuthSecurityScheme;
    if (!isPlainObject(s) || typeof s.scheme !== 'string' || s.scheme.toLowerCase() !== 'bearer') {
      return { reason: 'scheme_kind_mismatch' };
    }
    const token = secretField(secret, 'token');
    if (token === null) return { reason: 'secret_invalid' };
    return { scope: { kind, scheme: schemeName }, material: { token } };
  }
  if (kind === 'oauth2_client') {
    const s = scheme.oauth2SecurityScheme;
    const flow = isPlainObject(s) && isPlainObject(s.flows) ? s.flows.clientCredentials : undefined;
    if (!isPlainObject(flow)) return { reason: 'scheme_kind_mismatch' };
    const tokenUrl = typeof flow.tokenUrl === 'string' ? flow.tokenUrl : '';
    if (!checkOutboundUrl(tokenUrl).ok) return { reason: 'token_url_refused' };
    if (!Array.isArray(requestedScopes)) return { reason: 'scopes_required' };
    const scopes = [...new Set(requestedScopes)].sort();
    if (scopes.some((sc) => typeof sc !== 'string' || !SCOPE_TEXT.test(sc) || !offeredScopes.includes(sc))) {
      return { reason: 'scope_not_on_card' };
    }
    const clientId = secretField(secret, 'client_id', CLIENT_TEXT);
    const clientSecret = secretField(secret, 'client_secret', CLIENT_TEXT);
    if (clientId === null || clientSecret === null) return { reason: 'secret_invalid' };
    return {
      scope: { kind, scheme: schemeName, token_url: tokenUrl, scopes: scopes as string[] },
      material: { client_id: clientId, client_secret: clientSecret },
    };
  }
  return { reason: 'credential_kind_unsupported' };
}

function insertNew(
  store: A2AStore,
  agentId: string,
  scope: CredentialScope,
  material: Material,
  nowMs: number,
): RemoteCredentialRow {
  const scopeJson = canonicalize(scope);
  const row: RemoteCredentialRow = {
    credential_ref: newA2AId(),
    remote_agent_id: agentId,
    kind: scope.kind,
    audience: scope.kind === 'oauth2_client' ? new URL(scope.token_url).origin : null,
    scope_json: scopeJson,
    scope_hash: sha256HexOfText(scopeJson),
    revision: store.maxCredentialRevision(agentId) + 1,
    status: 'active',
    created_at: nowMs,
    revoked_at: null,
  };
  store.insertCredential(row);
  store.insertCredentialSecret(row.credential_ref, JSON.stringify(material), nowMs);
  return row;
}

/**
 * A real credential for one of the pinned card's schemes, as Dina offers
 * them (`cardSchemeChoices`: at most 16 schemes, 32 scopes each). A binding
 * checks a credential against that same set (`credentialFitsCard`), so no
 * secret is stored that could never be bound.
 */
export function createRemoteCredential(
  deps: RemoteAgentDeps,
  agentId: string,
  input: { kind: unknown; scheme: unknown; secret: unknown; scopes?: unknown },
): CreateCredentialOutcome {
  const agent = deps.store.getAgent(agentId);
  if (agent === null) return { ok: false, reason: 'not_found' };
  if (agent.status === 'revoked') return { ok: false, reason: 'revoked' };
  if (typeof input.scheme !== 'string') return { ok: false, reason: 'scheme_required' };
  const offered = cardSchemeChoices(agent.schemes_json).find((c) => c.name === input.scheme);
  const scheme = offered === undefined ? undefined : schemesOf(agent.schemes_json)[input.scheme];
  if (offered === undefined || scheme === undefined) return { ok: false, reason: 'scheme_not_on_card' };
  const made = scopeFor(input.kind, input.scheme, scheme, input.secret, input.scopes, offered.scopes ?? []);
  if ('reason' in made) return { ok: false, reason: made.reason };
  const now = (deps.nowMs ?? Date.now)();
  return deps.store.transaction(() => ({ ok: true, credential: insertNew(deps.store, agentId, made.scope, made.material, now) }) as const);
}

/**
 * Rotate: new material under a NEW reference with the same scope; the old
 * reference's bindings move to it, the old one is revoked and its material
 * deleted — one commit. In-flight approvals made under the old reference no
 * longer match their snapshot and void at dispatch.
 */
export function rotateRemoteCredential(
  deps: RemoteAgentDeps,
  credentialRef: string,
  secret: unknown,
): CreateCredentialOutcome {
  const old = deps.store.getCredential(credentialRef);
  if (old === null) return { ok: false, reason: 'not_found' };
  if (old.status !== 'active') return { ok: false, reason: 'revoked' };
  if (old.kind === 'none') return { ok: false, reason: 'nothing_to_rotate' };
  const parsed = parseStrictJson(old.scope_json);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { ok: false, reason: 'scope_unreadable' };
  const scope = parsed.value as unknown as CredentialScope;
  let material: Material | null = null;
  if (scope.kind === 'api_key') {
    const value = secretField(secret, 'value');
    material = value === null ? null : { value };
  } else if (scope.kind === 'bearer') {
    const token = secretField(secret, 'token');
    material = token === null ? null : { token };
  } else {
    const id = secretField(secret, 'client_id', CLIENT_TEXT);
    const sec = secretField(secret, 'client_secret', CLIENT_TEXT);
    material = id === null || sec === null ? null : { client_id: id, client_secret: sec };
  }
  if (material === null) return { ok: false, reason: 'secret_invalid' };
  const fresh = material;
  const now = (deps.nowMs ?? Date.now)();
  return deps.store.transaction((): CreateCredentialOutcome => {
    const row = insertNew(deps.store, old.remote_agent_id, scope, fresh, now);
    deps.store.moveBindingsToCredential(old.credential_ref, row.credential_ref, now);
    deps.store.setCredentialReplacement(old.credential_ref, row.credential_ref);
    deps.store.revokeCredential(old.credential_ref, now);
    deps.store.deleteCredentialSecret(old.credential_ref);
    forgetCachedToken(old.credential_ref);
    return { ok: true, credential: row };
  });
}

/**
 * THE door: hand an active credential's material to `use`, never return it.
 * Null when the credential is not active or has no material.
 */
export function useRemoteCredentialSecret<T>(
  store: A2AStore,
  credentialRef: string,
  use: (material: Readonly<Record<string, string>>) => T,
): T | null {
  const text = store.readCredentialMaterial(credentialRef);
  if (text === null) return null;
  const parsed = parseStrictJson(text);
  if (!parsed.ok || !isPlainObject(parsed.value)) return null;
  return use(parsed.value as Record<string, string>);
}

// ------------------------------------------------------------ OAuth tokens

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/** Access tokens by credential reference, in memory only: a restart fetches a new one. */
const tokenCache = new Map<string, CachedToken>();
/** A token is used until this long before its stated expiry. */
const TOKEN_EARLY_MS = 30_000;
const TOKEN_DEFAULT_LIFE_MS = 5 * 60_000;
const ACCESS_TOKEN = /^[\x21-\x7e]{1,8192}$/;

export function forgetCachedToken(credentialRef: string): void {
  tokenCache.delete(credentialRef);
}

/** RFC 6749 §2.3.1: the client id and secret are form-encoded before Basic encoding. */
function basicAuth(clientId: string, clientSecret: string): string {
  const raw = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${base64Encode(new TextEncoder().encode(raw))}`;
}

/**
 * Transport failures that may pass: the network, not the endpoint's
 * address or answer. A URL or address the policy refuses, a redirect, an
 * answer of the wrong kind or size, or a host with no transport never pass.
 */
const TRANSIENT_TRANSPORT: ReadonlySet<A2ATransportError> = new Set(['dns_failed', 'connect_failed', 'tls_failed', 'timeout', 'io_error']);

/**
 * A token from the credential's token endpoint. `token_unavailable` when the
 * endpoint did not answer this time (the network failed, a 5xx, a 429):
 * asking again later may work. Anything else that yields no token (no
 * material, an endpoint the policy refuses, a refusal, an answer that is not
 * a bearer token, a credential revoked during the fetch) is
 * `credential_unusable`.
 */
async function oauthToken(
  store: A2AStore,
  credential: RemoteCredentialRow,
  scope: Extract<CredentialScope, { kind: 'oauth2_client' }>,
  nowMs: number,
): Promise<{ ok: true; token: string } | { ok: false; reason: AuthProblem }> {
  const unusable = { ok: false, reason: 'credential_unusable' } as const;
  const cached = tokenCache.get(credential.credential_ref);
  if (cached !== undefined && cached.expiresAtMs > nowMs) return { ok: true, token: cached.token };
  const request = useRemoteCredentialSecret(store, credential.credential_ref, (m) => ({
    authorization: basicAuth(m.client_id ?? '', m.client_secret ?? ''),
  }));
  if (request === null) return unusable;
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (scope.scopes.length > 0) form.set('scope', scope.scopes.join(' '));
  const response = await a2aFetch({
    method: 'POST',
    url: scope.token_url,
    headers: { Authorization: request.authorization },
    body: form.toString(),
    contentType: 'application/x-www-form-urlencoded',
    ...A2A_FETCH_LIMITS.token,
  });
  if (!response.ok) return TRANSIENT_TRANSPORT.has(response.error) ? { ok: false, reason: 'token_unavailable' } : unusable;
  if (response.status === 429 || response.status >= 500) return { ok: false, reason: 'token_unavailable' };
  if (response.status !== 200) return unusable;
  const parsed = parseStrictJson(response.body);
  if (!parsed.ok || !isPlainObject(parsed.value)) return unusable;
  const { access_token: token, token_type: type, expires_in: expiresIn } = parsed.value;
  if (typeof token !== 'string' || !ACCESS_TOKEN.test(token)) return unusable;
  if (typeof type !== 'string' || type.toLowerCase() !== 'bearer') return unusable;
  const life =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : TOKEN_DEFAULT_LIFE_MS;
  // The fetch took time: a credential revoked or rotated meanwhile must not
  // leave a token in the cache, nor have this one used.
  if (store.getCredential(credential.credential_ref)?.status !== 'active') return unusable;
  tokenCache.set(credential.credential_ref, { token, expiresAtMs: nowMs + Math.max(0, life - TOKEN_EARLY_MS) });
  return { ok: true, token };
}

/**
 * Why a request carries no credential: the credential cannot be used, or its
 * token endpoint did not answer this time (an OAuth client only).
 */
export type AuthProblem = 'credential_unusable' | 'token_unavailable';

export type AuthHeaders = { ok: true; headers: Record<string, string> } | { ok: false; reason: AuthProblem };

/**
 * The headers one request to the remote carries for `credentialRef`, built
 * in memory for that request and never stored. `none` adds nothing.
 */
export async function remoteAuthHeaders(
  store: A2AStore,
  credentialRef: string,
  nowMs: number = Date.now(),
): Promise<AuthHeaders> {
  const credential = store.getCredential(credentialRef);
  if (credential === null || credential.status !== 'active') return { ok: false, reason: 'credential_unusable' };
  if (credential.kind === 'none') return { ok: true, headers: {} };
  const parsed = parseStrictJson(credential.scope_json);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { ok: false, reason: 'credential_unusable' };
  const scope = parsed.value as unknown as CredentialScope;
  if (scope.kind === 'api_key') {
    const headers = useRemoteCredentialSecret(store, credentialRef, (m) => ({ [scope.header]: m.value ?? '' }));
    return headers === null ? { ok: false, reason: 'credential_unusable' } : { ok: true, headers };
  }
  if (scope.kind === 'bearer') {
    const headers = useRemoteCredentialSecret(store, credentialRef, (m) => ({ Authorization: `Bearer ${m.token ?? ''}` }));
    return headers === null ? { ok: false, reason: 'credential_unusable' } : { ok: true, headers };
  }
  const token = await oauthToken(store, credential, scope, nowMs);
  return token.ok ? { ok: true, headers: { Authorization: `Bearer ${token.token}` } } : token;
}

/**
 * True when a credential still fits the card the agent has pinned NOW: the
 * same scheme, of the same kind, with the same header or token endpoint. A
 * reference made for an older card cannot be bound to a new one that dropped
 * or changed its scheme.
 */
export function credentialFitsCard(credential: RemoteCredentialRow, schemesJson: string): boolean {
  // `none` fits any scheme set; whether the card demands a credential at all
  // is the binding's check (`bindRemoteSkill`), which reads the whole card.
  if (credential.kind === 'none') return true;
  const scope = credentialScopeOf(credential);
  if (scope === null || scope.kind === 'none') return false;
  const choice = cardSchemeChoices(schemesJson).find((c) => c.name === scope.scheme);
  if (choice === undefined || choice.kind !== scope.kind) return false;
  if (scope.kind === 'api_key') return choice.header === scope.header;
  if (scope.kind === 'oauth2_client') {
    const card = schemesOf(schemesJson)[scope.scheme];
    const flow = card?.oauth2SecurityScheme;
    const tokenUrl =
      isPlainObject(flow) && isPlainObject(flow.flows) && isPlainObject(flow.flows.clientCredentials)
        ? flow.flows.clientCredentials.tokenUrl
        : undefined;
    return tokenUrl === scope.token_url && scope.scopes.every((sc) => (choice.scopes ?? []).includes(sc));
  }
  return true;
}

/** What the owner's card shows about a credential's scope, never its material. */
export function credentialScopeOf(credential: RemoteCredentialRow): CredentialScope | { kind: 'none' } | null {
  const parsed = parseStrictJson(credential.scope_json);
  return parsed.ok && isPlainObject(parsed.value) ? (parsed.value as unknown as CredentialScope | { kind: 'none' }) : null;
}

/** A scheme the pinned card declares, as the owner chooses among them; never a secret. */
export interface SchemeChoice {
  /** The card's key for the scheme, sent back as given when a credential is made for it. */
  name: string;
  /** The same name, cleaned and bounded for the owner to read. */
  label: string;
  kind: SecretKind | 'unsupported';
  /** The header an API key goes in (api_key). */
  header?: string;
  /** The token endpoint's host (oauth2_client). */
  token_host?: string;
  /** The scopes the card offers (oauth2_client). */
  scopes?: string[];
}

/** The card's schemes in the form the owner's console offers them. */
export function cardSchemeChoices(schemesJson: string): SchemeChoice[] {
  return Object.entries(schemesOf(schemesJson))
    .slice(0, 16)
    .map(([rawName, scheme]): SchemeChoice => {
      // The card's words, shown to the owner: cleaned and bounded. The raw
      // name stays the key a credential is created against.
      const name = rawName;
      const label = a2aDisplayText(rawName, 80);
      const apiKey = scheme.apiKeySecurityScheme;
      if (isPlainObject(apiKey)) {
        const header = typeof apiKey.name === 'string' ? apiKey.name : '';
        const usable = apiKey.location === 'header' && HEADER_NAME.test(header) && !RESERVED_HEADERS.has(header.toLowerCase());
        return usable ? { name, label, kind: 'api_key', header } : { name, label, kind: 'unsupported' };
      }
      const http = scheme.httpAuthSecurityScheme;
      if (isPlainObject(http)) {
        return typeof http.scheme === 'string' && http.scheme.toLowerCase() === 'bearer'
          ? { name, label, kind: 'bearer' }
          : { name, label, kind: 'unsupported' };
      }
      const oauth = scheme.oauth2SecurityScheme;
      const flow = isPlainObject(oauth) && isPlainObject(oauth.flows) ? oauth.flows.clientCredentials : undefined;
      if (isPlainObject(flow) && typeof flow.tokenUrl === 'string') {
        const check = checkOutboundUrl(flow.tokenUrl);
        if (!check.ok) return { name, label, kind: 'unsupported' };
        return {
          name,
          label,
          kind: 'oauth2_client',
          token_host: check.url.host,
          scopes: isPlainObject(flow.scopes)
            ? Object.keys(flow.scopes)
                .filter((sc) => SCOPE_TEXT.test(sc))
                .sort()
                .slice(0, 32)
            : [],
        };
      }
      return { name, label, kind: 'unsupported' };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
