/**
 * The owner dispatcher — BROWSER version (WEB_OWNER_SURFACE_PLAN §3.6).
 *
 * In a browser the owner's node is the Home Node that served the page, not
 * the limited node the app runs in the tab. Owner requests go to Core's own
 * origin, signed by this browser's owner device (`owner_device.web.ts`); the
 * host verifies the signature and marks the request as the owner. Nothing the
 * page sends carries a reusable secret.
 *
 * When this browser is not connected, every owner request answers
 * `401 owner_device_not_connected` without leaving the page, so the owner
 * clients raise their ordinary HTTP error and a screen can point the owner at
 * Settings → Owner access. A browser revoked from another surface is told
 * the same, once Core confirms it no longer knows the device, and its key is
 * forgotten.
 */

import { HttpOwnerDispatcher, type CoreResponse, type OwnerDispatcher } from '@dina/core';

import { forgetOwnerDeviceCoreDropped, loadOwnerSigner } from './owner_device';

const NOT_CONNECTED: CoreResponse = { status: 401, body: { error: 'owner_device_not_connected' } };

/**
 * Refusals that say nothing about whether Core still knows the device: a
 * clock out of the window, a replayed nonce, throttling. Anything else Core's
 * signature pipeline refuses may mean the device was revoked.
 */
const TRANSIENT_REJECTIONS: ReadonlySet<string> = new Set(['timestamp', 'nonce', 'rate_limit']);

function refusedDevice(res: CoreResponse): boolean {
  if (res.status !== 401 && res.status !== 403) return false;
  const at = (res.body as { rejected_at?: unknown } | undefined)?.rejected_at;
  return typeof at === 'string' && !TRANSIENT_REJECTIONS.has(at);
}

const browserOwnerDispatcher: OwnerDispatcher = {
  async dispatch(req) {
    const signer = await loadOwnerSigner();
    if (signer === null) return NOT_CONNECTED;
    // Same origin: the page and Core share it (Core served the page).
    const http = new HttpOwnerDispatcher({ baseUrl: '', signer });
    const res = await http.dispatch(req);
    if (!refusedDevice(res) || !(await deviceDroppedByCore(http))) return res;
    // Revoked from another surface: forget the key, so this screen and
    // Settings → Owner access say "connect this browser" instead of an
    // authorization error on every action.
    await forgetOwnerDeviceCoreDropped(signer.did);
    return NOT_CONNECTED;
  },
};

/**
 * Does Core still know this device? Asked on the one route every owner
 * device may read, so a refusal of some other path (one not on the owner
 * surface, say) never costs the owner their connection.
 */
async function deviceDroppedByCore(http: HttpOwnerDispatcher): Promise<boolean> {
  const probe = await http.dispatch({ method: 'GET', path: '/v1/owner/setup/status' });
  return refusedDevice(probe);
}

/**
 * Boot's in-process dispatcher belongs to the tab's limited node, which is not
 * the owner's node here, so the browser build does not install it.
 */
export function setOwnerDispatcher(_next: OwnerDispatcher | null): void {
  /* see above */
}

export function getOwnerDispatcher(): OwnerDispatcher {
  return browserOwnerDispatcher;
}
