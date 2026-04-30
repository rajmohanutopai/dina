/**
 * Trust feature-flag reader tests (TN-FLAG-005 + TN-MOB-051).
 *
 * Pins the gate the layout depends on:
 *
 *   - Loaded `true`  → tab visible.
 *   - Loaded `false` → tab hidden.
 *   - Unloaded       → tab visible (dev escape hatch — `null` does
 *                      NOT hide the tab so local dev keeps working
 *                      before AppView wiring lands).
 *   - Expired entry  → coerced to "unloaded" (returns null).
 *   - Closed-default on failure: any throw / non-boolean / null →
 *     cached `false` so a flapping AppView doesn't accidentally
 *     surface a half-broken tab.
 *
 * Pure module — runs under plain Jest, no RN deps.
 */

import {
  DEFAULT_FLAG_TTL_MS,
  getCachedTrustV1Enabled,
  isTrustTabHidden,
  loadTrustV1Enabled,
  resetTrustV1FlagCache,
  type TrustV1FlagFetcher,
} from '../../src/trust/flags';

beforeEach(() => {
  resetTrustV1FlagCache();
});

const T0 = 1_700_000_000_000;

// ─── loadTrustV1Enabled ───────────────────────────────────────────────────

describe('loadTrustV1Enabled', () => {
  it('caches an explicit true', async () => {
    const fetcher: TrustV1FlagFetcher = async () => true;
    const v = await loadTrustV1Enabled(fetcher, { now: T0 });
    expect(v).toBe(true);
    expect(getCachedTrustV1Enabled(T0 + 1)).toBe(true);
  });

  it('caches an explicit false', async () => {
    const fetcher: TrustV1FlagFetcher = async () => false;
    const v = await loadTrustV1Enabled(fetcher, { now: T0 });
    expect(v).toBe(false);
    expect(getCachedTrustV1Enabled(T0 + 1)).toBe(false);
  });

  it('coerces null (server "unknown") to cached false (closed-default)', async () => {
    const fetcher: TrustV1FlagFetcher = async () => null;
    const v = await loadTrustV1Enabled(fetcher, { now: T0 });
    expect(v).toBe(false);
    expect(getCachedTrustV1Enabled(T0 + 1)).toBe(false);
  });

  it('coerces a fetcher throw to cached false', async () => {
    const fetcher: TrustV1FlagFetcher = async () => {
      throw new Error('network down');
    };
    const v = await loadTrustV1Enabled(fetcher, { now: T0 });
    expect(v).toBe(false);
    expect(getCachedTrustV1Enabled(T0 + 1)).toBe(false);
  });

  it('rejects non-finite ttl', async () => {
    const fetcher: TrustV1FlagFetcher = async () => true;
    await expect(loadTrustV1Enabled(fetcher, { ttlMs: -1 })).rejects.toThrow();
    await expect(loadTrustV1Enabled(fetcher, { ttlMs: Number.NaN })).rejects.toThrow();
  });

  it('replaces a cached value on the next load (no stale-on-flip)', async () => {
    let v = true;
    const fetcher: TrustV1FlagFetcher = async () => v;
    await loadTrustV1Enabled(fetcher, { now: T0 });
    expect(getCachedTrustV1Enabled(T0)).toBe(true);

    v = false; // admin flipped the flag
    await loadTrustV1Enabled(fetcher, { now: T0 });
    expect(getCachedTrustV1Enabled(T0)).toBe(false);
  });

  // ── Strict-equality guard (docstring contract) ─────────────────────
  // The docstring says: "Fetcher returns anything other than `true`
  // (incl. truthy non-booleans like `1` or `"yes"`) → cached `false`.
  // Strict boolean check is what makes the cache a reliable gate;
  // type coercion would let a malformed wire response silently
  // surface the tab."
  //
  // The implementation enforces this with `value = raw === true`.
  // These tests pin the strict-equality semantics so a future
  // refactor to `!!raw` or `Boolean(raw)` would fail loudly here
  // rather than silently flipping the kill-switch open on bad wire
  // data. The TS type signature claims `Promise<boolean | null>` but
  // the test bypasses TS via `as unknown as TrustV1FlagFetcher` to
  // simulate exactly the malformed-server case the runtime guard
  // exists to defend against.

  it('coerces truthy number 1 to cached false (docstring: strict === true)', async () => {
    const fetcher = (async () => 1) as unknown as TrustV1FlagFetcher;
    const v = await loadTrustV1Enabled(fetcher, { now: T0 });
    expect(v).toBe(false);
    expect(getCachedTrustV1Enabled(T0 + 1)).toBe(false);
  });

  it('coerces truthy string "yes" to cached false', async () => {
    const fetcher = (async () => 'yes') as unknown as TrustV1FlagFetcher;
    const v = await loadTrustV1Enabled(fetcher, { now: T0 });
    expect(v).toBe(false);
    expect(getCachedTrustV1Enabled(T0 + 1)).toBe(false);
  });

  it('coerces truthy string "true" to cached false (NOT the boolean true)', async () => {
    // Subtle: the JSON string "true" is NOT the boolean true. A naive
    // string-parse layer that forgot to JSON.parse a wire field could
    // surface this exact value. Strict === guards correctly.
    const fetcher = (async () => 'true') as unknown as TrustV1FlagFetcher;
    const v = await loadTrustV1Enabled(fetcher, { now: T0 });
    expect(v).toBe(false);
  });

  it('coerces truthy object to cached false', async () => {
    const fetcher = (async () => ({ enabled: true })) as unknown as TrustV1FlagFetcher;
    const v = await loadTrustV1Enabled(fetcher, { now: T0 });
    expect(v).toBe(false);
  });

  it('coerces undefined to cached false', async () => {
    // Distinct from `null` (which the type signature admits and is
    // already tested): `undefined` is NOT in the type signature, but
    // the runtime guard handles it the same way as any other
    // non-`true` value.
    const fetcher = (async () => undefined) as unknown as TrustV1FlagFetcher;
    const v = await loadTrustV1Enabled(fetcher, { now: T0 });
    expect(v).toBe(false);
  });

  it('only the boolean `true` opens the gate (cross-check against truthy aliases)', async () => {
    // Single-test summary of the strict-equality contract: enumerate
    // common "would coerce to true under !!" values and assert they
    // ALL collapse to cached false. The boolean `true` is the lone
    // value that opens the gate.
    const truthyButNotTrue: readonly unknown[] = [
      1,
      'yes',
      'true',
      'enabled',
      [],
      {},
      Number.POSITIVE_INFINITY,
      Symbol('on'),
    ];
    for (const raw of truthyButNotTrue) {
      resetTrustV1FlagCache();
      const fetcher = (async () => raw) as unknown as TrustV1FlagFetcher;
      const v = await loadTrustV1Enabled(fetcher, { now: T0 });
      expect(v).toBe(false);
    }
  });
});

// ─── getCachedTrustV1Enabled ──────────────────────────────────────────────

describe('getCachedTrustV1Enabled', () => {
  it('returns null when never loaded (dev-workflow escape hatch)', () => {
    expect(getCachedTrustV1Enabled(T0)).toBeNull();
  });

  it('returns null after the TTL expires', async () => {
    await loadTrustV1Enabled(async () => true, { now: T0, ttlMs: 1_000 });
    expect(getCachedTrustV1Enabled(T0 + 500)).toBe(true); // fresh
    expect(getCachedTrustV1Enabled(T0 + 1_000)).toBeNull(); // exactly expired (boundary)
    expect(getCachedTrustV1Enabled(T0 + 5_000)).toBeNull(); // past
  });

  it('uses Date.now() when no `now` is supplied', async () => {
    await loadTrustV1Enabled(async () => true);
    // Fresh cache should still read true with the default TTL (5 min).
    expect(getCachedTrustV1Enabled()).toBe(true);
  });

  it('default TTL is 5 minutes', () => {
    expect(DEFAULT_FLAG_TTL_MS).toBe(5 * 60 * 1000);
  });
});

// ─── isTrustTabHidden ─────────────────────────────────────────────────────

describe('isTrustTabHidden', () => {
  it('returns false when never loaded (default visible — dev workflow)', () => {
    expect(isTrustTabHidden(T0)).toBe(false);
  });

  it('returns false when the cached value is true', async () => {
    await loadTrustV1Enabled(async () => true, { now: T0 });
    expect(isTrustTabHidden(T0)).toBe(false);
  });

  it('returns true ONLY when the cached value is explicitly false', async () => {
    await loadTrustV1Enabled(async () => false, { now: T0 });
    expect(isTrustTabHidden(T0)).toBe(true);
  });

  it('returns false again after the cache expires (collapses back to "unknown" → visible)', async () => {
    await loadTrustV1Enabled(async () => false, { now: T0, ttlMs: 1_000 });
    expect(isTrustTabHidden(T0 + 500)).toBe(true);
    expect(isTrustTabHidden(T0 + 5_000)).toBe(false);
  });
});

// ─── resetTrustV1FlagCache ────────────────────────────────────────────────

describe('resetTrustV1FlagCache', () => {
  it('clears the cache', async () => {
    await loadTrustV1Enabled(async () => true, { now: T0 });
    expect(getCachedTrustV1Enabled(T0)).toBe(true);
    resetTrustV1FlagCache();
    expect(getCachedTrustV1Enabled(T0)).toBeNull();
  });
});
