/**
 * Webhook configs for inbound tasks (A2A §3.1.7–§3.1.10, §4.3; design §7.5,
 * §6.6): what a client may set, how its webhook is called, and the four
 * config operations.
 *
 * A config is checked when it is set, with the URL rule every outbound
 * connection follows (HTTPS, no credentials in the URL, no literal address,
 * bounded length); the address the name resolves to is checked at each
 * delivery, by the transport. A task holds at most four configs. The token
 * and credentials must be safe as header values. Configs belong to their
 * task: they go when the task is purged, and a deleted config's waiting
 * events are suppressed in the same step.
 *
 * The client's own token and credentials come back to it on Get and List
 * (A2A §3.1.8: the config's details), and leave Core otherwise only inside
 * a delivery claim.
 */

import {
  ingressRouteOf,
  isPlainObject,
  jsonRpcResult,
  type JsonValue,
  type TaskPushNotificationConfig,
} from '@dina/a2a';

import { checkOutboundUrl } from './host_transport';
import { newA2AId } from './ids';
import {
  admitIngress,
  ownedOperation,
  rpcError,
  slowDown,
  type GatewayAnswer,
  type GatewayEnvelope,
  type InboundRuntime,
} from './ingress_common';

import type { A2AStore, PushConfigRow } from './store';

export const MAX_PUSH_CONFIGS_PER_TASK = 4;
export const MAX_PUSH_TOKEN_LENGTH = 1024;
export const MAX_PUSH_CREDENTIALS_LENGTH = 4096;

/** The header A2A's reference SDKs send a config's `token` in; the spec names none (design note). */
export const A2A_NOTIFICATION_TOKEN_HEADER = 'x-a2a-notification-token';

/** An HTTP auth scheme token (RFC 9110 §11.1). */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]{0,31}$/;
/** Visible ASCII and space: nothing that could end or split a header line. */
const HEADER_SAFE_RE = /^[\x20-\x7e]+$/;

export interface PushConfigInput {
  url: string;
  token?: string;
  authentication?: { scheme: string; credentials?: string };
}

export type PushConfigCheck = { ok: true; config: PushConfigInput } | { ok: false; reason: string };

/**
 * A client's config, checked. `id`, `taskId` and an empty `tenant` are the
 * server's to fill and are ignored; a non-empty tenant is refused (Dina
 * serves no tenants).
 */
export function parsePushConfigInput(value: unknown): PushConfigCheck {
  if (!isPlainObject(value)) return { ok: false, reason: 'push_config_not_object' };
  if (value.tenant !== undefined && value.tenant !== '') return { ok: false, reason: 'tenant_unsupported' };
  if (typeof value.url !== 'string') return { ok: false, reason: 'push_url_missing' };
  const url = checkOutboundUrl(value.url);
  if (!url.ok) return { ok: false, reason: `push_url_${url.reason}` };
  const config: PushConfigInput = { url: value.url };
  if (value.token !== undefined && value.token !== '') {
    if (typeof value.token !== 'string' || value.token.length > MAX_PUSH_TOKEN_LENGTH || !HEADER_SAFE_RE.test(value.token)) {
      return { ok: false, reason: 'push_token_malformed' };
    }
    config.token = value.token;
  }
  if (value.authentication !== undefined) {
    const auth = value.authentication;
    if (!isPlainObject(auth) || typeof auth.scheme !== 'string' || !SCHEME_RE.test(auth.scheme)) {
      return { ok: false, reason: 'push_auth_malformed' };
    }
    const out: { scheme: string; credentials?: string } = { scheme: auth.scheme };
    if (auth.credentials !== undefined && auth.credentials !== '') {
      if (
        typeof auth.credentials !== 'string' ||
        auth.credentials.length > MAX_PUSH_CREDENTIALS_LENGTH ||
        !HEADER_SAFE_RE.test(auth.credentials)
      ) {
        return { ok: false, reason: 'push_auth_malformed' };
      }
      out.credentials = auth.credentials;
    }
    config.authentication = out;
  }
  return { ok: true, config };
}

function storedAuth(row: PushConfigRow): { scheme: string; credentials?: string } | null {
  if (row.auth_json === null) return null;
  try {
    return JSON.parse(row.auth_json) as { scheme: string; credentials?: string };
  } catch {
    return null;
  }
}

/** The headers a delivery to this webhook carries (A2A §4.3.3). */
export function webhookHeaders(row: PushConfigRow): Record<string, string> {
  const headers: Record<string, string> = {};
  const auth = storedAuth(row);
  if (auth !== null) {
    headers.authorization = auth.credentials === undefined ? auth.scheme : `${auth.scheme} ${auth.credentials}`;
  }
  if (row.token !== null) headers[A2A_NOTIFICATION_TOKEN_HEADER] = row.token;
  return headers;
}

/** A stored config as the client set it, with its server id and task id. */
export function pushConfigView(row: PushConfigRow, taskId: string): TaskPushNotificationConfig {
  const auth = storedAuth(row);
  return {
    id: row.id,
    taskId,
    url: row.url,
    ...(row.token === null ? {} : { token: row.token }),
    ...(auth === null ? {} : { authentication: auth }),
  };
}

/**
 * Store a checked config on a task; null when the task already holds the
 * most it may. Call inside the transaction that owns the task's change.
 */
export function addPushConfig(store: A2AStore, operationRef: number, input: PushConfigInput, nowMs: number): PushConfigRow | null {
  if (store.pushConfigsOf(operationRef).length >= MAX_PUSH_CONFIGS_PER_TASK) return null;
  const row: PushConfigRow = {
    id: newA2AId(),
    operation_ref: operationRef,
    url: input.url,
    token: input.token ?? null,
    auth_json: input.authentication === undefined ? null : JSON.stringify(input.authentication),
    created_at: nowMs,
  };
  store.insertPushConfig(row);
  return row;
}

const result = (id: Parameters<typeof jsonRpcResult>[0], value: unknown): GatewayAnswer => ({
  status: 200,
  body: jsonRpcResult(id, value as JsonValue),
});

/** `CreateTaskPushNotificationConfig`: the params are the config itself, its task named by `taskId`. */
export function ingressCreatePushConfig(rt: InboundRuntime, envelope: GatewayEnvelope, extId: string): GatewayAnswer {
  const admitted = admitIngress(rt, envelope, { template: ingressRouteOf('CreateTaskPushNotificationConfig'), params: { extId } });
  if (!admitted.ok) return admitted.answer;
  // A write: it spends the budget new calls spend.
  if (!rt.budgets.chargeMiss(admitted.principal, rt.a2a.nowMs())) return slowDown();
  const op = ownedOperation(rt, admitted.principal, admitted.params.taskId);
  if (op === null) return rpcError(admitted.id, 'taskNotFound');
  const parsed = parsePushConfigInput(admitted.params);
  if (!parsed.ok) return rpcError(admitted.id, 'invalidParams', parsed.reason);
  const row = rt.a2a.store.transaction(() => addPushConfig(rt.a2a.store, op.id, parsed.config, rt.a2a.nowMs()));
  if (row === null) return rpcError(admitted.id, 'invalidParams', 'too_many_push_configs');
  return result(admitted.id, pushConfigView(row, op.external_id));
}

/** `GetTaskPushNotificationConfig`. */
export function ingressGetPushConfig(rt: InboundRuntime, envelope: GatewayEnvelope, extId: string, configId: string): GatewayAnswer {
  const admitted = admitIngress(rt, envelope, {
    template: ingressRouteOf('GetTaskPushNotificationConfig'),
    params: { extId, configId },
  });
  if (!admitted.ok) return admitted.answer;
  if (!rt.budgets.chargeRead(admitted.principal, rt.a2a.nowMs())) return slowDown();
  const op = ownedOperation(rt, admitted.principal, admitted.params.taskId);
  const row = op === null || typeof admitted.params.id !== 'string' ? null : rt.a2a.store.getPushConfig(op.id, admitted.params.id);
  if (op === null || row === null) return rpcError(admitted.id, 'taskNotFound');
  return result(admitted.id, pushConfigView(row, op.external_id));
}

/** `ListTaskPushNotificationConfigs`: one page holds them all (at most four). */
export function ingressListPushConfigs(rt: InboundRuntime, envelope: GatewayEnvelope, extId: string): GatewayAnswer {
  const admitted = admitIngress(rt, envelope, { template: ingressRouteOf('ListTaskPushNotificationConfigs'), params: { extId } });
  if (!admitted.ok) return admitted.answer;
  if (!rt.budgets.chargeRead(admitted.principal, rt.a2a.nowMs())) return slowDown();
  const op = ownedOperation(rt, admitted.principal, admitted.params.taskId);
  if (op === null) return rpcError(admitted.id, 'taskNotFound');
  const configs = rt.a2a.store.pushConfigsOf(op.id).map((row) => pushConfigView(row, op.external_id));
  return result(admitted.id, { configs, nextPageToken: '' });
}

/** `DeleteTaskPushNotificationConfig`: idempotent (A2A §3.1.10); a config already gone is no error. */
export function ingressDeletePushConfig(rt: InboundRuntime, envelope: GatewayEnvelope, extId: string, configId: string): GatewayAnswer {
  const admitted = admitIngress(rt, envelope, {
    template: ingressRouteOf('DeleteTaskPushNotificationConfig'),
    params: { extId, configId },
  });
  if (!admitted.ok) return admitted.answer;
  if (!rt.budgets.chargeRead(admitted.principal, rt.a2a.nowMs())) return slowDown();
  const op = ownedOperation(rt, admitted.principal, admitted.params.taskId);
  const id = admitted.params.id;
  if (op === null || typeof id !== 'string') return rpcError(admitted.id, 'taskNotFound');
  rt.a2a.store.transaction(() => rt.a2a.store.deletePushConfig(op.id, id));
  // google.protobuf.Empty.
  return result(admitted.id, {});
}
