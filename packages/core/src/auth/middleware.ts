/**
 * Auth middleware orchestration — chain all auth building blocks.
 *
 * Pipeline:
 *   1. Validate headers present (X-DID, X-Timestamp, X-Nonce, X-Signature)
 *   2. Validate timestamp (±5 min window)
 *   3. Check nonce replay
 *   4. Verify Ed25519 signature over canonical payload
 *   5. Rate limit per-DID
 *   6. Resolve caller type (service/device/agent)
 *   7. Authorize (path × callerType matrix)
 *
 * Each step can reject with a specific error. The pipeline short-circuits
 * on the first failure.
 *
 * Source: ARCHITECTURE.md Section 2.4
 */

import { extractPublicKey } from '../identity/did';

import { isScopeAuthorized, requiredScopeFor, resolveAgentScope, type AgentScope } from './agent_scope';
import { isAuthorized, type CallerType as AuthzCallerType } from './authz';
import { resolveCallerType } from './caller_type';
import { verifyRequest } from './canonical';
import { NonceCache } from './nonce';
import { PerDIDRateLimiter } from './ratelimit';
import { isTimestampValid } from './timestamp';

export interface AuthRequest {
  method: string;
  path: string;
  query: string;
  body: Uint8Array;
  headers: Record<string, string>;
}

export interface AuthResult {
  authenticated: boolean;
  did?: string;
  /**
   * Coarse caller type from the DID registry: `service` / `device` / `agent`
   * / `plugin` / `unknown`. Brain, admin, and every connector all collapse to
   * `service` here — the finer distinction lives in `authzRole`.
   */
  callerType?: string;
  /**
   * PLG-31 #1: the FINE-GRAINED authorization role the path×caller matrix was
   * evaluated against — `brain` / `admin` / `connector` / `device` / `agent`
   * / `plugin`. Only present on an authenticated result. The router threads
   * THIS (not the coarse `callerType`) onto the request so a handler can tell
   * a connector apart from the brain — both of which are `callerType:service`.
   */
  authzRole?: AuthzCallerType;
  /**
   * Item C — the agent's `agent_scope` (`coding`/`runner`), derived from the
   * signature-authenticated device record (never a client claim). Present only
   * for an `agent`/`plugin` caller; the router threads it onto
   * `req.agentScope`. An agent/plugin device with no stamped scope defaults to
   * `runner` (the historical delegation-runner meaning).
   */
  agentScope?: AgentScope;
  rejectedAt?: 'headers' | 'timestamp' | 'nonce' | 'signature' | 'rate_limit' | 'authorization';
  reason?: string;
}

/** Shared instances for the middleware pipeline. */
const nonceCache = new NonceCache();
let rateLimiter = new PerDIDRateLimiter();

/** Injectable public key resolver (DID → Ed25519 public key). */
let publicKeyResolver: ((did: string) => Uint8Array | null) | null = null;

/**
 * Read the registered resolver — for callers that need a DID's key OUTSIDE
 * request authentication (§12.7's held-evidence check verifies this node's
 * own past signature).
 *
 * Returns null when no resolver is installed, so a caller cannot mistake
 * "not wired yet" for "no such key".
 */
export function resolveRegisteredPublicKey(did: string): Uint8Array | null {
  return publicKeyResolver === null ? null : publicKeyResolver(did);
}

/** Register a public key resolver. */
export function registerPublicKeyResolver(resolver: (did: string) => Uint8Array | null): void {
  publicKeyResolver = resolver;
}

/** Get the nonce cache (for rotation scheduling). */
export function getNonceCache(): NonceCache {
  return nonceCache;
}

/** Get the rate limiter (for configuration). */
export function getRateLimiter(): PerDIDRateLimiter {
  return rateLimiter;
}

/**
 * Replace the module-level rate limiter with one using `config`. Used by
 * mobile boot, where Brain calling its own in-process Core generates
 * request volume (workflow-event polling, hydration, etc.) that the 50/min
 * default trips through quickly. In-process callers share a DID with Core,
 * so per-DID limiting on the mobile's own DID is meaningless against
 * external abuse. Call this once at app boot with a high ceiling (e.g.
 * 10,000/min). Server builds continue to use the 50/min default by
 * NOT calling this.
 */
export function configureRateLimiter(config: { maxRequests: number; windowSeconds: number }): void {
  rateLimiter = new PerDIDRateLimiter(config);
}

/**
 * Authenticate and authorize a request through the full pipeline.
 *
 * Returns AuthResult with authenticated=true and callerType on success,
 * or authenticated=false with rejectedAt and reason on failure.
 */
export function authenticateRequest(req: AuthRequest): AuthResult {
  const did = req.headers['X-DID'];
  const timestamp = req.headers['X-Timestamp'];
  const nonce = req.headers['X-Nonce'];
  const signature = req.headers['X-Signature'];

  // 1. Validate headers present
  if (!did || !timestamp || !nonce || !signature) {
    return {
      authenticated: false,
      rejectedAt: 'headers',
      reason: 'Missing required auth headers (X-DID, X-Timestamp, X-Nonce, X-Signature)',
    };
  }

  // 2. Validate timestamp (±5 min window)
  if (!isTimestampValid(timestamp)) {
    return {
      authenticated: false,
      did,
      rejectedAt: 'timestamp',
      reason: 'Timestamp outside ±5 minute window',
    };
  }

  // 3. Verify Ed25519 signature
  //
  // Resolution order:
  //   1. The host-supplied resolver, if any. This is how `did:plc:`
  //      identities (and any non-self-describing DID method) are
  //      mapped to public keys.
  //   2. did:key fallback. did:key encodes the public key in the
  //      DID itself, so the key is *always* derivable — even for
  //      DIDs the resolver has never seen (e.g. a freshly-paired
  //      agent). Without this fallback, every signed RPC from a
  //      paired agent on mobile 401s with "Cannot resolve public
  //      key for DID" because the mobile resolver only knows the
  //      self-DID and explicitly-registered D2D peers.
  let publicKey: Uint8Array | null = null;
  if (publicKeyResolver) {
    publicKey = publicKeyResolver(did);
  }
  if (!publicKey && did.startsWith('did:key:')) {
    try {
      publicKey = extractPublicKey(did);
    } catch {
      publicKey = null;
    }
  }

  if (!publicKey) {
    return {
      authenticated: false,
      did,
      rejectedAt: 'signature',
      reason: 'Cannot resolve public key for DID',
    };
  }

  const signatureValid = verifyRequest(
    req.method,
    req.path,
    req.query,
    timestamp,
    nonce,
    req.body,
    signature,
    publicKey,
  );

  if (!signatureValid) {
    return {
      authenticated: false,
      did,
      rejectedAt: 'signature',
      reason: 'Ed25519 signature verification failed',
    };
  }

  // 4. Nonce replay check — AFTER signature verification (P3.9). The nonce is
  // a single-use resource recorded by `check()`; consuming it only once a
  // request is proven authentic stops an attacker from burning a victim's
  // future nonces (or flooding the cache) with unsigned / bad-signature
  // requests. A genuine replay still fails here: the replayed request has a
  // valid signature but its nonce is already recorded.
  if (!nonceCache.check(nonce)) {
    return {
      authenticated: false,
      did,
      rejectedAt: 'nonce',
      reason: 'Nonce already used (replay detected)',
    };
  }

  // 5. Rate limit
  const agentDID = req.headers['X-Agent-DID'];
  if (!rateLimiter.allow(did)) {
    return {
      authenticated: false,
      did,
      rejectedAt: 'rate_limit',
      reason: 'Rate limit exceeded',
    };
  }

  // 6. Resolve caller type
  const callerIdentity = resolveCallerType(did, agentDID);

  // 7. Authorize (path × callerType)
  // Map generic 'service' to specific authz role using the registered service name
  const authzRole = mapToAuthzRole(callerIdentity.callerType, callerIdentity.name);

  // Fail-closed: if we can't determine a role, reject the request
  if (!authzRole) {
    return {
      authenticated: false,
      did,
      callerType: callerIdentity.callerType,
      rejectedAt: 'authorization',
      reason: `Cannot determine authorization role for ${callerIdentity.callerType}/${callerIdentity.name ?? 'unknown'}`,
    };
  }

  if (!isAuthorized(authzRole, req.method, req.path)) {
    return {
      authenticated: false,
      did,
      callerType: callerIdentity.callerType,
      rejectedAt: 'authorization',
      reason: `${authzRole} not authorized for ${req.method} ${req.path}`,
    };
  }

  // Item C — derive + enforce agent_scope for an agent/plugin caller. The scope
  // comes from the signed device record (never a client claim); an agent/plugin
  // with no stamped scope defaults to `runner` (the historical delegation-runner
  // meaning), so pre-scope runners keep working while an unstamped device is
  // still barred from the coding surfaces. Non-agent callers carry no scope and
  // are unaffected (scope-ruled paths gate agents only).
  let agentScope: AgentScope | undefined;
  if (callerIdentity.callerType === 'agent' || callerIdentity.callerType === 'plugin') {
    agentScope = resolveAgentScope(callerIdentity.scope) ?? 'runner';
    if (!isScopeAuthorized(agentScope, req.path)) {
      return {
        authenticated: false,
        did,
        callerType: callerIdentity.callerType,
        rejectedAt: 'authorization',
        reason: `agent_scope '${requiredScopeFor(req.path)}' required for ${req.path}`,
      };
    }
  }

  return {
    authenticated: true,
    did: callerIdentity.did,
    callerType: callerIdentity.callerType,
    // PLG-31 #1: expose the fine-grained role the request was authorized as,
    // so downstream handlers can distinguish brain / connector / admin (all
    // `callerType:service`).
    authzRole,
    ...(agentScope !== undefined ? { agentScope } : {}),
  };
}

/**
 * Map generic caller type + service name to specific authz role.
 * 'service' with name 'brain' → 'brain', 'admin' → 'admin', etc.
 * 'device' → 'device', 'agent' → 'agent'.
 * Returns null for unrecognized callers → fail-closed (rejected by step 7).
 */
function mapToAuthzRole(callerType: string, name?: string): AuthzCallerType | null {
  if (callerType === 'device') return 'device';
  if (callerType === 'agent') return 'agent';
  // Plugin instances (PLUGIN_ARCHITECTURE.md §9.0): their OWN authz row —
  // never folded into 'device' or 'agent'.
  if (callerType === 'plugin') return 'plugin';

  // Service: only recognized names get a role
  if (callerType === 'service' && name) {
    const role = name.toLowerCase();
    if (role === 'brain' || role === 'admin' || role === 'connector') {
      return role as AuthzCallerType;
    }
  }

  // Unknown caller type OR unknown service name → null → rejected
  return null;
}

/** Reset all middleware state (for testing). */
export function resetMiddlewareState(): void {
  nonceCache.rotate();
  nonceCache.rotate();
  rateLimiter = new PerDIDRateLimiter();
  publicKeyResolver = null;
}
