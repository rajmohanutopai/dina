/**
 * `service_query_execution` task payload — THE codec.
 *
 * This shape rides a workflow task from the provider's ServiceHandler to
 * whoever executes it (the in-process Tier 1 runner, a paired dina-agent
 * over `POST /v1/workflow/tasks/claim`, or — via the approval hop — the
 * WorkflowEventConsumer → executeAndRespond chain), and is read AGAIN by
 * Core's Response Bridge when the task completes. Before this module it
 * was hand-built in two places and hand-parsed in four; two of those
 * parsers silently dropped fields (`service_uri`, `schema_snapshot`,
 * `mcp_tool`) — found live in the Tier 1 salon demo when an approved
 * booking executed against the wrong listing. One builder + one parser
 * closes the CLASS: a field added here is added everywhere.
 *
 * Wire compatibility (do not break — the Python dina-agent daemon reads
 * this JSON off the claim response):
 *   - snake_case field names.
 *   - `type`, `from_did`, `query_id`, `capability`, `params`,
 *     `ttl_seconds`, `service_name`, `schema_hash`, `mcp_tool` are
 *     ALWAYS present (string fields default to '').
 *   - `mcp_server`, `schema_snapshot`, `service_uri`,
 *     `operator_approved` appear only when meaningful.
 *
 * Parse normalization: the wire writes '' when a string value is absent;
 * `parseServiceQueryExecutionPayload` normalizes '' → undefined so TS
 * consumers branch on presence, not empty-string sentinels.
 *
 * Zero runtime deps (enforced by dep_hygiene.test.ts).
 */

export const SERVICE_QUERY_EXECUTION_TYPE = 'service_query_execution' as const;

/**
 * Frozen copy of the capability's published schema at task-creation time
 * (GAP-SH-03/04). snake_case to match main-dina's persisted shape.
 */
export interface ServiceExecutionSchemaSnapshot {
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  schema_hash: string;
}

/** Parsed + normalized payload. See module docs for wire shape. */
export interface ServiceQueryExecutionPayload {
  type: typeof SERVICE_QUERY_EXECUTION_TYPE;
  /** Requester DID (authenticated at Core ingress). */
  from_did: string;
  /** The `service.query`'s query_id — correlation key for the response. */
  query_id: string;
  /** Canonical capability name. */
  capability: string;
  /** Query params — validated + stripped at ingress; opaque here. */
  params: unknown;
  ttl_seconds?: number;
  service_name?: string;
  schema_hash?: string;
  /** MCP tool routing key (agent lane). */
  mcp_tool?: string;
  /**
   * The capability's runner (agent lane). Only persisted on APPROVAL
   * payloads — the approval→delegation hop needs it to stamp
   * `requested_runner` on the fresh execution task.
   */
  mcp_server?: string;
  schema_snapshot?: ServiceExecutionSchemaSnapshot;
  /** Multi-listing pin — AT-URI of the listing the requester chose. */
  service_uri?: string;
  /**
   * True when this execution was spawned by an operator's approval
   * (`executeAndRespond`). The Tier 1 runtime tells the model the
   * human gate already passed ("ask me first" → confirm, not re-ask).
   */
  operator_approved?: boolean;
}

/** Builder input — same fields, presence-optional where the wire defaults. */
export type ServiceQueryExecutionPayloadInput = Omit<ServiceQueryExecutionPayload, 'type'>;

/**
 * Build the wire object (callers `JSON.stringify` it into the task).
 * Emits the exact legacy shape — see module docs.
 */
export function buildServiceQueryExecutionPayload(
  input: ServiceQueryExecutionPayloadInput,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: SERVICE_QUERY_EXECUTION_TYPE,
    from_did: input.from_did,
    query_id: input.query_id,
    capability: input.capability,
    params: input.params,
    ttl_seconds: input.ttl_seconds ?? 60,
    service_name: input.service_name ?? '',
    schema_hash: input.schema_hash ?? '',
    mcp_tool: input.mcp_tool ?? '',
  };
  if (input.mcp_server !== undefined && input.mcp_server !== '') {
    out.mcp_server = input.mcp_server;
  }
  if (input.schema_snapshot !== undefined) {
    out.schema_snapshot = input.schema_snapshot;
  }
  if (input.service_uri !== undefined && input.service_uri !== '') {
    out.service_uri = input.service_uri;
  }
  if (input.operator_approved === true) {
    out.operator_approved = true;
  }
  return out;
}

/** '' → undefined (the wire's absent-value sentinel for strings). */
function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Narrow a raw `schema_snapshot` to the frozen-snapshot shape. Malformed
 * input degrades to `undefined` — downstream validation then falls back
 * to the capability registry, same as a provider that never published
 * schemas.
 */
export function parseServiceExecutionSchemaSnapshot(
  raw: unknown,
): ServiceExecutionSchemaSnapshot | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  if (
    s.params === null ||
    typeof s.params !== 'object' ||
    s.result === null ||
    typeof s.result !== 'object' ||
    typeof s.schema_hash !== 'string'
  ) {
    return undefined;
  }
  return {
    params: s.params as Record<string, unknown>,
    result: s.result as Record<string, unknown>,
    schema_hash: s.schema_hash,
  };
}

/**
 * Parse a task payload (JSON string or pre-parsed object). Returns `null`
 * when the payload is not a `service_query_execution` (other delegation
 * kinds are someone else's contract) or its required identity fields
 * (`from_did`, `query_id`, `capability`) are missing/empty — a payload
 * the Response Bridge could never answer.
 */
export function parseServiceQueryExecutionPayload(
  raw: string | unknown,
): ServiceQueryExecutionPayload | null {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (p.type !== SERVICE_QUERY_EXECUTION_TYPE) return null;
  const from_did = p.from_did;
  const query_id = p.query_id;
  const capability = p.capability;
  if (
    typeof from_did !== 'string' ||
    from_did === '' ||
    typeof query_id !== 'string' ||
    query_id === '' ||
    typeof capability !== 'string' ||
    capability === ''
  ) {
    return null;
  }
  const ttl =
    typeof p.ttl_seconds === 'number' && Number.isFinite(p.ttl_seconds)
      ? p.ttl_seconds
      : undefined;
  const serviceName = optionalString(p.service_name);
  const schemaHash = optionalString(p.schema_hash);
  const mcpTool = optionalString(p.mcp_tool);
  const mcpServer = optionalString(p.mcp_server);
  const snapshot = parseServiceExecutionSchemaSnapshot(p.schema_snapshot);
  const serviceUri = optionalString(p.service_uri);
  return {
    type: SERVICE_QUERY_EXECUTION_TYPE,
    from_did,
    query_id,
    capability,
    params: p.params,
    ...(ttl !== undefined ? { ttl_seconds: ttl } : {}),
    ...(serviceName !== undefined ? { service_name: serviceName } : {}),
    ...(schemaHash !== undefined ? { schema_hash: schemaHash } : {}),
    ...(mcpTool !== undefined ? { mcp_tool: mcpTool } : {}),
    ...(mcpServer !== undefined ? { mcp_server: mcpServer } : {}),
    ...(snapshot !== undefined ? { schema_snapshot: snapshot } : {}),
    ...(serviceUri !== undefined ? { service_uri: serviceUri } : {}),
    ...(p.operator_approved === true ? { operator_approved: true } : {}),
  };
}
