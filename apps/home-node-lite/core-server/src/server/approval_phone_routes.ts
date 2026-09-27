/**
 * The server's approval phone (`/v1/owner/setup/phone`): pair and revoke the
 * phone that approves this node's cards remotely. Server-only, so it stays a
 * Fastify route here; the rest of the owner's devices (coding agents, staff,
 * owner devices, status) are Core routes every owner surface shares
 * (`@dina/core` `registerOwnerSetupRoutes`), and this node's approval-phone
 * state joins their status through `phoneStatusForOwnerSetup`.
 */

import { OWNER_SETUP_PREFIX, ownerPresenceRefusal } from '@dina/core';

import { buildCoreRequest, ownerVerdict, type OwnerDeviceAuth } from './bind_core_router';

import type { PhoneApprovalStatus } from '../approval/phone_approval_manager';
import type { FastifyRequest } from 'fastify';

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
  post(path: string, handler: OwnerSetupHandler): unknown;
  delete(path: string, handler: OwnerSetupHandler): unknown;
}

export interface RegisterApprovalPhoneOptions {
  enabled: boolean;
  ownerCapability: string;
  phoneManager: PhoneApprovalLifecycle | null;
  /** Owner devices (WEB_OWNER_SURFACE_PLAN §3.3); absent: the capability header only. */
  ownerDeviceAuth?: OwnerDeviceAuth;
}

export interface PhoneApprovalLifecycle {
  status(): PhoneApprovalStatus;
  pair(setupCode: string): Promise<PhoneApprovalStatus>;
  revoke(): Promise<PhoneApprovalStatus>;
}

/** Register the owner-only approval-phone lifecycle API. */
export function registerApprovalPhoneRoutes(
  app: OwnerSetupApp,
  options: RegisterApprovalPhoneOptions,
): void {
  if (!options.enabled) return;

  app.post(`${OWNER_SETUP_PREFIX}/phone`, async (req, reply) => {
    const request = req as OwnerSetupRequest;
    const ownerPrincipal = requireOwner(request, reply, options);
    if (ownerPrincipal === null) return;
    noStore(reply);
    // WEB_OWNER_SURFACE_PLAN §3.8 — the approval phone decides this node's
    // cards, so pairing one hands out authority: a person must be present.
    // Unpairing reduces authority and is not gated.
    const refusal = ownerPresenceRefusal(
      { ownerPrincipal },
      Date.now(),
      'pairing an approval phone needs a person present',
    );
    if (refusal !== null) return reply.code(refusal.status).send(refusal.body);
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
    if (requireOwner(req, reply, options) === null) return;
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

/**
 * The same owner decision the route binder makes (`ownerVerdict`): the
 * capability header, or a verified owner device. One function, so these
 * Fastify-level routes and the bound CoreRouter routes cannot drift.
 * Returns the owner principal, or null after answering the refusal.
 */
function requireOwner(
  req: unknown,
  reply: OwnerSetupReply,
  options: RegisterApprovalPhoneOptions,
): string | null {
  const verdict = ownerVerdict(
    buildCoreRequest(req as FastifyRequest),
    options.ownerCapability,
    options.ownerDeviceAuth,
  );
  if (verdict.kind === 'owner') return verdict.principal;
  noStore(reply);
  if (verdict.kind === 'refused') {
    reply.code(verdict.status).send(verdict.body);
  } else {
    reply.code(403).send({ error: 'access_denied' });
  }
  return null;
}

function noStore(reply: OwnerSetupReply): void {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
}

/** The approval phone's state, for the owner-setup status Core serves. */
export function phoneStatusForOwnerSetup(phoneManager: PhoneApprovalLifecycle | null): {
  phone: PhoneApprovalStatus;
} {
  return { phone: phoneManager?.status() ?? { configured: false, state: 'unpaired' } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
