/**
 * Where the owner is sent to finish at the merchant (UCP plan §3.8). In order:
 *  1. the checkout's `continue_url`, when it is https and the session has not
 *     expired;
 *  2. a permalink, when the merchant offers `dev.ucp.shopping.permalink`: the
 *     approved items and quantities only, no personal data, within 2,048
 *     bytes (the merchant answers it with a 303 and must not treat it as an
 *     order; Dina cannot watch what follows);
 *  3. the `continue_url` of an error answer, when no session could be made;
 *  4. the store's home page, with a note that the cart did not carry over.
 *
 * A URL whose host is not the merchant's own (its profile's host, a host its
 * profile names, or a subdomain of one) is still offered, shown whole, with
 * a warning that it leads elsewhere. Dina never appends anything to
 * `continue_url` (that is the embedded-checkout protocol, which Dina does not
 * speak).
 */

import { buildPermalink, type PermalinkLine } from './permalink';

export type HandoffSource = 'continue_url' | 'permalink' | 'error_continue_url' | 'home_page';

export interface HandoffUrl {
  url: string;
  source: HandoffSource;
  /** The URL's host is not one the merchant's profile names: show it whole, with a warning. */
  offHost: boolean;
}

export interface HandoffInput {
  /** The merchant's canonical origin (its root profile's origin): the home page of step 4. */
  merchantOrigin: string;
  /** Hosts the merchant's profile names (its endpoints, its permalink endpoint). */
  profileHosts: readonly string[];
  now: number;
  /** The checkout session, when one was made. */
  checkout?: { continueUrl?: string; expiresAt?: number };
  /** The permalink endpoint the merchant advertises, with the approved lines. */
  permalink?: { endpoint: string; lines: readonly PermalinkLine[] };
  /** The `continue_url` of the error answer that refused the session. */
  errorContinueUrl?: string;
  /** The longest URL a surface can carry; a longer one moves on to the next step. */
  maxBytes?: number;
}

function httpsUrl(value: string | undefined): URL | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url : null;
  } catch {
    return null;
  }
}

/** Whether `host` is one of `hosts` or a subdomain of one (names compared case-blind, without a trailing dot). */
export function isMerchantHost(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return hosts.some((raw) => {
    const m = raw.toLowerCase().replace(/\.$/, '');
    return m !== '' && (h === m || h.endsWith(`.${m}`));
  });
}

/** The URL the owner is handed, by the order above. */
export function handoffUrl(input: HandoffInput): HandoffUrl {
  const home = httpsUrl(input.merchantOrigin);
  if (home === null) throw new Error('handoff: the merchant origin is not https');
  const hosts = [home.hostname, ...input.profileHosts];
  const fits = (url: URL) =>
    input.maxBytes === undefined || new TextEncoder().encode(url.href).length <= input.maxBytes;

  const candidates: [URL | null, HandoffSource][] = [];
  const live =
    input.checkout !== undefined &&
    (input.checkout.expiresAt === undefined || input.now < input.checkout.expiresAt);
  candidates.push([live ? httpsUrl(input.checkout?.continueUrl) : null, 'continue_url']);
  if (input.permalink !== undefined) {
    const built = buildPermalink(input.permalink.endpoint, input.permalink.lines);
    candidates.push([built.ok ? httpsUrl(built.url) : null, 'permalink']);
  }
  candidates.push([httpsUrl(input.errorContinueUrl), 'error_continue_url']);
  for (const [url, source] of candidates)
    if (url !== null && fits(url))
      return { url: url.href, source, offHost: !isMerchantHost(url.hostname, hosts) };
  return { url: `${home.origin}/`, source: 'home_page', offHost: false };
}
