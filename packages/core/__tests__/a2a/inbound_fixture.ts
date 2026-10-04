/**
 * The Lane 2 test world (design §7): one node with a public bus listing on a
 * bound runner lane, one A2A client with its bearer, the grant and config
 * repositories installed as a host installs them, and helpers that drive
 * ingress the way the gateway does — a forwarded raw request and its bearer.
 * Shared by the inbound tests (M2) and the delivery, push-config, stream and
 * extended-card tests (M3).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import { didRequestSigningInput } from '@dina/a2a';

import {
  A2A_RPC_PATH,
  PrincipalBudgets,
  a2aWorkflowHooks,
  admitInboundClaimWith,
  bindRunner,
  createA2AClient,
  ingressSendMessage,
  type GatewayEnvelope,
  type InboundRuntime,
} from '../../src/a2a';
import { sign } from '../../src/crypto/ed25519';
import { registerDevice, resetDeviceRegistry } from '../../src/devices/registry';
import { clearPairingState, setNodeDID } from '../../src/pairing/ceremony';
import {
  resetServiceConfigState,
  setServiceConfigDurable,
  validateServiceConfigForSave,
} from '../../src/service/service_config';
import {
  SQLiteServiceConfigRepository,
  setServiceConfigRepository,
} from '../../src/service/service_config_repository';
import {
  SQLiteServiceGrantRepository,
  setServiceGrantRepository,
} from '../../src/service/service_grant_repository';

import { LaneWorld } from './outbound_fixture';

import type { A2ATaskRow } from '../../src/a2a/store';
import type { WorkflowTask } from '../../src/workflow/domain';
import type { WorkflowServiceOptions } from '../../src/workflow/service';
import type { ServiceConfig } from '@dina/protocol';

/** The node's own DID, set at boot: an execution child names its listing under it. */
export const INBOUND_NODE_DID = 'did:plc:inboundprovidernode';

/**
 * The four values of a DID-signed request, as a client signs one
 * (`didRequestSigningInput`): addressed to this world's node unless
 * `nodeDid` names another, at the current time with a fresh nonce unless the
 * test picks them.
 */
export function didRequestSignature(args: {
  method?: string;
  path?: string;
  query?: string;
  body: string;
  signer: { privateKey: Uint8Array; did: string };
  did?: string;
  nodeDid?: string;
  timestamp?: string;
  nonce?: string;
}): { did: string; timestamp: string; nonce: string; signature: string } {
  const timestamp = args.timestamp ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = args.nonce ?? bytesToHex(randomBytes(16));
  const text = didRequestSigningInput({
    nodeDid: args.nodeDid ?? INBOUND_NODE_DID,
    method: args.method ?? 'POST',
    path: args.path ?? A2A_RPC_PATH,
    query: args.query ?? '',
    timestamp,
    nonce,
    bodySha256Hex: bytesToHex(sha256(new TextEncoder().encode(args.body))),
  });
  return {
    did: args.did ?? args.signer.did,
    timestamp,
    nonce,
    signature: bytesToHex(sign(args.signer.privateKey, new TextEncoder().encode(text))),
  };
}

export const ETA_PARAMS = {
  type: 'object',
  required: ['route_id'],
  properties: { route_id: { type: 'string', minLength: 1 } },
};
export const ETA_RESULT = {
  type: 'object',
  required: ['eta_minutes'],
  properties: { eta_minutes: { type: 'integer' } },
};
export const BOOK_PARAMS = {
  type: 'object',
  required: ['slot'],
  properties: { slot: { type: 'string' } },
};
export const BOOK_RESULT = {
  type: 'object',
  required: ['booked'],
  properties: { booked: { type: 'boolean' } },
};

export function listing(over: Partial<ServiceConfig>): ServiceConfig {
  return {
    isDiscoverable: true,
    discoverability: 'public',
    status: 'active',
    name: 'Bus 42',
    capabilities: {
      eta_query: {
        mcpServer: 'transit',
        mcpTool: 'get_eta',
        responsePolicy: 'auto',
        category: 'transit',
      },
    },
    capabilitySchemas: {
      eta_query: { params: ETA_PARAMS, result: ETA_RESULT, schemaHash: 'h-eta' },
    },
    ...over,
  };
}

/** A public booking listing on the bound lane. A valid one is review-gated (the validator's write rule). */
export function bookingListing(policy: 'review' | 'auto' = 'review', tool = 'book'): ServiceConfig {
  return listing({
    capabilities: {
      appointment_book: {
        mcpServer: 'transit',
        mcpTool: tool,
        responsePolicy: policy,
        category: 'appointments',
      },
    },
    capabilitySchemas: {
      appointment_book: { params: BOOK_PARAMS, result: BOOK_RESULT, schemaHash: 'h-book' },
    },
  });
}

/** A save as the owner's route makes it: validated, durable (the revision Core pins), then in memory. */
export async function save(config: ServiceConfig, rkey: string): Promise<void> {
  const verdict = validateServiceConfigForSave(config);
  if (!verdict.ok) throw new Error(`fixture listing refused: ${JSON.stringify(verdict)}`);
  await setServiceConfigDurable(config, rkey);
}

/** A row the validator never saw (an older row, a direct write): Core must not trust it. */
export async function saveUnchecked(config: ServiceConfig, rkey: string): Promise<void> {
  await setServiceConfigDurable(config, rkey);
}

export function resultOf(answer: { body?: unknown }): Record<string, unknown> {
  const body = answer.body as { result?: Record<string, unknown>; error?: unknown };
  if (body.result === undefined) throw new Error(`no result: ${JSON.stringify(body)}`);
  return body.result;
}

export function errorOf(answer: { body?: unknown }): { code: number; reason?: string } {
  const body = answer.body as { error?: { code: number; data?: { reason: string }[] } };
  if (body.error === undefined) throw new Error(`no error: ${JSON.stringify(answer.body)}`);
  return {
    code: body.error.code,
    ...(body.error.data?.[0] === undefined ? {} : { reason: body.error.data[0].reason }),
  };
}

/** The Task inside a SendMessageResponse: A2A v1.0 answers `{task}`, never a bare Task. */
export function sentTask(answer: { body?: unknown }): Record<string, unknown> {
  const result = resultOf(answer);
  const task = result.task;
  if (typeof task !== 'object' || task === null || Array.isArray(task)) {
    throw new Error(`not a SendMessageResponse: ${JSON.stringify(result)}`);
  }
  return task as Record<string, unknown>;
}

let rpcId = 0;

export class InboundWorld {
  readonly world: LaneWorld;
  readonly rt: InboundRuntime;
  readonly grants: SQLiteServiceGrantRepository;
  readonly configs: SQLiteServiceConfigRepository;
  /** What the D2D bridge was asked to send: an inbound result never goes out over D2D. */
  readonly sent: unknown[] = [];
  token = '';
  clientId = '';
  readonly runnerDid: string;

  private constructor(extra: Partial<WorkflowServiceOptions>) {
    resetDeviceRegistry();
    resetServiceConfigState();
    setNodeDID(INBOUND_NODE_DID);
    this.world = new LaneWorld();
    const hooks = a2aWorkflowHooks(() => this.world.runtime);
    this.world.useService(true, {
      responseEgressGate: hooks.responseEgressGate,
      ...(hooks.onTaskRequeued === undefined ? {} : { onTaskRequeued: hooks.onTaskRequeued }),
      responseBridgeSender: async (...args: unknown[]) => {
        this.sent.push(args);
      },
      ...extra,
    });
    this.configs = new SQLiteServiceConfigRepository(this.world.store.db);
    setServiceConfigRepository(this.configs);
    this.grants = new SQLiteServiceGrantRepository(this.world.store.db);
    // Installed, as a host does: the settle hook and the claim check read it.
    setServiceGrantRepository(this.grants);
    this.rt = { a2a: this.world.runtime, grants: this.grants, budgets: new PrincipalBudgets() };
    this.runnerDid = registerDevice('Transit runner', 'z6MkInboundRunner', 'agent', 'runner').did;
    bindRunner(this.world.store, { lane: 'transit', device_did: this.runnerDid }, this.world.clock);
  }

  /** The world with the bus listing saved and one client. */
  static async create(extra: Partial<WorkflowServiceOptions> = {}): Promise<InboundWorld> {
    const w = new InboundWorld(extra);
    await save(listing({}), 'bus');
    const created = createA2AClient(w.world.store, { display_name: 'Acme agent' }, w.world.clock);
    if (!created.ok) throw new Error(created.reason);
    w.token = created.token;
    w.clientId = created.client.client_id;
    return w;
  }

  close(): void {
    setServiceGrantRepository(null);
    setServiceConfigRepository(null);
    resetServiceConfigState();
    resetDeviceRegistry();
    clearPairingState();
    this.world.close();
  }

  request(
    method: string,
    params: Record<string, unknown> | undefined,
    over: Partial<GatewayEnvelope['request']> = {},
    auth: string | null = `Bearer ${this.token}`,
  ): GatewayEnvelope {
    rpcId += 1;
    return {
      request: {
        method: 'POST',
        path: A2A_RPC_PATH,
        query: '',
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, ...(params === undefined ? {} : { params }) }),
        version: '1.0',
        ...over,
      },
      client_auth: auth === null ? {} : { authorization: auth },
    };
  }

  message(data: Record<string, unknown>, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      message: { messageId: `m-${rpcId + 1}`, role: 'ROLE_USER', parts: [{ data }], ...over },
    };
  }

  call(data: Record<string, unknown>, over: Record<string, unknown> = {}) {
    return ingressSendMessage(this.rt, this.request('SendMessage', this.message(data, over)));
  }

  opOf(externalId: string): A2ATaskRow {
    const op = this.world.store.getTaskByExternal('inbound', `a2a:${this.clientId}`, externalId);
    if (op === null) throw new Error(`no operation ${externalId}`);
    return op;
  }

  /** The operation's current workflow child (execution or review card). */
  childOf(externalId: string): WorkflowTask {
    const id = this.opOf(externalId).internal_id;
    const child = id === null ? null : this.world.workflow.store().getById(id);
    if (child === null) throw new Error(`no child for ${externalId}`);
    return child;
  }

  /**
   * Claim the call's child as its runner's claim path does: take it from the
   * lane, then pass the effect boundary (`admitInboundClaimWith`).
   */
  claimChild(externalId: string, leaseMs = 60_000): { verdict: string; taskId: string } {
    const op = this.opOf(externalId);
    const claimed = this.world.repo.claimDelegationTask(this.runnerDid, this.world.clock, leaseMs, 'transit');
    if (claimed === null || claimed.id !== op.internal_id) throw new Error('claim');
    return { verdict: admitInboundClaimWith(this.rt, claimed, this.runnerDid), taskId: claimed.id };
  }

  /** Run the child as its runner would: claim, pass the boundary, complete it with `result`. */
  runChild(externalId: string, result: unknown): void {
    const { verdict, taskId } = this.claimChild(externalId);
    if (verdict !== 'admitted') throw new Error(`claim ${verdict}`);
    this.world.workflow.complete(taskId, JSON.stringify(result), 'done', this.runnerDid);
  }
}
