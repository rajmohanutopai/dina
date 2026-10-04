/**
 * Provider-side ingress for an admitted `service.query` (A2A plan §4.2a,
 * the "ingress move"). Core's receive pipeline authenticates the sender and
 * decides whether the query may enter at all (`evaluateServiceIngressBypass`:
 * a configured capability, a live listing, a grant for `known_only`); this
 * module does everything after that, in Core:
 *
 *   - checks the body, finds the listing's config for the capability, and
 *     refuses a capability with no way to run;
 *   - checks the requester's `schema_hash`, validates params against the
 *     published schema (or the first-party registry), and strips params the
 *     schema does not declare;
 *   - `review` → an approval card (`pending_approval`) and the owner's
 *     notifiers; `auto` → a plugin hand-off (§11.2a), the Core reasoning
 *     lane, or a delegation task on the capability's runner lane (its
 *     `mcpServer`, or the reserved in-process `dina.local` lane for Tier 1);
 *   - after the owner approves a card, the same choice for the approved
 *     query (`executeApproved`), then the card is closed.
 *
 * A query refused before any task exists is answered at once through the
 * direct responder, so the requester never waits out its TTL.
 *
 * This logic lived in Brain's `ServiceHandler` until the move. Its outcomes
 * are unchanged: the same tasks with the same payloads, the same refusals
 * with the same codes and text (the params validator and the capability
 * registry moved with it). What changed is who creates the tasks: Core's
 * workflow service, directly, so nothing outside Core queues work on the
 * reserved lanes, and the create route refuses `dina.local` to every caller.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import {
  LOCAL_RUNNER_NAME,
  buildServiceQueryExecutionPayload,
  effectiveListingStatus,
  getCatalogCapability,
  parseServiceListingUri,
  parseServiceQueryExecutionPayload,
  resolveCanonicalCapability,
  resolveCatalogCapability,
  validateServiceQueryBody,
} from '@dina/protocol';

import { WorkflowTaskKind, WorkflowTaskState } from '../workflow/domain';
import { WorkflowConflictError } from '../workflow/repository';

import { getCapability, getTTL } from './capabilities/registry';
import { serviceSchemaError } from './capabilities/schema';
import { capabilitySchemaHash } from './capability_schema_hash';
import { isReservedLane, namesReservedLane } from './reserved_lanes';

import type { ProviderIngressSubmitter } from '../plugins/provider_ingress';
import type { WorkflowService } from '../workflow/service';
import type {
  ServiceReasoningSubmission,
  ServiceReasoningSubmitter,
} from '../reasoning/service_execution';
import type {
  ServiceCapabilityConfig,
  ServiceCapabilitySchemas,
  ServiceConfig,
  ServiceQueryBody,
  ServiceResponseStatus,
} from '@dina/protocol';

/**
 * Frozen copy of a capability's published schema at task-creation time.
 * Embedded in the task payload so the Response Bridge validates the
 * runner's output against the contract agreed when the query was accepted,
 * never whatever the live config says at completion time.
 *
 * GAP-WIRE-01: snake_case to match main-dina's `schema_snapshot` shape, so a
 * snapshot persisted by one runtime can be validated by the other.
 */
export interface SchemaSnapshot {
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  schema_hash: string;
}

/** Owner-notification sink for review-policy approval cards. */
export type ApprovalNotifier = (notice: {
  taskId: string;
  fromDID: string;
  capability: string;
  serviceName: string;
  approveCommand: string;
  /**
   * The query's params, already validated and stripped to declared
   * properties, so the owner's surface can show "book 4:30 PM today"
   * rather than a bare capability name. STRANGER-CONTROLLED content —
   * render as plain text only.
   */
  params?: unknown;
}) => void | Promise<void>;

/**
 * Fired once per accepted query, after its task exists (an execution for
 * `auto`, an approval card for `review`). The phone posts a system line into
 * the owner's chat so they see who asked what. Not fired for refusals: those
 * get a log line and an error `service.response`. A throw is logged and
 * swallowed.
 */
export type ServiceInboundNotifier = (notice: {
  kind: 'execution' | 'approval';
  taskId: string;
  fromDID: string;
  capability: string;
  serviceName: string;
}) => void | Promise<void>;

/**
 * Sends one `service.response` envelope now, outside any task's lifecycle.
 * Two cases need it: a query refused before a task exists (issue #9 — the
 * requester would otherwise wait out its TTL), and a §12.7 reconcile Core
 * answered from its own records with no runner asked (WS-4.6).
 *
 * `status` is the wire's own type (`success | unavailable | error`): a local
 * union that merely resembles the contract cannot notice when it drifts.
 * The hosts wrap Core's `sendD2D`; tests pass a spy.
 */
export type ServiceDirectResponder = (
  recipientDID: string,
  body: {
    query_id: string;
    capability: string;
    status: ServiceResponseStatus;
    /** Present on failure statuses. */
    error?: string;
    /** Present on `success`: the answer Core produced. */
    result?: unknown;
    ttl_seconds: number;
  },
) => Promise<void>;

export interface ServiceQueryIngressOptions {
  /** Core's workflow service: every task this module makes is created here. */
  workflow: WorkflowService;
  /**
   * The CURRENT config of a listing, read on every query so a config change
   * takes effect at once. `rkey` names the listing (the rkey of the query's
   * `service_uri`); omitted means the default `self` listing. A query for
   * `…/route-7` executes against `route-7`, never `self`.
   */
  readConfig: (rkey?: string) => ServiceConfig | null;
  /** Fires when an approval card is created (Telegram, chat, push). */
  notifier?: ApprovalNotifier;
  /** Fires once per accepted query. */
  inboundNotifier?: ServiceInboundNotifier;
  /**
   * Answers a query refused before any task exists. Absent: the refusal is
   * only logged and the requester waits out its TTL.
   */
  directResponder?: ServiceDirectResponder;
  /**
   * Core's reasoning lane, offered only instruction-backed official
   * read/quote capabilities. Absent: the Tier 1 / agent workflow runs them.
   */
  reasoningSubmitter?: ServiceReasoningSubmitter;
  /**
   * Core's plugin executor (§11.2a), offered only a capability with a
   * complete plugin binding. Absent: this node runs no provider plugins, and
   * such a capability answers `unavailable` rather than falling through to a
   * lane it was never configured for.
   */
  providerIngressSubmitter?: ProviderIngressSubmitter;
  /** Structured log sink: metadata only, never params. Defaults to no-op. */
  logger?: (entry: Record<string, unknown>) => void;
  /** Wall clock in seconds. */
  nowSecFn?: () => number;
  /** Random id for new tasks. */
  generateUUID?: () => string;
}

/** An approved card may start execution only from these states (approve moves it to `queued`). */
const APPROVED_STATES: ReadonlySet<string> = new Set([WorkflowTaskState.Queued, WorkflowTaskState.Running]);

/** One admitted `service.query` per call. Stateless between calls. */
export class ServiceQueryIngress {
  private readonly workflow: WorkflowService;
  private readonly readConfig: (rkey?: string) => ServiceConfig | null;
  private readonly notifier: ApprovalNotifier | null;
  private readonly inboundNotifier: ServiceInboundNotifier | null;
  private readonly directResponder: ServiceDirectResponder | null;
  private readonly reasoningSubmitter: ServiceReasoningSubmitter | null;
  private readonly providerIngressSubmitter: ProviderIngressSubmitter | null;
  private readonly log: (entry: Record<string, unknown>) => void;
  private readonly nowSecFn: () => number;
  private readonly generateUUID: () => string;

  constructor(options: ServiceQueryIngressOptions) {
    if (!options.workflow) throw new Error('ServiceQueryIngress: workflow is required');
    if (!options.readConfig) throw new Error('ServiceQueryIngress: readConfig is required');
    this.workflow = options.workflow;
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
   * One admitted `service.query`. Never throws: a refusal is answered
   * through the direct responder so the requester's TTL does not lapse in
   * silence.
   */
  async admitQuery(fromDID: string, body: unknown): Promise<void> {
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

    const config = this.readConfig(rkeyForQuery(query));
    const cap = findCapabilityConfig(config, query.capability);
    if (cap === null) {
      await this.sendError(fromDID, query, 'unavailable', 'capability_not_configured');
      return;
    }
    // A runner lane only Core may fill (`dina.local` named outright, a
    // plugin, A2A or reasoning lane) is not an agent binding: a listing that
    // names one never runs, whatever else it says (the save refuses it too).
    if (namesReservedLane(cap)) {
      await this.sendError(fromDID, query, 'unavailable', 'capability_not_executable');
      return;
    }

    // A capability with no way to run (no agent binding, no Tier 1
    // instruction, no plugin binding) could only end in TTL expiry: say so
    // now. `validateServiceListing` refuses to save one on an active listing
    // (`missing_execution_plane`), so this catches configs written before
    // that rule or by a client that bypassed it. The listing rule and this
    // rule are the same rule.
    const hasPluginPlane = pluginBinding(cap) !== null;
    if (!hasAgentPlane(cap) && !hasInstructionPlane(cap) && !hasPluginPlane) {
      await this.sendError(fromDID, query, 'unavailable', 'capability_not_executable');
      return;
    }

    const schemaErr = checkQuerySchemaHash(config, query);
    if (schemaErr !== null) {
      await this.sendError(fromDID, query, 'error', schemaErr);
      return;
    }

    const paramsErr = validateQueryParams(config, query);
    if (paramsErr !== null) {
      await this.sendError(fromDID, query, 'error', paramsErr);
      return;
    }

    // WM-BRAIN-06b: params reach a task payload stripped to the published
    // schema's declared properties, even when the schema forgot
    // `additionalProperties: false`.
    const strippedQuery = this.stripUndeclaredParams(config, query);

    if (cap.responsePolicy === 'review') {
      await this.createApprovalTask(fromDID, strippedQuery, cap);
      return;
    }
    // A capability with a plugin binding is answered by that install or not
    // at all: falling through would hand it to a lane the owner never chose.
    if (hasPluginPlane) {
      await this.dispatchToPlugin(fromDID, strippedQuery, cap, config);
      return;
    }
    await this.createExecutionTask(fromDID, strippedQuery, cap);
  }

  /**
   * The owner approved a service card: start the approved query, then close
   * the card. Driven by the workflow-event consumer's `approved` event, and
   * safe to re-run: the delegation id is derived from the card's id, so a
   * retry finds the task it made.
   *
   * Core reads the card itself and starts nothing unless it is an approval
   * card for a service query that the owner's approve moved out of
   * `pending_approval`. Throws on a card it cannot act on, so the event is
   * retried with backoff and an operator can see it.
   */
  async executeApproved(approvalTaskId: string): Promise<void> {
    const card = this.workflow.store().getById(approvalTaskId);
    if (card === null) throw new Error(`executeApproved: approval task ${approvalTaskId} not found`);
    if (card.kind !== WorkflowTaskKind.Approval) {
      throw new Error(`executeApproved: task ${approvalTaskId} is not an approval card`);
    }
    if (!APPROVED_STATES.has(card.status)) {
      // Never approved, or already settled (expired, denied, executed).
      this.log({ event: 'service.query.approved_not_live', approval_task_id: approvalTaskId, state: card.status });
      return;
    }
    const parsed = parseServiceQueryExecutionPayload(card.payload);
    if (parsed === null || !parsed.from_did || !parsed.query_id || !parsed.capability) {
      throw new Error(`executeApproved: approval task ${approvalTaskId} has incomplete payload`);
    }
    const payload = parsed;
    const execTaskId = `svc-exec-from-${approvalTaskId}`;
    const ttl =
      typeof payload.ttl_seconds === 'number' && payload.ttl_seconds > 0
        ? payload.ttl_seconds
        : getTTL(payload.capability);
    const asked: ServiceQueryBody = {
      query_id: payload.query_id,
      capability: payload.capability,
      params: payload.params,
      ttl_seconds: ttl,
      ...(payload.schema_hash === undefined ? {} : { schema_hash: payload.schema_hash }),
      ...(payload.service_uri === undefined ? {} : { service_uri: payload.service_uri }),
      ...(payload.grant_id === undefined ? {} : { grant_id: payload.grant_id }),
    };

    // The card holds what admission checked against the listing as it was.
    // The owner's yes runs it only against the listing as it is now: still
    // live, naming no reserved lane, with the same published schema, and the
    // params still valid under it. The lane and the tool come from the live
    // listing, never from the card.
    const config = this.readConfig(
      payload.service_uri === undefined ? undefined : parseServiceListingUri(payload.service_uri)?.rkey,
    );
    const cap = findCapabilityConfig(config, payload.capability);
    const refusal: [status: 'unavailable' | 'error', code: string] | null =
      cap === null
        ? ['unavailable', 'capability_not_configured']
        : namesReservedLane(cap)
          ? ['unavailable', 'capability_not_executable']
          : snapshotDigest(snapshotForCapability(config, payload.capability)) !== snapshotDigest(payload.schema_snapshot)
            ? ['error', 'schema_version_mismatch']
            : null;
    const paramsErr = refusal === null ? validateQueryParams(config, asked) : null;
    if (refusal !== null || paramsErr !== null) {
      const [status, code] = refusal ?? ['error', paramsErr ?? ''];
      await this.sendError(payload.from_did, asked, status, code);
      this.cancelApprovalAfterExecution(approvalTaskId, refusal === null ? 'params_invalid' : code);
      return;
    }
    const query = this.stripUndeclaredParams(config, asked);
    // §11.2a — a review-gated plugin capability reaches its install AFTER
    // the owner approves; without this branch the approval would fall into
    // the agent/instruction path the owner never configured for it.
    if (cap !== null && pluginBinding(cap) !== null) {
      await this.dispatchToPlugin(payload.from_did, query, cap, config);
      this.cancelApprovalAfterExecution(approvalTaskId, 'executed_via_plugin');
      return;
    }
    const reasoning =
      cap === null
        ? null
        : await this.tryCreateReasoningExecution({
            fromDID: payload.from_did,
            queryId: payload.query_id,
            capability: payload.capability,
            params: query.params,
            ttlSeconds: ttl,
            cap,
            config,
            schemaSnapshot: payload.schema_snapshot,
            serviceUri: payload.service_uri,
            grantId: payload.grant_id,
            operatorApproved: true,
          });
    if (reasoning === 'conflict' || reasoning === 'unavailable') {
      const code = reasoning === 'conflict' ? 'reasoning_request_conflict' : 'service_unavailable';
      await this.sendError(payload.from_did, query, 'error', code);
      this.cancelApprovalAfterExecution(approvalTaskId, code);
      return;
    }
    if (reasoning !== null) {
      this.cancelApprovalAfterExecution(approvalTaskId, 'executed_via_reasoning');
      return;
    }

    try {
      this.createExecutionTaskRaw({
        fromDID: payload.from_did,
        queryId: payload.query_id,
        capability: payload.capability,
        params: query.params,
        ttlSeconds: ttl,
        schemaHash: payload.schema_hash,
        mcpTool: cap?.mcpTool,
        mcpServer: cap?.mcpServer,
        serviceName: payload.service_name,
        schemaSnapshot: payload.schema_snapshot,
        serviceUri: payload.service_uri,
        grantId: payload.grant_id,
        // This delegation exists BECAUSE the owner approved: the Tier 1
        // runtime (and any agent) must not ask again.
        operatorApproved: true,
        taskId: execTaskId,
      });
    } catch (err) {
      if (!(err instanceof WorkflowConflictError)) throw err;
      // A previous attempt made it: carry on and close the card.
      this.log({ event: 'service.query.execute_exists', approval_task_id: approvalTaskId, exec_task_id: execTaskId });
    }
    this.cancelApprovalAfterExecution(approvalTaskId, 'executed_via_delegation');
  }

  /**
   * Hand an admitted query to the install bound to its capability (§11.2a).
   * Core's submitter resolves the binding, checks subject authorization and
   * creates the task on the install's private lane; a typed refusal goes
   * back to the requester now.
   */
  private async dispatchToPlugin(
    fromDID: string,
    query: ServiceQueryBody,
    cap: ServiceCapabilityConfig,
    config: ServiceConfig | null,
  ): Promise<void> {
    const binding = pluginBinding(cap);
    if (binding === null || this.providerIngressSubmitter === null) {
      // Fail closed: a node that cannot run provider plugins says
      // `unavailable` rather than nothing.
      this.log({
        event: 'service.query.plugin_unavailable',
        from: fromDID,
        capability: query.capability,
        reason: binding === null ? 'no_binding' : 'no_submitter',
      });
      await this.sendError(fromDID, query, 'unavailable', 'plugin_lane_unavailable');
      return;
    }

    const snapshot = snapshotForCapability(config, query.capability);
    const outcome = this.providerIngressSubmitter({
      capabilityConfig: binding,
      query: {
        fromDid: fromDID,
        queryId: query.query_id,
        capability: query.capability,
        serviceRkey: rkeyForQuery(query) ?? 'self',
        params: query.params,
        ttlSeconds: query.ttl_seconds,
        ...(config?.name === undefined ? {} : { serviceName: config.name }),
        ...(snapshot === undefined ? {} : { schemaSnapshot: snapshot }),
      },
    });

    if (!outcome.ok) {
      this.log({
        event: 'service.query.plugin_refused',
        from: fromDID,
        capability: query.capability,
        code: outcome.code,
      });
      // The CODE goes to the requester; Core's message is written for an
      // operator reading logs, and an order-scoped denial must not disclose.
      await this.sendError(fromDID, query, 'unavailable', outcome.code);
      return;
    }

    if ('coreAnswerJson' in outcome) {
      // WS-4.6 — Core answered from its own records (§12.7 reconcile). No
      // task will ever carry this answer, so it goes out here or not at all.
      this.log({ event: 'service.query.answered_by_core', from: fromDID, capability: query.capability });
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

  private async createExecutionTask(
    fromDID: string,
    query: ServiceQueryBody,
    cap: ServiceCapabilityConfig,
  ): Promise<void> {
    const taskId = `svc-exec-${this.generateUUID()}`;
    const config = this.readConfig(rkeyForQuery(query));
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
    try {
      this.createExecutionTaskRaw({
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
    } catch (err) {
      this.log({
        event: 'service.query.create_failed',
        from: fromDID,
        query_id: query.query_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    await this.fireInboundNotifier({
      kind: 'execution',
      taskId,
      fromDID,
      capability: query.capability,
      serviceName,
    });
  }

  /**
   * Core's reasoning lane, for an instruction-backed official read/quote
   * capability with no agent binding. `null` means "not this lane" (the
   * Tier 1 / agent task follows); `conflict` and `unavailable` are refusals.
   */
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
    if (instruction === '' || hasAgentPlane(args.cap)) return null;

    // Unknown/custom capabilities have no trusted action classification:
    // they stay on the Tier 1 lane until an owner-approved manifest can
    // supply equivalent execution semantics.
    const canonical = resolveCatalogCapability(args.capability);
    const definition = canonical === null ? undefined : getCatalogCapability(canonical);
    if (definition == null || (definition.action_class !== 'read' && definition.action_class !== 'quote')) {
      return null;
    }
    const responseSchema = args.schemaSnapshot?.result ?? getCapability(args.capability)?.resultSchema;
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
        err !== null && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
      if (code === 'conflict') {
        this.log({ event: 'service.query.reasoning_conflict', capability: args.capability, query_id: args.queryId });
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
      // Only an explicit `null` from the submitter means no live reasoning
      // backend took the work. An unexpected failure must not fall back to
      // the less constrained execution lane.
      this.log({
        event: 'service.query.reasoning_unavailable',
        capability: args.capability,
        query_id: args.queryId,
        reason: 'reasoning_submission_failed',
      });
      return 'unavailable';
    }
  }

  /** Close the card once execution started. Best effort: the execution resolves the query. */
  private cancelApprovalAfterExecution(approvalTaskId: string, reason: string): void {
    try {
      this.workflow.cancel(approvalTaskId, reason);
    } catch {
      this.log({
        event: 'service.query.approval_cancel_failed',
        approval_task_id: approvalTaskId,
        reason: 'approval_cleanup_failed',
      });
    }
  }

  /** The delegation task for an execution, for the auto path and an approved card alike. */
  private createExecutionTaskRaw(args: {
    fromDID: string;
    queryId: string;
    capability: string;
    params: unknown;
    ttlSeconds: number;
    schemaHash?: string;
    /** MCP tool routing key: a top-level payload field, kept out of the published schema snapshot. */
    mcpTool?: string;
    /** The runner lane (`requested_runner`) a multi-runner provider routes by. */
    mcpServer?: string;
    serviceName?: string;
    /** GAP-SH-03: the schema the Response Bridge validates the runner's output against. */
    schemaSnapshot?: SchemaSnapshot;
    /** AT-URI of the chosen listing (multi-listing per DID). */
    serviceUri?: string;
    grantId?: string;
    /** The owner already approved: the runtime must not ask again. */
    operatorApproved?: boolean;
    taskId: string;
  }): void {
    // ONE payload builder (`@dina/protocol`): a field added to the codec
    // survives every hop, and nothing else can drop one.
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
    const lane = args.mcpServer !== undefined && args.mcpServer !== '' ? args.mcpServer : LOCAL_RUNNER_NAME;
    if (lane !== LOCAL_RUNNER_NAME && isReservedLane(lane)) {
      // Unreachable: admission and execution refuse such a listing first.
      throw new Error(`refusing to queue a service query on reserved lane ${lane}`);
    }
    this.workflow.create({
      id: args.taskId,
      kind: WorkflowTaskKind.Delegation,
      description: `Execute service query: ${args.capability}`,
      payload: JSON.stringify(payload),
      origin: 'd2d',
      correlationId: args.queryId,
      // A capability with no agent binding runs on the RESERVED local lane:
      // the claim route refuses it to any external daemon, so only this
      // node's own LocalDelegationRunner executes it.
      requestedRunner: lane,
      expiresAtSec: this.nowSecFn() + args.ttlSeconds,
      // `queued`, so a paired runner claims it (with lease and heartbeat).
      initialState: WorkflowTaskState.Queued,
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
    const config = this.readConfig(rkeyForQuery(query));
    const serviceName = config?.name ?? '';
    const snapshot = snapshotForCapability(config, query.capability);
    // The SAME codec shape as the execution payload: `executeApproved`
    // parses it back and forwards every field into the delegation.
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
    try {
      this.workflow.create({
        id: taskId,
        kind: WorkflowTaskKind.Approval,
        description: `Service review: ${query.capability} from ${fromDID}`,
        payload: JSON.stringify(payload),
        origin: 'd2d',
        correlationId: query.query_id,
        expiresAtSec: this.nowSecFn() + ttl,
        // Straight into `pending_approval`, so approve (→ queued) and the
        // reconciler's expiry fire with no extra transition.
        initialState: WorkflowTaskState.PendingApproval,
      });
    } catch (err) {
      this.log({
        event: 'service.query.create_failed',
        from: fromDID,
        query_id: query.query_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
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
          // Validated and stripped above; still stranger-authored text.
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

  /** Tell the owner a query was accepted. A throw never undoes the task. */
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

  /** A Core-produced answer (WS-4.6), sent with no task behind it. Never throws. */
  private async sendAnswer(fromDID: string, query: ServiceQueryBody, result: unknown): Promise<void> {
    if (this.directResponder === null) return;
    try {
      await this.directResponder(fromDID, {
        query_id: query.query_id,
        capability: query.capability,
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

  /** A refusal before any task exists (issue #9). Never throws. */
  private async sendError(
    fromDID: string,
    query: ServiceQueryBody,
    status: 'unavailable' | 'error',
    message: string,
  ): Promise<void> {
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
      this.log({
        event: 'service.query.reject_send_failed',
        from: fromDID,
        query_id: query.query_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Strip params to the keys the published schema declares. No published
   * schema, params that are not a plain object, or an empty `properties`
   * map (the schema declares no whitelist) pass through unchanged. Dropped
   * key NAMES are logged so an operator sees clients sending unknown fields.
   */
  private stripUndeclaredParams(config: ServiceConfig | null, query: ServiceQueryBody): ServiceQueryBody {
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

    const filtered: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(query.params as Record<string, unknown>)) {
      if (allowedKeys.includes(k)) filtered[k] = v;
      else dropped.push(k);
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
// Pure rules, shared with the Tier 1 runner and the A2A gateway
// ---------------------------------------------------------------------------

/**
 * The listing rkey a query targets, from its `service_uri`; `undefined`
 * (the default `self` listing) when there is none or it is malformed. Only
 * the rkey is used: `readConfig` reads only OUR listings, and the
 * recipient-DID bind happens upstream (the receive pipeline).
 */
function rkeyForQuery(query: ServiceQueryBody): string | undefined {
  if (typeof query.service_uri !== 'string' || query.service_uri === '') return undefined;
  return parseServiceListingUri(query.service_uri)?.rkey;
}

/**
 * What a schema snapshot pins, as one comparable string: the published hash
 * and the canonical hash of the schemas themselves (so a schema edited under
 * a stale stored hash still counts as changed). No snapshot is ''.
 */
function snapshotDigest(snapshot: SchemaSnapshot | undefined): string {
  if (snapshot === undefined) return '';
  let canonical: string;
  try {
    canonical = capabilitySchemaHash({ params: snapshot.params, result: snapshot.result });
  } catch {
    canonical = JSON.stringify([snapshot.params, snapshot.result]);
  }
  return `${snapshot.schema_hash}|${canonical}`;
}

function hasAgentPlane(cap: ServiceCapabilityConfig): boolean {
  return (
    typeof cap.mcpServer === 'string' &&
    cap.mcpServer !== '' &&
    typeof cap.mcpTool === 'string' &&
    cap.mcpTool !== ''
  );
}

function hasInstructionPlane(cap: ServiceCapabilityConfig): boolean {
  return typeof cap.instruction === 'string' && cap.instruction.trim() !== '';
}

/**
 * The config key an inbound capability was stored under (Layer 5:
 * discovery hands out the CANONICAL name, but this provider may have
 * configured an alias, `bus_eta` for `eta_query`). Exact key first, then a
 * canonical match. `null` when nothing matches.
 */
function resolveConfiguredKey(keys: readonly string[], capability: string): string | null {
  if (keys.includes(capability)) return capability;
  const inboundCanonical = resolveCanonicalCapability(capability);
  if (inboundCanonical === null) return null;
  for (const key of keys) {
    if (resolveCanonicalCapability(key) === inboundCanonical) return key;
  }
  return null;
}

/** The published JSON Schema for a capability, alias-aware (Layer 5). */
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
 * The capability's config on a LIVE listing, or null. Authorization already
 * happened at ingress (public → discoverable, unlisted → `service_uri`,
 * known_only → a grant for the authenticated caller); this only requires
 * the targeted listing to be `active`, so a grant-authorized `known_only`
 * query is never dropped by a second gate. Paused and draft listings do
 * not execute.
 */
export function findCapabilityConfig(
  config: ServiceConfig | null,
  capability: string,
): ServiceCapabilityConfig | null {
  if (config === null) return null;
  if (effectiveListingStatus(config) !== 'active') return null;
  const key = resolveConfiguredKey(Object.keys(config.capabilities), capability);
  if (key === null) return null;
  return config.capabilities[key] ?? null;
}

/**
 * The §11.2a plugin binding, or null. All three fields or none:
 * `validateServiceListing` refuses a partial binding, and reading one here
 * would dispatch to an install with no CID pin.
 */
export function pluginBinding(cap: ServiceCapabilityConfig): {
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

/** A frozen copy of the published schema, or `undefined` when none is published. */
export function snapshotForCapability(
  config: ServiceConfig | null,
  capability: string,
): SchemaSnapshot | undefined {
  const s = lookupPublishedSchema(config, capability);
  if (s === undefined) return undefined;
  return { params: s.params, result: s.result, schema_hash: s.schemaHash };
}

/**
 * The requester's `schema_hash` against the published one (GAP-SH-01):
 *   - nothing published, or published with an empty hash → pass (no
 *     versioned contract yet);
 *   - published but the query names no hash → `schema_hash_required`;
 *   - otherwise it must equal the canonical `{params, result, description}`
 *     hash the publisher publishes, or the stored hash (a requester holding
 *     an older record) → else `schema_version_mismatch`.
 * A schema with no canonical form (Core's recipe refuses it) matches only
 * by its stored hash.
 */
export function checkQuerySchemaHash(config: ServiceConfig | null, query: ServiceQueryBody): string | null {
  if (config === null) return null;
  const published = lookupPublishedSchema(config, query.capability);
  if (published === undefined) return null;
  if (published.schemaHash === '') return null;
  if (query.schema_hash === undefined || query.schema_hash === '') return 'schema_hash_required';
  let canonical: string | null;
  try {
    canonical = capabilitySchemaHash(published);
  } catch {
    canonical = null;
  }
  if (canonical === query.schema_hash) return null;
  if (published.schemaHash === query.schema_hash) return null;
  return 'schema_version_mismatch';
}

/**
 * Params against the PUBLISHED schema when there is one (GAP-SH-02: the
 * exact contract the requester saw on AppView); otherwise the first-party
 * registry's validator; otherwise nothing to check. The error text goes to
 * the requester.
 */
export function validateQueryParams(config: ServiceConfig | null, query: ServiceQueryBody): string | null {
  const published = lookupPublishedSchema(config, query.capability);
  if (published !== undefined && typeof published.params === 'object' && published.params !== null) {
    return serviceSchemaError(query.params, published.params);
  }
  const registered = getCapability(query.capability);
  if (registered === undefined) return null;
  return registered.validateParams(query.params);
}
