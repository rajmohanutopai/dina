/**
 * Trust score query client — fetch trust profiles from AppView xRPC.
 *
 * The Dina community trust system uses AT Protocol AppView as the
 * source of truth for trust scores. Scores are computed from:
 *   - Attestation count (how many peers vouched for this DID)
 *   - Attestation recency (recent vouches weigh more)
 *   - Category breakdown (product_review, identity_verification, etc.)
 *   - Community standing (PDS registration age, activity)
 *
 * The xRPC endpoint: app.dina.trust.getProfile
 *   Input: { did: string }
 *   Output: { did, score, attestationCount, categories, lastUpdated }
 *
 * The client supports:
 *   - Single DID query
 *   - Batch query (multiple DIDs)
 *   - Timeout handling
 *   - Error classification (network vs 404 vs server error)
 *
 * Source: ARCHITECTURE.md Task 9.1
 */

import type { TrustScore } from './cache';
import {
  DEFAULT_APPVIEW_URL as APPVIEW_URL,
  TRUST_RATING_MIN,
  TRUST_RATING_MAX,
} from '../constants';

const DEFAULT_APPVIEW_URL = APPVIEW_URL;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface TrustProfile {
  did: string;
  score: number; // 0-100
  attestationCount: number;
  categories: Record<string, number>; // category → attestation count
  lastUpdated: number; // ms timestamp from server
  registeredSince?: number; // PDS registration timestamp
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
      const url = `${this.appviewURL}/xrpc/app.dina.trust.getProfile?did=${encodeURIComponent(did)}`;

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

    // Try batch endpoint first
    try {
      const url = `${this.appviewURL}/xrpc/app.dina.trust.getProfiles`;
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
   * Convert a trust profile to a TrustScore (for cache integration).
   */
  toTrustScore(profile: TrustProfile): TrustScore {
    return {
      did: profile.did,
      score: profile.score,
      attestationCount: profile.attestationCount,
      lastUpdated: profile.lastUpdated,
    };
  }
}

/**
 * Parse a raw xRPC response into a TrustProfile.
 */
function parseProfile(data: Record<string, unknown>): TrustProfile {
  return {
    did: String(data.did ?? ''),
    score: clampScore(Number(data.score ?? 0)),
    attestationCount: Math.max(0, Math.floor(Number(data.attestationCount ?? 0))),
    categories:
      typeof data.categories === 'object' && data.categories !== null
        ? (data.categories as Record<string, number>)
        : {},
    lastUpdated: Number(data.lastUpdated ?? Date.now()),
    registeredSince: data.registeredSince ? Number(data.registeredSince) : undefined,
  };
}

/** Clamp trust score to [0, 100]. */
function clampScore(score: number): number {
  if (isNaN(score)) return 0;
  return Math.max(TRUST_RATING_MIN, Math.min(TRUST_RATING_MAX, Math.round(score)));
}
