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

import { WorkflowConflictError } from '@dina/core';
import {
  validateServiceQueryBody,
  resolveCanonicalCapability,
  resolveCatalogCapability,
  getCatalogCapability,
  parseServiceListingUri,
  effectiveListingStatus,
  LOCAL_RUNNER_NAME,
  buildServiceQueryExecutionPayload,
  type ServiceResponseStatus,
} from '@dina/protocol';

import { getCapability, getTTL } from './capabilities/registry';
import { validateAgainstSchema } from './capabilities/schema_validator';
import { canonicalCapabilitySchemaHash } from './service_publisher';

import type {
  CoreClient,
  ProviderIngressSubmitter,
  ServiceReasoningSubmission,
  ServiceReasoningSubmitter,
} from '@dina/core';
import type {
  ServiceQueryExecutionPayload,
  ServiceConfig,
  ServiceCapabilityConfig,
  ServiceCapabilitySchemas,
  ServiceQueryBody,
} from '@dina/protocol';

/**
 * Resolve an inbound `capability` to the config key the provider actually
 * stored it under. SERVICES_LAUNCH_ARCHITECTURE.md Part 1, Layer 5: consumer
 * discovery hands out the CANONICAL capability, but THIS provider may have
 * configured itself under an alias (`bus_eta` vs canonical `eta_query`).
 * Core's D2D ingress (`isCapabilityConfigured`) already accepts the query on
 * a canonical match — Brain's handler must agree, else Core accepts and Brain
 * then can't find the config (`capability_not_configured`).
 *
 * Returns the EXACT key present in `keys` to look up with, or `null` when
 * nothing matches. Exact-match fast path (covers canonical-configured AND
 * out-of-registry custom keys), then canonical match (alias↔canonical).
 * Pure + synchronous — `resolveCanonicalCapability` is a local registry
 * lookup, no I/O.
 */
function resolveConfiguredKey(keys: readonly string[], capability: string): string | null {
  if (keys.includes(capability)) return capability;
  const inboundCanonical = resolveCanonicalCapability(capability);
  if (inboundCanonical === null) return null; // not in registry, no exact hit
  for (const key of keys) {
    if (resolveCanonicalCapability(key) === inboundCanonical) return key;
  }
  return null;
}

/**
 * Look up the published JSON-Schema entry for an inbound `capability`,
 * resolving alias↔canonical (Layer 5). All schema-driven paths
 * (`checkSchemaHash`, `validateParams`, `stripUndeclaredParams`,
 * `snapshotForCapability`) funnel through here so they agree on the same
 * config key Core's ingress accepted.
 */
export function lookupPublishedSchema(
  config: ServiceConfig | null,
  capability: string,
): ServiceCapabilitySchemas | undefined {
  const schemas = config?.capabilitySchemas;
  if (schemas === undefined) return undefined;
  const key = resolveConfiguredKey(Object.keys(schemas), capability);
  if (key === null) return undefined;
  return schemas[key];
}

/**
 * The 2-method slice of `CoreClient` the handler needs:
 *   - `createWorkflowTask` creates the approval task (review-policy) or
 *     the delegation task (auto-policy) that Guardian's workflow-event
 *     consumer later picks up.
 *   - `cancelWorkflowTask` is called on the approval task once the
 *     delegation has spun up — keeps the approval from sitting in
 *     `pending_approval` after the downstream work already started.
 */
export type ServiceHandlerCoreClient = Pick<
  CoreClient,
  'createWorkflowTask' | 'cancelWorkflowTask'
>;

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
  /**
   * The query's params (already schema-validated + stripped to declared
   * properties). Carried so the operator surface can render a human
   * preview ("book 4:30 PM today") instead of a bare capability name.
   * STRANGER-CONTROLLED content — render as plain text only.
   */
  params?: unknown;
}) => void | Promise<void>;

/**
 * Provider-side feedback hook fired when an inbound `service.query` is
 * accepted and a task has been created. Used by the mobile UI to post a
 * system message into the operator's chat thread so they have visible
 * evidence that an external request landed and how it was handled.
 *
 * Fires AFTER successful task creation (once per accepted query). Does
 * NOT fire on rejected queries — those already produce structured logs
 * and an error `service.response`. Errors thrown by the notifier are
 * logged and swallowed (mirrors the `ApprovalNotifier` contract).
 */
export type ServiceInboundNotifier = (notice: {
  /** Either an execution (auto-policy) or an approval (review-policy). */
  kind: 'execution' | 'approval';
  taskId: string;
  fromDID: string;
  capability: string;
  serviceName: string;
}) => void | Promise<void>;

/**
 * Callback that sends an ad-hoc `service.response` D2D envelope, for answers
 * that exist BEFORE any workflow task does.
 *
 * Two cases reach it. A query that fails early (unknown capability, schema
 * mismatch, bad params) — issue #9, without which requesters sit waiting out
 * their TTL. And, since WS-4.6, a query COMPILED CORE ANSWERED ITSELF: a
 * §12.7 reconcile is answered from Core's own records with no runner asked,
 * so there is no task to carry the result and the answer must go out here.
 *
 * `status: 'success'` carries `result`; the failure statuses carry `error`.
 * The value is `success` and not `ok` because the WIRE says so — the union is
 * `success | unavailable | error` (`@dina/protocol` `ServiceResponseStatus`)
 * and `validateServiceResponse` refuses anything else. This said `ok` for as
 * long as nothing validated it, which meant the one lane that answers from
 * Core's own records — the §12.7 reconcile below — emitted a response a
 * conforming buyer must reject. The
 * union is not split into two callbacks because both are the same act — one
 * envelope, sent now, outside the delegation lifecycle — and a second
 * callback would be a second thing every composition root has to remember to
 * wire.
 *
 * The callback is expected to sign + seal + relay to `recipientDID`. In
 * production it wraps Core's `sendD2D` with the service.response type bound.
 * Tests pass a spy.
 */
export type ServiceDirectResponder = (
  recipientDID: string,
  body: {
    query_id: string;
    capability: string;
    /**
     * THE PROTOCOL'S OWN TYPE, not a hand-written copy of it.
     *
     * This was `'unavailable' | 'error' | 'ok'`, and `ok` is not on the wire:
     * `ServiceResponseStatus` is `success | unavailable | error` and
     * `validateServiceResponse` refuses the rest. A local union that merely
     * resembles the contract cannot notice when it stops matching, and this
     * one had drifted far enough that the §12.7 Core-answer path emitted a
     * response every conforming buyer must reject.
     */
    status: ServiceResponseStatus;
    /** Present on failure statuses. */
    error?: string;
    /** Present on `success` — the answer Core produced. */
    result?: unknown;
    ttl_seconds: number;
  },
) => Promise<void>;

export interface ServiceHandlerOptions {
  coreClient: ServiceHandlerCoreClient;
  /**
   * Returns the *current* ServiceConfig for a listing. Read lazily on every
   * inbound query so config updates via `onServiceConfigChanged` take effect
   * without rewiring the handler.
   *
   * Multi-listing: `rkey` selects WHICH listing's config to validate +
   * execute against (the rkey carried by the query's `service_uri`). Omitted
   * ⇒ the default `self` listing — back-compat for single-listing providers
   * and queries that carry no `service_uri`. A query for
   * `…/com.dinakernel.service.profile/route-7` must execute against the
   * `route-7` config, NOT `self` (the one-row==one-record==one-execution
   * invariant).
   */
  readConfig: (rkey?: string) => ServiceConfig | null;
  /**
   * Optional: fires when an approval task is created. Wire to Telegram /
   * chat / push notifications. No-op when absent.
   */
  notifier?: ApprovalNotifier;
  /**
   * Optional: fires once per accepted inbound query (either an execution
   * task for auto policy, or an approval task for review policy). Wire to
   * the operator's chat thread so they see who is asking what. No-op
   * when absent.
   */
  inboundNotifier?: ServiceInboundNotifier;
  /**
   * Optional: sends a `service.response` D2D when the handler rejects
   * an inbound query before a workflow task is created. When absent the
   * handler only logs the rejection; the requester waits out its TTL.
   * Supplying this closes the loop with an immediate error notification.
   */
  directResponder?: ServiceDirectResponder;
  /**
   * Optional Core-owned reasoning executor. The handler offers it only
   * instruction-backed official read/quote capabilities. `null` means the
   * existing Tier-1/agent workflow remains the execution path.
   */
  reasoningSubmitter?: ServiceReasoningSubmitter;
  /**
   * Optional Core-owned PLUGIN executor (§11.2a). Offered only to a
   * capability carrying a complete plugin binding. Absent means this node
   * cannot run provider plugins, and such a capability answers `unavailable`
   * rather than falling through to a plane it was never configured for.
   */
  providerIngressSubmitter?: ProviderIngressSubmitter;
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
  private readonly readConfig: (rkey?: string) => ServiceConfig | null;
  private readonly notifier: ApprovalNotifier | null;
  private readonly inboundNotifier: ServiceInboundNotifier | null;
  private readonly directResponder: ServiceDirectResponder | null;
  private readonly reasoningSubmitter: ServiceReasoningSubmitter | null;
  private readonly providerIngressSubmitter: ProviderIngressSubmitter | null;
  private readonly log: (entry: Record<string, unknown>) => void;
  private readonly nowSecFn: () => number;
  private readonly generateUUID: () => string;

  constructor(options: ServiceHandlerOptions) {
    if (!options.coreClient) throw new Error('ServiceHandler: coreClient is required');
    if (!options.readConfig) throw new Error('ServiceHandler: readConfig is required');
    this.core = options.coreClient;
    this.readConfig = options.readConfig;
    this.notifier = options.notifier ?? null;
    this.inboundNotifier = options.inboundNotifier ?? null;
    this.directResponder = options.directResponder ?? null;
    this.reasoningSubmitter = options.reasoningSubmitter ?? null;
    this.providerIngressSubmitter = options.providerIngressSubmitter ?? null;
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

    const config = this.readConfig(this.rkeyForQuery(query));
    const cap = findCapabilityConfig(config, query.capability);
    if (cap === null) {
      await this.sendError(fromDID, query, 'unavailable', 'capability_not_configured');
      return;
    }

    // Defensive: a capability with NO execution plane (no agent binding,
    // no Tier 1 instruction) can only end in TTL expiry — tell the
    // requester now. `validateServiceListing` blocks saving this on an
    // active listing (`missing_execution_plane`), so this only fires for
    // configs written before that rule or through a bypassing client.
    const hasAgentPlane =
      typeof cap.mcpServer === 'string' &&
      cap.mcpServer !== '' &&
      typeof cap.mcpTool === 'string' &&
      cap.mcpTool !== '';
    const hasInstructionPlane =
      typeof cap.instruction === 'string' && cap.instruction.trim() !== '';
    // §11.2a — the plugin plane. `validateServiceListing` has accepted a
    // complete plugin binding as an execution plane since the substrate
    // landed, so a listing bound to a provider plugin saves cleanly; this
    // handler did not recognise it, and answered `capability_not_executable`
    // to every query it received. The listing rule and the answering rule
    // have to be the same rule.
    const hasPluginPlane = pluginBinding(cap) !== null;
    if (!hasAgentPlane && !hasInstructionPlane && !hasPluginPlane) {
      await this.sendError(fromDID, query, 'unavailable', 'capability_not_executable');
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
    // The plugin plane is checked BEFORE the generic execution path. A
    // capability carrying a binding is answered by that install or not at
    // all: falling through would hand the query to an agent or instruction
    // plane the operator never configured for it.
    if (hasPluginPlane) {
      await this.dispatchToPlugin(fromDID, strippedQuery, cap, config);
      return;
    }
    await this.createExecutionTask(fromDID, strippedQuery, cap);
  }

  /**
   * Hand an authenticated query to the install bound to its capability
   * (§11.2a). Brain does no plugin reasoning of its own: Core's submitter
   * resolves the binding, enforces subject authorization, and creates the
   * task on the install's private lane. A typed refusal comes back as a
   * `service.response` so the requester learns now instead of waiting out
   * its TTL.
   */
  private async dispatchToPlugin(
    fromDID: string,
    query: ServiceQueryBody,
    cap: ServiceCapabilityConfig,
    config: ServiceConfig | null,
  ): Promise<void> {
    const binding = pluginBinding(cap);
    if (binding === null || this.providerIngressSubmitter === null) {
      // Fail closed. No submitter means this node cannot run provider
      // plugins at all, which is a configuration fact the requester should
      // hear as `unavailable` rather than as silence.
      this.log({
        event: 'service.query.plugin_unavailable',
        from: fromDID,
        capability: query.capability,
        reason: binding === null ? 'no_binding' : 'no_submitter',
      });
      await this.sendError(fromDID, query, 'unavailable', 'plugin_lane_unavailable');
      return;
    }

    const outcome = this.providerIngressSubmitter({
      capabilityConfig: binding,
      query: {
        fromDid: fromDID,
        queryId: query.query_id,
        capability: query.capability,
        serviceRkey: this.rkeyForQuery(query) ?? 'self',
        params: query.params,
        ttlSeconds: query.ttl_seconds,
        ...(config?.name === undefined ? {} : { serviceName: config.name }),
        ...(() => {
          const snapshot = snapshotForCapability(config, query.capability);
          return snapshot === undefined ? {} : { schemaSnapshot: snapshot };
        })(),
      },
    });

    if (!outcome.ok) {
      this.log({
        event: 'service.query.plugin_refused',
        from: fromDID,
        capability: query.capability,
        code: outcome.code,
      });
      // The refusal CODE is the requester-facing detail; the message is
      // not, because Core's messages are written for an operator reading
      // logs and an order-scoped denial must stay non-disclosing.
      await this.sendError(fromDID, query, 'unavailable', outcome.code);
      return;
    }

    if ('coreAnswerJson' in outcome) {
      // WS-4.6 — compiled Core answered (§12.7 reconcile). There is no task,
      // so nothing downstream will ever emit this response; it goes out here
      // or not at all. The JSON came from Core, so it parses — but a throw on
      // this path would break `handleQuery`'s no-throw contract and lose the
      // answer silently, so it is guarded and reported like any other failure.
      this.log({
        event: 'service.query.answered_by_core',
        from: fromDID,
        capability: query.capability,
      });
      let result: unknown;
      try {
        result = JSON.parse(outcome.coreAnswerJson);
      } catch {
        await this.sendError(fromDID, query, 'error', 'core_answer_unreadable');
        return;
      }
      await this.sendAnswer(fromDID, query, result);
      return;
    }

    this.log({
      event: 'service.query.plugin_dispatched',
      from: fromDID,
      capability: query.capability,
      task_id: outcome.taskId,
    });
    await this.fireInboundNotifier({
      kind: 'execution',
      taskId: outcome.taskId,
      fromDID,
      capability: query.capability,
      serviceName: config?.name ?? '',
    });
  }

  /**
   * Called by Guardian when a `workflow.approved` event fires for an
   * approval task. Spawns a FRESH delegation task with a deterministic id
   * so retries are idempotent, then cancels the approval task.
   *
   * `payload` is the codec-parsed approval payload
   * (`parseServiceQueryExecutionPayload`) — every field it carries is
   * forwarded into the fresh delegation, so adding a field to the codec
   * automatically survives this hop.
   */
  async executeAndRespond(
    approvalTaskId: string,
    payload: Omit<ServiceQueryExecutionPayload, 'type'> & { type?: string },
  ): Promise<void> {
    if (!payload.from_did || !payload.query_id || !payload.capability) {
      throw new Error(`executeAndRespond: approval task ${approvalTaskId} has incomplete payload`);
    }
    const execTaskId = `svc-exec-from-${approvalTaskId}`;
    const ttl =
      typeof payload.ttl_seconds === 'number' && payload.ttl_seconds > 0
        ? payload.ttl_seconds
        : getTTL(payload.capability);

    const config = this.readConfig(
      payload.service_uri === undefined
        ? undefined
        : parseServiceListingUri(payload.service_uri)?.rkey,
    );
    const cap = findCapabilityConfig(config, payload.capability);
    // §11.2a — a review-gated plugin capability must reach its install AFTER
    // the operator approves. Without this branch the approval succeeds and
    // the query falls into the agent/instruction delegation path, which the
    // operator never configured for it: the requester waits out its TTL and
    // the approval looks like it worked.
    if (cap !== null && pluginBinding(cap) !== null) {
      await this.dispatchToPlugin(
        payload.from_did,
        {
          query_id: payload.query_id,
          capability: payload.capability,
          params: payload.params,
          ttl_seconds: ttl,
          ...(payload.schema_hash === undefined ? {} : { schema_hash: payload.schema_hash }),
          ...(payload.service_uri === undefined ? {} : { service_uri: payload.service_uri }),
          ...(payload.grant_id === undefined ? {} : { grant_id: payload.grant_id }),
        },
        cap,
        config,
      );
      await this.cancelApprovalAfterExecution(approvalTaskId, 'executed_via_plugin');
      return;
    }
    const reasoning =
      cap === null
        ? null
        : await this.tryCreateReasoningExecution({
            fromDID: payload.from_did,
            queryId: payload.query_id,
            capability: payload.capability,
            params: payload.params,
            ttlSeconds: ttl,
            cap,
            config,
            schemaSnapshot: payload.schema_snapshot,
            serviceUri: payload.service_uri,
            grantId: payload.grant_id,
            operatorApproved: true,
          });
    if (reasoning === 'conflict' || reasoning === 'unavailable') {
      await this.sendError(
        payload.from_did,
        {
          query_id: payload.query_id,
          capability: payload.capability,
          params: payload.params,
          ttl_seconds: ttl,
          ...(payload.schema_hash === undefined ? {} : { schema_hash: payload.schema_hash }),
          ...(payload.service_uri === undefined ? {} : { service_uri: payload.service_uri }),
          ...(payload.grant_id === undefined ? {} : { grant_id: payload.grant_id }),
        },
        'error',
        reasoning === 'conflict' ? 'reasoning_request_conflict' : 'service_unavailable',
      );
      await this.cancelApprovalAfterExecution(
        approvalTaskId,
        reasoning === 'conflict' ? 'reasoning_request_conflict' : 'service_unavailable',
      );
      return;
    }
    if (reasoning !== null) {
      await this.cancelApprovalAfterExecution(approvalTaskId, 'executed_via_reasoning');
      return;
    }

    try {
      await this.createExecutionTaskRaw({
        fromDID: payload.from_did,
        queryId: payload.query_id,
        capability: payload.capability,
        params: payload.params,
        ttlSeconds: ttl,
        schemaHash: payload.schema_hash,
        mcpTool: payload.mcp_tool,
        mcpServer: payload.mcp_server,
        serviceName: payload.service_name,
        schemaSnapshot: payload.schema_snapshot,
        serviceUri: payload.service_uri,
        grantId: payload.grant_id,
        // This delegation exists BECAUSE the operator approved — let the
        // Tier 1 runtime (and any agent) know the human gate is passed.
        operatorApproved: true,
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

    await this.cancelApprovalAfterExecution(approvalTaskId, 'executed_via_delegation');
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
    const config = this.readConfig(this.rkeyForQuery(query));
    const serviceName = config?.name ?? '';
    const reasoning = await this.tryCreateReasoningExecution({
      fromDID,
      queryId: query.query_id,
      capability: query.capability,
      params: query.params,
      ttlSeconds: query.ttl_seconds,
      cap,
      config,
      schemaSnapshot: snapshotForCapability(config, query.capability),
      serviceUri: query.service_uri,
      grantId: query.grant_id,
      operatorApproved: false,
    });
    if (reasoning === 'conflict' || reasoning === 'unavailable') {
      await this.sendError(
        fromDID,
        query,
        'error',
        reasoning === 'conflict' ? 'reasoning_request_conflict' : 'service_unavailable',
      );
      return;
    }
    if (reasoning !== null) {
      await this.fireInboundNotifier({
        kind: 'execution',
        taskId: reasoning.taskId,
        fromDID,
        capability: query.capability,
        serviceName,
      });
      return;
    }
    await this.createExecutionTaskRaw({
      fromDID,
      queryId: query.query_id,
      capability: query.capability,
      params: query.params,
      ttlSeconds: query.ttl_seconds,
      schemaHash: query.schema_hash,
      mcpTool: cap.mcpTool,
      mcpServer: cap.mcpServer,
      serviceName,
      schemaSnapshot: snapshotForCapability(config, query.capability),
      serviceUri: query.service_uri,
      taskId,
    });
    await this.fireInboundNotifier({
      kind: 'execution',
      taskId,
      fromDID,
      capability: query.capability,
      serviceName,
    });
  }

  private async tryCreateReasoningExecution(args: {
    fromDID: string;
    queryId: string;
    capability: string;
    params: unknown;
    ttlSeconds: number;
    cap: ServiceCapabilityConfig;
    config: ServiceConfig | null;
    schemaSnapshot?: SchemaSnapshot;
    serviceUri?: string;
    grantId?: string;
    operatorApproved: boolean;
  }): Promise<ServiceReasoningSubmission | 'conflict' | 'unavailable' | null> {
    if (this.reasoningSubmitter === null) return null;
    const instruction = typeof args.cap.instruction === 'string' ? args.cap.instruction.trim() : '';
    const hasAgentPlane =
      typeof args.cap.mcpServer === 'string' &&
      args.cap.mcpServer !== '' &&
      typeof args.cap.mcpTool === 'string' &&
      args.cap.mcpTool !== '';
    if (instruction === '' || hasAgentPlane) return null;

    // Unknown/custom capabilities have no trusted action classification. They
    // keep using the established Tier-1 lane until an owner-approved manifest
    // can supply equivalent execution semantics.
    const canonical = resolveCatalogCapability(args.capability);
    const definition = canonical === null ? undefined : getCatalogCapability(canonical);
    if (
      definition == null ||
      (definition.action_class !== 'read' && definition.action_class !== 'quote')
    ) {
      return null;
    }
    const responseSchema =
      args.schemaSnapshot?.result ?? getCapability(args.capability)?.resultSchema;
    if (
      responseSchema === undefined ||
      args.params === null ||
      typeof args.params !== 'object' ||
      Array.isArray(args.params)
    ) {
      return null;
    }
    try {
      const submitted = await this.reasoningSubmitter({
        requesterDid: args.fromDID,
        queryId: args.queryId,
        capabilityId: args.capability,
        params: args.params as Record<string, unknown>,
        instructions: instruction,
        serviceName: args.config?.name ?? '',
        ...(args.serviceUri === undefined ? {} : { serviceUri: args.serviceUri }),
        ...(args.grantId === undefined ? {} : { grantId: args.grantId }),
        ttlSeconds: args.ttlSeconds,
        responseSchema,
        ...(args.schemaSnapshot?.schema_hash === undefined
          ? {}
          : { responseSchemaHash: args.schemaSnapshot.schema_hash }),
        vaultPersona: args.config?.vaultPersona ?? 'general',
        operatorApproved: args.operatorApproved,
      });
      if (submitted !== null) {
        this.log({
          event: 'service.query.reasoning_created',
          task_id: submitted.taskId,
          backend_id: submitted.backendId,
          capability: args.capability,
          query_id: args.queryId,
          deduplicated: submitted.deduplicated,
        });
      }
      return submitted;
    } catch (err) {
      const code =
        err !== null && typeof err === 'object' && 'code' in err
          ? String((err as { code: unknown }).code)
          : '';
      if (code === 'conflict') {
        this.log({
          event: 'service.query.reasoning_conflict',
          capability: args.capability,
          query_id: args.queryId,
        });
        return 'conflict';
      }
      if (code === 'authority_unavailable') {
        this.log({
          event: 'service.query.reasoning_authority_unavailable',
          capability: args.capability,
          query_id: args.queryId,
        });
        return 'unavailable';
      }
      // Only an explicit `null` from the submitter means that no live
      // reasoning backend accepted the work. Unexpected failures must not
      // silently downgrade into the less constrained legacy execution lane.
      this.log({
        event: 'service.query.reasoning_unavailable',
        capability: args.capability,
        query_id: args.queryId,
        reason: 'reasoning_submission_failed',
      });
      return 'unavailable';
    }
  }

  private async cancelApprovalAfterExecution(
    approvalTaskId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.core.cancelWorkflowTask(approvalTaskId, reason);
    } catch {
      // Tolerate "already terminal" / 404. Downstream execution is what
      // resolves the query; approval cleanup is best effort.
      this.log({
        event: 'service.query.approval_cancel_failed',
        approval_task_id: approvalTaskId,
        reason: 'approval_cleanup_failed',
      });
    }
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
    /** The capability's `mcpServer` — the runner that should execute this
     *  task. Carried onto the workflow task as `requested_runner` so a
     *  multi-runner provider routes each capability to the right daemon. */
    mcpServer?: string;
    serviceName?: string;
    /** GAP-SH-03: frozen copy of the provider's published schema at
     *  task-creation time. The response bridge validates the runner's
     *  output against this snapshot (not the live config) so a config
     *  flip between dispatch + complete can't smuggle a drifted
     *  contract past the requester. */
    schemaSnapshot?: SchemaSnapshot;
    /** AT-URI of the chosen listing (multi-listing per DID). Carried onto the
     *  task payload so the agent knows which listing the query is for. */
    serviceUri?: string;
    grantId?: string;
    /** True when this delegation was spawned by `executeAndRespond` —
     *  i.e. the operator personally approved the request. The Tier 1
     *  runtime reads `payload.operator_approved` so an instruction like
     *  "ask me first" doesn't make the model re-request a confirmation
     *  that already happened. */
    operatorApproved?: boolean;
    taskId: string;
  }): Promise<void> {
    // ONE builder for the payload — `buildServiceQueryExecutionPayload`
    // (@dina/protocol). Hand-rolled shapes at each hop are how the
    // approval handoff silently dropped service_uri/schema_snapshot/
    // mcp_tool; a new field now goes through the codec or nowhere.
    const payload = buildServiceQueryExecutionPayload({
      from_did: args.fromDID,
      query_id: args.queryId,
      capability: args.capability,
      params: args.params,
      ttl_seconds: args.ttlSeconds,
      ...(args.serviceName !== undefined ? { service_name: args.serviceName } : {}),
      ...(args.schemaHash !== undefined ? { schema_hash: args.schemaHash } : {}),
      ...(args.mcpTool !== undefined ? { mcp_tool: args.mcpTool } : {}),
      ...(args.schemaSnapshot !== undefined ? { schema_snapshot: args.schemaSnapshot } : {}),
      ...(args.serviceUri !== undefined ? { service_uri: args.serviceUri } : {}),
      ...(args.grantId !== undefined ? { grant_id: args.grantId } : {}),
      ...(args.operatorApproved === true ? { operator_approved: true } : {}),
    });
    const expiresAtSec = this.nowSecFn() + args.ttlSeconds;
    await this.core.createWorkflowTask({
      id: args.taskId,
      kind: 'delegation',
      description: `Execute service query: ${args.capability}`,
      payload: JSON.stringify(payload),
      origin: 'd2d',
      correlationId: args.queryId,
      // Tier 1 prompt-provider lane: a capability with no agent binding
      // routes to the RESERVED local runner. The reserved name keeps the
      // task away from external agent daemons (their claim-any path
      // explicitly excludes it — see claimDelegationTask) so only this
      // node's own LocalDelegationRunner executes it.
      requestedRunner:
        args.mcpServer !== undefined && args.mcpServer !== '' ? args.mcpServer : LOCAL_RUNNER_NAME,
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
    const config = this.readConfig(this.rkeyForQuery(query));
    const serviceName = config?.name ?? '';
    const snapshot = snapshotForCapability(config, query.capability);
    // The approval payload is the SAME codec shape as the execution
    // payload — `executeAndRespond` parses it back and forwards every
    // field into the fresh delegation. mcp_tool/mcp_server ride at the
    // top level (WM-BRAIN-06a / multi-runner routing); schema_snapshot
    // survives the handoff (GAP-SH-04); service_uri pins the listing
    // (P1, multi-listing).
    const payload = buildServiceQueryExecutionPayload({
      from_did: fromDID,
      query_id: query.query_id,
      capability: query.capability,
      params: query.params,
      ttl_seconds: ttl,
      service_name: serviceName,
      ...(query.schema_hash !== undefined ? { schema_hash: query.schema_hash } : {}),
      ...(cap.mcpTool !== undefined ? { mcp_tool: cap.mcpTool } : {}),
      ...(cap.mcpServer !== undefined ? { mcp_server: cap.mcpServer } : {}),
      ...(snapshot !== undefined ? { schema_snapshot: snapshot } : {}),
      ...(query.service_uri !== undefined ? { service_uri: query.service_uri } : {}),
      ...(query.grant_id !== undefined ? { grant_id: query.grant_id } : {}),
    });
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
    await this.fireInboundNotifier({
      kind: 'approval',
      taskId,
      fromDID,
      capability: query.capability,
      serviceName,
    });
    if (this.notifier !== null) {
      try {
        await this.notifier({
          taskId,
          fromDID,
          capability: query.capability,
          serviceName,
          approveCommand: `/service_approve ${taskId}`,
          // Stripped + validated upstream in handleQuery — safe to surface
          // as a preview, still stranger-authored text.
          params: query.params,
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

  /**
   * Best-effort: notify the operator that a query was accepted. Errors
   * are logged + swallowed — chat-thread plumbing must never block task
   * creation that already succeeded.
   */
  private async fireInboundNotifier(notice: {
    kind: 'execution' | 'approval';
    taskId: string;
    fromDID: string;
    capability: string;
    serviceName: string;
  }): Promise<void> {
    if (this.inboundNotifier === null) return;
    try {
      await this.inboundNotifier(notice);
    } catch (err) {
      this.log({
        event: 'service.query.inbound_notifier_threw',
        task_id: notice.taskId,
        error: (err as Error).message ?? String(err),
      });
    }
  }

  /**
   * Send an answer compiled Core produced, with no task behind it (WS-4.6).
   *
   * Shares `sendError`'s delivery path because it is the same act — one
   * `service.response` envelope, sent now, outside the delegation lifecycle.
   * Best-effort and non-throwing for the same reason: `handleQuery` promises
   * the inbound dispatch path never throws.
   */
  private async sendAnswer(
    fromDID: string,
    query: ServiceQueryBody,
    result: unknown,
  ): Promise<void> {
    if (this.directResponder === null) return;
    try {
      await this.directResponder(fromDID, {
        query_id: query.query_id,
        capability: query.capability,
        // `success`, per `ServiceResponseStatus`. See the note in this class's
        // header: `ok` is not on the wire and never was.
        status: 'success',
        result,
        ttl_seconds: query.ttl_seconds,
      });
    } catch (err) {
      this.log({
        event: 'service.query.core_answer_send_failed',
        from: fromDID,
        query_id: query.query_id,
        error: err instanceof Error ? err.message : String(err),
      });
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
    // envelope via the injected `directResponder`. Issue #9.
    this.log({
      event: 'service.query.rejected',
      from: fromDID,
      query_id: query.query_id,
      capability: query.capability,
      status,
      message,
    });
    if (this.directResponder === null) return;
    try {
      await this.directResponder(fromDID, {
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
   *   - Published schema present but `schemaHash` empty → pass; the
   *     provider has not committed to a versioned schema yet.
   *   - Requester MUST supply a non-empty `schema_hash` once the provider
   *     publishes one — missing / empty is rejected as `schema_hash_required`.
   *     Without this, a stale requester could bypass version safety.
   *   - Mismatch → `schema_version_mismatch`.
   */
  /**
   * The listing rkey a query targets, from its `service_uri`. Returns
   * `undefined` when no (or a malformed) `service_uri` is present, so
   * `readConfig(undefined)` falls back to the default `self` listing. The
   * `did` half of the uri is NOT trusted here — `readConfig` only reads OUR
   * local listings, and the recipient-DID bind is enforced upstream (Core
   * route + the D2D confused-deputy fix); we use only the rkey segment.
   */
  private rkeyForQuery(query: ServiceQueryBody): string | undefined {
    if (typeof query.service_uri !== 'string' || query.service_uri === '') return undefined;
    return parseServiceListingUri(query.service_uri)?.rkey;
  }

  private checkSchemaHash(config: ServiceConfig | null, query: ServiceQueryBody): string | null {
    if (config === null) return null;
    const published = lookupPublishedSchema(config, query.capability);
    if (published === undefined) return null;
    if (published.schemaHash === '') return null;
    if (query.schema_hash === undefined || query.schema_hash === '') {
      return 'schema_hash_required';
    }
    // The requester echoes the PUBLISHED hash, and the publisher always
    // recomputes the canonical {params, result, description} hash at
    // publish time (stored hashes are advisory — serialiseSchemas).
    // Compare against the SAME canonical recompute first, so a config
    // whose CACHED hash predates the canonical recipe (params-only
    // writers) doesn't reject its own published listing. The stored
    // hash stays accepted as a fallback for requesters holding an older
    // published record.
    if (canonicalCapabilitySchemaHash(published) === query.schema_hash) return null;
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
    const published = lookupPublishedSchema(config, query.capability);
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
    const schema = lookupPublishedSchema(config, query.capability);
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

export function findCapabilityConfig(
  config: ServiceConfig | null,
  capability: string,
): ServiceCapabilityConfig | null {
  if (config === null) return null;
  // The TARGETED listing (resolved by the query's service_uri rkey) must be
  // LIVE to execute — `active`, regardless of discoverability. AUTHORIZATION
  // already happened at Core ingress (public → discoverable, unlisted →
  // service_uri, known_only → an active service_grant for the authenticated
  // caller); Brain only EXECUTES what Core admitted, so it must NOT re-apply a
  // publishability gate that excludes `known_only` (that double-gate dropped
  // grant-authorized known_only queries — they passed Core then died here). A
  // `paused`/`draft` listing is still rejected (not active).
  if (effectiveListingStatus(config) !== 'active') return null;
  // Layer 5: accept a canonical query against an alias-configured key.
  const key = resolveConfiguredKey(Object.keys(config.capabilities), capability);
  if (key === null) return null;
  return config.capabilities[key] ?? null;
}

/**
 * Extract a plain-object snapshot of the published schema for
 * `capability`. Returns `undefined` when no schema is published, so
 * the task payload omits `schema_snapshot` and response validation uses
 * the capability registry only. Exported for tests.
 *
 * Resolves through the alias↔canonical map (Layer 5) so a canonical query
 * still finds an alias-keyed published schema.
 */
/**
 * The §11.2a plugin plane, or null.
 *
 * All three fields or none: `validateServiceListing` rejects a partial
 * binding (`partial_plugin_binding`), and reading one here would let a
 * half-written config dispatch to an install id with no CID pin — exactly
 * the stale-binding case the pin exists to prevent.
 */
function pluginBinding(cap: ServiceCapabilityConfig): {
  pluginInstallId: string;
  pluginManifestCid: string;
  pluginCapabilityId: string;
} | null {
  const { pluginInstallId, pluginManifestCid, pluginCapabilityId } = cap;
  if (
    typeof pluginInstallId !== 'string' ||
    pluginInstallId === '' ||
    typeof pluginManifestCid !== 'string' ||
    pluginManifestCid === '' ||
    typeof pluginCapabilityId !== 'string' ||
    pluginCapabilityId === ''
  ) {
    return null;
  }
  return { pluginInstallId, pluginManifestCid, pluginCapabilityId };
}

export function snapshotForCapability(
  config: ServiceConfig | null,
  capability: string,
): SchemaSnapshot | undefined {
  const s = lookupPublishedSchema(config, capability);
  if (s === undefined) return undefined;
  return {
    params: s.params,
    result: s.result,
    schema_hash: s.schemaHash,
  };
}
