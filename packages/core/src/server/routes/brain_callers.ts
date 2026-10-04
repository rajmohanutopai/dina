/**
 * Who may call Brain (docs/A2A_GATEWAY_ARCHITECTURE.md §4.1, plan §3.18).
 *
 * On a server, Brain is its own process on loopback, and loopback is not an
 * identity. Brain serves only signed callers it knows: Core, under its
 * service key, and the owner's paired devices. It learns both here, over its
 * own signed link, and asks again when an unknown DID signs. Only Brain may
 * read this: the list names the owner's devices.
 */

import { listActiveDevices } from '../../devices/registry';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

export const BRAIN_CALLERS_ROUTE = '/v1/brain/callers';

let coreServiceDid: string | null = null;

/** The server host installs the DID Core signs its calls to Brain with; null removes it. */
export function installCoreServiceDid(did: string | null): void {
  coreServiceDid = did;
}

export function getCoreServiceDid(): string | null {
  return coreServiceDid;
}

function brainCallers(req: CoreRequest): CoreResponse {
  if (req.callerType !== 'brain') return { status: 403, body: { error: 'brain_only' } };
  const ownerDevices = listActiveDevices()
    .filter((d) => d.role === 'owner' && d.did !== '')
    .map((d) => d.did)
    .sort();
  return { status: 200, body: { core: coreServiceDid, owner_devices: ownerDevices } };
}

export function registerBrainCallerRoutes(router: CoreRouter): void {
  router.get(BRAIN_CALLERS_ROUTE, async (req) => brainCallers(req));
}
