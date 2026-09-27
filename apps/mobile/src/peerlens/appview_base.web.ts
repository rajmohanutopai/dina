/**
 * Where the PeerLens screens read the AppView — WEB.
 *
 * The browser must not call the AppView itself: external reads go through the
 * Home Node, and the AppView sends no CORS headers anyway. Brain forwards
 * PeerLens reads server-side at `/api/peerlens/xrpc/*`, reached cross-origin
 * from the Core-served page (WEB_OWNER_SURFACE_PLAN §3.4).
 */

import { brainUrl } from '../services/web_runtime';

export function appViewBase(): Promise<string> {
  return brainUrl('/api/peerlens');
}
