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


import { isScopeAuthorized, requiredScopeFor, resolveAgentScope, type AgentScope } from './agent_scope';
import { isAuthorized, type CallerType as AuthzCallerType } from './authz';
import { resolveCallerType, type CallerIdentity } from './caller_type';
import { NonceCache } from './nonce';
import { PerDIDRateLimiter, type RateLimitConfig } from './ratelimit';
import { checkRequestSignature } from './signed_request';

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
export function configureRateLimiter(config: RateLimitConfig): void {
  rateLimiter = new PerDIDRateLimiter(config);
}

/** Steps 1–6 of the pipeline passed: the request is authentic and its caller known. */
interface VerifiedIdentity {
  verified: true;
  callerIdentity: CallerIdentity;
}

/**
 * Steps 1–6: headers, timestamp window, Ed25519 signature, nonce replay,
 * per-DID rate limit, caller-type resolution. Everything EXCEPT the
 * path × caller authorization, which differs between the matrix
 * (`authenticateRequest`) and the owner device (`authenticateOwnerDevice`).
 */
function verifySignedIdentity(req: AuthRequest): VerifiedIdentity | AuthResult {
  // 1–4. Headers, timestamp window, Ed25519 signature, nonce replay: the
  // shared check (`signed_request.ts`), against this process's resolver and
  // replay cache. The nonce is spent only after the signature is proven
  // (P3.9), so unsigned requests cannot burn a victim's future nonces.
  const did = req.headers['X-DID'];
  const check = checkRequestSignature(
    {
      method: req.method,
      path: req.path,
      query: req.query,
      body: req.body,
      ...(did === undefined ? {} : { did }),
      ...(req.headers['X-Timestamp'] === undefined ? {} : { timestamp: req.headers['X-Timestamp'] }),
      ...(req.headers['X-Nonce'] === undefined ? {} : { nonce: req.headers['X-Nonce'] }),
      ...(req.headers['X-Signature'] === undefined ? {} : { signature: req.headers['X-Signature'] }),
    },
    { nonces: nonceCache, resolvePublicKey: publicKeyResolver },
  );
  if (!check.ok) {
    return {
      authenticated: false,
      ...(check.did === undefined ? {} : { did: check.did }),
      rejectedAt: check.rejectedAt,
      reason: check.reason,
    };
  }

  // 5. Resolve caller type
  const callerIdentity = resolveCallerType(check.did, req.headers['X-Agent-DID']);

  // 6. Rate limit, by the signing DID. A DID no caller holds is refused at
  // authorization whatever it asks, so it spends no bucket: a flood of
  // self-made did:keys, each signing its own requests, grows nothing.
  if (callerIdentity.callerType !== 'unknown' && !rateLimiter.allow(check.did)) {
    return {
      authenticated: false,
      did: check.did,
      rejectedAt: 'rate_limit',
      reason: 'Rate limit exceeded',
    };
  }
  return { verified: true, callerIdentity };
}

function isVerified(r: VerifiedIdentity | AuthResult): r is VerifiedIdentity {
  return (r as VerifiedIdentity).verified === true;
}

/**
 * Authenticate and authorize a request through the full pipeline.
 *
 * Returns AuthResult with authenticated=true and callerType on success,
 * or authenticated=false with rejectedAt and reason on failure.
 */
export function authenticateRequest(req: AuthRequest): AuthResult {
  const verified = verifySignedIdentity(req);
  if (!isVerified(verified)) return verified;
  const { callerIdentity } = verified;
  const did = callerIdentity.did;

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
 * WEB_OWNER_SURFACE_PLAN §3.3 — verify a request signed by a browser paired
 * as an OWNER device. The same steps 1–6 as every signed request (headers,
 * ±5-minute window, Ed25519 signature, nonce replay, per-DID rate limit),
 * then one rule instead of the path matrix: the signer must be a registered
 * device whose role is `owner`. The matrix itself grants `owner_device`
 * nothing, so such a device reaches Core ONLY through the host's owner entry
 * point, which calls this and then marks the request exactly as the owner
 * capability header does. The caller decides which paths that entry point
 * covers; this function knows nothing of paths.
 */
export function authenticateOwnerDevice(req: AuthRequest): AuthResult {
  const verified = verifySignedIdentity(req);
  if (!isVerified(verified)) return verified;
  const { callerIdentity } = verified;
  if (callerIdentity.callerType !== 'owner_device') {
    return {
      authenticated: false,
      did: callerIdentity.did,
      callerType: callerIdentity.callerType,
      rejectedAt: 'authorization',
      reason: 'not an owner device',
    };
  }
  return { authenticated: true, did: callerIdentity.did, callerType: 'owner_device' };
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
  // TRADE_FIRST §6.2: staff maps to its OWN fail-closed row. This is the
  // SIGNED pipeline's half of the mapping — `resolveCallerType` learned
  // 'staff' with the caller-type work, but this seam kept refusing every
  // real staff phone with "cannot determine authorization role" while
  // the handler-level harnesses preset the caller type and never noticed.
  // Found live, 2026-08-18.
  if (callerType === 'staff') return 'staff';
  // WEB_OWNER_SURFACE_PLAN §3.3: an owner device has its own row, which
  // grants NOTHING. It reaches Core only through the host's owner entry
  // point (`authenticateOwnerDevice`), never through this matrix.
  if (callerType === 'owner_device') return 'owner_device';

  // Service: only recognized names get a role
  if (callerType === 'service' && name) {
    const role = name.toLowerCase();
    if (role === 'brain' || role === 'admin' || role === 'connector' || role === 'gateway') {
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
