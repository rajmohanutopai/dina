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

function isCallback(url: string): boolean {
  return url.includes('oauth/callback') && /[?&]code=|[?&]error=/.test(url);
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
        reject(new Error('Login timed out — no response from Bluesky.'));
      }
    }, timeoutMs);
  });
}

/** Clear any pending/buffered state (call before starting a fresh flow). */
export function resetRedirect(): void {
  resolver = null;
  bufferedUrl = null;
}
