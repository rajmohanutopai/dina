/**
 * Where the PeerLens screens read the AppView — PHONE.
 *
 * The phone IS the Home Node, so it calls the AppView directly at the hosted
 * endpoint (env overrides first, then the endpoint mode's fleet).
 */

import { mobileHostedEndpoints } from '../services/hosted_endpoints';

export function appViewBase(): Promise<string> {
  return Promise.resolve(mobileHostedEndpoints().appViewBaseUrl);
}

/** How those reads are sent: the AppView is public, so a plain fetch. */
export const appViewFetch: typeof fetch = (input, init) => fetch(input, init);
