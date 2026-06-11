/**
 * Requester-side orchestrator for public-service queries.
 *
 * Invariants:
 *   - Core's `workflow_tasks` table owns lifecycle (queued → running →
 *     completed/failed/cancelled). No in-memory pending map.
 *   - Core's workflow sweeper expires tasks whose `expires_at` elapses.
 *     No periodic orchestrator-side timeout loop.
 *   - `issueQuery` returns immediately with `{queryId, taskId, toDID,
 *     serviceName, deduped}`. The response lands asynchronously as a
 *     `workflow_event(completed)` on the service_query task; the
 *     `WorkflowEventConsumer` formats + delivers it to chat.
 *
 * Pipeline: AppView search → rank candidates → `coreClient.sendServiceQuery`.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { MAX_SERVICE_TTL, resolveSearchableCapability } from '@dina/protocol';

import {
  AppViewError,
  type AppViewClient,
  type SearchServicesParams,
  type ServiceProfile,
} from '../appview_client/http';

import { pickTopCandidate, type Location, type RankOptions } from './candidate_ranker';
import { getCapability, getTTL } from './capabilities/registry';
import { canonicalCapabilitySchemaHash } from './service_publisher';

import type { CoreClient, ServiceQueryResult } from '@dina/core';

/**
 * Canonicalize a requester-supplied capability ONCE at the orchestrator
 * boundary (SERVICES_LAUNCH_ARCHITECTURE.md Part 1). AppView stores +
 * returns capabilities CANONICALLY, and Core / the provider canonicalize
 * inbound — so the requester pipeline (AppView search, ranking, schema
 * lookup, sender-side validation, Core send) must ALL operate on the
 * canonical name, else `/service bus_eta` searches for an alias AppView
 * never indexes and the ranker exact-matches against a canonical profile.
 * Namespaced custom capabilities (`com.acme.widget_price`) are their own
 * searchable key, normalized by the shared resolver.
 */
function canonicalizeRequested(capability: string): string {
  return resolveSearchableCapability(capability) ?? capability;
}

/** Minimal slice of `CoreClient` the orchestrator needs. */
export type OrchestratorCoreClient = Pick<CoreClient, 'sendServiceQuery'>;

/** Minimal subset of `AppViewClient` the orchestrator needs. */
export type OrchestratorAppView = Pick<AppViewClient, 'searchServices'>;

/** Inputs to `issueQuery`. */
export interface IssueQueryRequest {
  capability: string;
  params: unknown;
  /** Override the capability default TTL (seconds). */
  ttlSeconds?: number;
  /** Requester location — used for ranking + AppView geo search. */
  viewer?: Location;
  /** Radius for AppView geo search (km). Default 5. */
  radiusKm?: number;
  /** Free-text match — passed through to AppView. */
  q?: string;
  /** Per-candidate lat/lng resolver for the ranker. */
  coordsOf?: RankOptions['coordsOf'];
  /** Tag for telemetry — e.g. "chat", "scheduled". */
  originChannel?: string;
  /**
   * The requester's own DID. Forwarded to the ranker so a node that also
   * advertises this capability (role=provider, or a stale self-listing in
   * AppView) never routes the query back to itself. See
   * `RankOptions.excludeDid`.
   */
  selfDid?: string;
}

/**
 * Inputs to `issueQueryToDID` — dispatch a service.query to a SPECIFIC
 * provider the caller already picked. This is what the `query_service`
 * LLM tool uses: the model chose an operator_did (and optionally
 * pinned a schema_hash) in a prior turn and wants Core to send the
 * query to exactly that DID. No AppView re-search, no ranker override.
 * Issue #7, #8.
 */
export interface IssueQueryToDIDRequest {
  /** Target provider DID (required — this is the whole point). */
  toDID: string;
  capability: string;
  params: unknown;
  /** Override the capability default TTL. */
  ttlSeconds?: number;
  /** Schema-version pin from AppView search. Forwarded verbatim. */
  schemaHash?: string;
  /** Display label for audit/telemetry. Defaults to the DID. */
  serviceName?: string;
  /** Tag for telemetry — e.g. "ask", "chat", "scheduled". */
  originChannel?: string;
  /**
   * AT-URI of the specific listing the caller chose (from
   * `search_provider_services`). A provider DID may publish many listings; this
   * carries the selection to the provider. Forwarded opaquely onto the wire.
   */
  serviceUri?: string;
  /**
   * Grant id the caller is exercising (from a `service.offer`, surfaced by
   * `find_preferred_provider`). Forwarded onto the wire — required-in-effect
   * for a known_only listing (provider authorizes by grant_id + authed DID).
   */
  grantId?: string;
}

/**
 * Synchronous outcome of `issueQuery`. Note this is the **dispatch** result,
 * not the response — the response arrives later via a workflow event.
 */
export interface IssueQueryResult {
  queryId: string;
  taskId: string;
  toDID: string;
  serviceName: string;
  /** True when Core returned an existing live task for the same idem key. */
  deduped: boolean;
}

/** Options for `ServiceQueryOrchestrator`. */
export interface OrchestratorOptions {
  appViewClient: OrchestratorAppView;
  coreClient: OrchestratorCoreClient;
  /** Injectable query-id generator for deterministic tests. */
  generateQueryId?: () => string;
}

/**
 * Structured errors surfaced when the orchestrator fails before Core has
 * accepted the query. Once Core owns the task, failures arrive through the
 * Guardian event path.
 */
export class ServiceOrchestratorError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'capability_required'
      | 'params_required'
      | 'params_invalid'
      | 'to_did_required'
      | 'no_candidate'
      | 'send_failed',
  ) {
    super(message);
    this.name = 'ServiceOrchestratorError';
  }
}

/**
 * Sender-side params validation (main-dina 9b1c4a47, refined for
 * review #2).
 *
 * Gating rules (applied in order):
 *
 *   1. Unknown capability → skip. Matches Go's "validate when schema
 *      is present"; an older app build shouldn't block a capability
 *      the device doesn't know about.
 *
 *   2. Provider published a `schema_hash` that DOESN'T match our
 *      local one → skip. The provider is on a different schema
 *      version; running their query through our stale validator
 *      would reject payloads they would legitimately accept.
 *      Defer to the provider (which validates server-side anyway).
 *
 *   3. Hashes match (or provider didn't advertise a hash at all)
 *      → run our local validator. This is the happy path — a quick
 *      sender-side guard so mis-shaped tool calls never leave the
 *      device.
 */
function validateParamsSenderSide(
  capability: string,
  params: unknown,
  providerSchemaHash: string | undefined,
): void {
  const cap = getCapability(capability);
  if (cap === undefined) return;
  if (providerSchemaHash !== undefined && providerSchemaHash !== '') {
    // The provider's published hash is the CANONICAL recipe over
    // {params, result, description} (serialiseSchemas). Comparing a
    // params-only hash here never matched a canonical-hash provider, so
    // this fast sender-side guard was silently skipped for every
    // registry capability — mis-shaped tool calls left the device and
    // failed a network round-trip later.
    const ours = canonicalCapabilitySchemaHash({
      params: cap.paramsSchema,
      result: cap.resultSchema,
      description: cap.description,
    });
    if (ours !== providerSchemaHash) {
      // Version mismatch — defer to the provider's validator.
      return;
    }
  }
  const err = cap.validateParams(params);
  if (err !== null) {
    throw new ServiceOrchestratorError(
      `params failed ${capability} schema: ${err}`,
      'params_invalid',
    );
  }
}

/**
 * Thin Phase-2 orchestrator. One instance per brain process is plenty —
 * there is no per-query state.
 */
export class ServiceQueryOrchestrator {
  private readonly appView: OrchestratorAppView;
  private readonly core: OrchestratorCoreClient;
  private readonly generateQueryId: () => string;

  constructor(options: OrchestratorOptions) {
    if (!options.appViewClient) {
      throw new Error('ServiceQueryOrchestrator: appViewClient is required');
    }
    if (!options.coreClient) {
      throw new Error('ServiceQueryOrchestrator: coreClient is required');
    }
    this.appView = options.appViewClient;
    this.core = options.coreClient;
    this.generateQueryId = options.generateQueryId ?? defaultQueryId;
  }

  /**
   * Search AppView, pick the top candidate, hand off to Core. Returns
   * immediately with the dispatch identifiers. Response delivery is
   * Guardian's responsibility.
   *
   * Throws `ServiceOrchestratorError` for pre-send failures (no
   * candidate, send failed). Post-send failures (provider unavailable,
   * TTL expired, capability errored) surface via the workflow event and
   * never raise here.
   */
  async issueQuery(req: IssueQueryRequest): Promise<IssueQueryResult> {
    if (!req.capability) {
      throw new ServiceOrchestratorError('capability is required', 'capability_required');
    }
    if (req.params === undefined || req.params === null) {
      throw new ServiceOrchestratorError('params is required', 'params_required');
    }

    // Canonicalize ONCE at the boundary; everything downstream uses this.
    const capability = canonicalizeRequested(req.capability);

    const ttlSeconds = this.pickTtlRaw(req.ttlSeconds, capability);

    const searchParams: SearchServicesParams = {
      capability,
      lat: req.viewer?.lat,
      lng: req.viewer?.lng,
      radiusKm: req.radiusKm,
      q: req.q,
    };
    let services: ServiceProfile[];
    try {
      services = await this.appView.searchServices(searchParams);
    } catch (err) {
      if (isSearchRejectionNoCandidate(err)) {
        throw new ServiceOrchestratorError(
          `no service advertises "${capability}"`,
          'no_candidate',
        );
      }
      throw err;
    }

    const top = pickTopCandidate(capability, services, {
      viewer: req.viewer,
      coordsOf: req.coordsOf,
      ...(req.selfDid !== undefined ? { excludeDid: req.selfDid } : {}),
    });
    if (top === null) {
      throw new ServiceOrchestratorError(
        `no service advertises "${capability}"`,
        'no_candidate',
      );
    }

    const queryId = this.generateQueryId();
    const schemaHash = top.profile.capabilitySchemas?.[capability]?.schemaHash;

    // Review #2: validate only AFTER we know the provider's schema
    // hash. When the provider is on a different schema version,
    // local validation would reject payloads the provider would
    // accept — defer to them in that case.
    validateParamsSenderSide(capability, req.params, schemaHash);

    let sendResult: ServiceQueryResult;
    try {
      sendResult = await this.core.sendServiceQuery({
        toDID: top.profile.did,
        capability,
        // CoreClient narrows to Record<string, unknown>; the orchestrator's
        // caller API accepts `unknown` + defers to the capability validator
        // above. The cast is safe — validateParamsSenderSide rejected
        // non-objects before we reached here.
        params: req.params as Record<string, unknown>,
        queryId,
        ttlSeconds,
        serviceName: top.profile.name,
        originChannel: req.originChannel,
        schemaHash: schemaHash !== '' ? schemaHash : undefined,
        // The ranker chose THIS listing — carry its uri so a multi-listing
        // provider DID knows which one was selected.
        serviceUri:
          typeof top.profile.uri === 'string' && top.profile.uri !== ''
            ? top.profile.uri
            : undefined,
      });
    } catch (err) {
      throw new ServiceOrchestratorError(
        `failed to send service.query: ${(err as Error).message ?? String(err)}`,
        'send_failed',
      );
    }

    return {
      queryId: sendResult.queryId || queryId,
      taskId: sendResult.taskId,
      toDID: top.profile.did,
      serviceName: top.profile.name,
      // CoreClient returns `deduped?` (optional); the orchestrator's
      // IssueQueryResult exposes always-boolean. Collapse undefined → false.
      deduped: sendResult.deduped ?? false,
    };
  }

  /**
   * Dispatch a service.query to an EXPLICIT provider DID. No AppView
   * re-search, no candidate ranker. Used by the `query_service` LLM
   * tool (which gets `operator_did` from a prior `search_provider_services`
   * tool call and forwards the model's choice verbatim).
   *
   * Issue #7/#8: this is the path that enforces "ask Bob's transit
   * service" instead of silently substituting whoever happens to rank
   * first today.
   */
  async issueQueryToDID(req: IssueQueryToDIDRequest): Promise<IssueQueryResult> {
    if (!req.capability) {
      throw new ServiceOrchestratorError('capability is required', 'capability_required');
    }
    if (req.params === undefined || req.params === null) {
      throw new ServiceOrchestratorError('params is required', 'params_required');
    }
    if (!req.toDID) {
      throw new ServiceOrchestratorError('toDID is required', 'to_did_required');
    }
    // Canonicalize ONCE at the boundary; validation + Core send use this.
    const capability = canonicalizeRequested(req.capability);
    // Review #5: DO NOT use `req.schemaHash` to gate validation here.
    // In `issueQuery` the schema_hash comes from the AppView profile
    // (a trusted signal). Here the caller is the LLM `query_service`
    // tool — the model can emit a bogus or hallucinated hash, and if
    // we treated that as a "version mismatch" we'd silently disable
    // the very guard this layer exists to provide. `req.schemaHash`
    // is still forwarded on the wire so Core / the provider can do
    // their own version check; we just don't let it turn off OUR
    // validator. Pass `undefined` so the gate always uses the
    // hashes-agree branch — i.e. validates when a local schema is
    // registered.
    validateParamsSenderSide(capability, req.params, undefined);

    const ttlSeconds = this.pickTtlRaw(req.ttlSeconds, capability);
    const queryId = this.generateQueryId();

    let sendResult: ServiceQueryResult;
    try {
      sendResult = await this.core.sendServiceQuery({
        toDID: req.toDID,
        capability,
        // Same narrowing as issueQuery — sender-side validator rejected
        // non-objects already.
        params: req.params as Record<string, unknown>,
        queryId,
        ttlSeconds,
        serviceName: req.serviceName ?? req.toDID,
        originChannel: req.originChannel,
        schemaHash:
          req.schemaHash !== undefined && req.schemaHash !== '' ? req.schemaHash : undefined,
        // Carry the LLM-chosen listing's uri (multi-listing per DID).
        serviceUri: req.serviceUri !== undefined && req.serviceUri !== '' ? req.serviceUri : undefined,
        // Carry the grant id for a known_only listing (provider authorizes by
        // grant_id + the authenticated caller DID).
        grantId: req.grantId !== undefined && req.grantId !== '' ? req.grantId : undefined,
      });
    } catch (err) {
      throw new ServiceOrchestratorError(
        `failed to send service.query: ${(err as Error).message ?? String(err)}`,
        'send_failed',
      );
    }

    return {
      queryId: sendResult.queryId || queryId,
      taskId: sendResult.taskId,
      toDID: req.toDID,
      serviceName: req.serviceName ?? req.toDID,
      // Same `?? false` collapse as issueQuery — CoreClient's deduped is
      // optional; the orchestrator's result shape is always-boolean.
      deduped: sendResult.deduped ?? false,
    };
  }

  private pickTtlRaw(override: number | undefined, capability: string): number {
    // Client-side validation matches Core's `/v1/service/query` rule:
    // 1 <= ttl_seconds <= MAX_SERVICE_TTL. Previously the orchestrator
    // accepted any positive integer and let Core reject it — which
    // meant invalid TTLs (e.g. 10_000_000 from a buggy LLM tool call)
    // went all the way through the agentic loop before failing at the
    // Core boundary, wasting tokens + a request ID. Review #20.
    if (override !== undefined) {
      if (
        !Number.isFinite(override) ||
        !Number.isInteger(override) ||
        override < 1 ||
        override > MAX_SERVICE_TTL
      ) {
        throw new Error(
          `ServiceQueryOrchestrator: ttl_seconds override must be an integer in [1, ${MAX_SERVICE_TTL}] (got ${override})`,
        );
      }
      return override;
    }
    return getTTL(capability);
  }
}

/** Default query-id: 16-byte hex. Matches existing dina-mobile conventions. */
function defaultQueryId(): string {
  return bytesToHex(randomBytes(16));
}

function isSearchRejectionNoCandidate(err: unknown): boolean {
  return (
    err instanceof AppViewError &&
    err.status === 400 &&
    err.path === '/xrpc/com.dinakernel.service.search'
  );
}
