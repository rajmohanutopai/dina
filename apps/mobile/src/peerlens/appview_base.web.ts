/**
 * Where the PeerLens screens read the AppView — WEB.
 *
 * The browser must not call the AppView itself: external reads go through the
 * Home Node, and the AppView sends no CORS headers anyway. Brain forwards
 * PeerLens reads server-side at `/api/peerlens/xrpc/*`, reached cross-origin
 * from the Core-served page (WEB_OWNER_SURFACE_PLAN §3.4).
 */

import { brainUrl, brainUrlFetch } from '../services/web_runtime';

export function appViewBase(): Promise<string> {
  return brainUrl('/api/peerlens');
}

/**
 * How those reads are sent: signed by the owner device, as every call to
 * Brain is (Brain serves signed callers only, A2A design §4.1).
 */
export const appViewFetch: typeof fetch = brainUrlFetch;
