/**
 * Trust Network feature-flag reader (TN-FLAG-005 + TN-MOB-051).
 *
 * Per plan §13.9, AppView's `appview_config.trust_v1_enabled` boolean
 * gates the V1 rollout. When `false`:
 *   - All `com.dina.*` xRPC endpoints return 503.
 *   - The firehose ingester skips trust-network records.
 *   - Mobile UI hides the Trust tab.
 *
 * This module owns the mobile side: pull the flag from AppView at
 * boot, cache it, expose a synchronous getter the tab-bar can read
 * during render. Three primitives:
 *
 *   - `loadTrustV1Enabled(fetcher, options?)` — async loader.
 *     Bootstrap calls it once; later callers re-await to extend the
 *     cache. The fetcher is injected so tests don't hit the network
 *     and so the bootstrap layer owns the URL/auth concerns.
 *
 *   - `getCachedTrustV1Enabled(now?)` — sync getter. Returns
 *     `true` / `false` when a fresh cached value is present, `null`
 *     when unloaded or expired. The "unloaded → null" semantic is
 *     deliberate: screens treat null as "we don't know yet, default
 *     visible" so the dev workflow (no AppView wiring) keeps the tab
 *     reachable. Production hides the tab only after an explicit
 *     `false` lands.
 *
 *   - `isTrustTabHidden(now?)` — convenience wrapper for the layout
 *     gate. Returns `true` ONLY when the cached value is explicitly
 *     `false`. `null` and `true` both surface the tab.
 *
 * Closed-default semantic on fetch failure: a thrown error becomes
 * a cached `false`. Plan §13.9 says the flag's production default is
 * `false` until the parity gate flips it; if AppView is unreachable
 * we fail toward "feature off" rather than silently surfacing a
 * partially-broken tab. Tests for both paths.
 *
 * Pure module — no React, no Expo. Tests run under plain Jest.
 */

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Caller-supplied fetcher. Returns:
 *   - `true`  — flag explicitly on
 *   - `false` — flag explicitly off
 *   - `null`  — server returned "unknown" (e.g. config row missing).
 *               Treated the same as `false` per closed-default policy.
 *
 * Throwing is allowed; the loader catches and treats it as `false`.
 */
export type TrustV1FlagFetcher = () => Promise<boolean | null>;

export interface LoadOptions {
  /** Override `Date.now()` for deterministic tests. */
  readonly now?: number;
  /** Cache TTL in ms. Default `DEFAULT_FLAG_TTL_MS` (5 min). */
  readonly ttlMs?: number;
}

/**
 * Cache TTL — 5 min mirrors the AppView config-flag refresh cadence.
 * Long enough to skip per-render lookups; short enough that flipping
 * the flag in admin propagates to running mobile sessions inside one
 * lunch break. Plan doesn't pin a number; this is a reasonable
 * default that the tests pin so a future change is deliberate.
 */
export const DEFAULT_FLAG_TTL_MS = 5 * 60 * 1000;

// ─── Module state ─────────────────────────────────────────────────────────

interface CacheEntry {
  readonly value: boolean;
  readonly expiresAt: number;
}

let cache: CacheEntry | null = null;

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Load the flag from AppView (via the supplied fetcher) and cache
 * the result. Returns the resolved boolean.
 *
 * Bootstrap calls this once at startup; the cached value powers the
 * synchronous getters that screens use during render.
 *
 * Failure modes (all → cached `false`):
 *   - Fetcher throws → caught, cached `false`.
 *   - Fetcher returns `null` → cached `false` (per closed-default).
 *   - Fetcher returns anything other than `true` (incl. truthy
 *     non-booleans like `1` or `"yes"`) → cached `false`. Strict
 *     boolean check is what makes the cache a reliable gate; type
 *     coercion would let a malformed wire response silently surface
 *     the tab.
 */
export async function loadTrustV1Enabled(
  fetcher: TrustV1FlagFetcher,
  options?: LoadOptions,
): Promise<boolean> {
  const now = options?.now ?? Date.now();
  const ttl = options?.ttlMs ?? DEFAULT_FLAG_TTL_MS;
  if (!Number.isFinite(ttl) || ttl < 0) {
    throw new Error(`loadTrustV1Enabled: ttlMs must be a non-negative finite number`);
  }

  let value: boolean;
  try {
    const raw = await fetcher();
    value = raw === true;
  } catch {
    value = false;
  }

  cache = { value, expiresAt: now + ttl };
  return value;
}

/**
 * Sync read of the cached flag.
 *
 *   - `true` / `false` — fresh cached value.
 *   - `null` — never loaded, or the cached entry has expired.
 *
 * The `null` semantic is the dev-workflow escape hatch: screens that
 * default-visible-when-unknown render normally during local dev
 * before the AppView config endpoint exists. Production callers
 * should use `isTrustTabHidden` for the explicit "hide me" gate.
 */
export function getCachedTrustV1Enabled(now?: number): boolean | null {
  if (cache === null) return null;
  const t = now ?? Date.now();
  if (cache.expiresAt <= t) return null;
  return cache.value;
}

/**
 * Should the layout HIDE the Trust tab right now? `true` ONLY when
 * the cached flag is explicitly `false`. `null` (unloaded / expired)
 * and `true` both leave the tab visible.
 *
 * This is the layout-gate convenience — `_layout.tsx` reads it
 * synchronously to decide between `href: null` (hidden) and
 * `href: undefined` (default).
 */
export function isTrustTabHidden(now?: number): boolean {
  return getCachedTrustV1Enabled(now) === false;
}

/**
 * Test-only: clear the cache. Production code never needs this —
 * `loadTrustV1Enabled` overwrites on next call.
 */
export function resetTrustV1FlagCache(): void {
  cache = null;
}
