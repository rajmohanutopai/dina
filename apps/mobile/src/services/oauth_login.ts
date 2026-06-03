/**
 * "Login with Bluesky" orchestrator — the React-Native (Linking) half
 * of the ATProto OAuth flow. Keeps `atproto_oauth.ts` pure/testable;
 * this module owns the browser round-trip:
 *
 *   startOAuth → Linking.openURL(authorizeUrl) → user approves on
 *   Bluesky → custom-scheme redirect fires Linking 'url' → parse
 *   code+state → completeOAuth → proven { did, handle, pdsUrl }.
 */

import { Linking } from 'react-native';

import { resolveExistingAtprotoIdentity } from './atproto_identity';
import { startOAuth, completeOAuth, type FetchLike, type OAuthResult } from './atproto_oauth';

const nowSec = (): number => Math.floor(Date.now() / 1000);

// The app routes fetch through expo/fetch on iOS; the Response shape
// (status, headers.get, text()) satisfies FetchLike.
const fetchFn: FetchLike = (url, init) =>
  globalThis.fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

export interface LoginWithBlueskyOptions {
  appViewUrl?: string;
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
    ...(opts.appViewUrl !== undefined ? { appViewUrl: opts.appViewUrl } : {}),
  });

  // Open Bluesky consent in the system browser and wait for the
  // custom-scheme redirect back into the app.
  const redirectUrl = await new Promise<string>((resolve, reject) => {
    const sub = Linking.addEventListener('url', (e) => {
      if (e.url.startsWith(start.session.redirectUri.split(':')[0] + ':')) {
        clearTimeout(timer);
        sub.remove();
        resolve(e.url);
      }
    });
    const timer = setTimeout(
      () => {
        sub.remove();
        reject(new Error('Login timed out — no response from Bluesky.'));
      },
      opts.timeoutMs ?? 5 * 60 * 1000,
    );
    Linking.openURL(start.authorizeUrl).catch((err: unknown) => {
      clearTimeout(timer);
      sub.remove();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  // Custom-scheme URLs aren't reliably parsed by `new URL()`; pull the
  // query string off directly.
  const query = redirectUrl.split('?')[1] ?? '';
  const params = new URLSearchParams(query);
  const code = params.get('code') ?? '';
  if (code === '') {
    const err = params.get('error_description') ?? params.get('error') ?? 'no authorization code';
    throw new Error(`Bluesky login failed: ${err}`);
  }
  return completeOAuth(
    start.session,
    { code, state: params.get('state') ?? '' },
    { fetchFn, nowSec: nowSec() },
  );
}
