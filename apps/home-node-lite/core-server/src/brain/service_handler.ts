/**
 * Inbound service.query handler (GAP.md row #19 closure — M3 blocker).
 *
 * When Brain's home node is configured as a PROVIDER (publishing a
 * service profile to AppView), other Dinas send it `service.query`
 * messages over D2D. Each query names a capability + carries typed
 * params + a `schema_hash` pin.
 *
 * This primitive is the **decision half** of the inbound flow:
 *
 *   incoming query → validate schema_hash → validate params
 *                  → apply response policy
 *                  → produce one of:
 *                      { action: 'respond', body }   (auto or canned)
 *                      { action: 'delegate', taskSpec } (auto → OpenClaw)
 *                      { action: 'reject', body }    (schema/auth/policy fail)
 *                      { action: 'review', taskSpec } (operator must approve)
 *
 * The IO side — reading service config from Core, creating the
 * delegation task, wiring the response back onto D2D — is the
 * caller's job. Keeping this primitive pure + injected means the
 * routing policy is testable offline without a running service
 * mesh.
 *
 * **Schema validation** is a tiny JSON-Schema subset matching
 * `tool_registry.ts::validateArgs` semantics (object with required
 * keys, typed primitives, nested objects). Reusing its rules keeps
 * inbound-query validation consistent with LLM-tool validation.
 *
 * **Response policies** mirror the Python `responsePolicy` per-capability
 * field: `auto` (fire-and-forget delegation), `review` (notify
 * operator), `deny` (return deny-response).
 *
 * **Canned responses** — some capabilities (e.g. `ping`, `capabilities`)
 * don't need a delegation task; the handler answers directly. A
 * capability config can supply a `cannedResponse` object which the
 * handler returns verbatim.
 *
 * Source: GAP.md (task 5.46 follow-up) — M3 service-network gate.
 */

export type CapabilityResponsePolicy = 'auto' | 'review' | 'deny';

/** Subset of JSON Schema the handler supports — mirrors tool_registry. */
export interface CapabilityParamSchema {
  type: 'object';
  properties?: Record<string, { type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' }>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface CapabilityConfig {
  /** Capability name (e.g. `eta_query`). */
  name: string;
  /** Current schema hash published to AppView. */
  schemaHash: string;
  /** Params JSON Schema. */
  paramsSchema: CapabilityParamSchema;
  /** Policy for this capability. */
  policy: CapabilityResponsePolicy;
  /**
   * Optional canned response body returned verbatim on `auto` when
   * no delegation task is needed (e.g. `ping` → `{ok: true}`). When
   * absent + policy `auto`, the handler returns a delegation taskSpec.
   */
  cannedResponse?: Record<string, unknown>;
}

export interface InboundQuery {
  queryId: string;
  fromDid: string;
  capability: string;
  schemaHash: string;
  params: Record<string, unknown>;
  /** Unix seconds — echoed in the response for audit. */
  receivedAt: number;
}

export type HandlerAction =
  | { action: 'respond'; body: Record<string, unknown> }
  | { action: 'delegate'; taskSpec: DelegationTaskSpec }
  | { action: 'review'; taskSpec: DelegationTaskSpec }
  | { action: 'reject'; body: ErrorBody };

export interface DelegationTaskSpec {
  /** Suggested task-id — caller may override. */
  suggestedTaskId: string;
  /** Echoes the capability. */
  capability: string;
  /** Validated params — ready to hand to OpenClaw. */
  params: Record<string, unknown>;
  /** Originating query metadata for the D2D response bridge. */
  queryId: string;
  fromDid: string;
  /** Free-form origin — `auto` or `review`. */
  kind: 'auto_delegation' | 'review_pending_approval';
  /** Echoes receivedAt. */
  receivedAt: number;
}

export interface ErrorBody {
  queryId: string;
  status: 'error';
  error: HandlerRejectionReason;
  detail?: string;
}

export type HandlerRejectionReason =
  | 'unknown_capability'
  | 'schema_version_mismatch'
  | 'invalid_params'
  | 'policy_deny'
  | 'malformed_query';

export interface ServiceHandlerConfig {
  /** Capabilities this service is configured to handle. */
  capabilities: ReadonlyArray<CapabilityConfig>;
  /** Suggested-task-id generator. Injectable for tests. */
  makeTaskIdFn?: () => string;
}

/**
 * Decide how to handle an inbound query. Returns a structured action
 * outcome — NEVER throws.
 */
export function handleInboundQuery(
  query: InboundQuery,
  config: ServiceHandlerConfig,
): HandlerAction {
  const queryValidation = validateQueryShape(query);
  if (queryValidation !== null) {
    return rejectWith(query, 'malformed_query', queryValidation);
  }

  const capability = config.capabilities.find((c) => c.name === query.capability);
  if (!capability) {
    return rejectWith(query, 'unknown_capability', query.capability);
  }

  if (capability.schemaHash !== query.schemaHash) {
    return rejectWith(
      query,
      'schema_version_mismatch',
      `expected ${capability.schemaHash}, got ${query.schemaHash}`,
    );
  }

  const paramErrors = validateParams(query.params, capability.paramsSchema);
  if (paramErrors.length > 0) {
    return rejectWith(query, 'invalid_params', paramErrors.join('; '));
  }

  if (capability.policy === 'deny') {
    return rejectWith(query, 'policy_deny', 'capability configured as deny');
  }

  // `auto` → canned response if supplied, else delegate to local executor.
  if (capability.policy === 'auto') {
    if (capability.cannedResponse) {
      return {
        action: 'respond',
        body: {
          queryId: query.queryId,
          status: 'success',
          result: { ...capability.cannedResponse },
        },
      };
    }
    return {
      action: 'delegate',
      taskSpec: buildTaskSpec(query, 'auto_delegation', config),
    };
  }

  // `review` → operator-gated delegation task.
  return {
    action: 'review',
    taskSpec: buildTaskSpec(query, 'review_pending_approval', config),
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validateQueryShape(query: InboundQuery): string | null {
  if (!query || typeof query !== 'object') return 'query must be an object';
  if (typeof query.queryId !== 'string' || query.queryId === '') return 'queryId required';
  if (typeof query.fromDid !== 'string' || !query.fromDid.startsWith('did:')) return 'fromDid must be a DID';
  if (typeof query.capability !== 'string' || query.capability === '') return 'capability required';
  if (typeof query.schemaHash !== 'string' || query.schemaHash === '') return 'schemaHash required';
  if (!query.params || typeof query.params !== 'object') return 'params must be an object';
  if (!Number.isFinite(query.receivedAt)) return 'receivedAt must be finite';
  return null;
}

/**
 * Validate `params` against a tiny JSON-Schema subset. Returns ALL
 * validation errors (so the querier can fix in one round-trip).
 */
export function validateParams(
  params: Record<string, unknown>,
  schema: CapabilityParamSchema,
): string[] {
  const errors: string[] = [];
  if (schema.type !== 'object') {
    errors.push('schema.type must be "object"');
    return errors;
  }
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  for (const key of required) {
    if (!(key in params)) errors.push(`missing required: ${key}`);
  }
  for (const [key, value] of Object.entries(params)) {
    const propSchema = props[key];
    if (!propSchema) {
      if (schema.additionalProperties === false) {
        errors.push(`unknown property: ${key}`);
      }
      continue;
    }
    if (!typeMatches(value, propSchema.type)) {
      errors.push(`${key}: expected ${propSchema.type}, got ${typeOf(value)}`);
    }
  }
  return errors;
}

function typeMatches(
  value: unknown,
  expected: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array',
): boolean {
  switch (expected) {
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function rejectWith(
  query: InboundQuery,
  error: HandlerRejectionReason,
  detail?: string,
): HandlerAction {
  const body: ErrorBody = {
    queryId: typeof query?.queryId === 'string' ? query.queryId : '',
    status: 'error',
    error,
  };
  if (detail !== undefined) body.detail = detail;
  return { action: 'reject', body };
}

function buildTaskSpec(
  query: InboundQuery,
  kind: DelegationTaskSpec['kind'],
  config: ServiceHandlerConfig,
): DelegationTaskSpec {
  const makeTaskId =
    config.makeTaskIdFn ?? (() => `svc-task-${query.queryId}`);
  return {
    suggestedTaskId: makeTaskId(),
    capability: query.capability,
    params: { ...query.params },
    queryId: query.queryId,
    fromDid: query.fromDid,
    kind,
    receivedAt: query.receivedAt,
  };
}
