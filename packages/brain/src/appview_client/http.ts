/**
 * Brain's HTTP client for the AppView service discovery API.
 *
 * This is the **requester-side** surface. The provider side publishes records
 * via PDS (`packages/brain/src/pds/publisher.ts`); the requester reads the
 * indexed view via AppView:
 *
 *   GET /xrpc/com.dina.service.search    — find services by capability + geo
 *   GET /xrpc/com.dina.service.isDiscoverable  — check whether a DID is discoverable
 *
 * The Core-side `AppViewServiceResolver` (`packages/core/src/appview/`) exists
 * for egress-gate bypass decisions and caches `isDiscoverable` results. It is a
 * separate role — Core's resolver is a policy input for D2D sending, while
 * this client drives ranked discovery for LLM tools and Brain orchestration.
 *
 * Retry: 3× exponential backoff on 5xx (reuses `core/src/transport/http_retry`).
 * Non-retryable 4xx (other than 408/429) bubble up as `AppViewError`.
 * Timeout per attempt: 10 s default (matches Python reference `httpx.AsyncClient(timeout=10)`).
 *
 * Source: brain/src/adapter/appview_client.py
 */

import type { Confidence, Sentiment, SubjectType } from '@dina/protocol';
import {
  backoff,
  isRetryableStatus,
  parseResponseBody,
} from '../../../core/src/transport/http_retry';

/** Retryable client-side response statuses beyond 5xx. */
const RETRYABLE_4XX = new Set([408, 429]);

/** Default per-attempt timeout (ms). Mirrors Python `httpx.AsyncClient(timeout=10)`. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Default max retries. Mirrors Brain's `STAGING_MAX_RETRIES`. */
const DEFAULT_MAX_RETRIES = 3;

/**
 * One service profile entry from `com.dina.service.search` results.
 * Field naming is camelCase — this matches AppView's lexicon on the wire.
 */
/**
 * Per-capability published schema. Fidelity with main-dina's shape
 * so the mobile reasoning agent sees the same provider contract the
 * Python agent does. Extended in the PC-remediation audit to carry
 * `description` + `defaultTtlSeconds` + ensure `params`/`result`
 * are surfaced to the model (GAP-PROF-01).
 */
export interface PublishedCapabilitySchema {
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  schemaHash: string;
  /** Human-facing description of what this capability returns —
   *  the reasoning agent uses it when picking between capabilities
   *  on a profile. Optional because older profiles don't carry it. */
  description?: string;
  /** Per-capability TTL hint in seconds. When absent the requester
   *  falls back to the registry default (`getTTL(capability)`). */
  defaultTtlSeconds?: number;
}

export interface ServiceProfile {
  did: string;
  handle?: string;
  name: string;
  description?: string;
  capabilities: string[];
  responsePolicy?: Record<string, 'auto' | 'review'>;
  isDiscoverable: boolean;
  /** Published schemas, one per capability. */
  capabilitySchemas?: Record<string, PublishedCapabilitySchema>;
  /** Distance in km from the query location, if the query supplied lat/lng. */
  distanceKm?: number;
}

/** Parameters for `searchServices`. */
export interface SearchServicesParams {
  capability: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  /** Free-text match against service name/description. */
  q?: string;
  /** Maximum results returned. AppView caps this at 50 today. */
  limit?: number;
}

/** Result of `isDiscoverable`. */
export interface IsDiscoverableResult {
  isDiscoverable: boolean;
  capabilities: string[];
}

// ---------------------------------------------------------------------------
// Trust Network types (mirrors `appview/src/shared/types/api-types.ts`)
// ---------------------------------------------------------------------------

/** Aggregate attestation counts for a trust subject. */
export interface TrustAttestationSummary {
  total: number;
  positive: number;
  neutral: number;
  negative: number;
  averageDimensions: unknown;
}

/** Community-flagged concerns on a subject (scam / fake / deceptive / etc.). */
export interface TrustFlag {
  flagType: string;
  severity: string;
}

/** Authenticity consensus block — present when reviewers have weighed in. */
export interface TrustAuthenticity {
  predominantAssessment: string;
  confidence: number | null;
}

/** How the requester relates to the target in the trust graph. */
export interface TrustGraphContext {
  shortestPath: number | null;
  mutualConnections: number | null;
  trustedAttestors: string[];
}

/**
 * `com.dina.trust.resolve` response — trust level + recommendation
 * for a subject (DID / product / content / etc.). `subject` must be a
 * JSON-stringified subject reference: `{"type":"did","did":"did:plc:..."}`
 * or `{"type":"product","domain":"amazon.com","productId":"B0..."}`.
 */
export interface ResolveTrustResponse {
  subjectType: string;
  trustLevel: string;
  confidence: number;
  attestationSummary: TrustAttestationSummary | null;
  flags: TrustFlag[];
  authenticity: TrustAuthenticity | null;
  graphContext: TrustGraphContext | null;
  recommendation: string;
  reasoning: string;
}

/** `com.dina.trust.resolve` params. `subject` is JSON-stringified. */
export interface ResolveTrustParams {
  subject: string;
  requesterDid?: string;
  domain?: string;
  context?:
    | 'before-transaction'
    | 'before-interaction'
    | 'content-verification'
    | 'product-evaluation'
    | 'general-lookup';
}

/** `com.dina.trust.search` result — raw attestation rows (AppView sends
 *  them as `Attestation` records, not normalised further here). */
export interface TrustAttestation {
  uri?: string;
  cid?: string;
  authorDid?: string;
  subjectId?: string;
  category?: string;
  domain?: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
  confidence?: 'speculative' | 'moderate' | 'high' | 'certain';
  tags?: string[];
  recordCreatedAt?: string;
  [key: string]: unknown;
}

/** `com.dina.trust.search` response — attestation rows + pagination cursor. */
export interface SearchTrustResponse {
  results: TrustAttestation[];
  cursor?: string;
  totalEstimate: number | null;
}

/** `com.dina.trust.search` params (subset of AppView's surface — we
 *  don't expose the full date / cursor / tag-array knobs to the agent
 *  yet, just the fields a product-vendor query needs). */
export interface SearchTrustParams {
  q?: string;
  category?: string;
  domain?: string;
  subjectType?: SubjectType;
  sentiment?: Sentiment;
  minConfidence?: Confidence;
  authorDid?: string;
  tags?: string[];
  sort?: 'recent' | 'relevant';
  limit?: number;
}

/** Configuration for `AppViewClient`. */
export interface AppViewClientOptions {
  /** Base URL of the AppView (trailing slash stripped). */
  appViewURL: string;
  /** Per-attempt request timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** Maximum retries on transient failure. Default 3. */
  maxRetries?: number;
  /** Injectable `fetch`. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /**
   * Injectable sleep for retry backoff — tests override to skip real waits.
   * Must honour the standard `backoff(attempt)` signature (attempt 0-indexed).
   */
  sleepFn?: (attemptZeroIndexed: number) => Promise<void>;
}

/** Structured error raised for every non-success terminal outcome. */
export class AppViewError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly path: string,
  ) {
    super(message);
    this.name = 'AppViewError';
  }
}

/**
 * Read-only AppView client. Safe to share across callers — no mutable state
 * beyond the injected `fetch`.
 */
export class AppViewClient {
  private readonly appViewURL: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleepFn: (attempt: number) => Promise<void>;

  constructor(options: AppViewClientOptions) {
    if (!options.appViewURL) {
      throw new Error('AppViewClient: appViewURL is required');
    }
    this.appViewURL = options.appViewURL.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.sleepFn = options.sleepFn ?? backoff;
    if (this.timeoutMs <= 0) {
      throw new Error(`AppViewClient: timeoutMs must be > 0 (got ${this.timeoutMs})`);
    }
    if (this.maxRetries < 0) {
      throw new Error(`AppViewClient: maxRetries must be ≥ 0 (got ${this.maxRetries})`);
    }
  }

  /**
   * Search for public services by capability (optionally scoped by geo).
   * Returns the `services` array, ordered by trust + proximity as AppView
   * decides. An empty list means "no matches" (not an error).
   *
   * Throws `AppViewError` on HTTP failure past the retry budget.
   */
  async searchServices(params: SearchServicesParams): Promise<ServiceProfile[]> {
    if (!params.capability) {
      throw new AppViewError(
        'searchServices: capability is required',
        null,
        '/xrpc/com.dina.service.search',
      );
    }
    const query: Record<string, string> = { capability: params.capability };
    if (params.lat !== undefined) query.lat = String(params.lat);
    if (params.lng !== undefined) query.lng = String(params.lng);
    if (params.radiusKm !== undefined) query.radiusKm = String(params.radiusKm);
    if (params.q !== undefined && params.q !== '') query.q = params.q;
    if (params.limit !== undefined) query.limit = String(params.limit);

    const body = await this.get('/xrpc/com.dina.service.search', query);
    const services = (body as { services?: unknown }).services;
    if (!Array.isArray(services)) return [];
    // AppView's search xRPC publishes `operatorDid` (matches the AT-Proto
    // record metadata convention) and omits `isDiscoverable` because the
    // search index already filters by it. Coerce to the local
    // `ServiceProfile` shape (`did`, `isDiscoverable: true`) so the
    // downstream validator + LLM tools see the expected wire format.
    const coerced: unknown[] = services.map((s) => {
      if (!s || typeof s !== 'object') return s;
      const r = s as Record<string, unknown>;
      const did = typeof r.did === 'string' ? r.did : (r.operatorDid as string | undefined);
      const isDiscoverable = typeof r.isDiscoverable === 'boolean' ? r.isDiscoverable : true;
      return { ...r, did, isDiscoverable };
    });
    return coerced.filter((s): s is ServiceProfile => isServiceProfile(s)).map(normalizeProfile);
  }

  /**
   * Check whether a DID is registered as a public service, and list its
   * advertised capabilities. Matches Python `is_public` tuple return as an
   * object for ergonomic destructuring: `const {isDiscoverable, capabilities} = …`.
   */
  async isDiscoverable(did: string): Promise<IsDiscoverableResult> {
    if (!did) {
      throw new AppViewError(
        'isDiscoverable: did is required',
        null,
        '/xrpc/com.dina.service.isDiscoverable',
      );
    }
    const body = await this.get('/xrpc/com.dina.service.isDiscoverable', { did });
    const r = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return {
      isDiscoverable: typeof r.isDiscoverable === 'boolean' ? r.isDiscoverable : false,
      capabilities: Array.isArray(r.capabilities)
        ? r.capabilities.filter((c): c is string => typeof c === 'string')
        : [],
    };
  }

  // -------------------------------------------------------------------------
  // Trust Network — `com.dina.trust.*`
  // -------------------------------------------------------------------------

  /**
   * Resolve the trust level of a subject (DID / product / content /
   * etc.). Maps to AppView `com.dina.trust.resolve`. Returns
   * `trustLevel` + `recommendation` + `attestationSummary` so the
   * caller can decide whether to proceed / warn / block.
   *
   * `subject` is a JSON-stringified subject reference (verbatim to
   * AppView's contract):
   *   - `{"type":"did","did":"did:plc:..."}`
   *   - `{"type":"product","domain":"amazon.com","productId":"B0..."}`
   *   - `{"type":"content","uri":"at://..."}`
   *   - `{"type":"organization","domain":"nytimes.com"}`
   */
  async resolveTrust(params: ResolveTrustParams): Promise<ResolveTrustResponse> {
    if (!params.subject) {
      throw new AppViewError(
        'resolveTrust: subject is required',
        null,
        '/xrpc/com.dina.trust.resolve',
      );
    }
    const query: Record<string, string> = { subject: params.subject };
    if (params.requesterDid !== undefined) query.requesterDid = params.requesterDid;
    if (params.domain !== undefined) query.domain = params.domain;
    if (params.context !== undefined) query.context = params.context;

    const body = await this.get('/xrpc/com.dina.trust.resolve', query);
    return body as ResolveTrustResponse;
  }

  /**
   * Free-text / faceted search over trust attestations. Maps to
   * AppView `com.dina.trust.search`. Returns attestation rows (not
   * subject aggregates — use `resolveTrust` for that). Pagination via
   * the returned `cursor`.
   */
  async searchTrust(params: SearchTrustParams): Promise<SearchTrustResponse> {
    const query: Record<string, string> = {};
    if (params.q !== undefined) query.q = params.q;
    if (params.category !== undefined) query.category = params.category;
    if (params.domain !== undefined) query.domain = params.domain;
    if (params.subjectType !== undefined) query.subjectType = params.subjectType;
    if (params.sentiment !== undefined) query.sentiment = params.sentiment;
    if (params.minConfidence !== undefined) query.minConfidence = params.minConfidence;
    if (params.authorDid !== undefined) query.authorDid = params.authorDid;
    if (params.tags !== undefined && params.tags.length > 0) {
      query.tags = params.tags.join(',');
    }
    if (params.sort !== undefined) query.sort = params.sort;
    if (params.limit !== undefined) query.limit = String(params.limit);

    const body = await this.get('/xrpc/com.dina.trust.search', query);
    const r = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return {
      results: Array.isArray(r.results) ? (r.results as TrustAttestation[]) : [],
      cursor: typeof r.cursor === 'string' ? r.cursor : undefined,
      totalEstimate: typeof r.totalEstimate === 'number' ? r.totalEstimate : null,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async get(path: string, query: Record<string, string>): Promise<unknown> {
    const qs = new URLSearchParams(query).toString();
    const url = `${this.appViewURL}${path}${qs ? '?' + qs : ''}`;

    let lastError: AppViewError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: 'GET',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
      } catch (err) {
        lastError = new AppViewError(`network error: ${(err as Error).message}`, null, path);
        if (attempt < this.maxRetries) {
          await this.sleepFn(attempt);
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 200) {
        return parseResponseBody(response);
      }

      const retryable = isRetryableStatus(response.status) || RETRYABLE_4XX.has(response.status);
      lastError = new AppViewError(`AppView responded ${response.status}`, response.status, path);
      if (retryable && attempt < this.maxRetries) {
        await this.sleepFn(attempt);
        continue;
      }
      throw lastError;
    }
    // Unreachable — loop either returns or throws.
    throw lastError ?? new AppViewError('AppView: retries exhausted', null, path);
  }
}

function isServiceProfile(x: unknown): x is ServiceProfile {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.did === 'string' &&
    typeof r.name === 'string' &&
    Array.isArray(r.capabilities) &&
    r.capabilities.every((c) => typeof c === 'string') &&
    typeof r.isDiscoverable === 'boolean'
  );
}

/**
 * GAP-WIRE-01: main-dina publishes per-capability schemas with
 * snake_case inner keys (`schema_hash`, `default_ttl_seconds`).
 * Normalise AppView responses into the idiomatic camelCase shape
 * `PublishedCapabilitySchema` exposes, tolerating either casing so
 * mobile reads survive a mixed ecosystem (main-style providers
 * alongside older mobile-published profiles).
 */
function normalizeProfile(p: ServiceProfile): ServiceProfile {
  if (p.capabilitySchemas === undefined) return p;
  const normalized: Record<string, PublishedCapabilitySchema> = {};
  let mutated = false;
  for (const [cap, raw] of Object.entries(p.capabilitySchemas)) {
    const r = raw as unknown as Record<string, unknown>;
    const hash =
      typeof r.schema_hash === 'string' && r.schema_hash !== ''
        ? r.schema_hash
        : typeof r.schemaHash === 'string'
          ? r.schemaHash
          : '';
    const ttl =
      typeof r.default_ttl_seconds === 'number'
        ? r.default_ttl_seconds
        : typeof r.defaultTtlSeconds === 'number'
          ? r.defaultTtlSeconds
          : undefined;
    const description = typeof r.description === 'string' ? r.description : undefined;
    const entry: PublishedCapabilitySchema = {
      params: (r.params as Record<string, unknown>) ?? {},
      result: (r.result as Record<string, unknown>) ?? {},
      schemaHash: hash,
    };
    if (description !== undefined) entry.description = description;
    if (ttl !== undefined) entry.defaultTtlSeconds = ttl;
    normalized[cap] = entry;
    if (
      entry.schemaHash !== (raw as PublishedCapabilitySchema).schemaHash ||
      entry.defaultTtlSeconds !== (raw as PublishedCapabilitySchema).defaultTtlSeconds
    ) {
      mutated = true;
    }
  }
  if (!mutated) return p;
  return { ...p, capabilitySchemas: normalized };
}
