/**
 * The owner's devices (WEB_OWNER_SURFACE_PLAN §3.5, §3.8): coding agents,
 * staff phones and browsers connected as the owner's device. One set of
 * routes on Core's router, reached the same way from every owner surface:
 * the phone in-process, the web app and the server console over HTTP.
 *
 * Minting a code hands out authority, so it needs the owner AND a person
 * present (`no_user_presence` otherwise). Revoking reduces authority, so it
 * needs the owner only: a lost laptop must be cut off at once.
 *
 * The relay address a setup code carries is the host's (`msgboxURL`); a host
 * with more to say about the owner's devices (the server's approval phone)
 * adds it to the status through `extraStatus`.
 */

import { bytesToHex } from '@noble/hashes/utils.js';

import { ownerPresenceRefusal } from '../../commerce/owner_presence';
import {
  getDevice,
  listActiveDevices,
  listDevices,
  revokeDeviceDurable,
  type PairedDevice,
} from '../../devices/registry';
import { generatePairingCode, getNodeDID, getNodeSigningPublicKey } from '../../pairing/ceremony';
import { buildAgentSetupCode } from '../../pairing/setup_code';

import { makeOwnerGuard } from './owner_guard';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

export const OWNER_SETUP_PREFIX = '/v1/owner/setup';

export interface OwnerSetupRouteOptions {
  /** The relay a paired device reaches this node through. */
  msgboxURL: () => string;
  /** More status from the host (the server adds its approval phone). */
  extraStatus?: () => Record<string, unknown>;
}

/** The coding-agent name when the owner gives none (the console's fixed name). */
const DEFAULT_AGENT_NAME = 'coding-agent';
/** The server node's name when the owner gives none. */
const DEFAULT_NODE_NAME = 'server node';

// Printable, no control characters: the name is shown on owner cards.
// eslint-disable-next-line no-control-regex
const DEVICE_NAME_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

function answer(status: number, body?: unknown): CoreResponse {
  return body === undefined ? { status, headers: NO_STORE } : { status, body, headers: NO_STORE };
}

type DeviceKind = 'coding-agent' | 'server-node' | 'staff' | 'owner-device';

const KIND_OF: Record<DeviceKind, (d: PairedDevice) => boolean> = {
  'coding-agent': (d) => d.role === 'agent' && d.scope === 'coding',
  'server-node': (d) => d.role === 'agent' && d.scope === 'node',
  staff: (d) => d.role === 'staff',
  'owner-device': (d) => d.role === 'owner',
};

const NOT_FOUND: Record<DeviceKind, string> = {
  'coding-agent': 'coding_agent_not_found',
  'server-node': 'server_node_not_found',
  staff: 'staff_device_not_found',
  'owner-device': 'owner_device_not_found',
};

const NOT_DURABLE: Record<DeviceKind | 'device', string> = {
  'coding-agent': 'coding_agent_revoke_not_durable',
  'server-node': 'server_node_revoke_not_durable',
  staff: 'staff_device_revoke_not_durable',
  'owner-device': 'owner_device_revoke_not_durable',
  device: 'device_revoke_not_durable',
};

function summary(device: PairedDevice): Record<string, unknown> {
  return {
    device_id: device.deviceId,
    did: device.did,
    name: device.deviceName,
    created_at: device.createdAt,
    last_seen: device.lastSeen,
  };
}

/** Every device the node has paired, revoked ones included, for the Agents list. */
function fullEntry(device: PairedDevice): Record<string, unknown> {
  return {
    ...summary(device),
    role: device.role,
    ...(device.scope !== undefined ? { scope: device.scope } : {}),
    revoked: device.revoked,
  };
}

function bodyOf(req: CoreRequest): Record<string, unknown> {
  const body = req.body;
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** The owner's name for a device, or a refusal. */
function deviceName(req: CoreRequest, fallback?: string): string | CoreResponse {
  const raw = bodyOf(req).device_name;
  const name = typeof raw === 'string' ? raw.trim() : (fallback ?? '');
  if (!DEVICE_NAME_RE.test(name)) {
    return answer(400, { error: 'device_name is required: 1 to 64 printable characters' });
  }
  return name;
}

function presence(req: CoreRequest, detail: string): CoreResponse | null {
  const refusal = ownerPresenceRefusal(req, Date.now(), detail);
  return refusal === null ? null : answer(refusal.status, refusal.body);
}

export function registerOwnerSetupRoutes(
  router: CoreRouter,
  ownerCapability: string | undefined,
  options: OwnerSetupRouteOptions,
): void {
  const guard = makeOwnerGuard(ownerCapability, 'the owner’s devices are the owner’s to manage');
  const owner = (req: CoreRequest): CoreResponse | null => {
    const refused = guard(req);
    return refused === null ? null : answer(refused.status, refused.body);
  };

  router.get(`${OWNER_SETUP_PREFIX}/status`, async (req) => {
    const refused = owner(req);
    if (refused !== null) return refused;
    const active = listActiveDevices();
    const nodeDID = getNodeDID();
    return answer(200, {
      coding_agent_pairing_available: nodeDID !== null,
      home_did: nodeDID,
      msgbox_url: options.msgboxURL(),
      coding_agents: active.filter(KIND_OF['coding-agent']).map(summary),
      server_nodes: active.filter(KIND_OF['server-node']).map(summary),
      staff_devices: active.filter(KIND_OF.staff).map(summary),
      owner_devices: active.filter(KIND_OF['owner-device']).map(summary),
      devices: listDevices().map(fullEntry),
      ...(options.extraStatus?.() ?? {}),
    });
  });

  router.post(`${OWNER_SETUP_PREFIX}/coding-agent`, async (req) => {
    const refused = owner(req) ?? presence(req, 'pairing a coding agent needs a person present');
    if (refused !== null) return refused;
    const name = deviceName(req, DEFAULT_AGENT_NAME);
    if (typeof name !== 'string') return name;
    const nodeDID = getNodeDID();
    if (nodeDID === null) return answer(503, { error: 'Home Node identity is not ready' });
    try {
      const { code, expiresAt } = generatePairingCode({
        deviceName: name,
        role: 'agent',
        scope: 'coding',
      });
      return answer(201, {
        setup_code: buildAgentSetupCode({
          msgboxUrl: options.msgboxURL(),
          homenodeDid: nodeDID,
          code,
          deviceName: name,
        }),
        device_name: name,
        expires_at: expiresAt,
      });
    } catch {
      return answer(503, { error: 'Could not create a setup code; retry shortly' });
    }
  });

  // The owner's own server node, paired here to mirror its approval cards (UCP plan §3.9:
  // a checkout's start and hand-off, a held search). Paired as an agent with the `node`
  // scope: it reaches no coding or runner surface, and it alone may send a card that opens a
  // link or asks for a person present.
  router.post(`${OWNER_SETUP_PREFIX}/server-node`, async (req) => {
    const refused = owner(req) ?? presence(req, 'pairing a server node needs a person present');
    if (refused !== null) return refused;
    const name = deviceName(req, DEFAULT_NODE_NAME);
    if (typeof name !== 'string') return name;
    const nodeDID = getNodeDID();
    if (nodeDID === null) return answer(503, { error: 'Home Node identity is not ready' });
    try {
      const { code, expiresAt } = generatePairingCode({
        deviceName: name,
        role: 'agent',
        scope: 'node',
      });
      return answer(201, {
        setup_code: buildAgentSetupCode({
          msgboxUrl: options.msgboxURL(),
          homenodeDid: nodeDID,
          code,
          deviceName: name,
        }),
        device_name: name,
        expires_at: expiresAt,
      });
    } catch {
      return answer(503, { error: 'Could not create a setup code; retry shortly' });
    }
  });

  // A staff device — a till, a connector such as Jiffy's — is named by the
  // owner here, and that name is what an owner card shows when the device
  // proposes a change. The code pairs a device with role `staff` and no
  // authority: grants are a separate owner act on the commerce routes.
  router.post(`${OWNER_SETUP_PREFIX}/staff`, async (req) => {
    const refused =
      owner(req) ?? presence(req, 'creating a staff setup code needs a person present');
    if (refused !== null) return refused;
    const name = deviceName(req);
    if (typeof name !== 'string') return name;
    const nodeDID = getNodeDID();
    // A staff phone seals its first request to the node's signing key and
    // runs no DID resolution, so a staff code without that key is useless.
    const nodePub = getNodeSigningPublicKey();
    if (nodeDID === null || nodePub === null) {
      return answer(503, { error: 'Home Node identity is not ready' });
    }
    try {
      const { code, expiresAt } = generatePairingCode({ deviceName: name, role: 'staff' });
      return answer(201, {
        setup_code: buildAgentSetupCode({
          msgboxUrl: options.msgboxURL(),
          homenodeDid: nodeDID,
          code,
          deviceName: name,
          nodeSigningPubHex: bytesToHex(nodePub),
        }),
        device_name: name,
        expires_at: expiresAt,
      });
    } catch {
      return answer(503, { error: 'Could not create a setup code; retry shortly' });
    }
  });

  // §3.3 — connect a browser as the owner's device. The owner (capability,
  // or an owner device already connected) with a person present mints a
  // single-use code carrying role `owner`; the browser completes it on
  // `/v1/pair/complete` with the public half of a key it cannot export.
  // `/v1/pair/initiate` never mints this role.
  router.post(`${OWNER_SETUP_PREFIX}/owner-device`, async (req) => {
    const refused =
      owner(req) ?? presence(req, 'connecting a browser as the owner needs a person present');
    if (refused !== null) return refused;
    const name = deviceName(req);
    if (typeof name !== 'string') return name;
    try {
      const { code, expiresAt } = generatePairingCode({ deviceName: name, role: 'owner' });
      return answer(201, { code, device_name: name, expires_at: expiresAt });
    } catch {
      return answer(503, { error: 'Could not create a pairing code; retry shortly' });
    }
  });

  const revoke = async (deviceId: string, kind: DeviceKind | 'device'): Promise<CoreResponse> => {
    // revokeDeviceDurable cuts access before persisting; report a storage
    // failure honestly so the owner retries until the tombstone is durable.
    const result = await revokeDeviceDurable(deviceId);
    return result.durable ? answer(204) : answer(503, { error: NOT_DURABLE[kind] });
  };

  for (const kind of Object.keys(KIND_OF) as DeviceKind[]) {
    router.delete(`${OWNER_SETUP_PREFIX}/${kind}/:deviceId`, async (req) => {
      const refused = owner(req);
      if (refused !== null) return refused;
      const device = getDevice(req.params.deviceId ?? '');
      if (device === null || device.revoked || !KIND_OF[kind](device)) {
        return answer(404, { error: NOT_FOUND[kind] });
      }
      return revoke(device.deviceId, kind);
    });
  }

  // Any device the node has paired (the Agents list shows them all): a CLI,
  // a runner, a staff phone, a browser.
  router.delete(`${OWNER_SETUP_PREFIX}/device/:deviceId`, async (req) => {
    const refused = owner(req);
    if (refused !== null) return refused;
    const device = getDevice(req.params.deviceId ?? '');
    if (device === null || device.revoked) return answer(404, { error: 'device_not_found' });
    return revoke(device.deviceId, 'device');
  });
}
