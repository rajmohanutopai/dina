/**
 * "Login with Bluesky" orchestrator — the React-Native (Linking) half
 * of the ATProto OAuth flow. Keeps `atproto_oauth.ts` pure/testable;
 * this module owns the browser round-trip:
 *
 *   startOAuth → Linking.openURL(authorizeUrl) → user approves on
 *   Bluesky → `<scheme>:/oauth/callback?code=…` returns → parse
 *   code+state → completeOAuth → proven { did, handle, pdsUrl }.
 *
 * The redirect is captured via the shared `oauth_flow_store` bridge,
 * fed by BOTH this module's `Linking` listener (active during
 * onboarding, when `UnlockGate` renders `OnboardingFlow` and not the
 * router) AND the `app/oauth/callback` route (active when the router is
 * mounted, or on cold start). Whichever fires first wins. Scheme-
 * agnostic: matches the `oauth/callback` path, not the scheme.
 */

import { Linking } from 'react-native';

import { resolveExistingAtprotoIdentity } from './atproto_identity';
import { startOAuth, completeOAuth, type FetchLike, type OAuthResult } from './atproto_oauth';
import { awaitRedirect, deliverRedirect, resetRedirect } from './oauth_flow_store';

const nowSec = (): number => Math.floor(Date.now() / 1000);

// The app routes fetch through expo/fetch on iOS; the Response shape
// (status, headers.get, text()) satisfies FetchLike.
const fetchFn: FetchLike = (url, init) =>
  globalThis.fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

export interface LoginWithBlueskyOptions {
  /** Override the OAuth client-metadata host (defaults to env/mobile host). */
  oauthClientUrl?: string;
  /** Abort if the user never returns from the browser. Default 5 min. */
  timeoutMs?: number;
}

export async function loginWithBluesky(
  identifier: string,
  opts: LoginWithBlueskyOptions = {},
): Promise<OAuthResult> {
  const start = await startOAuth(identifier, {
    fetchFn,
    nowSec: nowSec(),
    resolve: resolveExistingAtprotoIdentity,
    ...(opts.oauthClientUrl !== undefined ? { oauthClientUrl: opts.oauthClientUrl } : {}),
  });

  resetRedirect();
  const sub = Linking.addEventListener('url', (e) => {
    deliverRedirect(e.url);
  });
  try {
    // If the app was cold-started by the redirect, the launch URL holds it.
    const initial = await Linking.getInitialURL();
    if (initial !== null) deliverRedirect(initial);

    await Linking.openURL(start.authorizeUrl);
    const redirectUrl = await awaitRedirect(opts.timeoutMs ?? 5 * 60 * 1000);

    // Custom-scheme URLs aren't reliably parsed by `new URL()`; pull the
    // query string off directly.
    const query = redirectUrl.split('?')[1] ?? '';
    const params = new URLSearchParams(query);
    const code = params.get('code') ?? '';
    if (code === '') {
      const err = params.get('error_description') ?? params.get('error') ?? 'no authorization code';
      throw new Error(`Bluesky login failed: ${err}`);
    }
    return await completeOAuth(
      start.session,
      { code, state: params.get('state') ?? '' },
      { fetchFn, nowSec: nowSec() },
    );
  } finally {
    sub.remove();
  }
}
