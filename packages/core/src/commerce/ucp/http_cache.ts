/**
 * The cache for public UCP documents: merchant profiles (§3.6 step 1) and
 * schemas (step 4a). Both honour `Cache-Control` with a 60 s floor and
 * revalidate with `If-None-Match`; a profile is also served stale while it is
 * revalidated.
 *
 * Every fetch goes through `ucpFetch` (https, no redirects, no special-use
 * address, a body cap). Entries live in memory: the documents are public, and
 * a cold cache costs one fetch.
 */

import { ucpFetch, type UcpFetchResult } from './fetch';

import type { PolicySocketRequest } from '@dina/net-policy';

/** No document is trusted for less than this (§3.6: "a 60 s floor"). */
export const CACHE_FLOOR_SECONDS = 60;
/** Nor kept fresh longer than this, whatever the server says. */
export const CACHE_CEILING_SECONDS = 24 * 60 * 60;
/**
 * How long past its freshness a profile may still be served while it is
 * revalidated. Past this, a read waits for the merchant; a profile that keeps
 * failing to revalidate stops being used after an hour.
 */
export const STALE_WINDOW_SECONDS = 60 * 60;

export interface CacheControl {
  maxAge: number | null;
  noStore: boolean;
  noCache: boolean;
}

/** The directives that matter here; unknown or malformed ones are ignored. */
export function parseCacheControl(header: string | undefined): CacheControl {
  const out: CacheControl = { maxAge: null, noStore: false, noCache: false };
  if (header === undefined) return out;
  for (const part of header.split(',')) {
    const [rawName, rawValue] = part.trim().split('=', 2) as [string, string | undefined];
    const name = rawName.trim().toLowerCase();
    if (name === 'no-store') out.noStore = true;
    else if (name === 'no-cache') out.noCache = true;
    else if (name === 'max-age' && rawValue !== undefined) {
      const v = rawValue.trim().replace(/^"(.*)"$/, '$1');
      if (/^\d{1,10}$/.test(v)) out.maxAge = Number(v);
    }
  }
  return out;
}

/**
 * How long an answer stays fresh, in seconds: its max-age, raised to the floor
 * and capped; no-store and no-cache still get the floor (Dina must not fetch a
 * profile on every call, and 60 s is the plan's own bound on staleness).
 */
export function freshFor(cc: CacheControl): number {
  const given = cc.noStore || cc.noCache ? 0 : (cc.maxAge ?? 0);
  return Math.min(Math.max(given, CACHE_FLOOR_SECONDS), CACHE_CEILING_SECONDS);
}

export interface CachedDocument {
  url: string;
  bytes: Uint8Array;
  etag?: string;
  fetchedAt: number;
  freshUntil: number;
  /** After a failed revalidation, no new one before this (ms). */
  retryAfter?: number;
}

export type DocumentFetch =
  | { ok: true; doc: CachedDocument; stale: boolean }
  | { ok: false; error: 'unreachable' | 'status' | 'too_large'; status?: number };

export interface DocumentCacheOptions {
  fetch?: (request: PolicySocketRequest) => Promise<UcpFetchResult>;
  now?: () => number;
  /** Per-document body cap. */
  maxBytes: number;
  /** Serve a stale copy at once and revalidate behind it (profiles), or wait (schemas). */
  staleWhileRevalidate: boolean;
  /** Entries kept; the oldest go first. */
  maxEntries?: number;
  timeoutMs?: number;
}

export class DocumentCache {
  private readonly entries = new Map<string, CachedDocument>();
  private readonly inflight = new Map<string, Promise<DocumentFetch>>();
  private readonly fetchFn: (request: PolicySocketRequest) => Promise<UcpFetchResult>;
  private readonly now: () => number;

  constructor(private readonly options: DocumentCacheOptions) {
    this.fetchFn = options.fetch ?? ucpFetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * The document at `url`, from the cache while fresh. One fetch per URL at a
   * time. `force` revalidates now even when fresh (with the stored ETag): the
   * caller met a key the document does not list, so it may have changed.
   */
  async get(url: string, options: { force?: boolean } = {}): Promise<DocumentFetch> {
    const now = this.now();
    const cached = this.entries.get(url);
    if (options.force === true) return this.refresh(url, cached);
    if (cached !== undefined && cached.freshUntil > now)
      return { ok: true, doc: cached, stale: false };
    const servable =
      cached !== undefined &&
      this.options.staleWhileRevalidate &&
      now < cached.freshUntil + STALE_WINDOW_SECONDS * 1000;
    if (servable) {
      // One revalidation at a time, and none sooner than a minute after one failed.
      if ((cached.retryAfter ?? 0) <= now) void this.refresh(url, cached);
      return { ok: true, doc: cached, stale: true };
    }
    return this.refresh(url, cached);
  }

  /** Forget a document (a merchant the owner removed, or a test). */
  delete(url: string): void {
    this.entries.delete(url);
  }

  private refresh(url: string, cached: CachedDocument | undefined): Promise<DocumentFetch> {
    let pending = this.inflight.get(url);
    if (pending === undefined) {
      pending = this.load(url, cached).finally(() => this.inflight.delete(url));
      this.inflight.set(url, pending);
    }
    return pending;
  }

  private async load(url: string, cached: CachedDocument | undefined): Promise<DocumentFetch> {
    const r = await this.fetchFn({
      method: 'GET',
      url,
      headers: {},
      accept: 'json',
      minTls: 'TLSv1.2',
      readAuthErrorBodies: false,
      ...(cached?.etag !== undefined ? { ifNoneMatch: cached.etag } : {}),
      maxResponseBytes: this.options.maxBytes,
      timeoutMs: this.options.timeoutMs ?? 10_000,
    });
    const now = this.now();
    if (!r.ok) {
      this.failed(cached, now);
      return r.error === 'too_large'
        ? { ok: false, error: 'too_large' }
        : { ok: false, error: 'unreachable' };
    }
    const fresh = freshFor(parseCacheControl(r.headers['cache-control']));
    if (r.status === 304 && cached !== undefined) {
      const doc = { ...cached, fetchedAt: now, freshUntil: now + fresh * 1000 };
      this.store(doc);
      return { ok: true, doc, stale: false };
    }
    if (r.status === 404 || r.status === 410) {
      // The merchant withdrew it: never serve the old copy again.
      this.entries.delete(url);
      return { ok: false, error: 'status', status: r.status };
    }
    if (r.status !== 200) {
      this.failed(cached, now);
      return { ok: false, error: 'status', status: r.status };
    }
    const etag = r.headers.etag;
    const doc: CachedDocument = {
      url,
      bytes: r.bodyBytes,
      ...(etag !== undefined ? { etag } : {}),
      fetchedAt: now,
      freshUntil: now + fresh * 1000,
    };
    this.store(doc);
    return { ok: true, doc, stale: false };
  }

  /** A revalidation failed: keep serving within the window, but wait the floor before trying again. */
  private failed(cached: CachedDocument | undefined, now: number): void {
    if (cached === undefined || this.entries.get(cached.url) !== cached) return;
    cached.retryAfter = now + CACHE_FLOOR_SECONDS * 1000;
  }

  private store(doc: CachedDocument): void {
    this.entries.delete(doc.url);
    this.entries.set(doc.url, doc);
    const max = this.options.maxEntries ?? 512;
    while (this.entries.size > max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}
