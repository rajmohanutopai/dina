/**
 * The STAFF PHONE's client (TRADE_FIRST_STRATEGY §6.3) — a clerk device
 * that is NOT a Home Node. It pairs to the business's node with a
 * `dina1:` code, holds one Ed25519 device key, and reaches exactly the
 * staff surface (§6.2's authz rows) over `RemoteCoreClient`'s sealed
 * relay tunnel. Every gate stays server-side: presence, grants, caps,
 * escalation — this client only carries the requests.
 */

import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';

import { getPublicKey } from '../crypto/ed25519';
import { deriveDIDKey, publicKeyToMultibase } from '../identity/did';
import { parseAgentSetupCode } from '../pairing/setup_code';

import { RemoteCoreClient, type WebSocketLike } from './remote_core_client';

export interface StaffIdentity {
  deviceDid: string;
  /** Ed25519 seed, hex — persisted by the app's secure store. */
  devicePrivateKeyHex: string;
  homenodeDid: string;
  homenodeSigningPubHex: string;
  msgboxUrl: string;
  deviceName: string;
}

export class StaffClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorKey: string,
  ) {
    super(message);
    this.name = 'StaffClientError';
  }
}

/**
 * Pair a fresh staff device from a pasted `dina1:` code. The code must
 * carry `node_pub` (codes minted since the staff build do): without the
 * node's signing key nothing can be sealed, and a clerk's phone has no
 * business running DID resolution before it belongs anywhere.
 */
export async function pairStaffDevice(args: {
  setupCode: string;
  makeWebSocket: (url: string) => WebSocketLike;
  timeoutMs?: number;
}): Promise<StaffIdentity> {
  const parsed = parseAgentSetupCode(args.setupCode);
  if (parsed.nodeSigningPubHex === null) {
    throw new Error(
      'this setup code carries no node key — mint a fresh staff code on the business phone',
    );
  }
  const seed = randomBytes(32);
  const pub = getPublicKey(seed);
  const deviceDid = deriveDIDKey(pub);
  const transport = new RemoteCoreClient({
    msgboxUrl: parsed.msgboxUrl,
    homenodeDid: parsed.homenodeDid,
    homenodeSigningPub: hexToBytes(parsed.nodeSigningPubHex),
    deviceDid,
    devicePrivateKey: seed,
    makeWebSocket: args.makeWebSocket,
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  });
  const res = await transport.request(
    'POST',
    '/v1/pair/complete',
    JSON.stringify({ code: parsed.code, public_key_multibase: publicKeyToMultibase(pub) }),
  );
  const body = JSON.parse(res.body === '' ? '{}' : res.body) as Record<string, unknown>;
  if (res.status !== 201 && res.status !== 200) {
    throw new StaffClientError(
      `pairing failed: ${String(body.error ?? res.status)}`,
      res.status,
      String(body.error ?? 'pairing_failed'),
    );
  }
  if (body.role !== 'staff') {
    // The code decides the role at initiate time; a non-staff code
    // pairing through the STAFF shell would hand this app an identity
    // whose surface it does not render. Refuse rather than half-join.
    throw new StaffClientError(
      `this code pairs role '${String(body.role)}', not staff — mint it from Staff, not Agents`,
      409,
      'not_a_staff_code',
    );
  }
  return {
    deviceDid,
    devicePrivateKeyHex: bytesToHex(seed),
    homenodeDid: parsed.homenodeDid,
    homenodeSigningPubHex: parsed.nodeSigningPubHex,
    msgboxUrl: parsed.msgboxUrl,
    deviceName: parsed.deviceName,
  };
}

/** Rebuild the transport from a persisted identity. */
export function staffTransportFor(
  identity: StaffIdentity,
  makeWebSocket: (url: string) => WebSocketLike,
  timeoutMs?: number,
): RemoteCoreClient {
  return new RemoteCoreClient({
    msgboxUrl: identity.msgboxUrl,
    homenodeDid: identity.homenodeDid,
    homenodeSigningPub: hexToBytes(identity.homenodeSigningPubHex),
    deviceDid: identity.deviceDid,
    devicePrivateKey: hexToBytes(identity.devicePrivateKeyHex),
    makeWebSocket,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

export interface StaffInboxItem {
  kind: string;
  role: string;
  subject: string;
  counterparty_did: string;
  created_at: number;
}

/** The §6.2 surface, method for method — nothing wider. */
export class StaffCoreClient {
  constructor(private readonly transport: RemoteCoreClient) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.transport.request(
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      body === undefined ? {} : { 'content-type': 'application/json' },
    );
    const parsed = JSON.parse(res.body === '' ? '{}' : res.body) as Record<string, unknown>;
    if (res.status < 200 || res.status >= 300) {
      throw new StaffClientError(
        `${method} ${path} failed ${String(res.status)} — ${String(parsed.error ?? 'error')}`,
        res.status,
        String(parsed.error ?? 'error'),
      );
    }
    return parsed as T;
  }

  /** §6.4 — the attributed presence stamp. Five minutes per proof. */
  async provePresence(pin: string): Promise<{ ok: true; ttl_ms: number }> {
    return this.call('POST', '/v1/commerce/trade/staff-presence', { pin });
  }

  async inbox(): Promise<{ ok: true; items: StaffInboxItem[] }> {
    return this.call('GET', '/v1/commerce/trade/inbox');
  }

  async unanswered(counterpartyDid: string): Promise<{
    ok: true;
    delivery_notes: { record_digest: string; purchase_order_id: string; created_at: number }[];
    payment_notes: { record_digest: string; created_at: number }[];
  }> {
    return this.call(
      'GET',
      `/v1/commerce/trade/unanswered?counterparty_did=${encodeURIComponent(counterpartyDid)}`,
    );
  }

  /**
   * §6.5 commerce_receive_goods. A 202 means the value crossed the cap
   * and an owner card exists — surfaced as a typed outcome, not an
   * error, because "waiting for the owner" is a clerk's normal day.
   */
  async issueDeliveryReceipt(args: {
    deliveryNoteDigest: string;
    lines: { line_id: string; accepted_quantity: { value: string; unit_code: string }; reason_code?: string }[];
  }): Promise<
    | { kind: 'issued'; document: Record<string, unknown> }
    | { kind: 'pending_approval'; taskId: string }
  > {
    const res = await this.transport.request(
      'POST',
      '/v1/commerce/trade/delivery-receipt',
      JSON.stringify({ delivery_note_digest: args.deliveryNoteDigest, lines: args.lines }),
      { 'content-type': 'application/json' },
    );
    const parsed = JSON.parse(res.body === '' ? '{}' : res.body) as Record<string, unknown>;
    if (res.status === 202) {
      return { kind: 'pending_approval', taskId: String(parsed.task_id ?? '') };
    }
    if (res.status !== 200) {
      throw new StaffClientError(
        `delivery-receipt failed ${String(res.status)} — ${String(parsed.error ?? 'error')}`,
        res.status,
        String(parsed.error ?? 'error'),
      );
    }
    return { kind: 'issued', document: (parsed.document as Record<string, unknown>) ?? {} };
  }

  /** §6.5 commerce_confirm — the draft vouch ceremony. */
  async confirmDraft(draftId: string): Promise<Record<string, unknown>> {
    return this.call('POST', '/v1/commerce/orders/drafts/confirm', { draft_id: draftId });
  }

  /** §6.5 commerce_submit — supplier order decide. */
  async decideOrder(args: {
    buyerDid: string;
    purchaseOrderId: string;
    approve: boolean;
  }): Promise<Record<string, unknown>> {
    return this.call('POST', '/v1/commerce/orders/decide', {
      buyer_did: args.buyerDid,
      purchase_order_id: args.purchaseOrderId,
      approve: args.approve,
    });
  }
}
