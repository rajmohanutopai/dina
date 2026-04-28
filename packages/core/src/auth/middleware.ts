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

import { isTimestampValid } from './timestamp';
import { verifyRequest } from './canonical';
import { NonceCache } from './nonce';
import { PerDIDRateLimiter } from './ratelimit';
import { isAuthorized, type CallerType as AuthzCallerType } from './authz';
import { resolveCallerType, type CallerType as ResolvedCallerType } from './caller_type';
import { extractPublicKey } from '../identity/did';

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
  callerType?: string;
  rejectedAt?: 'headers' | 'timestamp' | 'nonce' | 'signature' | 'rate_limit' | 'authorization';
  reason?: string;
}

/** Shared instances for the middleware pipeline. */
const nonceCache = new NonceCache();
let rateLimiter = new PerDIDRateLimiter();

/** Injectable public key resolver (DID → Ed25519 public key). */
let publicKeyResolver: ((did: string) => Uint8Array | null) | null = null;

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

  // 3. Check nonce replay
  if (!nonceCache.check(nonce)) {
    return {
      authenticated: false,
      did,
      rejectedAt: 'nonce',
      reason: 'Nonce already used (replay detected)',
    };
  }

  // 4. Verify Ed25519 signature
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

  return {
    authenticated: true,
    did: callerIdentity.did,
    callerType: callerIdentity.callerType,
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
