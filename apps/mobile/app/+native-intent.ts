import { resolveSafeDeepLink } from '../src/notifications/deep_link';
import { ucpLinkCallbackRoute } from '../src/services/ucp_link_callback';

interface NativeIntentInput {
  path: string | null;
  initial: boolean;
}

/**
 * Expo Router receives custom-scheme URLs as full strings. Normalize Dina's
 * public links before route matching so cold and warm launches behave like
 * notification taps. Unknown or sensitive Dina links are ignored.
 */
export function redirectSystemPath({ path }: NativeIntentInput): string | null {
  if (path === null) return null;

  try {
    if (path.startsWith('dina://expo-development-client/')) return path;
    if (path.startsWith('dina://oauth/callback')) {
      return `/${path.slice('dina://'.length)}`;
    }
    if (path.startsWith('dina://')) return resolveSafeDeepLink(path);
    // A merchant sending the owner back after linking an account (UCP plan §3.17).
    if (path.startsWith('https://')) return ucpLinkCallbackRoute(path) ?? path;
    return path;
  } catch {
    return null;
  }
}
