/**
 * Task 4.85 — Prometheus exposition tests.
 *
 * Pins the text-format wire shape for the `/metrics` endpoint so
 * Prometheus / Grafana Agent / VictoriaMetrics all parse us correctly.
 */

import {
  DEFAULT_METRIC_PREFIX,
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheusText,
} from '../src/metrics/exporter';
import { MetricsRegistry } from '../src/metrics/registry';

describe('renderPrometheusText (task 4.85)', () => {
  describe('constants', () => {
    it('DEFAULT_METRIC_PREFIX is "dina_core"', () => {
      expect(DEFAULT_METRIC_PREFIX).toBe('dina_core');
    });
    it('PROMETHEUS_CONTENT_TYPE is version=0.0.4', () => {
      expect(PROMETHEUS_CONTENT_TYPE).toBe(
        'text/plain; version=0.0.4; charset=utf-8',
      );
    });
  });

  describe('empty snapshot (cold boot)', () => {
    it('emits totals + TYPE/HELP headers, no counter/histogram rows', () => {
      const text = renderPrometheusText(new MetricsRegistry().snapshot());
      expect(text).toContain('# HELP dina_core_requests_total_all');
      expect(text).toContain('# TYPE dina_core_requests_total_all counter');
      expect(text).toContain('dina_core_requests_total_all 0');
      expect(text).toContain('dina_core_requests_error_total 0');
      // TYPE + HELP for the families must always be present.
      expect(text).toContain('# TYPE dina_core_requests_total counter');
      expect(text).toContain(
        '# TYPE dina_core_request_duration_seconds histogram',
      );
      // Ends with a newline per Prometheus convention.
      expect(text.endsWith('\n')).toBe(true);
    });
  });

  describe('single observation', () => {
    it('renders the counter + cumulative buckets + count + sum', () => {
      const reg = new MetricsRegistry();
      reg.record('/v1/things', 'GET', 200, 0.015);
      const text = renderPrometheusText(reg.snapshot());

      expect(text).toContain(
        'dina_core_requests_total{route="/v1/things",method="GET",status="200"} 1',
      );
      // Prometheus convention: bucket counts are CUMULATIVE.
      // 0.015s lands in the le=0.025 bucket; smaller buckets are 0, larger+are 1.
      expect(text).toContain(
        'dina_core_request_duration_seconds_bucket{route="/v1/things",method="GET",le="0.01"} 0',
      );
      expect(text).toContain(
        'dina_core_request_duration_seconds_bucket{route="/v1/things",method="GET",le="0.025"} 1',
      );
      expect(text).toContain(
        'dina_core_request_duration_seconds_bucket{route="/v1/things",method="GET",le="0.05"} 1',
      );
      // +Inf terminal bucket present + equal to total count.
      expect(text).toContain(
        'dina_core_request_duration_seconds_bucket{route="/v1/things",method="GET",le="+Inf"} 1',
      );
      expect(text).toContain(
        'dina_core_request_duration_seconds_count{route="/v1/things",method="GET"} 1',
      );
      // Sum with non-scientific formatting.
      expect(text).toMatch(
        /dina_core_request_duration_seconds_sum\{route="\/v1\/things",method="GET"\} 0\.015/,
      );
    });
  });

  describe('overflow lands in +Inf but not in numbered buckets', () => {
    it('observation above largest bucket keeps numbered counts stable, +Inf = total', () => {
      const reg = new MetricsRegistry();
      reg.record('/slow', 'GET', 200, 60); // 60s > 10s largest bucket
      const text = renderPrometheusText(reg.snapshot());
      expect(text).toContain(
        'dina_core_request_duration_seconds_bucket{route="/slow",method="GET",le="10"} 0',
      );
      expect(text).toContain(
        'dina_core_request_duration_seconds_bucket{route="/slow",method="GET",le="+Inf"} 1',
      );
      expect(text).toContain(
        'dina_core_request_duration_seconds_count{route="/slow",method="GET"} 1',
      );
    });
  });

  describe('multiple observations + multiple routes', () => {
    it('aggregates per-(route, method) histograms and per-(route, method, status) counters', () => {
      const reg = new MetricsRegistry();
      reg.record('/a', 'GET', 200, 0.01);
      reg.record('/a', 'GET', 404, 0.02);
      reg.record('/b', 'POST', 500, 0.5);
      const text = renderPrometheusText(reg.snapshot());

      expect(text).toContain(
        'dina_core_requests_total{route="/a",method="GET",status="200"} 1',
      );
      expect(text).toContain(
        'dina_core_requests_total{route="/a",method="GET",status="404"} 1',
      );
      expect(text).toContain(
        'dina_core_requests_total{route="/b",method="POST",status="500"} 1',
      );
      expect(text).toContain('dina_core_requests_total_all 3');
      expect(text).toContain('dina_core_requests_error_total 2'); // 404 + 500
    });

    it('sort order is stable (route asc, method asc, status asc)', () => {
      const reg = new MetricsRegistry();
      reg.record('/b', 'GET', 200, 0.01);
      reg.record('/a', 'POST', 500, 0.01);
      reg.record('/a', 'GET', 200, 0.01);
      const text = renderPrometheusText(reg.snapshot());
      // Find the relative positions of the three counter lines.
      const ia = text.indexOf('route="/a",method="GET"');
      const ib = text.indexOf('route="/a",method="POST"');
      const ic = text.indexOf('route="/b",method="GET"');
      expect(ia).toBeGreaterThan(-1);
      expect(ib).toBeGreaterThan(ia);
      expect(ic).toBeGreaterThan(ib);
    });
  });

  describe('label escaping', () => {
    it('escapes embedded double-quote in route', () => {
      const reg = new MetricsRegistry();
      reg.record('/x"y', 'GET', 200, 0.01);
      const text = renderPrometheusText(reg.snapshot());
      expect(text).toContain('route="/x\\"y"');
    });

    it('escapes backslash in route', () => {
      const reg = new MetricsRegistry();
      reg.record('/x\\y', 'GET', 200, 0.01);
      const text = renderPrometheusText(reg.snapshot());
      expect(text).toContain('route="/x\\\\y"');
    });

    it('escapes newline in route', () => {
      const reg = new MetricsRegistry();
      reg.record('/x\ny', 'GET', 200, 0.01);
      const text = renderPrometheusText(reg.snapshot());
      expect(text).toContain('route="/x\\ny"');
    });
  });

  describe('namePrefix override', () => {
    it('honours a custom prefix', () => {
      const reg = new MetricsRegistry();
      reg.record('/x', 'GET', 200, 0.01);
      const text = renderPrometheusText(reg.snapshot(), { namePrefix: 'zzz' });
      expect(text).toContain('zzz_requests_total{route="/x"');
      expect(text).toContain('zzz_requests_error_total 0');
      expect(text).toContain('zzz_request_duration_seconds_count');
      expect(text).not.toContain('dina_core_');
    });
  });

  describe('integer bucket rendering', () => {
    it('le="1" and le="10" render without decimal point', () => {
      const reg = new MetricsRegistry();
      reg.record('/x', 'GET', 200, 0.01);
      const text = renderPrometheusText(reg.snapshot());
      expect(text).toContain(',le="1"');
      expect(text).toContain(',le="10"');
      expect(text).not.toContain(',le="1.0"');
    });
  });
});
