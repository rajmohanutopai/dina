/**
 * The Dina app's claimed link for linking an account at a merchant (UCP
 * plan §3.17): `https://<label>.<profile host>/oauth/callback`. The OS hands
 * it to the app; the app routes it to its own screen (the Bluesky sign-in
 * has `dina://oauth/callback`), which gives the parameters to Core.
 *
 * Kept free of `@dina/core` on purpose: `+native-intent` reads it before
 * boot, before the crypto polyfills are in. The label rule is the profile
 * host's (`@dina/ucp` `LABEL_PATTERN`); a test holds the two together.
 */

const DEFAULT_PROFILE_HOST = 'ucp.dinakernel.com';
const LABEL = /^[a-z2-7]{26}$/;
const CALLBACK_PATH = '/oauth/callback';
/** Where the app shows the callback (`app/ucp/oauth/callback.tsx`). */
export const UCP_LINK_CALLBACK_ROUTE = '/ucp/oauth/callback';

/** The profile host this build publishes to (as `startUcp` reads it). */
export function ucpProfileHost(): string {
  const configured = process.env.EXPO_PUBLIC_DINA_UCP_PROFILE_HOST;
  return configured !== undefined && configured !== '' ? configured : DEFAULT_PROFILE_HOST;
}

/** The app route for a claimed callback link, or null when `url` is not one. */
export function ucpLinkCallbackRoute(url: string, profileHost = ucpProfileHost()): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '')
    return null;
  if (u.pathname !== CALLBACK_PATH) return null;
  const suffix = `.${profileHost}`;
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(suffix) || !LABEL.test(host.slice(0, -suffix.length))) return null;
  return `${UCP_LINK_CALLBACK_ROUTE}${u.search}`;
}
