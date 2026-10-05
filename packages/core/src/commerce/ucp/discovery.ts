/**
 * Discovering a merchant (UCP plan §3.6 steps 1–5): its profile from
 * `https://<origin>/.well-known/ucp` (no redirects, cached by Cache-Control
 * with a 60 s floor, revalidated with If-None-Match, served stale while
 * revalidating); the version both speak, through the merchant's leaf profile
 * when its current version is not Dina's; entries filtered and capabilities
 * intersected the way the merchant will; MCP chosen over REST when both are
 * offered (D9, S18).
 *
 * The answer names what was dropped and why, for the owner's merchant status.
 * Nothing here talks to a merchant beyond reading its public profile.
 */

import { UCP_FETCH_LIMITS, type PolicySocketRequest } from '@dina/net-policy';
import {
  discoverMerchant,
  readProfileDocument,
  type Discovery,
  type ProfileRead,
} from '@dina/ucp';

import { DocumentCache } from './http_cache';

import type { UcpFetchResult } from './fetch';

// The rules are @dina/ucp's (shared with AppView's merchant index); this file adds the cache.
export {
  merchantOrigin,
  type DiscoveredMerchant,
  type Discovery,
  type DiscoveryFailure,
  type MerchantTransport,
} from '@dina/ucp';

/** A profile's caps (§3.3): 128 KiB, the spec's floor for a profile size cap, and 10 s. */
export const PROFILE_LIMITS = UCP_FETCH_LIMITS.profile;

export interface UcpDiscoveryOptions {
  fetch?: (request: PolicySocketRequest) => Promise<UcpFetchResult>;
  now?: () => number;
}

export class UcpDiscovery {
  private readonly cache: DocumentCache;

  constructor(options: UcpDiscoveryOptions = {}) {
    this.cache = new DocumentCache({
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      maxBytes: PROFILE_LIMITS.maxResponseBytes,
      timeoutMs: PROFILE_LIMITS.timeoutMs,
      staleWhileRevalidate: true,
    });
  }

  /** `force`: revalidate the profiles now (a signing key the merchant uses was not listed). */
  async discover(input: string, options: { force?: boolean } = {}): Promise<Discovery> {
    return discoverMerchant(input, (url) => this.readProfile(url, options));
  }

  private async readProfile(url: string, options: { force?: boolean } = {}): Promise<ProfileRead> {
    const got = await this.cache.get(url, options);
    if (!got.ok) {
      if (got.error === 'too_large') return { ok: false, reason: 'too_large' };
      if (got.error === 'status' && got.status === 404) return { ok: false, reason: 'not_found' };
      return {
        ok: false,
        reason: 'unreachable',
        ...(got.status !== undefined ? { detail: String(got.status) } : {}),
      };
    }
    const read = readProfileDocument(got.doc.bytes);
    if (!read.ok) return read;
    return { ok: true, profile: read.profile, stale: got.stale };
  }
}
