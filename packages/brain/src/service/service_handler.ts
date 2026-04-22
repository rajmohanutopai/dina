/**
 * Provider-side handler for inbound `service.query`.
 *
 * Never invokes a capability directly — delegates to Core's workflow
 * subsystem via `createWorkflowTask`. The Response Bridge emits the
 * actual `service.response` when the delegation task completes.
 *
 * Response-policy branches:
 *   - `auto`:   create a `delegation` task (state=`queued`) for an agent
 *               to claim and execute.
 *   - `review`: create an `approval` task (state=`pending_approval`) and
 *               fire the operator notifier. `executeAndRespond(id, payload)`
 *               is the post-`/service_approve` entry point; it spawns a
 *               fresh delegation task (idempotent via deterministic id)
 *               and cancels the approval task.
 *
 * Never calls MCP tools itself — "Dina never executes." The execution
 * plane (OpenClaw / MCP runner, via paired dina-agent) picks up
 * delegation tasks from Core's `/v1/workflow/tasks/claim` endpoint.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { WorkflowConflictError, type BrainCoreClient } from '../core_client/http';
import type {
  ServiceConfig,
  ServiceCapabilityConfig,
  ServiceQueryBody,
} from '@dina/protocol';
import { validateServiceQueryBody } from '@dina/protocol';
import { getCapability, getTTL } from './capabilities/registry';
import { validateAgainstSchema } from './capabilities/schema_validator';

/** Minimal subset of `BrainCoreClient` the handler needs. */
export interface ServiceHandlerCoreClient extends Pick<
  BrainCoreClient,
  'createWorkflowTask' | 'cancelWorkflowTask' | 'sendServiceRespond'
> {}

/**
 * Frozen copy of a capability's published schema at task-creation time.
 * Embedded in the task payload so the Response Bridge can validate
 * the runner's output against the exact contract that was agreed when
 * the query was accepted — not whatever the live config says at
 * completion time.
 *
 * GAP-WIRE-01: field names are snake_case to match main-dina's
 * `schema_snapshot` shape (`service_handler.py`), so a snapshot
 * persisted by one runtime can be validated by the other.
 */
export interface SchemaSnapshot {
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  schema_hash: string;
}

/** Operator-notification sink for review-policy approval tasks. */
export type ApprovalNotifier = (notice: {
  taskId: string;
  fromDID: string;
  capability: string;
  serviceName: string;
  approveCommand: string;
}) => void | Promise<void>;

/**
 * Callback that sends an ad-hoc `service.response` D2D envelope. Used by
 * `ServiceHandler.sendError` when a query fails BEFORE any workflow
 * task exists (unknown capability, schema mismatch, bad params). Issue
 * #9 — without this, requesters sit waiting until their TTL expires.
 *
 * The callback is expected to sign + seal + relay to `recipientDID`.
 * In production it wraps Core's `sendD2D` with the service.response
 * type bound. Tests pass a spy.
 */
export type ServiceRejectResponder = (
  recipientDID: string,
  body: {
    query_id: string;
    capability: string;
    status: 'unavailable' | 'error';
    error: string;
    ttl_seconds: number;
  },
) => Promise<void>;

export interface ServiceHandlerOptions {
  coreClient: ServiceHandlerCoreClient;
  /**
   * Returns the *current* ServiceConfig. Read lazily on every inbound
   * query so config updates via `onServiceConfigChanged` take effect
   * without rewiring the handler.
   */
  readConfig: () => ServiceConfig | null;
  /**
   * Optional: fires when an approval task is created. Wire to Telegram /
   * chat / push notifications. No-op when absent.
   */
  notifier?: ApprovalNotifier;
  /**
   * Optional: sends a `service.response` D2D when the handler rejects
   * an inbound query before a workflow task is created. When absent the
   * handler only logs the rejection; the requester waits out its TTL.
   * Supplying this closes the loop with an immediate error notification.
   */
  rejectResponder?: ServiceRejectResponder;
  /** Structured log sink. Defaults to no-op. */
  logger?: (entry: Record<string, unknown>) => void;
  /** Wall-clock source (seconds). Defaults to `Math.floor(Date.now()/1000)`. */
  nowSecFn?: () => number;
  /** Random id generator for new delegation/approval tasks. Testable. */
  generateUUID?: () => string;
}

/**
 * Handles one inbound `service.query` per call. Stateless.
 */
export class ServiceHandler {
  private readonly core: ServiceHandlerCoreClient;
  private readonly readConfig: () => ServiceConfig | null;
  private readonly notifier: ApprovalNotifier | null;
  private readonly rejectResponder: ServiceRejectResponder | null;
  private readonly log: (entry: Record<string, unknown>) => void;
  private readonly nowSecFn: () => number;
  private readonly generateUUID: () => string;

  constructor(options: ServiceHandlerOptions) {
    if (!options.coreClient) throw new Error('ServiceHandler: coreClient is required');
    if (!options.readConfig) throw new Error('ServiceHandler: readConfig is required');
    this.core = options.coreClient;
    this.readConfig = options.readConfig;
    this.notifier = options.notifier ?? null;
    this.rejectResponder = options.rejectResponder ?? null;
    this.log =
      options.logger ??
      (() => {
        /* no-op */
      });
    this.nowSecFn = options.nowSecFn ?? (() => Math.floor(Date.now() / 1000));
    this.generateUUID = options.generateUUID ?? (() => bytesToHex(randomBytes(16)));
  }

  /**
   * Top-level entry for inbound `service.query` D2D. Dispatches on the
   * capability's configured response policy:
   *   - `auto` → create a delegation task now.
   *   - `review` → create an approval task + notify operator.
   *
   * Never throws. Validation / config / schema errors produce an error
   * `service.response` via `sendServiceRespond` so the requester's TTL
   * doesn't silently elapse.
   */
  async handleQuery(fromDID: string, body: unknown): Promise<void> {
    const bodyErr = validateServiceQueryBody(body);
    if (bodyErr !== null) {
      this.log({ event: 'service.query.invalid_body', from: fromDID, error: bodyErr });
      return;
    }
    const query = body as ServiceQueryBody;
    this.log({
      event: 'service.query.received',
      from: fromDID,
      capability: query.capability,
      query_id: query.query_id,
      ttl_seconds: query.ttl_seconds,
    });

    const config = this.readConfig();
    const cap = findCapabilityConfig(config, query.capability);
    if (cap === null) {
      await this.sendError(fromDID, query, 'unavailable', 'capability_not_configured');
      return;
    }

    const schemaErr = this.checkSchemaHash(config, query);
    if (schemaErr !== null) {
      await this.sendError(fromDID, query, 'error', schemaErr);
      return;
    }

    const paramsErr = this.validateParams(config, query);
    if (paramsErr !== null) {
      await this.sendError(fromDID, query, 'error', paramsErr);
      return;
    }

    // WM-BRAIN-06b: strip params down to the published schema's declared
    // properties BEFORE the params land in a task payload. Defense in
    // depth: even if the published JSON-Schema forgot
    // `additionalProperties: false`, undeclared keys never reach the
    // provider. The stripped query is forwarded to the downstream
    // create-task helpers.
    const strippedQuery = this.stripUndeclaredParams(config, query);

    if (cap.responsePolicy === 'review') {
      await this.createApprovalTask(fromDID, strippedQuery, cap);
      return;
    }
    await this.createExecutionTask(fromDID, strippedQuery, cap);
  }

  /**
   * Called by Guardian when a `workflow.approved` event fires for an
   * approval task. Spawns a FRESH delegation task with a deterministic id
   * so retries are idempotent, then cancels the approval task.
   */
  async executeAndRespond(
    approvalTaskId: string,
    payload: {
      from_did: string;
      query_id: string;
      capability: string;
      params: unknown;
      ttl_seconds?: number;
      schema_hash?: string;
      service_name?: string;
      /** WM-BRAIN-06a: forwarded from the approval task payload. */
      mcp_tool?: string;
      /** GAP-SH-04: frozen schema block captured at approval-creation
       *  time. Forwarded verbatim into the fresh delegation so the
       *  response bridge validates against the same contract that was
       *  agreed when the operator approved. */
      schema_snapshot?: SchemaSnapshot;
    },
  ): Promise<void> {
    if (!payload.from_did || !payload.query_id || !payload.capability) {
      throw new Error(`executeAndRespond: approval task ${approvalTaskId} has incomplete payload`);
    }
    const execTaskId = `svc-exec-from-${approvalTaskId}`;
    const ttl =
      typeof payload.ttl_seconds === 'number' && payload.ttl_seconds > 0
        ? payload.ttl_seconds
        : getTTL(payload.capability);

    try {
      await this.createExecutionTaskRaw({
        fromDID: payload.from_did,
        queryId: payload.query_id,
        capability: payload.capability,
        params: payload.params,
        ttlSeconds: ttl,
        schemaHash: payload.schema_hash,
        mcpTool: payload.mcp_tool,
        serviceName: payload.service_name,
        schemaSnapshot: payload.schema_snapshot,
        taskId: execTaskId,
      });
    } catch (err) {
      if (err instanceof WorkflowConflictError) {
        // Previous attempt already created it — keep going so we still
        // cancel the approval task.
        this.log({
          event: 'service.query.execute_exists',
          approval_task_id: approvalTaskId,
          exec_task_id: execTaskId,
        });
      } else {
        throw err;
      }
    }

    try {
      await this.core.cancelWorkflowTask(approvalTaskId, 'executed_via_delegation');
    } catch (err) {
      // Tolerate "already terminal" / 404. Approval task cleanup is
      // best-effort because the delegation is what actually resolves the
      // query.
      this.log({
        event: 'service.query.approval_cancel_failed',
        approval_task_id: approvalTaskId,
        error: (err as Error).message ?? String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async createExecutionTask(
    fromDID: string,
    query: ServiceQueryBody,
    cap: ServiceCapabilityConfig,
  ): Promise<void> {
    const taskId = `svc-exec-${this.generateUUID()}`;
    const config = this.readConfig();
    await this.createExecutionTaskRaw({
      fromDID,
      queryId: query.query_id,
      capability: query.capability,
      params: query.params,
      ttlSeconds: query.ttl_seconds,
      schemaHash: query.schema_hash,
      mcpTool: cap.mcpTool,
      serviceName: config?.name ?? '',
      schemaSnapshot: snapshotForCapability(config, query.capability),
      taskId,
    });
  }

  /**
   * Shared: build the payload + call `createWorkflowTask`. Used by both
   * the auto path and `executeAndRespond`.
   */
  private async createExecutionTaskRaw(args: {
    fromDID: string;
    queryId: string;
    capability: string;
    params: unknown;
    ttlSeconds: number;
    schemaHash?: string;
    /** MCP tool routing key — kept out of the published schema snapshot
     *  so the canonical schema stays portable; surfaced here as a
     *  top-level payload field (WM-BRAIN-06a). */
    mcpTool?: string;
    serviceName?: string;
    /** GAP-SH-03: frozen copy of the provider's published schema at
     *  task-creation time. The response bridge validates the runner's
     *  output against this snapshot (not the live config) so a config
     *  flip between dispatch + complete can't smuggle a drifted
     *  contract past the requester. */
    schemaSnapshot?: SchemaSnapshot;
    taskId: string;
  }): Promise<void> {
    const payload: Record<string, unknown> = {
      type: 'service_query_execution',
      from_did: args.fromDID,
      query_id: args.queryId,
      capability: args.capability,
      params: args.params,
      ttl_seconds: args.ttlSeconds,
      service_name: args.serviceName ?? '',
      schema_hash: args.schemaHash ?? '',
      mcp_tool: args.mcpTool ?? '',
    };
    if (args.schemaSnapshot !== undefined) {
      payload.schema_snapshot = args.schemaSnapshot;
    }
    const expiresAtSec = this.nowSecFn() + args.ttlSeconds;
    await this.core.createWorkflowTask({
      id: args.taskId,
      kind: 'delegation',
      description: `Execute service query: ${args.capability}`,
      payload: JSON.stringify(payload),
      origin: 'd2d',
      correlationId: args.queryId,
      expiresAtSec,
      // Tasks enter `queued` so paired dina-agents can claim them via
      // POST /v1/workflow/tasks/claim. In-process execution is not
      // supported for delegation — the agent model requires an
      // out-of-process runner for lease recovery + heartbeat semantics.
      initialState: 'queued',
    });
    this.log({
      event: 'service.query.execution_created',
      task_id: args.taskId,
      capability: args.capability,
      query_id: args.queryId,
    });
  }

  private async createApprovalTask(
    fromDID: string,
    query: ServiceQueryBody,
    cap: ServiceCapabilityConfig,
  ): Promise<void> {
    const taskId = `approval-${this.generateUUID()}`;
    const ttl = query.ttl_seconds > 0 ? query.ttl_seconds : getTTL(query.capability);
    const config = this.readConfig();
    const serviceName = config?.name ?? '';
    const snapshot = snapshotForCapability(config, query.capability);
    const payload: Record<string, unknown> = {
      type: 'service_query_execution',
      from_did: fromDID,
      query_id: query.query_id,
      capability: query.capability,
      params: query.params,
      ttl_seconds: ttl,
      service_name: serviceName,
      schema_hash: query.schema_hash ?? '',
      // WM-BRAIN-06a: mcp_tool at top level, outside the schema snapshot.
      // `executeAndRespond` reads this back to dispatch the delegation.
      mcp_tool: cap.mcpTool,
    };
    // GAP-SH-04: approval-path payload also carries the schema snapshot
    // so it survives the approval → delegation handoff in
    // `executeAndRespond`.
    if (snapshot !== undefined) {
      payload.schema_snapshot = snapshot;
    }
    await this.core.createWorkflowTask({
      id: taskId,
      kind: 'approval',
      description: `Service review: ${query.capability} from ${fromDID}`,
      payload: JSON.stringify(payload),
      origin: 'd2d',
      correlationId: query.query_id,
      expiresAtSec: this.nowSecFn() + ttl,
      // Seed directly into `pending_approval` so the operator's approve
      // command (pending_approval → queued) or the reconciler's expiry
      // (pending_approval → cancelled/failed) can fire without an extra
      // transition. The server validates against `isValidInitialState`.
      initialState: 'pending_approval',
    });
    this.log({
      event: 'service.query.approval_created',
      task_id: taskId,
      capability: query.capability,
      query_id: query.query_id,
    });
    if (this.notifier !== null) {
      try {
        await this.notifier({
          taskId,
          fromDID,
          capability: query.capability,
          serviceName,
          approveCommand: `/service_approve ${taskId}`,
        });
      } catch (err) {
        this.log({
          event: 'service.query.notifier_threw',
          task_id: taskId,
          error: (err as Error).message ?? String(err),
        });
      }
    }
  }

  private async sendError(
    fromDID: string,
    query: ServiceQueryBody,
    status: 'unavailable' | 'error',
    message: string,
  ): Promise<void> {
    // No workflow task exists yet (handleQuery rejected pre-create), so
    // we can't use `sendServiceRespond` which routes through the
    // delegation-lifecycle endpoint. Instead, send a task-less D2D
    // envelope via the injected `rejectResponder`. Issue #9.
    this.log({
      event: 'service.query.rejected',
      from: fromDID,
      query_id: query.query_id,
      capability: query.capability,
      status,
      message,
    });
    if (this.rejectResponder === null) return;
    try {
      await this.rejectResponder(fromDID, {
        query_id: query.query_id,
        capability: query.capability,
        status,
        error: message,
        ttl_seconds: query.ttl_seconds,
      });
    } catch (err) {
      // The response is best-effort. Log the failure so operators see
      // stuck rejections but never throw — handleQuery contract
      // guarantees no throw on the inbound dispatch path.
      this.log({
        event: 'service.query.reject_send_failed',
        from: fromDID,
        query_id: query.query_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Match the provider's advertised schema hash against what the
   * requester pinned. Rules (GAP-SH-01, matches main-dina):
   *   - No published schema  → pass (provider can't commit what it hasn't advertised).
   *   - Published schema present but `schemaHash` empty → pass (legacy).
   *   - Requester MUST supply a non-empty `schema_hash` once the provider
   *     publishes one — missing / empty is rejected as `schema_hash_required`.
   *     Without this, a stale requester could bypass version safety.
   *   - Mismatch → `schema_version_mismatch`.
   */
  private checkSchemaHash(config: ServiceConfig | null, query: ServiceQueryBody): string | null {
    if (config === null) return null;
    const published = config.capabilitySchemas?.[query.capability];
    if (published === undefined) return null;
    if (published.schemaHash === '') return null;
    if (query.schema_hash === undefined || query.schema_hash === '') {
      return 'schema_hash_required';
    }
    if (published.schemaHash === query.schema_hash) return null;
    return 'schema_version_mismatch';
  }

  /**
   * Validate params against the PUBLISHED JSON Schema when the provider
   * advertises one (GAP-SH-02, matches main-dina). Falls back to the
   * hard-coded capability registry validator only when no schema is
   * published. This pins validation to the exact contract the requester
   * sees on AppView rather than a separately-maintained registry.
   */
  private validateParams(config: ServiceConfig | null, query: ServiceQueryBody): string | null {
    const published = config?.capabilitySchemas?.[query.capability];
    if (
      published !== undefined &&
      typeof published.params === 'object' &&
      published.params !== null
    ) {
      return validateAgainstSchema(query.params, published.params);
    }
    const registered = getCapability(query.capability);
    if (registered === undefined) return null;
    return registered.validateParams(query.params);
  }

  /**
   * Strip `query.params` to only the keys declared in the published
   * schema's `params.properties`. Returns a NEW `query` with the
   * filtered params; leaves the input untouched. Dropped keys are
   * emitted via `service.query.params_stripped` so operators can see
   * clients advertising unknown fields.
   *
   * No published schema, or params not a plain object → pass through
   * unchanged. An empty `properties` map also passes through — the
   * schema explicitly advertises "no declared params," so we have no
   * whitelist to filter against.
   */
  private stripUndeclaredParams(
    config: ServiceConfig | null,
    query: ServiceQueryBody,
  ): ServiceQueryBody {
    if (query.params === null || typeof query.params !== 'object' || Array.isArray(query.params)) {
      return query;
    }
    const schema = config?.capabilitySchemas?.[query.capability];
    if (schema === undefined) return query;
    const props = schema.params as { properties?: Record<string, unknown> } | undefined;
    const allowed = props?.properties;
    if (allowed === undefined || typeof allowed !== 'object') return query;
    const allowedKeys = Object.keys(allowed);
    if (allowedKeys.length === 0) return query;

    const incoming = query.params as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(incoming)) {
      if (allowedKeys.includes(k)) {
        filtered[k] = v;
      } else {
        dropped.push(k);
      }
    }
    if (dropped.length > 0) {
      this.log({
        event: 'service.query.params_stripped',
        capability: query.capability,
        query_id: query.query_id,
        dropped,
      });
    }
    return { ...query, params: filtered };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findCapabilityConfig(
  config: ServiceConfig | null,
  capability: string,
): ServiceCapabilityConfig | null {
  if (config === null) return null;
  if (!config.isDiscoverable) return null;
  return config.capabilities[capability] ?? null;
}

/**
 * Extract a plain-object snapshot of the published schema for
 * `capability`. Returns `undefined` when no schema is published — the
 * task payload then simply omits `schema_snapshot` and the response
 * bridge falls back to its legacy behaviour (pass-through without
 * result-schema validation). Exported for tests.
 */
export function snapshotForCapability(
  config: ServiceConfig | null,
  capability: string,
): SchemaSnapshot | undefined {
  const s = config?.capabilitySchemas?.[capability];
  if (s === undefined) return undefined;
  return {
    params: s.params,
    result: s.result,
    schema_hash: s.schemaHash,
  };
}
