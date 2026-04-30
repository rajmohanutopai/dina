/**
 * Trust score query client — fetch trust profiles from AppView xRPC.
 *
 * The Dina community trust system uses AT Protocol AppView as the
 * source of truth for trust scores. The xRPC endpoint
 * `com.dina.trust.getProfile` returns the shape defined by
 * `appview/src/shared/types/api-types.ts.GetProfileResponse`:
 *
 *   {
 *     did: string,
 *     overallTrustScore: number | null,   // [0, 1] real, null when unscored
 *     attestationSummary: { total, positive, neutral, negative },
 *     vouchCount: number,
 *     endorsementCount: number,
 *     reviewerStats: { totalAttestationsBy, corroborationRate, evidenceRate, helpfulRatio },
 *     activeDomains: string[],
 *     lastActive: string | null   // ISO-8601 datetime
 *   }
 *
 * Lite mirrors that shape verbatim with one normalisation:
 * `lastActive` is parsed from ISO into ms-since-epoch so callers can
 * compare with `Date.now()` directly.
 *
 * The score is on a real `[0, 1]` scale (matching AppView's
 * `algorithms/trust-score.ts` clamp). UI layers that prefer a 0–100
 * integer band multiply by 100 themselves — keeping the wire shape
 * lossless until the very last render step.
 *
 * The client supports:
 *   - Single DID query
 *   - Batch query (multiple DIDs) — see `queryBatch`. AppView does not
 *     yet expose `getProfiles` plural, so the batch attempt always
 *     falls through to a per-DID loop today; the path is wire-ready
 *     so the server can add it later with no client change.
 *   - Timeout handling
 *   - Error classification (network vs 404 vs server error)
 *
 * Source: ARCHITECTURE.md Task 9.1 +
 *         appview/src/api/xrpc/get-profile.ts (wire contract).
 */

import type { Confidence, Sentiment, SubjectType } from '@dina/protocol';
import type { TrustScore } from './cache';
import { DEFAULT_APPVIEW_URL as APPVIEW_URL } from '../constants';

const DEFAULT_APPVIEW_URL = APPVIEW_URL;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface AttestationSummary {
  total: number;
  positive: number;
  neutral: number;
  negative: number;
}

export interface ReviewerStats {
  totalAttestationsBy: number;
  corroborationRate: number;
  evidenceRate: number;
  helpfulRatio: number;
}

/**
 * Trust profile of a DID, as returned by AppView's
 * `com.dina.trust.getProfile`. Mirrors `GetProfileResponse` from
 * `appview/src/shared/types/api-types.ts` byte-for-byte except for
 * `lastActive`, which is normalised from ISO string → ms timestamp.
 *
 * Scores are real numbers in `[0, 1]`; `null` means "no profile yet"
 * (DID is known but hasn't been scored). UI layers can render `null`
 * as "unrated" rather than coercing to zero.
 */
export interface TrustProfile {
  did: string;
  overallTrustScore: number | null;
  attestationSummary: AttestationSummary;
  vouchCount: number;
  endorsementCount: number;
  reviewerStats: ReviewerStats;
  activeDomains: string[];
  lastActive: number | null;
}

export interface QueryConfig {
  appviewURL?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export type QueryError = 'not_found' | 'timeout' | 'network' | 'server_error';

export interface QueryResult {
  success: boolean;
  profile?: TrustProfile;
  error?: QueryError;
  errorMessage?: string;
}

/**
 * Subset of `com.dina.trust.search` filters that AppView already
 * accepts on the wire. Mirrors `appview/src/api/xrpc/search.ts`
 * `SearchParams`. Plan §6.1 calls for additional `language` and
 * `location` filters; those land with TN-API-001 and will be added
 * here in lockstep.
 */
export interface AttestationSearchParams {
  q?: string;
  category?: string;
  domain?: string;
  subjectType?: SubjectType;
  sentiment?: Sentiment;
  /** Comma-separated tag list (matches AppView's wire format). */
  tags?: string;
  authorDid?: string;
  minConfidence?: Confidence;
  /** ISO-8601 lower bound on `recordCreatedAt`. */
  since?: string;
  /** ISO-8601 upper bound on `recordCreatedAt`. */
  until?: string;
  sort?: 'recent' | 'relevant';
  /** 1–100 — AppView clamps. */
  limit?: number;
  cursor?: string;
}

/**
 * One attestation row from `com.dina.trust.search`. Mirrors
 * `appview/src/db/schema/attestations.ts` rows projected through
 * the search endpoint.
 *
 * Field set is a subset — the search response shape evolves over
 * time and we preserve unknown fields via the index signature so
 * forward-compatible additions don't require client churn.
 */
export interface AttestationSearchHit {
  uri?: string;
  cid?: string;
  authorDid?: string;
  subjectId?: string;
  category?: string;
  domain?: string;
  sentiment?: Sentiment;
  confidence?: Confidence;
  tags?: string[];
  recordCreatedAt?: string;
  [key: string]: unknown;
}

export interface SearchResult {
  success: boolean;
  results: AttestationSearchHit[];
  cursor?: string;
  totalEstimate: number | null;
  error?: QueryError;
  errorMessage?: string;
}

export class TrustQueryClient {
  private readonly appviewURL: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config?: QueryConfig) {
    this.appviewURL = (config?.appviewURL ?? DEFAULT_APPVIEW_URL).replace(/\/$/, '');
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = config?.fetch ?? globalThis.fetch;
  }

  /**
   * Query trust profile for a single DID.
   */
  async queryProfile(did: string): Promise<QueryResult> {
    if (!did) {
      return { success: false, error: 'network', errorMessage: 'DID is required' };
    }

    try {
      const url = `${this.appviewURL}/xrpc/com.dina.trust.getProfile?did=${encodeURIComponent(did)}`;

      const response = await this.fetchFn(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.status === 404) {
        return {
          success: false,
          error: 'not_found',
          errorMessage: `DID "${did}" has no trust profile`,
        };
      }

      if (!response.ok) {
        return { success: false, error: 'server_error', errorMessage: `HTTP ${response.status}` };
      }

      const data = (await response.json()) as Record<string, unknown>;
      const profile = parseProfile(data);

      return { success: true, profile };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('timeout') || message.includes('abort')) {
        return { success: false, error: 'timeout', errorMessage: message };
      }

      return { success: false, error: 'network', errorMessage: message };
    }
  }

  /**
   * Query trust profiles for multiple DIDs.
   *
   * Uses the batch xRPC endpoint for efficiency.
   * Falls back to individual queries if batch endpoint fails.
   */
  async queryBatch(dids: string[]): Promise<Map<string, QueryResult>> {
    const results = new Map<string, QueryResult>();

    if (dids.length === 0) return results;

    // Try the batch endpoint first.
    //
    // NOTE: AppView's xRPC dispatcher does not currently register
    // `com.dina.trust.getProfiles` (see `appview/src/web/server.ts`).
    // The batch attempt 404s on every call and the catch below falls
    // through to per-DID queries. The path is kept on the wire-format-
    // ready side so adding the server endpoint later requires no
    // client change.
    try {
      const url = `${this.appviewURL}/xrpc/com.dina.trust.getProfiles`;
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ dids }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.ok) {
        const data = (await response.json()) as { profiles: Array<Record<string, unknown>> };
        for (const raw of data.profiles ?? []) {
          const profile = parseProfile(raw);
          results.set(profile.did, { success: true, profile });
        }

        // Mark missing DIDs as not_found
        for (const did of dids) {
          if (!results.has(did)) {
            results.set(did, {
              success: false,
              error: 'not_found',
              errorMessage: 'Not in batch response',
            });
          }
        }

        return results;
      }
    } catch {
      // Batch failed — fall through to individual queries
    }

    // Fallback: individual queries
    for (const did of dids) {
      const result = await this.queryProfile(did);
      results.set(did, result);
    }

    return results;
  }

  /**
   * Run a filtered search against AppView's `com.dina.trust.search`
   * xRPC. Each filter passed here is a Lite-side reflection of an
   * AppView wire param — see `AttestationSearchParams`.
   *
   * Returns the raw attestation rows + pagination cursor. Aggregation
   * into review entries / weighted scores happens upstream in
   * `network_search.ts`.
   */
  async searchAttestations(params: AttestationSearchParams): Promise<SearchResult> {
    try {
      const url = `${this.appviewURL}/xrpc/com.dina.trust.search${buildSearchQueryString(params)}`;

      const response = await this.fetchFn(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.status === 404) {
        return {
          success: false,
          results: [],
          totalEstimate: 0,
          error: 'not_found',
          errorMessage: 'search endpoint not found',
        };
      }

      if (!response.ok) {
        return {
          success: false,
          results: [],
          totalEstimate: null,
          error: 'server_error',
          errorMessage: `HTTP ${response.status}`,
        };
      }

      const data = (await response.json()) as Record<string, unknown>;
      return parseSearchResponse(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error: QueryError =
        message.includes('timeout') || message.includes('abort') ? 'timeout' : 'network';
      return {
        success: false,
        results: [],
        totalEstimate: null,
        error,
        errorMessage: message,
      };
    }
  }

  /**
   * Project a trust profile to the slim shape the cache layer stores.
   *
   * The cache only needs the score, an attestation count for "based
   * on N reviews" UX, and a server-side timestamp for staleness
   * judgement. The richer breakdown (sentiment buckets, vouch counts,
   * reviewer stats, domains) stays in the live profile.
   */
  toTrustScore(profile: TrustProfile): TrustScore {
    return {
      did: profile.did,
      score: profile.overallTrustScore,
      attestationCount: profile.attestationSummary.total,
      lastUpdated: profile.lastActive ?? Date.now(),
    };
  }
}

// ── Parsing ─────────────────────────────────────────────────────────

function parseAttestationSummary(raw: unknown): AttestationSummary {
  const obj = isPlainObject(raw) ? raw : {};
  return {
    total: nonNegativeInt(obj.total),
    positive: nonNegativeInt(obj.positive),
    neutral: nonNegativeInt(obj.neutral),
    negative: nonNegativeInt(obj.negative),
  };
}

function parseReviewerStats(raw: unknown): ReviewerStats {
  const obj = isPlainObject(raw) ? raw : {};
  return {
    totalAttestationsBy: nonNegativeInt(obj.totalAttestationsBy),
    corroborationRate: clampUnit(obj.corroborationRate),
    evidenceRate: clampUnit(obj.evidenceRate),
    helpfulRatio: clampUnit(obj.helpfulRatio),
  };
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

function parseLastActive(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Parse a raw xRPC response into a TrustProfile.
 */
function parseProfile(data: Record<string, unknown>): TrustProfile {
  return {
    did: String(data.did ?? ''),
    overallTrustScore: parseScore(data.overallTrustScore),
    attestationSummary: parseAttestationSummary(data.attestationSummary),
    vouchCount: nonNegativeInt(data.vouchCount),
    endorsementCount: nonNegativeInt(data.endorsementCount),
    reviewerStats: parseReviewerStats(data.reviewerStats),
    activeDomains: parseStringArray(data.activeDomains),
    lastActive: parseLastActive(data.lastActive),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInt(raw: unknown): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/**
 * Clamp to `[0, 1]`. Rejects NaN / Infinity → 0.
 *
 * Used for ratio fields (corroborationRate / evidenceRate / helpfulRatio)
 * where the AppView contract is a real ratio, not a nullable score.
 */
function clampUnit(raw: unknown): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Parse the `overallTrustScore` field. Preserves `null` (the wire's
 * "unscored" signal) and clamps real values into `[0, 1]`. Garbage
 * input collapses to `null` so callers can render "unrated" rather
 * than a fake zero.
 */
function parseScore(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Build a stable URL query string from `AttestationSearchParams`.
 *
 * Stable means: keys are sorted, undefined / empty values are
 * omitted, and the result is a deterministic function of the input
 * — important so that downstream cache keys hash consistently.
 */
function buildSearchQueryString(params: AttestationSearchParams): string {
  const entries: Array<[string, string]> = [];
  const push = (key: string, value: string | number | undefined): void => {
    if (value === undefined) return;
    if (typeof value === 'string' && value.length === 0) return;
    entries.push([key, String(value)]);
  };
  push('q', params.q);
  push('category', params.category);
  push('domain', params.domain);
  push('subjectType', params.subjectType);
  push('sentiment', params.sentiment);
  push('tags', params.tags);
  push('authorDid', params.authorDid);
  push('minConfidence', params.minConfidence);
  push('since', params.since);
  push('until', params.until);
  push('sort', params.sort);
  push('limit', params.limit);
  push('cursor', params.cursor);
  if (entries.length === 0) return '';
  // Sort for determinism so the same logical params produce the same
  // wire URL (matters for HTTP caching + test assertions).
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    '?' +
    entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  );
}

/**
 * Parse a raw `com.dina.trust.search` response into `SearchResult`.
 * AppView returns `{ results, cursor?, totalEstimate }`. Unknown
 * fields on individual rows are preserved — see `AttestationSearchHit`.
 */
function parseSearchResponse(data: Record<string, unknown>): SearchResult {
  const rawResults = Array.isArray(data.results) ? data.results : [];
  const results: AttestationSearchHit[] = rawResults
    .filter((row): row is Record<string, unknown> => isPlainObject(row))
    .map((row) => row as AttestationSearchHit);
  const cursor = typeof data.cursor === 'string' && data.cursor.length > 0 ? data.cursor : undefined;
  const totalEstimate =
    typeof data.totalEstimate === 'number' && Number.isFinite(data.totalEstimate)
      ? Math.max(0, Math.floor(data.totalEstimate))
      : null;
  return { success: true, results, cursor, totalEstimate };
}
