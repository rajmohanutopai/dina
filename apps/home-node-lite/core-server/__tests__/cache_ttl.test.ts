/**
 * Task 6.9 — cache TTL + Cache-Control tests.
 */

import {
  DEFAULT_MAX_TTL_MS,
  PLC_DEFAULT_TTL_MS,
  parseCacheControl,
  resolveTtl,
} from '../src/appview/cache_ttl';

describe('parseCacheControl (task 6.9)', () => {
  describe('empty input', () => {
    it.each([null, undefined, ''])('returns empty directives for %s', (input) => {
      const d = parseCacheControl(input);
      expect(d.maxAgeSeconds).toBeNull();
      expect(d.sMaxAgeSeconds).toBeNull();
      expect(d.noStore).toBe(false);
      expect(d.noCache).toBe(false);
      expect(d.mustRevalidate).toBe(false);
      expect(d.isPrivate).toBe(false);
      expect(d.isPublic).toBe(false);
      expect(d.unknownDirectives).toEqual([]);
    });
  });

  describe('boolean directives', () => {
    it.each([
      ['no-store', 'noStore'],
      ['no-cache', 'noCache'],
      ['must-revalidate', 'mustRevalidate'],
      ['private', 'isPrivate'],
      ['public', 'isPublic'],
    ] as const)('%s sets %s=true', (header, prop) => {
      const d = parseCacheControl(header);
      expect(d[prop]).toBe(true);
    });

    it('proxy-revalidate is treated as must-revalidate', () => {
      const d = parseCacheControl('proxy-revalidate');
      expect(d.mustRevalidate).toBe(true);
    });

    it('case-insensitive', () => {
      const d = parseCacheControl('NO-CACHE, PRIVATE, MAX-AGE=60');
      expect(d.noCache).toBe(true);
      expect(d.isPrivate).toBe(true);
      expect(d.maxAgeSeconds).toBe(60);
    });

    it('multiple booleans in one header', () => {
      const d = parseCacheControl('private, no-cache, must-revalidate');
      expect(d.isPrivate).toBe(true);
      expect(d.noCache).toBe(true);
      expect(d.mustRevalidate).toBe(true);
    });
  });

  describe('max-age', () => {
    it('parses simple max-age', () => {
      expect(parseCacheControl('max-age=300').maxAgeSeconds).toBe(300);
    });

    it('tolerates whitespace', () => {
      expect(parseCacheControl('max-age = 300').maxAgeSeconds).toBe(300);
    });

    it('max-age=0 is a valid directive (not a parse failure)', () => {
      expect(parseCacheControl('max-age=0').maxAgeSeconds).toBe(0);
    });

    it('rejects negative max-age as unknown', () => {
      const d = parseCacheControl('max-age=-5');
      expect(d.maxAgeSeconds).toBeNull();
      expect(d.unknownDirectives).toContain('max-age=-5');
    });

    it('rejects non-integer max-age as unknown', () => {
      const d = parseCacheControl('max-age=3.14');
      expect(d.maxAgeSeconds).toBeNull();
      expect(d.unknownDirectives).toContain('max-age=3.14');
    });

    it('s-maxage parsed independently', () => {
      const d = parseCacheControl('max-age=60, s-maxage=600');
      expect(d.maxAgeSeconds).toBe(60);
      expect(d.sMaxAgeSeconds).toBe(600);
    });
  });

  describe('unknown + malformed', () => {
    it('preserves unknown tokens', () => {
      const d = parseCacheControl('max-age=60, immutable, stale-while-revalidate=30');
      expect(d.maxAgeSeconds).toBe(60);
      expect(d.unknownDirectives).toEqual(
        expect.arrayContaining(['immutable', 'stale-while-revalidate=30']),
      );
    });

    it('skips empty tokens between commas', () => {
      const d = parseCacheControl(',,max-age=60,,');
      expect(d.maxAgeSeconds).toBe(60);
    });
  });
});

describe('resolveTtl (task 6.9)', () => {
  describe('no header — uses default', () => {
    it.each([null, undefined, ''])('cacheControl=%s falls back to default', (cc) => {
      const r = resolveTtl({ cacheControl: cc, defaultTtlMs: 60_000 });
      expect(r.ttlMs).toBe(60_000);
      expect(r.storable).toBe(true);
      expect(r.source).toBe('default');
    });
  });

  describe('no-store', () => {
    it('returns storable=false + ttl=0', () => {
      const r = resolveTtl({
        cacheControl: 'no-store',
        defaultTtlMs: 60_000,
      });
      expect(r.storable).toBe(false);
      expect(r.ttlMs).toBe(0);
      expect(r.source).toBe('no-store');
    });

    it('no-store wins over max-age', () => {
      const r = resolveTtl({
        cacheControl: 'no-store, max-age=600',
        defaultTtlMs: 60_000,
      });
      expect(r.storable).toBe(false);
    });
  });

  describe('no-cache', () => {
    it('returns storable=true + ttl=0 + mustRevalidate=true', () => {
      const r = resolveTtl({
        cacheControl: 'no-cache',
        defaultTtlMs: 60_000,
      });
      expect(r.storable).toBe(true);
      expect(r.ttlMs).toBe(0);
      expect(r.mustRevalidate).toBe(true);
      expect(r.source).toBe('no-cache');
    });

    it('no-cache beats max-age', () => {
      const r = resolveTtl({
        cacheControl: 'no-cache, max-age=600',
        defaultTtlMs: 60_000,
      });
      expect(r.source).toBe('no-cache');
    });
  });

  describe('max-age', () => {
    it('max-age=N → ttl = N * 1000', () => {
      const r = resolveTtl({
        cacheControl: 'max-age=300',
        defaultTtlMs: 60_000,
      });
      expect(r.ttlMs).toBe(300_000);
      expect(r.storable).toBe(true);
      expect(r.source).toBe('max-age');
    });

    it('max-age=0 is equivalent to no-cache (ttl=0 + must-revalidate)', () => {
      const r = resolveTtl({
        cacheControl: 'max-age=0',
        defaultTtlMs: 60_000,
      });
      expect(r.ttlMs).toBe(0);
      expect(r.mustRevalidate).toBe(true);
      expect(r.source).toBe('max-age');
    });

    it('max-age clamped to maxTtlMs', () => {
      const r = resolveTtl({
        cacheControl: 'max-age=1000000',
        defaultTtlMs: 60_000,
        maxTtlMs: 60 * 60 * 1000,
      });
      expect(r.ttlMs).toBe(60 * 60 * 1000);
    });

    it('must-revalidate flag propagates alongside max-age', () => {
      const r = resolveTtl({
        cacheControl: 'max-age=300, must-revalidate',
        defaultTtlMs: 60_000,
      });
      expect(r.mustRevalidate).toBe(true);
      expect(r.ttlMs).toBe(300_000);
    });
  });

  describe('s-maxage precedence', () => {
    it('s-maxage wins over max-age for downstream caches', () => {
      const r = resolveTtl({
        cacheControl: 'max-age=60, s-maxage=600',
        defaultTtlMs: 60_000,
      });
      expect(r.ttlMs).toBe(600_000);
      expect(r.source).toBe('s-maxage');
    });

    it('s-maxage=0 triggers revalidate too', () => {
      const r = resolveTtl({
        cacheControl: 's-maxage=0',
        defaultTtlMs: 60_000,
      });
      expect(r.ttlMs).toBe(0);
      expect(r.mustRevalidate).toBe(true);
      expect(r.source).toBe('s-maxage');
    });
  });

  describe('defaults + bounds', () => {
    it('default ttl clamped to maxTtlMs', () => {
      const r = resolveTtl({
        defaultTtlMs: 10 * 60 * 60 * 1000,
        maxTtlMs: 60 * 1000,
      });
      expect(r.ttlMs).toBe(60 * 1000);
    });

    it('negative defaultTtlMs throws RangeError', () => {
      expect(() =>
        resolveTtl({ defaultTtlMs: -1 }),
      ).toThrow(/defaultTtlMs/);
    });

    it('negative maxTtlMs throws RangeError', () => {
      expect(() =>
        resolveTtl({ defaultTtlMs: 0, maxTtlMs: -1 }),
      ).toThrow(/maxTtlMs/);
    });

    it('NaN defaultTtlMs throws RangeError', () => {
      expect(() => resolveTtl({ defaultTtlMs: NaN })).toThrow();
    });

    // ── ±Infinity coverage ─────────────────────────────────────────
    // Production guard `!Number.isFinite(opts.defaultTtlMs) || ... < 0`
    // catches NaN AND ±Infinity. A refactor to `Number.isNaN(n)` (a
    // common "fix" when only NaN appears in tests) would silently let
    // Infinity through — and `+Infinity * 1000` clamped to maxTtlMs
    // would surface a 24h ceiling-cap result that LOOKS sane, hiding
    // the input bug. Pin every non-finite that should throw.

    it.each([
      ['+Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('defaultTtlMs=%s throws RangeError', (_label, value) => {
      expect(() => resolveTtl({ defaultTtlMs: value })).toThrow(/defaultTtlMs/);
    });

    it.each([
      ['+Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['NaN', Number.NaN],
    ])('maxTtlMs=%s throws RangeError', (_label, value) => {
      expect(() => resolveTtl({ defaultTtlMs: 0, maxTtlMs: value })).toThrow(/maxTtlMs/);
    });
  });

  describe('constants', () => {
    it('PLC_DEFAULT_TTL_MS is 1 hour (per task spec)', () => {
      expect(PLC_DEFAULT_TTL_MS).toBe(60 * 60 * 1000);
    });

    it('DEFAULT_MAX_TTL_MS is 24 hours', () => {
      expect(DEFAULT_MAX_TTL_MS).toBe(24 * 60 * 60 * 1000);
    });
  });

  describe('realistic AppView/PLC scenarios', () => {
    it('PLC response with Cache-Control: public, max-age=3600 → 1h', () => {
      const r = resolveTtl({
        cacheControl: 'public, max-age=3600',
        defaultTtlMs: PLC_DEFAULT_TTL_MS,
      });
      expect(r.ttlMs).toBe(3600_000);
      expect(r.source).toBe('max-age');
    });

    it('PLC response with no header → 1h default', () => {
      const r = resolveTtl({
        defaultTtlMs: PLC_DEFAULT_TTL_MS,
      });
      expect(r.ttlMs).toBe(PLC_DEFAULT_TTL_MS);
      expect(r.source).toBe('default');
    });

    it('AppView response with Cache-Control: private, no-cache → revalidate', () => {
      const r = resolveTtl({
        cacheControl: 'private, no-cache',
        defaultTtlMs: 60_000,
      });
      expect(r.mustRevalidate).toBe(true);
      expect(r.ttlMs).toBe(0);
      expect(r.storable).toBe(true);
    });
  });
});
