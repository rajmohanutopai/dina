/**
 * Service-workflow bridge — composition over `service_handler`.
 *
 * `service_handler.handleInboundQuery` is the pure decision half:
 * given an inbound D2D query, produce an action (respond / delegate
 * / review / reject). This module is the IO orchestrator that:
 *
 *   1. Calls the handler on an inbound envelope.
 *   2. For `respond` actions: ships the canned body on D2D.
 *   3. For `delegate` / `review` actions: records the `queryId` →
 *      `taskId` correlation + creates the delegation task; when
 *      that task later completes, builds a `service.response` body
 *      from the result and ships it on D2D.
 *   4. For `reject` actions: ships the error body on D2D.
 *
 * **Correlation store** is in-memory by default — persistence is a
 * separate concern (Core's workflow table would back it in production).
 * The bridge exposes a `pendingCount()` introspection for admin UI.
 *
 * **Result validation** on task completion: the bridge optionally
 * validates the task result against the capability's result schema
 * before shipping. Invalid result → sends an `error` response
 * (`provider_result_invalid`). This mirrors the plan in docs/HOME_NODE_LITE_TASKS.md
 * — "provider validates OpenClaw's result against published result
 * schema".
 *
 * **Never throws** — every outcome is a tagged `BridgeOutcome`.
 * Wire-level errors surface as `io_error` with the stage that failed.
 */

import {
  handleInboundQuery,
  validateParams,
  type CapabilityParamSchema,
  type HandlerAction,
  type InboundQuery,
  type ServiceHandlerConfig,
} from './service_handler';

export interface ResponseEnvelope {
  queryId: string;
  status: 'success' | 'error';
  result?: Record<string, unknown>;
  error?: string;
  detail?: string;
}

export interface TaskCompletionInput {
  /** The delegation task id previously assigned. */
  taskId: string;
  /** Whether the task succeeded. */
  ok: boolean;
  /** Structured result (success path). */
  result?: Record<string, unknown>;
  /** Error string (failure path). */
  error?: string;
}

export interface PendingCorrelation {
  taskId: string;
  queryId: string;
  fromDid: string;
  capability: string;
  receivedAt: number;
  kind: 'auto_delegation' | 'review_pending_approval';
}

export type BridgeOutcome =
  | { kind: 'responded'; queryId: string; via: 'canned' | 'reject' | 'task_result' | 'task_error' }
  | { kind: 'pending'; taskId: string; queryId: string }
  | { kind: 'unknown_task'; taskId: string }
  | { kind: 'io_error'; stage: 'create_task' | 'send_response'; error: string };

export type BridgeEvent =
  | { kind: 'inbound_decided'; action: HandlerAction['action']; queryId: string }
  | {
      kind: 'task_enqueued';
      taskId: string;
      queryId: string;
      taskKind: 'auto_delegation' | 'review_pending_approval';
    }
  | { kind: 'task_completed'; taskId: string; ok: boolean }
  | { kind: 'response_sent'; queryId: string; status: 'success' | 'error' };

export interface ServiceWorkflowBridgeIO {
  /** Create the delegation task in Core's workflow store. */
  createTaskFn: (
    spec: { taskId: string; queryId: string; fromDid: string; capability: string; params: Record<string, unknown>; kind: 'auto_delegation' | 'review_pending_approval' },
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Send a D2D response envelope back to `toDid`. */
  sendResponseFn: (
    input: { toDid: string; body: ResponseEnvelope },
  ) => Promise<{ ok: boolean; error?: string }>;
}

export interface ServiceWorkflowBridgeOptions {
  handlerConfig: ServiceHandlerConfig;
  io: ServiceWorkflowBridgeIO;
  /**
   * Optional per-capability RESULT schemas. When present, the bridge
   * validates task results before shipping them — prevents a rogue
   * executor from sending arbitrary data to the requester.
   */
  resultSchemas?: Readonly<Record<string, CapabilityParamSchema>>;
  onEvent?: (event: BridgeEvent) => void;
}

/**
 * Compose handler + IO into a bridge. Exposes two entry points:
 *
 *   - `onInboundQuery(query)` — Brain calls this when a D2D
 *     `service.query` arrives.
 *   - `onTaskCompleted(taskId, result)` — Brain calls this when an
 *     OpenClaw task previously enqueued by the bridge resolves.
 */
export class ServiceWorkflowBridge {
  private readonly handlerConfig: ServiceHandlerConfig;
  private readonly io: ServiceWorkflowBridgeIO;
  private readonly resultSchemas: Readonly<Record<string, CapabilityParamSchema>>;
  private readonly onEvent?: (event: BridgeEvent) => void;
  private readonly pending = new Map<string, PendingCorrelation>();

  constructor(opts: ServiceWorkflowBridgeOptions) {
    if (!opts?.handlerConfig) throw new TypeError('handlerConfig required');
    if (!opts.io || typeof opts.io.createTaskFn !== 'function' || typeof opts.io.sendResponseFn !== 'function') {
      throw new TypeError('io.createTaskFn and io.sendResponseFn required');
    }
    this.handlerConfig = opts.handlerConfig;
    this.io = opts.io;
    this.resultSchemas = opts.resultSchemas ?? {};
    this.onEvent = opts.onEvent;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  async onInboundQuery(query: InboundQuery): Promise<BridgeOutcome> {
    const action = handleInboundQuery(query, this.handlerConfig);
    this.onEvent?.({
      kind: 'inbound_decided',
      action: action.action,
      queryId: typeof query?.queryId === 'string' ? query.queryId : '',
    });

    if (action.action === 'respond') {
      // `handleInboundQuery` always builds the respond-body as
      // `{queryId, status: 'success', result}` — the `ResponseEnvelope`
      // shape. Cast narrows the handler's looser `Record<string,
      // unknown>` return type without runtime cost.
      return this.ship(query.fromDid, action.body as unknown as ResponseEnvelope, 'canned');
    }

    if (action.action === 'reject') {
      return this.ship(query.fromDid, action.body, 'reject');
    }

    // delegate OR review
    const taskSpec = action.taskSpec;
    try {
      const create = await this.io.createTaskFn({
        taskId: taskSpec.suggestedTaskId,
        queryId: taskSpec.queryId,
        fromDid: taskSpec.fromDid,
        capability: taskSpec.capability,
        params: taskSpec.params,
        kind: taskSpec.kind,
      });
      if (!create.ok) {
        return { kind: 'io_error', stage: 'create_task', error: create.error ?? 'createTask failed' };
      }
    } catch (err) {
      return { kind: 'io_error', stage: 'create_task', error: extractMessage(err) };
    }

    this.pending.set(taskSpec.suggestedTaskId, {
      taskId: taskSpec.suggestedTaskId,
      queryId: taskSpec.queryId,
      fromDid: taskSpec.fromDid,
      capability: taskSpec.capability,
      receivedAt: taskSpec.receivedAt,
      kind: taskSpec.kind,
    });
    this.onEvent?.({
      kind: 'task_enqueued',
      taskId: taskSpec.suggestedTaskId,
      queryId: taskSpec.queryId,
      taskKind: taskSpec.kind,
    });
    return { kind: 'pending', taskId: taskSpec.suggestedTaskId, queryId: taskSpec.queryId };
  }

  async onTaskCompleted(completion: TaskCompletionInput): Promise<BridgeOutcome> {
    const correlation = this.pending.get(completion.taskId);
    if (!correlation) {
      return { kind: 'unknown_task', taskId: completion.taskId };
    }
    this.onEvent?.({ kind: 'task_completed', taskId: completion.taskId, ok: completion.ok });
    this.pending.delete(completion.taskId);

    if (!completion.ok) {
      const body: ResponseEnvelope = {
        queryId: correlation.queryId,
        status: 'error',
        error: completion.error ?? 'task_failed',
      };
      return this.ship(correlation.fromDid, body, 'task_error');
    }

    const result = completion.result ?? {};
    const schema = this.resultSchemas[correlation.capability];
    if (schema) {
      const errors = validateParams(result, schema);
      if (errors.length > 0) {
        const body: ResponseEnvelope = {
          queryId: correlation.queryId,
          status: 'error',
          error: 'provider_result_invalid',
          detail: errors.join('; '),
        };
        return this.ship(correlation.fromDid, body, 'task_error');
      }
    }

    const body: ResponseEnvelope = {
      queryId: correlation.queryId,
      status: 'success',
      result,
    };
    return this.ship(correlation.fromDid, body, 'task_result');
  }

  /** Read-only snapshot of pending correlations — admin/debug. */
  listPending(): PendingCorrelation[] {
    return Array.from(this.pending.values()).map((c) => ({ ...c }));
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async ship(
    toDid: string,
    body: ResponseEnvelope,
    via: Extract<BridgeOutcome, { kind: 'responded' }>['via'],
  ): Promise<BridgeOutcome> {
    try {
      const send = await this.io.sendResponseFn({ toDid, body });
      if (!send.ok) {
        return { kind: 'io_error', stage: 'send_response', error: send.error ?? 'send failed' };
      }
    } catch (err) {
      return { kind: 'io_error', stage: 'send_response', error: extractMessage(err) };
    }
    this.onEvent?.({ kind: 'response_sent', queryId: body.queryId, status: body.status });
    return { kind: 'responded', queryId: body.queryId, via };
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function extractMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
