/**
 * Task 6.9 — Cache-Control-aware TTL resolver.
 *
 * The Dina PLC resolver (task 6.10) + AppView xRPC client (6.11–6.16)
 * both cache responses. Two signals decide TTL:
 *
 *   1. The server's `Cache-Control` header — authoritative when
 *      present. `max-age=N`, `no-store`, `no-cache`, `private`,
 *      `must-revalidate`, `s-maxage=N` (proxy cache, used by
 *      AppView's CDN).
 *   2. A caller-chosen default (1h for PLC docs, per the task spec) —
 *      used only when the server says nothing.
 *
 * **Contract** (pinned by tests):
 *   - `no-store` → ttlMs = 0, storable = false. Don't put this in the
 *     cache at all.
 *   - `no-cache` → ttlMs = 0, storable = true, mustRevalidate = true.
 *     The cache can keep it for shape but must revalidate before use.
 *   - `max-age=0` → same as `no-cache`-effective: ttlMs = 0, storable.
 *   - `max-age=N` (N > 0) → ttlMs = N * 1000, storable.
 *   - `s-maxage=N` + `max-age=M` → s-maxage wins (we're a downstream
 *     cache, not the origin).
 *   - No directive → fall back to `defaultTtlMs`.
 *   - Malformed directives (e.g. `max-age=foo`) → preserved in
 *     `CacheControlDirectives.unknownDirectives` + ignored for TTL,
 *     falling back to `defaultTtlMs` if no other directive fires.
 *   - `max-age` values are clamped to [0, maxTtlMs] (default 24h).
 *     Protects against a server returning `max-age=31536000` + our
 *     cache then holding a stale PLC doc for a year.
 *
 * **RFC 7234 compliance** is pragmatic, not strict. We parse the
 * subset the AppView + PLC servers actually emit. Full RFC
 * compliance (warning parsing, pragma, vary) is out of scope — this
 * is an internal cache, not a shared proxy.
 *
 * **Why not just use `fetch`'s built-in caching?** Two reasons:
 *   - We want the TTL number for bookkeeping (admin UI "N cached
 *     entries, oldest X minutes"). Node 22's fetch cache is opaque.
 *   - PLC docs are signed + need signature re-verification on
 *     revalidation; the `fetch` cache's conditional-GET logic
 *     doesn't know about DID signatures.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6c task 6.9.
 */

export interface CacheControlDirectives {
  /** Parsed `max-age=N` in seconds, or null if absent. */
  maxAgeSeconds: number | null;
  /** Parsed `s-maxage=N` in seconds, or null if absent. Takes precedence over max-age for downstream caches. */
  sMaxAgeSeconds: number | null;
  /** `no-store` present — do not cache at all. */
  noStore: boolean;
  /** `no-cache` present — cache but revalidate before use. */
  noCache: boolean;
  /** `must-revalidate` — don't serve stale even if origin is down. */
  mustRevalidate: boolean;
  /** `private` — response is tied to a specific user. */
  isPrivate: boolean;
  /** `public` — can be cached by shared proxies. */
  isPublic: boolean;
  /** Raw directives that didn't match any known key — preserved for audit. */
  unknownDirectives: string[];
}

export interface TtlResolution {
  /** Effective time-to-live in milliseconds. 0 = don't serve without revalidation. */
  ttlMs: number;
  /** False when the response should not be placed in the cache at all. */
  storable: boolean;
  /** True when `no-cache` or `must-revalidate` requires re-checking before serving. */
  mustRevalidate: boolean;
  /** The directive source that decided the TTL — for admin UI + telemetry. */
  source: 'no-store' | 'no-cache' | 's-maxage' | 'max-age' | 'default';
}

export interface ResolveTtlOptions {
  /** The `Cache-Control` header value (or `null` / `undefined` if absent). */
  cacheControl?: string | null;
  /** Default TTL when the server gives no directive. */
  defaultTtlMs: number;
  /** Upper bound on TTL. Defaults to 24 hours. Set lower for short-lived resources. */
  maxTtlMs?: number;
}

export const DEFAULT_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const PLC_DEFAULT_TTL_MS = 60 * 60 * 1000; // Task spec: 1h PLC default.

/**
 * Parse an HTTP `Cache-Control` header into its directives. Accepts
 * any string — invalid tokens are preserved in `unknownDirectives`
 * so callers can audit. Case-insensitive per RFC 7234.
 */
export function parseCacheControl(
  header: string | null | undefined,
): CacheControlDirectives {
  const base: CacheControlDirectives = {
    maxAgeSeconds: null,
    sMaxAgeSeconds: null,
    noStore: false,
    noCache: false,
    mustRevalidate: false,
    isPrivate: false,
    isPublic: false,
    unknownDirectives: [],
  };
  if (typeof header !== 'string' || header.trim() === '') return base;

  // Split on commas; strip whitespace. Quoted string values are rare
  // in Cache-Control + we don't consume any (max-age is always a
  // bare int) — simple split is sufficient.
  for (const raw of header.split(',')) {
    const token = raw.trim();
    if (token === '') continue;
    const lower = token.toLowerCase();
    // Booleans first.
    if (lower === 'no-store') {
      base.noStore = true;
      continue;
    }
    if (lower === 'no-cache') {
      base.noCache = true;
      continue;
    }
    if (lower === 'must-revalidate' || lower === 'proxy-revalidate') {
      base.mustRevalidate = true;
      continue;
    }
    if (lower === 'private') {
      base.isPrivate = true;
      continue;
    }
    if (lower === 'public') {
      base.isPublic = true;
      continue;
    }
    // Key=value directives.
    const eq = lower.indexOf('=');
    if (eq !== -1) {
      const key = lower.slice(0, eq).trim();
      const val = lower.slice(eq + 1).trim().replace(/^"|"$/g, '');
      if (key === 'max-age') {
        const n = parseNonNegInt(val);
        if (n !== null) {
          base.maxAgeSeconds = n;
          continue;
        }
      } else if (key === 's-maxage') {
        const n = parseNonNegInt(val);
        if (n !== null) {
          base.sMaxAgeSeconds = n;
          continue;
        }
      }
    }
    base.unknownDirectives.push(token);
  }
  return base;
}

/**
 * Resolve the effective TTL for a response. This is the main entry
 * point — callers pass the raw header + their default, get back a
 * structured decision including where the TTL came from.
 */
export function resolveTtl(opts: ResolveTtlOptions): TtlResolution {
  const maxTtlMs = opts.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
  if (!Number.isFinite(opts.defaultTtlMs) || opts.defaultTtlMs < 0) {
    throw new RangeError('resolveTtl: defaultTtlMs must be >= 0');
  }
  if (!Number.isFinite(maxTtlMs) || maxTtlMs < 0) {
    throw new RangeError('resolveTtl: maxTtlMs must be >= 0');
  }

  // `parseCacheControl` never throws — malformed tokens land in
  // `unknownDirectives` + the absence of recognised directives maps
  // to the default branch below.
  const directives = parseCacheControl(opts.cacheControl);
  let source: TtlResolution['source'] = 'default';

  if (directives.noStore) {
    return { ttlMs: 0, storable: false, mustRevalidate: false, source: 'no-store' };
  }
  if (directives.noCache) {
    return { ttlMs: 0, storable: true, mustRevalidate: true, source: 'no-cache' };
  }

  // s-maxage wins for downstream caches when present.
  let ageSeconds: number | null = null;
  if (directives.sMaxAgeSeconds !== null) {
    ageSeconds = directives.sMaxAgeSeconds;
    source = 's-maxage';
  } else if (directives.maxAgeSeconds !== null) {
    ageSeconds = directives.maxAgeSeconds;
    source = 'max-age';
  }

  if (ageSeconds !== null) {
    if (ageSeconds === 0) {
      // max-age=0 is RFC-equivalent to no-cache for freshness purposes.
      return {
        ttlMs: 0,
        storable: true,
        mustRevalidate: true,
        source,
      };
    }
    return {
      ttlMs: clampTtl(ageSeconds * 1000, maxTtlMs),
      storable: true,
      mustRevalidate: directives.mustRevalidate,
      source,
    };
  }

  // No freshness directive → fall back.
  return {
    ttlMs: clampTtl(opts.defaultTtlMs, maxTtlMs),
    storable: true,
    mustRevalidate: directives.mustRevalidate,
    source: 'default',
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function clampTtl(ttlMs: number, maxTtlMs: number): number {
  if (ttlMs < 0) return 0;
  if (ttlMs > maxTtlMs) return maxTtlMs;
  return ttlMs;
}

function parseNonNegInt(s: string): number | null {
  // RFC: delta-seconds is 1*DIGIT — no leading zeros, no sign, no float.
  if (!/^\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
