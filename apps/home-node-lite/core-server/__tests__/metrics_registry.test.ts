/**
 * Tasks 4.88 + 4.89 — MetricsRegistry tests.
 *
 * Pins per-route histogram binning, per-status counter keying, error-
 * rate derivation, and the snapshot wire shape.
 */

import {
  DEFAULT_HISTOGRAM_BUCKETS_SEC,
  MetricsRegistry,
} from '../src/metrics/registry';

describe('MetricsRegistry (tasks 4.88 + 4.89)', () => {
  describe('constants', () => {
    it('default buckets mirror Prometheus defHistogramBuckets', () => {
      expect(DEFAULT_HISTOGRAM_BUCKETS_SEC).toEqual([
        0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
      ]);
    });
  });

  describe('record + snapshot — basic', () => {
    it('single observation: counter + histogram updated, totals incremented', () => {
      const reg = new MetricsRegistry();
      reg.record('/v1/pair/devices', 'GET', 200, 0.015);
      const snap = reg.snapshot();

      expect(snap.totalRequests).toBe(1);
      expect(snap.totalErrors).toBe(0);
      expect(snap.counters).toHaveLength(1);
      expect(snap.counters[0]).toMatchObject({
        route: '/v1/pair/devices',
        method: 'GET',
        status: 200,
        count: 1,
      });
      expect(snap.histograms).toHaveLength(1);
      const h = snap.histograms[0]!;
      expect(h.count).toBe(1);
      expect(h.sum).toBeCloseTo(0.015, 9);
      expect(h.overflow).toBe(0);
    });

    it('histogram places observation into the smallest bucket it fits (0.015 → le=0.025)', () => {
      const reg = new MetricsRegistry();
      reg.record('/x', 'GET', 200, 0.015);
      const h = reg.snapshot().histograms[0]!;
      // Find the 0.025 bucket and verify only it got the observation.
      for (const b of h.buckets) {
        if (b.le === 0.025) {
          expect(b.count).toBe(1);
        } else {
          expect(b.count).toBe(0);
        }
      }
    });

    it('boundary: observation exactly at bucket upper bound is included (<=, not <)', () => {
      const reg = new MetricsRegistry();
      reg.record('/x', 'GET', 200, 0.05);
      const h = reg.snapshot().histograms[0]!;
      // 0.05 → le=0.05 bucket must be 1, nothing in the smaller buckets.
      const buckAt = h.buckets.find((b) => b.le === 0.05)!;
      expect(buckAt.count).toBe(1);
    });

    it('observation above largest bucket lands in overflow', () => {
      const reg = new MetricsRegistry();
      reg.record('/x', 'GET', 200, 60); // way past 10s
      const h = reg.snapshot().histograms[0]!;
      expect(h.overflow).toBe(1);
      expect(h.count).toBe(1);
      expect(h.buckets.every((b) => b.count === 0)).toBe(true);
    });
  });

  describe('counter keying — (route, method, status)', () => {
    it('same route different status → distinct counters', () => {
      const reg = new MetricsRegistry();
      reg.record('/x', 'GET', 200, 0.01);
      reg.record('/x', 'GET', 200, 0.02);
      reg.record('/x', 'GET', 404, 0.01);
      const snap = reg.snapshot();
      expect(snap.counters).toHaveLength(2);
      const byStatus = Object.fromEntries(snap.counters.map((c) => [c.status, c.count]));
      expect(byStatus[200]).toBe(2);
      expect(byStatus[404]).toBe(1);
    });

    it('same route different method → distinct counters', () => {
      const reg = new MetricsRegistry();
      reg.record('/x', 'GET', 200, 0.01);
      reg.record('/x', 'POST', 200, 0.01);
      expect(reg.snapshot().counters).toHaveLength(2);
    });

    it('method is uppercased (GET == get)', () => {
      const reg = new MetricsRegistry();
      reg.record('/x', 'GET', 200, 0.01);
      reg.record('/x', 'get', 200, 0.01);
      const snap = reg.snapshot();
      expect(snap.counters).toHaveLength(1);
      expect(snap.counters[0]!.method).toBe('GET');
      expect(snap.counters[0]!.count).toBe(2);
    });

    it('empty route falls back to "unknown" (not empty-string collision)', () => {
      const reg = new MetricsRegistry();
      reg.record('', 'GET', 200, 0.01);
      expect(reg.snapshot().counters[0]!.route).toBe('unknown');
    });
  });

  describe('histogram keying — (route, method)', () => {
    it('same (route, method) across statuses → one histogram, multiple counters', () => {
      const reg = new MetricsRegistry();
      reg.record('/x', 'GET', 200, 0.01);
      reg.record('/x', 'GET', 404, 0.02);
      reg.record('/x', 'GET', 500, 0.03);
      const snap = reg.snapshot();
      expect(snap.histograms).toHaveLength(1);
      expect(snap.histograms[0]!.count).toBe(3);
      expect(snap.counters).toHaveLength(3);
    });

    it('histogram sum tracks raw seconds', () => {
      const reg = new MetricsRegistry();
      reg.record('/x', 'GET', 200, 0.5);
      reg.record('/x', 'GET', 200, 1.5);
      reg.record('/x', 'GET', 200, 7);
      expect(reg.snapshot().histograms[0]!.sum).toBeCloseTo(9, 9);
    });
  });

  describe('error-rate derivation', () => {
    it('totalErrors counts status >= 400', () => {
      const reg = new MetricsRegistry();
      reg.record('/x', 'GET', 200, 0.01);
      reg.record('/x', 'GET', 301, 0.01); // not an error
      reg.record('/x', 'GET', 400, 0.01);
      reg.record('/x', 'GET', 404, 0.01);
      reg.record('/x', 'GET', 500, 0.01);
      const snap = reg.snapshot();
      expect(snap.totalRequests).toBe(5);
      expect(snap.totalErrors).toBe(3);
    });

    it('status 399 is NOT an error; 400 is the floor', () => {
      const reg = new MetricsRegistry();
      reg.record('/x', 'GET', 399, 0.01);
      reg.record('/x', 'GET', 400, 0.01);
      const snap = reg.snapshot();
      expect(snap.totalErrors).toBe(1);
    });
  });

  describe('snapshot ordering', () => {
    it('counters sorted by route asc, method asc, status asc', () => {
      const reg = new MetricsRegistry();
      reg.record('/b', 'GET', 500, 0.01);
      reg.record('/a', 'POST', 200, 0.01);
      reg.record('/a', 'GET', 200, 0.01);
      reg.record('/a', 'GET', 404, 0.01);
      const ids = reg
        .snapshot()
        .counters.map((c) => `${c.route}|${c.method}|${c.status}`);
      expect(ids).toEqual(['/a|GET|200', '/a|GET|404', '/a|POST|200', '/b|GET|500']);
    });

    it('histograms sorted by route asc, method asc', () => {
      const reg = new MetricsRegistry();
      reg.record('/b', 'GET', 200, 0.01);
      reg.record('/a', 'POST', 200, 0.01);
      reg.record('/a', 'GET', 200, 0.01);
      const ids = reg.snapshot().histograms.map((h) => `${h.route}|${h.method}`);
      expect(ids).toEqual(['/a|GET', '/a|POST', '/b|GET']);
    });
  });

  describe('reset', () => {
    it('clears counters + histograms + totals', () => {
      const reg = new MetricsRegistry();
      reg.record('/x', 'GET', 200, 0.01);
      reg.record('/x', 'GET', 500, 0.01);
      expect(reg.snapshot().totalRequests).toBe(2);
      reg.reset();
      const snap = reg.snapshot();
      expect(snap.totalRequests).toBe(0);
      expect(snap.totalErrors).toBe(0);
      expect(snap.counters).toEqual([]);
      expect(snap.histograms).toEqual([]);
    });
  });

  describe('custom buckets', () => {
    it('honours a custom ascending bucket list', () => {
      const reg = new MetricsRegistry({ bucketsSec: [0.1, 1, 10] });
      reg.record('/x', 'GET', 200, 0.05);
      reg.record('/x', 'GET', 200, 0.5);
      reg.record('/x', 'GET', 200, 5);
      reg.record('/x', 'GET', 200, 50);
      const h = reg.snapshot().histograms[0]!;
      const le = Object.fromEntries(h.buckets.map((b) => [b.le, b.count]));
      expect(le[0.1]).toBe(1);
      expect(le[1]).toBe(1);
      expect(le[10]).toBe(1);
      expect(h.overflow).toBe(1);
    });

    it('rejects non-ascending buckets', () => {
      expect(() => new MetricsRegistry({ bucketsSec: [0.1, 0.2, 0.2, 0.5] })).toThrow(
        /strictly ascending/,
      );
      expect(() => new MetricsRegistry({ bucketsSec: [1, 0.5] })).toThrow(
        /strictly ascending/,
      );
    });

    it('rejects non-positive bucket', () => {
      expect(() => new MetricsRegistry({ bucketsSec: [0, 1] })).toThrow(
        /positive finite number/,
      );
      expect(() => new MetricsRegistry({ bucketsSec: [-1, 1] })).toThrow(
        /positive finite number/,
      );
      expect(() => new MetricsRegistry({ bucketsSec: [Infinity] })).toThrow(
        /positive finite number/,
      );
    });
  });

  describe('record validation', () => {
    it('rejects negative / NaN / Infinity status', () => {
      const reg = new MetricsRegistry();
      expect(() => reg.record('/x', 'GET', -1, 0.01)).toThrow(/non-negative/);
      expect(() => reg.record('/x', 'GET', NaN, 0.01)).toThrow(/non-negative/);
      expect(() => reg.record('/x', 'GET', Infinity, 0.01)).toThrow(/non-negative/);
    });

    it('rejects negative / NaN / Infinity duration', () => {
      const reg = new MetricsRegistry();
      expect(() => reg.record('/x', 'GET', 200, -0.1)).toThrow(/non-negative/);
      expect(() => reg.record('/x', 'GET', 200, NaN)).toThrow(/non-negative/);
      expect(() => reg.record('/x', 'GET', 200, Infinity)).toThrow(/non-negative/);
    });
  });

  describe('key count introspectors', () => {
    it('counterKeyCount + histogramKeyCount reflect distinct keys', () => {
      const reg = new MetricsRegistry();
      expect(reg.counterKeyCount()).toBe(0);
      expect(reg.histogramKeyCount()).toBe(0);
      reg.record('/a', 'GET', 200, 0.01);
      reg.record('/a', 'GET', 404, 0.01); // same histogram, new counter
      reg.record('/b', 'GET', 200, 0.01); // new both
      expect(reg.counterKeyCount()).toBe(3);
      expect(reg.histogramKeyCount()).toBe(2);
    });
  });
});
