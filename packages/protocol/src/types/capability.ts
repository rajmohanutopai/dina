/**
 * Capability schema + service-config types — the data shape a Dina home
 * node publishes to advertise public services it backs.
 *
 * Published via the AT Protocol `com.dina.service.profile` record on the
 * node's PDS. Requesters read it to discover services, then fire a
 * `service.query` D2D to the advertised capability. The `schemaHash`
 * contract lets them detect version skew.
 *
 * Source: extracted from `@dina/core/src/service/service_config.ts` per
 * docs/HOME_NODE_LITE_TASKS.md task 1.17 (category 1.16e).
 *
 * Zero runtime deps — pure type declarations.
 */

/** How the home node handles incoming `service.query` deliveries. */
export type ServiceResponsePolicy = 'auto' | 'review';

/** Configuration for a single capability published by this node. */
export interface ServiceCapabilityConfig {
  /** Name of the MCP server that backs this capability, e.g. `transit`. */
  mcpServer: string;
  /** MCP tool within that server to invoke. */
  mcpTool: string;
  /** Whether responses are auto-sent or gated by operator review. */
  responsePolicy: ServiceResponsePolicy;
  /**
   * SHA-256 of the canonical schema for this capability. Published
   * alongside the profile so requesters can detect version skew.
   */
  schemaHash?: string;
}

/** Per-capability JSON Schemas, published via the service profile. */
export interface ServiceCapabilitySchemas {
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  schemaHash: string;
  /**
   * Human-facing description of what this capability returns. Surfaced
   * to requesters via the published profile and folded into the
   * canonical `schemaHash` so a description change invalidates the
   * cache (matches main-dina).
   */
  description?: string;
  /**
   * Per-capability TTL hint in seconds. Purely informational on the
   * publish side; requesters read it from the published profile and
   * use it as their `ttl_seconds` default when they omit one on
   * `query_service`.
   */
  defaultTtlSeconds?: number;
}

/** The full local service configuration. Mirrors the Go `ServiceConfig`. */
export interface ServiceConfig {
  /**
   * Whether this home node is publicly discoverable. When `false`, the
   * service-profile record is removed from PDS and no inbound service
   * queries bypass the contact gate.
   */
  isDiscoverable: boolean;
  /** Human-readable service name. */
  name: string;
  description?: string;
  /** One entry per advertised capability. */
  capabilities: Record<string, ServiceCapabilityConfig>;
  /** JSON Schemas per capability. Omit to leave params unvalidated. */
  capabilitySchemas?: Record<string, ServiceCapabilitySchemas>;
}
