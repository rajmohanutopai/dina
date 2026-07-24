import { buildAgentSetupCode, generatePairingCode, getNodeDID } from '@dina/core';
import { getDevice, listActiveDevices, revokeDeviceDurable } from '@dina/core/devices';

import { ownerHeaderMatches } from './bind_core_router';

import type { PhoneApprovalStatus } from '../approval/phone_approval_manager';

interface OwnerSetupRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  params?: Record<string, string | undefined>;
}

interface OwnerSetupReply {
  header(name: string, value: string): OwnerSetupReply;
  code(status: number): OwnerSetupReply;
  send(payload?: unknown): OwnerSetupReply;
}

type OwnerSetupHandler = (req: unknown, reply: OwnerSetupReply) => unknown;

interface OwnerSetupApp {
  get(path: string, handler: OwnerSetupHandler): unknown;
  post(path: string, handler: OwnerSetupHandler): unknown;
  delete(path: string, handler: OwnerSetupHandler): unknown;
}

export const OWNER_SETUP_PREFIX = '/v1/owner/setup';

export interface RegisterOwnerSetupOptions {
  enabled: boolean;
  ownerCapability: string;
  msgboxURL: string;
  phoneManager: PhoneApprovalLifecycle | null;
}

export interface PhoneApprovalLifecycle {
  status(): PhoneApprovalStatus;
  pair(setupCode: string): Promise<PhoneApprovalStatus>;
  revoke(): Promise<PhoneApprovalStatus>;
}

/** Register the owner-only enrollment and approval-phone lifecycle API. */
export function registerOwnerSetupRoutes(
  app: OwnerSetupApp,
  options: RegisterOwnerSetupOptions,
): void {
  if (!options.enabled) return;

  app.get(`${OWNER_SETUP_PREFIX}/status`, async (req, reply) => {
    if (!requireOwner(req as OwnerSetupRequest, reply, options.ownerCapability)) return;
    noStore(reply);
    return {
      coding_agent_pairing_available: getNodeDID() !== null,
      coding_agents: codingAgents(),
      phone: options.phoneManager?.status() ?? unavailablePhoneStatus(),
    };
  });

  app.post(`${OWNER_SETUP_PREFIX}/coding-agent`, async (req, reply) => {
    if (!requireOwner(req as OwnerSetupRequest, reply, options.ownerCapability)) return;
    noStore(reply);
    const nodeDID = getNodeDID();
    if (nodeDID === null) {
      return reply.code(503).send({ error: 'Home Node identity is not ready' });
    }
    try {
      const { code, expiresAt } = generatePairingCode({
        deviceName: 'coding-agent',
        role: 'agent',
        scope: 'coding',
      });
      return reply.code(201).send({
        setup_code: buildAgentSetupCode({
          msgboxUrl: options.msgboxURL,
          homenodeDid: nodeDID,
          code,
          deviceName: 'coding-agent',
        }),
        expires_at: expiresAt,
      });
    } catch {
      return reply.code(503).send({ error: 'Could not create a setup code; retry shortly' });
    }
  });

  app.delete(`${OWNER_SETUP_PREFIX}/coding-agent/:deviceId`, async (req, reply) => {
    const request = req as OwnerSetupRequest;
    if (!requireOwner(request, reply, options.ownerCapability)) return;
    noStore(reply);
    const deviceId = request.params?.deviceId ?? '';
    const device = deviceId === '' ? null : getDevice(deviceId);
    if (device === null || device.role !== 'agent' || device.scope !== 'coding') {
      return reply.code(404).send({ error: 'coding_agent_not_found' });
    }
    const result = await revokeDeviceDurable(device.deviceId);
    if (!result.durable) {
      // revokeDeviceDurable cuts access before persistence. Report the storage
      // failure honestly so the owner retries until the tombstone is durable.
      return reply.code(503).send({ error: 'coding_agent_revoke_not_durable' });
    }
    return reply.code(204).send();
  });

  app.post(`${OWNER_SETUP_PREFIX}/phone`, async (req, reply) => {
    const request = req as OwnerSetupRequest;
    if (!requireOwner(request, reply, options.ownerCapability)) return;
    noStore(reply);
    if (options.phoneManager === null) {
      return reply.code(503).send({ error: 'Phone approval bridge is unavailable' });
    }
    const body = isRecord(request.body) ? request.body : {};
    const setupCode = typeof body.setup_code === 'string' ? body.setup_code.trim() : '';
    if (setupCode === '') {
      return reply.code(400).send({ error: 'setup_code is required' });
    }
    try {
      return reply.code(200).send({ phone: await options.phoneManager.pair(setupCode) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Phone pairing failed';
      const status =
        message.includes('already paired') || message.includes('still pending') ? 409 : 400;
      return reply.code(status).send({ error: message });
    }
  });

  app.delete(`${OWNER_SETUP_PREFIX}/phone`, async (req, reply) => {
    if (!requireOwner(req as OwnerSetupRequest, reply, options.ownerCapability)) return;
    noStore(reply);
    if (options.phoneManager === null) {
      return reply.code(503).send({ error: 'Phone approval bridge is unavailable' });
    }
    const phone = await options.phoneManager.revoke();
    // A relay outage leaves a durable revoking tombstone and synchronization
    // disabled. Report 202 so the owner knows remote cleanup is still pending.
    return reply.code(phone.state === 'revoking' ? 202 : 200).send({ phone });
  });
}

function requireOwner(req: OwnerSetupRequest, reply: OwnerSetupReply, capability: string): boolean {
  const raw = req.headers['x-dina-owner-capability'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!ownerHeaderMatches(header, capability)) {
    noStore(reply);
    reply.code(403).send({ error: 'access_denied' });
    return false;
  }
  return true;
}

function noStore(reply: OwnerSetupReply): void {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
}

function unavailablePhoneStatus(): PhoneApprovalStatus {
  return { configured: false, state: 'unpaired' };
}

function codingAgents(): Record<string, unknown>[] {
  return listActiveDevices()
    .filter((device) => device.role === 'agent' && device.scope === 'coding')
    .map((device) => ({
      device_id: device.deviceId,
      did: device.did,
      name: device.deviceName,
      created_at: device.createdAt,
      last_seen: device.lastSeen,
    }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
