/**
 * OAuth redirect bridge.
 *
 * The "Login with Bluesky" flow opens the system browser; the redirect
 * (`<scheme>:/oauth/callback?code=…`) can arrive two ways depending on
 * app state:
 *   - during ONBOARDING, `UnlockGate` renders `OnboardingFlow` (not the
 *     router), so the `existing_identity` screen stays mounted and a
 *     `Linking` 'url' listener catches it;
 *   - when the router IS active (or the app was cold-started by the
 *     redirect), the `app/oauth/callback` route catches it.
 *
 * Both paths funnel the redirect URL here; `awaitRedirect()` (called by
 * `loginWithBluesky`) resolves with whichever fires first. Scheme-
 * agnostic on purpose — we match on the `oauth/callback` path, not the
 * scheme, so it's robust to dina:// vs the reverse-domain scheme.
 */

let resolver: ((url: string) => void) | null = null;
let bufferedUrl: string | null = null;
let expectedState: string | null = null;

/** Pull the `state` query param off a callback URL ('' if absent). */
function callbackState(url: string): string {
  const query = url.split('?')[1] ?? '';
  return new URLSearchParams(query).get('state') ?? '';
}

function isCallback(url: string): boolean {
  if (!(url.includes('oauth/callback') && /[?&]code=|[?&]error=/.test(url))) return false;
  // State-aware: once a flow declares its `state` (via resetRedirect(state)),
  // ONLY that flow's callback is ours. A leftover callback from a PRIOR
  // login — e.g. surfaced by `Linking.getInitialURL()` on the next attempt —
  // carries a stale `state` and must be ignored, not consumed by the new
  // flow (which would otherwise fail completeOAuth's CSRF state check and
  // surface as an immediate, confusing login failure). When no state is set
  // (cold-start path, no in-process flow), accept any callback as before.
  if (expectedState !== null) return callbackState(url) === expectedState;
  return true;
}

/** Deliver a redirect URL. Returns true if it looked like our callback. */
export function deliverRedirect(url: string): boolean {
  if (!isCallback(url)) return false;
  if (resolver !== null) {
    const r = resolver;
    resolver = null;
    r(url);
  } else {
    // Arrived before anyone is waiting (e.g. cold start) — buffer it.
    bufferedUrl = url;
  }
  return true;
}

/** Wait for the OAuth redirect URL. Rejects after `timeoutMs`. */
export function awaitRedirect(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (bufferedUrl !== null) {
      const u = bufferedUrl;
      bufferedUrl = null;
      resolve(u);
      return;
    }
    resolver = resolve;
    setTimeout(() => {
      if (resolver === resolve) {
        resolver = null;
        reject(new Error('Login timed out. No response from Bluesky.'));
      }
    }, timeoutMs);
  });
}

/**
 * Clear any pending/buffered state before starting a fresh flow. Pass the
 * new flow's OAuth `state` so the bridge accepts ONLY that flow's callback
 * and ignores stale ones. Omit it (or '') to accept any callback — the
 * cold-start path, where no in-process flow declared a state.
 */
export function resetRedirect(state?: string): void {
  resolver = null;
  bufferedUrl = null;
  expectedState = typeof state === 'string' && state !== '' ? state : null;
}
