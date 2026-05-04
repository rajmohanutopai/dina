/**
 * Bus Driver tool set — the three tools the LLM uses during `/ask` to
 * classify a query as service-answerable and dispatch it.
 *
 *   geocode                    free-text address → {lat, lng}
 *   search_provider_services     capability + geo  → ranked service profiles
 *   query_service              operator DID + params → task_id (fire-and-forget)
 *
 * Each tool is a factory returning an `AgentTool`. Factories accept their
 * dependencies (AppView client, orchestrator, injectable fetch) so the
 * tools can be unit-tested against fakes.
 *
 * Source: main-dina `brain/src/service/vault_context.py:VAULT_TOOLS`
 *         (geocode / search_provider_services / query_service entries).
 */

import type { AgentTool } from './tool_registry';
import type { AppViewClient, ServiceProfile } from '../appview_client/http';
import type { ServiceQueryOrchestrator } from '../service/service_query_orchestrator';
import type { Contact } from '../../../core/src/contacts/directory';
import { autofillRequesterFields, type RequesterAutofillSchema } from './requester_autofill';

// ---------------------------------------------------------------------------
// geocode
// ---------------------------------------------------------------------------

export interface GeocodeToolOptions {
  /** Injectable fetch for tests + custom TLS configs. */
  fetch?: typeof globalThis.fetch;
  /**
   * Nominatim requires a User-Agent with contact info per their usage
   * policy. Default: `dina-mobile/0.0.1 (ops@dinakernel.com)` — callers
   * should override with a real contact on production builds.
   */
  userAgent?: string;
  /** Override endpoint (demo defaults to public Nominatim). */
  endpoint?: string;
  /**
   * Optional rate-limiter ceiling in ms — the tool waits at least this
   * long between calls to respect Nominatim's 1 req/sec rule. Default
   * 1_100 ms.
   */
  minGapMs?: number;
  /**
   * Hard timeout for a single Nominatim HTTP call. Default 10_000 ms.
   * Without this a stalled upstream can hang the whole agentic tool
   * loop because the loop awaits `execute()` synchronously (review
   * #18). On timeout the tool throws a "geocode: timeout" error which
   * the loop catches and returns to the LLM as a tool failure.
   */
  timeoutMs?: number;
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  display_name: string;
}

const DEFAULT_NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const DEFAULT_USER_AGENT = 'dina-mobile/0.0.1 (ops@dinakernel.com)';
const DEFAULT_MIN_GAP_MS = 1_100;
const DEFAULT_GEOCODE_TIMEOUT_MS = 10_000;

/**
 * Factory — returns an `AgentTool` that geocodes a free-text address via
 * Nominatim. For production deployments that want offline / commercial
 * providers, swap the body via a different factory while keeping the
 * `geocode` name so the LLM prompt stays stable.
 */
export function createGeocodeTool(options: GeocodeToolOptions = {}): AgentTool {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? DEFAULT_NOMINATIM_ENDPOINT;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GEOCODE_TIMEOUT_MS;
  let lastCallMs = 0;

  return {
    name: 'geocode',
    description:
      'Convert a free-text address, landmark, or place name into latitude + longitude coordinates. Useful when the user mentions a location by name ("Castro, SF", "Saratoga Junction") and a downstream service needs coordinates.',
    parameters: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'The free-text address, landmark, or place name to geocode.',
        },
      },
      required: ['address'],
    },
    async execute(args): Promise<GeocodeResult> {
      const address = String(args.address ?? '');
      if (address === '') throw new Error('geocode: address is required');
      const gap = Date.now() - lastCallMs;
      if (gap < minGapMs) {
        await new Promise((r) => setTimeout(r, minGapMs - gap));
      }
      lastCallMs = Date.now();
      const url = `${endpoint}?q=${encodeURIComponent(address)}&format=jsonv2&limit=1`;
      // Review #18: hard timeout — the agentic loop awaits execute()
      // synchronously, so a stalled Nominatim response would freeze the
      // whole chat turn until the LLM gave up.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await fetchFn(url, {
          headers: { 'User-Agent': userAgent, Accept: 'application/json' },
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError' || controller.signal.aborted) {
          throw new Error(`geocode: timeout after ${timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) {
        throw new Error(`geocode: HTTP ${resp.status}`);
      }
      const rows = (await resp.json()) as Array<{
        lat?: string;
        lon?: string;
        display_name?: string;
      }>;
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error(`geocode: no result for "${address}"`);
      }
      const top = rows[0];
      const lat = Number(top.lat);
      const lng = Number(top.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new Error('geocode: malformed coordinates in response');
      }
      return {
        lat,
        lng,
        display_name: top.display_name ?? address,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// search_provider_services
// ---------------------------------------------------------------------------

export interface SearchProviderServicesToolOptions {
  appViewClient: Pick<AppViewClient, 'searchServices'>;
  /** Cap the number of profiles returned to the LLM. Default 5. */
  resultLimit?: number;
}

/** Per-capability schema block returned to the LLM — trimmed from the
 *  published record so the agent sees params shape, description, hash,
 *  and TTL without blowing the prompt budget. GAP-PROF-04. */
export interface LLMCapabilitySchemaBlock {
  /** JSON Schema for params — lets the agent see required fields and
   *  types when composing a `query_service` call. */
  params_schema: Record<string, unknown>;
  /** Canonical hash (must be forwarded on `query_service` for version
   *  safety). */
  schema_hash: string;
  /** Human-facing description of what the capability returns. */
  description?: string;
  /** Per-capability TTL hint in seconds. `query_service` falls back to
   *  this when the caller omits `ttl_seconds`. */
  default_ttl_seconds?: number;
}

/**
 * Factory — returns an `AgentTool` that searches AppView for public
 * services matching a capability and (optionally) geo filter.
 *
 * Returned profiles are trimmed to the fields the LLM needs: DID, name,
 * capabilities list, per-capability schema block (params + hash +
 * description + TTL hint), optional distance. Matches main-dina's shape
 * so the mobile agent sees the same provider contract.
 */
export function createSearchProviderServicesTool(
  options: SearchProviderServicesToolOptions,
): AgentTool {
  const limit = options.resultLimit ?? 5;
  return {
    name: 'search_provider_services',
    description:
      'Find provider services on the Dina network that advertise a given capability (e.g. "eta_query" for transit ETAs). Returns a ranked list of service profiles with their DIDs, names, and per-capability schema blocks (params shape, hash, description, TTL). Pass lat/lng when the user mentioned a location.',
    parameters: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description: 'The capability name to search for (e.g. "eta_query", "price_check").',
        },
        lat: { type: 'number', description: 'Optional viewer latitude for proximity ranking.' },
        lng: { type: 'number', description: 'Optional viewer longitude for proximity ranking.' },
        radius_km: { type: 'number', description: 'Optional search radius in kilometres.' },
        q: { type: 'string', description: 'Optional free-text match against service names.' },
      },
      required: ['capability'],
    },
    async execute(args): Promise<Array<LLMProfile>> {
      const capability = String(args.capability ?? '');
      if (capability === '') throw new Error('search_provider_services: capability is required');
      const profiles = await options.appViewClient.searchServices({
        capability,
        lat: typeof args.lat === 'number' ? args.lat : undefined,
        lng: typeof args.lng === 'number' ? args.lng : undefined,
        radiusKm: typeof args.radius_km === 'number' ? args.radius_km : undefined,
        q: typeof args.q === 'string' ? args.q : undefined,
      });
      return profiles.slice(0, limit).map(toLLMProfile);
    },
  };
}

export interface LLMProfile {
  did: string;
  name: string;
  capabilities: string[];
  response_policy?: Record<string, 'auto' | 'review'>;
  /** Per-capability schema blocks (params shape + hash + description +
   *  TTL). Only present when the provider published schemas. */
  capability_schemas?: Record<string, LLMCapabilitySchemaBlock>;
  distance_km?: number;
}

function toLLMProfile(p: ServiceProfile): LLMProfile {
  const capabilitySchemas: Record<string, LLMCapabilitySchemaBlock> = {};
  if (p.capabilitySchemas !== undefined) {
    for (const [cap, schema] of Object.entries(p.capabilitySchemas)) {
      const block: LLMCapabilitySchemaBlock = {
        params_schema: schema.params ?? {},
        schema_hash: schema.schemaHash ?? '',
      };
      if (typeof schema.description === 'string' && schema.description !== '') {
        block.description = schema.description;
      }
      if (typeof schema.defaultTtlSeconds === 'number' && schema.defaultTtlSeconds > 0) {
        block.default_ttl_seconds = schema.defaultTtlSeconds;
      }
      capabilitySchemas[cap] = block;
    }
  }
  return {
    did: p.did,
    name: p.name,
    capabilities: p.capabilities,
    response_policy: p.responsePolicy,
    capability_schemas: Object.keys(capabilitySchemas).length > 0 ? capabilitySchemas : undefined,
    distance_km: p.distanceKm,
  };
}

// ---------------------------------------------------------------------------
// query_service
// ---------------------------------------------------------------------------

export interface QueryServiceToolOptions {
  orchestrator: Pick<ServiceQueryOrchestrator, 'issueQueryToDID'>;
  /**
   * Optional AppView client for schema auto-fetch (WM-BRAIN-06d). When
   * supplied AND the caller omitted `schema_hash`, the tool calls
   * `searchServices({capability})`, finds the profile whose
   * `did === operator_did`, and forwards that profile's advertised
   * `capabilitySchemas[capability].schemaHash` to the orchestrator.
   *
   * When omitted, auto-fetch is skipped — the tool still works (some
   * providers publish no schema). Callers that CAN supply an AppView
   * client SHOULD, because it closes the window where an LLM chooses
   * a provider via some other path (intent-classifier SHORTCUT, a
   * previously-stored DID) and has no hash for version safety.
   */
  appViewClient?: Pick<AppViewClient, 'searchServices'>;
  /**
   * Optional structured-log sink. A failed AppView fetch emits
   * `tool_executor.query_service.schema_autofetch_failed` here. When
   * omitted, failures are silent.
   */
  logger?: (entry: Record<string, unknown>) => void;
}

/**
 * Factory — returns an `AgentTool` that dispatches a service query via
 * the orchestrator. Fire-and-forget: the call returns `{task_id, ...}`
 * immediately; the actual response arrives later as a workflow event
 * and is delivered via `WorkflowEventConsumer.deliver` to the chat
 * thread (wired by the bootstrap, D4).
 *
 * The LLM should return a short user-facing ack after this tool ("Asking
 * Bus 42…") and NOT block waiting for the answer.
 */
export function createQueryServiceTool(options: QueryServiceToolOptions): AgentTool {
  return {
    name: 'query_service',
    description:
      'Send a structured service query to a specific provider DID. Fire-and-forget: returns a task_id immediately; the answer is delivered asynchronously to the chat thread. Use after search_provider_services has identified the target.',
    parameters: {
      type: 'object',
      properties: {
        operator_did: {
          type: 'string',
          description: 'The provider DID from search_provider_services results.',
        },
        capability: {
          type: 'string',
          description: 'The capability to invoke (e.g. "eta_query").',
        },
        params: {
          type: 'object',
          description: 'Capability-specific parameters. Shape depends on the capability.',
        },
        schema_hash: {
          type: 'string',
          description:
            'The per-capability schema hash from search_provider_services (forwarded for version safety).',
        },
        service_name: {
          type: 'string',
          description:
            "The provider's display name from search_provider_services (used as the acknowledgement label).",
        },
        ttl_seconds: {
          type: 'number',
          description: 'Optional TTL override. Default comes from the capability registry.',
        },
      },
      required: ['operator_did', 'capability', 'params'],
    },
    async execute(args): Promise<{
      task_id: string;
      query_id: string;
      to_did: string;
      service_name: string;
      deduped: boolean;
      status: 'pending';
    }> {
      const operatorDID = String(args.operator_did ?? '');
      const capability = String(args.capability ?? '');
      if (operatorDID === '' || capability === '') {
        throw new Error('query_service: operator_did and capability are required');
      }
      // Review #12: `params` is declared required by the tool schema
      // and every known capability expects a concrete shape (eta_query
      // needs route_id + location, etc.). Silently substituting {}
      // hid bugs where the LLM called query_service without having
      // ever called geocode → search_provider_services first. Fail
      // fast so the loop surfaces a tool error back to the LLM and
      // it retries correctly.
      if (args.params === undefined || args.params === null) {
        throw new Error('query_service: params is required');
      }
      if (typeof args.params !== 'object' || Array.isArray(args.params)) {
        throw new Error('query_service: params must be a JSON object');
      }
      let params = args.params as Record<string, unknown>;
      let schemaHash =
        typeof args.schema_hash === 'string' && args.schema_hash !== ''
          ? args.schema_hash
          : undefined;
      let serviceName = typeof args.service_name === 'string' ? args.service_name : undefined;
      let ttl = typeof args.ttl_seconds === 'number' ? args.ttl_seconds : undefined;
      let paramsSchema: RequesterAutofillSchema | undefined;

      // WM-BRAIN-06d: if the LLM didn't route via search_provider_services
      // first (intent-classifier SHORTCUT, cached DID, whatever), the
      // schema_hash is missing. Probe AppView for the advertised hash
      // so the orchestrator can still assert version safety. Fail-soft:
      // any lookup problem is logged and the query still goes through
      // without a hash — a provider that needs one will reject with
      // `schema_version_mismatch`, which is a legitimate answer.
      //
      // GAP-PROF-05: while we're there, also hydrate the published
      // `params` JSON Schema (for requester autofill) and the
      // per-capability `defaultTtlSeconds` (so TTL falls back to the
      // provider's advertised value when the caller omits one).
      if (options.appViewClient !== undefined) {
        try {
          const profiles = await options.appViewClient.searchServices({ capability });
          const match = profiles.find((p) => p.did === operatorDID);
          if (match !== undefined) {
            const published = match.capabilitySchemas?.[capability];
            if (published !== undefined) {
              if (
                schemaHash === undefined &&
                typeof published.schemaHash === 'string' &&
                published.schemaHash !== ''
              ) {
                schemaHash = published.schemaHash;
              }
              if (published.params !== undefined && typeof published.params === 'object') {
                paramsSchema = published.params as RequesterAutofillSchema;
              }
              if (
                ttl === undefined &&
                typeof published.defaultTtlSeconds === 'number' &&
                published.defaultTtlSeconds > 0
              ) {
                ttl = published.defaultTtlSeconds;
              }
            }
            if (serviceName === undefined && typeof match.name === 'string' && match.name !== '') {
              serviceName = match.name;
            }
          }
        } catch (err) {
          options.logger?.({
            event: 'tool_executor.query_service.schema_autofetch_failed',
            operator_did: operatorDID,
            capability,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // GAP-AUTOFILL-01: apply requester-identity autofill. ANY required
      // field whose name looks like an identity slot (patient_*,
      // customer_*, account_*, member_*) gets the wire sentinel `"self"`
      // when the caller omitted it. No-op when the schema is absent or
      // has no matching required fields.
      if (paramsSchema !== undefined) {
        const filled = autofillRequesterFields(params, paramsSchema);
        params = filled.params;
        if (filled.filled.length > 0) {
          options.logger?.({
            event: 'tool_executor.query_service.requester_autofill',
            operator_did: operatorDID,
            capability,
            filled: filled.filled,
          });
        }
      }

      // Issue #7: dispatch to the EXACT DID the LLM chose — after the
      // optional schema auto-fetch, not before. No AppView-driven DID
      // substitution, no ranker substitution.
      // Issue #14: forward the service_name through so the orchestrator
      // has a human-readable label for ack/formatting instead of
      // falling back to the DID.
      const result = await options.orchestrator.issueQueryToDID({
        toDID: operatorDID,
        capability,
        params,
        ttlSeconds: ttl,
        schemaHash,
        serviceName,
        originChannel: 'ask',
      });
      return {
        task_id: result.taskId,
        query_id: result.queryId,
        to_did: result.toDID,
        service_name: result.serviceName,
        deduped: result.deduped,
        status: 'pending',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// find_preferred_provider (PC-BRAIN-07)
// ---------------------------------------------------------------------------

/**
 * Minimal CoreClient surface needed by this tool — keeps the tool
 * decoupled from the rest of Core so tests can inject a one-method fake.
 */
export interface PreferredContactsClient {
  findContactsByPreference(category: string): Promise<Contact[]>;
}

export interface FindPreferredProviderToolOptions {
  core: PreferredContactsClient;
  /**
   * Optional AppView client. When present, each matched contact's
   * currently-published capabilities are fetched from AppView and
   * included in the tool's output so the LLM can pick a capability
   * and go straight to `query_service` — no intermediate
   * `search_provider_services` turn needed. When omitted the tool
   * still works but returns providers with empty `capabilities` (the
   * LLM can still route via `query_service` if it knows a
   * capability from another source).
   */
  appViewClient?: Pick<AppViewClient, 'isDiscoverable'>;
  /**
   * Optional structured-log sink. Emits
   * `tool_executor.find_preferred_*_failed` events on Core / AppView
   * hiccups so operators can spot them in telemetry without the tool
   * throwing.
   */
  logger?: (entry: Record<string, unknown>) => void;
}

/**
 * Return shape — an array of providers the user has asserted as
 * their go-to for `category`, each with their currently-published
 * capability list. An empty `providers` array with a `message`
 * signals the fall-back path ("no preferred provider for this
 * category — use search_provider_services next").
 *
 * Exported so tests can import the shape without re-deriving it.
 */
export interface PreferredProviderEntry {
  contact_did: string;
  contact_name: string;
  trust_level: string;
  capabilities: Array<{ name: string }>;
}
export interface FindPreferredProviderResult {
  providers: PreferredProviderEntry[];
  count?: number;
  message?: string;
  error?: string;
}

/**
 * Factory — returns an `AgentTool` that finds the user's go-to
 * contact(s) for a service category (dental / legal / tax / ...).
 *
 * The tool is deliberately LLM-first in its error handling: all
 * failure modes produce a benign `{providers: []}` with an advisory
 * `message`, rather than throwing, so the agentic loop stays on
 * rails. The system prompt (PC-BRAIN-08, pending) instructs the
 * agent to fall back to `search_provider_services` on an empty
 * result — loud errors here would force a defensive branch for a
 * cold path.
 *
 * Port of `brain/src/service/vault_context.py::_find_preferred_provider`.
 */
export function createFindPreferredProviderTool(
  options: FindPreferredProviderToolOptions,
): AgentTool {
  return {
    name: 'find_preferred_provider',
    description:
      'Find the user\'s go-to contact for a given service category (e.g. "dental", "legal", "tax"). Returns the user\'s preferred provider(s) — already-established contacts the user has explicitly chosen for that category — plus their currently-published capabilities from AppView. PREFER THIS over search_provider_services when the question is about an established service relationship ("my dentist", "my lawyer", "my accountant"), because it honours the user\'s choice rather than re-ranking providers each time. If this returns no candidates, fall back to search_provider_services.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description:
            'Service category, lowercase single token where possible: dental, medical, legal, tax, automotive, plumbing, electrical, veterinary, hair, mental_health, fitness, pharmacy, optical, chiropractic, physiotherapy, real_estate, banking, childcare, education, construction, landscaping, floral, tailoring, architecture.',
        },
      },
      required: ['category'],
    },
    async execute(args): Promise<FindPreferredProviderResult> {
      const category = typeof args.category === 'string' ? args.category.trim() : '';
      if (category === '') {
        return { providers: [], error: 'category is required' };
      }

      let contacts: Contact[];
      try {
        contacts = await options.core.findContactsByPreference(category);
      } catch (err) {
        options.logger?.({
          event: 'tool_executor.find_preferred_contacts_failed',
          category,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          providers: [],
          message: `contact lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (contacts.length === 0) {
        return {
          providers: [],
          message:
            `No contact has category ${JSON.stringify(category)} in their ` +
            'preferred_for. Do NOT call search_vault again — this is a ' +
            'live-state external query. Call search_provider_services ' +
            'next, with a matching capability and the geocoded location ' +
            '(lat/lng).',
        };
      }

      const providers: PreferredProviderEntry[] = [];
      for (const c of contacts) {
        const did = c.did;
        const name = c.displayName;
        const trust = c.trustLevel;
        const provider: PreferredProviderEntry = {
          contact_did: did,
          contact_name: name,
          trust_level: trust || 'unknown',
          capabilities: [],
        };

        // Pull current capabilities from AppView by DID. The DID's
        // published profile may expose multiple capabilities; include
        // them all so the LLM can pick by intent. Schema + hash for
        // each capability are fetched lazily by `query_service` on
        // dispatch (PC-BRAIN-06d already landed).
        if (options.appViewClient !== undefined && did !== '') {
          try {
            const res = await options.appViewClient.isDiscoverable(did);
            const caps = Array.isArray(res?.capabilities) ? res.capabilities : [];
            for (const cap of caps) {
              if (typeof cap === 'string' && cap !== '') {
                provider.capabilities.push({ name: cap });
              }
            }
          } catch (err) {
            options.logger?.({
              event: 'tool_executor.find_preferred_appview_failed',
              did,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        providers.push(provider);
      }

      return { providers, count: providers.length };
    },
  };
}
