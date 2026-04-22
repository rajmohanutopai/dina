/**
 * Task 4.26 — pairing-code path bypass.
 *
 * The pairing ceremony is a chicken-and-egg problem: the client
 * doesn't yet have an Ed25519 key pair registered with the home node
 * until it completes pairing, but it has to reach the pairing
 * endpoints to register. Those endpoints therefore bypass the
 * signed-request auth middleware; they authenticate via the one-time
 * pairing code itself (a short-lived 6-char code out-of-band).
 *
 * **Scope of bypass.** ONLY the signed-request (Ed25519) check is
 * skipped. The routes themselves still validate the pairing code,
 * enforce TTL + replay, and rate-limit failed attempts — those
 * protections live inside the route handlers, not in auth middleware.
 *
 * **Why a dedicated matcher.** Two call-sites need this: the auth
 * middleware dispatches on it to decide between "verify signature"
 * vs "let through"; /readyz reporting + boot-time validation use it
 * to confirm the expected set of bypass prefixes is honoured. A
 * single module means there's ONE list — no way to drift between
 * what the middleware thinks is bypassed and what the ops dashboard
 * renders.
 *
 * **Admin + public also bypass Ed25519**, but via different
 * mechanisms — see `client_token.ts` (task 4.25) for admin Bearer
 * auth and CoreRouter's `auth: 'public'` flag for /healthz + /readyz.
 * This module is specifically for routes that Dina treats as
 * "semi-trusted — verified by the pairing code, not by a key".
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4c task 4.26.
 */

/**
 * Prefixes whose inbound requests skip Ed25519 verification. The list
 * is frozen so there's no way to silently expand it at runtime.
 *
 * These paths must all be registered on the Core router too; this
 * module's role is ONLY to tell the middleware "don't verify" — the
 * route handler itself decides what IS required (the pairing code).
 */
export const PAIRING_BYPASS_PREFIXES: readonly string[] = Object.freeze([
  '/v1/pair/',
]);

/**
 * Does this path bypass the signed-request check?
 *
 * Exact prefix match (with trailing `/`): `/v1/pair/initiate` → bypass,
 * `/v1/pair/complete` → bypass, `/v1/pair-something-else` → NOT bypass.
 * A trailing `/` on each prefix prevents substring matches against
 * unrelated routes.
 */
export function isPairingBypassPath(path: string): boolean {
  if (path.length === 0) return false;
  // Normalise: treat trailing / the same as no trailing /, but only
  // for exact-segment matches. `/v1/pair` alone (no trailing segment)
  // is the pairing INDEX, which doesn't exist — reject.
  for (const prefix of PAIRING_BYPASS_PREFIXES) {
    if (path.startsWith(prefix)) {
      // Require at least one char past the prefix so `/v1/pair/` alone
      // doesn't accidentally match an unintended "root" handler.
      if (path.length > prefix.length) return true;
    }
  }
  return false;
}

/**
 * All known bypass categories, for /readyz + diagnostics.
 */
export interface BypassCategories {
  pairing: readonly string[];
}

export function getBypassCategories(): BypassCategories {
  return { pairing: PAIRING_BYPASS_PREFIXES };
}
