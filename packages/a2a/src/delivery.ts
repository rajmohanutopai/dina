/**
 * Task-event delivery between Core and the gateway (design §7.5): the wire
 * both sides share, and the checks each side runs on what the other sends.
 *
 * Core records each change a client could see as one event per target (the
 * task's streams, and each webhook its client configured) in a durable
 * outbox. The gateway claims due events under a lease, writes them to its
 * streams or POSTs them to webhooks, then reports each one. Core re-checks
 * the client's authority at every claim and hands a webhook's address and
 * credentials over only then.
 *
 * Every event is a `StreamResponse` (A2A §3.2.3) with exactly one of
 * `statusUpdate` or `artifactUpdate`: a stream opens with the Task Core
 * answered, so later events are updates (A2A §3.1.2), and a webhook takes
 * the same payload (A2A §4.3.3).
 */

import { isPlainObject, type JsonObject } from './json';
import { TERMINAL_TASK_STATES, type TaskState } from './types';

export type DeliveryTarget = 'sse' | 'webhook';

export interface DeliveryWebhook {
  url: string;
  /** `authorization` and `x-a2a-notification-token`, as the client configured them. */
  headers: Record<string, string>;
}

interface DeliveryItemBase {
  id: number;
  claim_id: string;
  /** The A2A task id the event is about. */
  task_id: string;
  /** The event's place in its task's sequence (1, 2, …). */
  seq: number;
  event: JsonObject;
}

/** An event for the task's streams. */
export interface StreamDeliveryItem extends DeliveryItemBase {
  target: 'sse';
  /**
   * The client's credential generation when the event was claimed. A stream
   * opened under an earlier one ends instead of getting it
   * (`A2A_CREDENTIAL_GEN_HEADER`).
   */
  credential_gen: number;
}

/** An event for one webhook the client configured. */
export interface WebhookDeliveryItem extends DeliveryItemBase {
  target: 'webhook';
  webhook: DeliveryWebhook;
}

export type DeliveryItem = StreamDeliveryItem | WebhookDeliveryItem;

/**
 * A client whose credential ended lately (design §10): every stream of its
 * (`A2A_STREAM_CLIENT_HEADER`) opened under a generation before
 * `before_gen` must end, and none may open.
 */
export interface StreamFence {
  client: string;
  before_gen: number;
}

export interface DeliveryClaim {
  items: DeliveryItem[];
  /**
   * Tasks whose streams must end now, with nothing more sent: the client's
   * authority went (design §7.3). The client learns the outcome from GetTask.
   */
  closed: string[];
  /**
   * The clients whose credential ended lately (design §10), each with the
   * generation its streams must have reached. Core sends the same fences
   * in every claim for `A2A_STREAM_FENCE_HOLD_MS` after a credential ends,
   * so a claim answer lost on its way, or a stream whose opening answer
   * was still on its way, never escapes one. The gateway applies them
   * before this claim's events, and refuses an older stream that opens
   * later; a stream the client opened under its new credential stays.
   */
  fenced: StreamFence[];
}

/**
 * What became of one claimed event: `delivered`; `retry` (a webhook that
 * failed in a way worth trying again — Core decides when, and when to stop);
 * `failed` (a webhook that refused, or a destination the policy refuses).
 */
export type DeliveryOutcome = 'delivered' | 'retry' | 'failed';
export const DELIVERY_OUTCOMES: readonly DeliveryOutcome[] = ['delivered', 'retry', 'failed'];

export interface DeliveryAck {
  id: number;
  claim_id: string;
  outcome: DeliveryOutcome;
}

/**
 * How long Core repeats a client's fence in every claim after one of its
 * credentials ends: longer than any streaming call can take to reach the
 * gateway (its forward times out well inside this), so no older stream
 * registers after the gateway last heard the fence.
 */
export const A2A_STREAM_FENCE_HOLD_MS = 5 * 60 * 1000;

export const DELIVERY_LIMITS = Object.freeze({
  /** Events one claim may take. */
  maxClaim: 100,
  /** Reports one ack may carry. */
  maxAcks: 200,
});

const CLAIM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isGen = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Core reads the gateway's report with this; anything malformed refuses the whole ack. */
export function parseDeliveryAcks(value: unknown): DeliveryAck[] | null {
  if (
    !isPlainObject(value) ||
    !Array.isArray(value.acks) ||
    value.acks.length > DELIVERY_LIMITS.maxAcks
  )
    return null;
  const out: DeliveryAck[] = [];
  for (const raw of value.acks) {
    if (
      !isPlainObject(raw) ||
      !isId(raw.id) ||
      typeof raw.claim_id !== 'string' ||
      !CLAIM_ID_RE.test(raw.claim_id)
    ) {
      return null;
    }
    if (!DELIVERY_OUTCOMES.includes(raw.outcome as DeliveryOutcome)) return null;
    out.push({ id: raw.id, claim_id: raw.claim_id, outcome: raw.outcome as DeliveryOutcome });
  }
  return out;
}

/** The task state an event reports, or null for an artifact update. */
export function eventTaskState(event: JsonObject): TaskState | null {
  const update = event.statusUpdate;
  if (!isPlainObject(update) || !isPlainObject(update.status)) return null;
  return typeof update.status.state === 'string' ? (update.status.state as TaskState) : null;
}

/**
 * The states a stream ends at (A2A §3.1.2): a terminal one, or an
 * interrupted one, where the task waits on the client (an answer for
 * INPUT_REQUIRED, design §7.7). The reference SDK ends its streams at
 * INPUT_REQUIRED too; the client's answer opens the next stream.
 */
export const STREAM_ENDING_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  ...TERMINAL_TASK_STATES,
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
]);

/** Whether a stream ends after this event: its task reached a terminal or interrupted state. */
export function endsStream(event: JsonObject): boolean {
  const state = eventTaskState(event);
  return state !== null && STREAM_ENDING_TASK_STATES.has(state);
}

function parseItem(raw: unknown): DeliveryItem | null {
  if (
    !isPlainObject(raw) ||
    !isId(raw.id) ||
    typeof raw.claim_id !== 'string' ||
    !CLAIM_ID_RE.test(raw.claim_id)
  ) {
    return null;
  }
  if (raw.target !== 'sse' && raw.target !== 'webhook') return null;
  if (
    typeof raw.task_id !== 'string' ||
    raw.task_id === '' ||
    !isId(raw.seq) ||
    !isPlainObject(raw.event)
  )
    return null;
  const event = raw.event;
  const kinds = ['statusUpdate', 'artifactUpdate'].filter((k) => isPlainObject(event[k]));
  if (kinds.length !== 1 || Object.keys(event).length !== 1) return null;
  // Parsed from JSON text, so every value in it is JSON.
  const base = { id: raw.id, claim_id: raw.claim_id, task_id: raw.task_id, seq: raw.seq, event: event as JsonObject };
  if (raw.target === 'sse') {
    if (raw.webhook !== undefined || !isGen(raw.credential_gen)) return null;
    return { ...base, target: 'sse', credential_gen: raw.credential_gen };
  }
  const hook = raw.webhook;
  if (raw.credential_gen !== undefined || !isPlainObject(hook) || typeof hook.url !== 'string' || !isPlainObject(hook.headers))
    return null;
  const headers: Record<string, string> = {};
  for (const [name, v] of Object.entries(hook.headers)) {
    if (typeof v !== 'string') return null;
    headers[name] = v;
  }
  return { ...base, target: 'webhook', webhook: { url: hook.url, headers } };
}

const STREAM_CLIENT_RE = /^[0-9a-f]{32}$/;

function parseFence(raw: unknown): StreamFence | null {
  if (!isPlainObject(raw) || typeof raw.client !== 'string' || !STREAM_CLIENT_RE.test(raw.client) || !isId(raw.before_gen)) return null;
  return { client: raw.client, before_gen: raw.before_gen };
}

/** Whether `value` is a stream client key as Core makes one (`A2A_STREAM_CLIENT_HEADER`). */
export function isStreamClientKey(value: unknown): value is string {
  return typeof value === 'string' && STREAM_CLIENT_RE.test(value);
}

/** The gateway reads Core's claim answer with this; a malformed answer is dropped whole. */
export function parseDeliveryClaim(value: unknown): DeliveryClaim | null {
  if (
    !isPlainObject(value) ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.closed) ||
    !Array.isArray(value.fenced)
  )
    return null;
  const items: DeliveryItem[] = [];
  for (const raw of value.items) {
    const item = parseItem(raw);
    if (item === null) return null;
    items.push(item);
  }
  if (!value.closed.every((t): t is string => typeof t === 'string' && t !== '')) return null;
  const fenced: StreamFence[] = [];
  for (const raw of value.fenced) {
    const fence = parseFence(raw);
    if (fence === null) return null;
    fenced.push(fence);
  }
  return { items, closed: [...value.closed], fenced };
}
