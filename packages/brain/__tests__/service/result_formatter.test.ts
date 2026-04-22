/**
 * BRAIN-P1-Q10-Q13 — result formatter tests.
 */

import {
  formatServiceQueryResult,
  type ServiceQueryEventDetails,
} from '../../src/service/result_formatter';

const BUS_DRIVER = 'Bus Driver';

describe('formatServiceQueryResult', () => {
  describe('terminal statuses', () => {
    it('expired → "No response from <name>"', () => {
      const out = formatServiceQueryResult({
        response_status: 'expired',
        service_name: BUS_DRIVER,
      });
      expect(out).toBe('No response from Bus Driver.');
    });

    it('unavailable → "<name> — service unavailable"', () => {
      const out = formatServiceQueryResult({
        response_status: 'unavailable',
        service_name: BUS_DRIVER,
      });
      expect(out).toBe('Bus Driver — service unavailable.');
    });

    it('error with explicit error text', () => {
      const out = formatServiceQueryResult({
        response_status: 'error',
        service_name: BUS_DRIVER,
        error: 'schema_version_mismatch',
      });
      // Matches Python: no trailing period on the error message itself.
      expect(out).toBe('Bus Driver — error: schema_version_mismatch');
    });

    it('error with missing error text defaults to "unknown"', () => {
      const out = formatServiceQueryResult({
        response_status: 'error',
        service_name: BUS_DRIVER,
      });
      expect(out).toBe('Bus Driver — error: unknown');
    });

    it('unknown status renders a fallback notice', () => {
      const out = formatServiceQueryResult({
        response_status: 'cosmic_ray',
        service_name: BUS_DRIVER,
      });
      expect(out).toMatch(/unexpected status/);
    });

    it('missing service_name defaults to "Service"', () => {
      const out = formatServiceQueryResult({ response_status: 'expired' });
      expect(out).toBe('No response from Service.');
    });
  });

  describe('eta_query success', () => {
    const base: ServiceQueryEventDetails = {
      response_status: 'success',
      capability: 'eta_query',
      service_name: BUS_DRIVER,
    };

    it('on_route with ETA + stop + map URL renders a 3-line summary', () => {
      const out = formatServiceQueryResult({
        ...base,
        result: {
          eta_minutes: 45,
          vehicle_type: 'Bus',
          route_name: '42',
          stop_name: 'Market & Powell',
          map_url: 'https://maps.google.com/?q=37.77,-122.41',
          status: 'on_route',
        },
      });
      expect(out).toBe(
        ['Bus 42', '45 min to Market & Powell', 'https://maps.google.com/?q=37.77,-122.41'].join(
          '\n',
        ),
      );
      // BRAIN-P3-Q02: Telegram auto-linkifies plain URLs, so we deliberately
      // do NOT wrap in Markdown syntax. Pin the invariant explicitly so a
      // future refactor adding `[label](url)` fails loudly.
      expect(out).not.toMatch(/\[[^\]]*\]\(/);
    });

    it('on_route with ETA but no stop renders "X minutes away"', () => {
      const out = formatServiceQueryResult({
        ...base,
        result: { eta_minutes: 12, vehicle_type: 'Bus', route_name: '42', status: 'on_route' },
      });
      expect(out).toBe('Bus 42\n12 minutes away');
    });

    it('defaults to status=on_route when the result omits status', () => {
      const out = formatServiceQueryResult({
        ...base,
        result: { eta_minutes: 5, vehicle_type: 'Tram', route_name: 'N' },
      });
      expect(out).toBe('Tram N\n5 minutes away');
    });

    it('on_route with no route name falls back to service_name as label', () => {
      const out = formatServiceQueryResult({
        ...base,
        result: { eta_minutes: 3, vehicle_type: 'Bus', route_name: '', status: 'on_route' },
      });
      expect(out.split('\n')[0]).toBe('Bus Driver');
    });

    it('not_on_route surfaces result.message when present', () => {
      const out = formatServiceQueryResult({
        ...base,
        result: { status: 'not_on_route', message: 'Closed for holiday.' },
      });
      expect(out).toBe('Closed for holiday.');
    });

    it('not_on_route with no message falls back to generic text', () => {
      const out = formatServiceQueryResult({
        ...base,
        result: { status: 'not_on_route' },
      });
      expect(out).toBe("Bus Driver doesn't serve your area.");
    });

    it('out_of_service generic fallback', () => {
      const out = formatServiceQueryResult({
        ...base,
        result: { status: 'out_of_service' },
      });
      expect(out).toBe('Bus Driver is not running at this time.');
    });

    it('not_found generic fallback', () => {
      const out = formatServiceQueryResult({
        ...base,
        result: { status: 'not_found' },
      });
      expect(out).toBe('Bus Driver — route not found.');
    });

    it('accepts result delivered as a JSON string (mixed pipe delivery)', () => {
      const out = formatServiceQueryResult({
        ...base,
        result: JSON.stringify({
          eta_minutes: 30,
          vehicle_type: 'Bus',
          route_name: '42',
          status: 'on_route',
        }),
      });
      expect(out).toBe('Bus 42\n30 minutes away');
    });

    it('malformed JSON string result collapses to empty — graceful fallback', () => {
      const out = formatServiceQueryResult({
        ...base,
        result: '{not json',
      });
      // result becomes {} → no ETA line, label falls back to service_name.
      expect(out).toBe('Bus Driver');
    });

    it('never throws on null result', () => {
      expect(() => formatServiceQueryResult({ ...base, result: null })).not.toThrow();
    });

    it('skips ETA line when eta_minutes is absent', () => {
      const out = formatServiceQueryResult({
        ...base,
        result: { vehicle_type: 'Bus', route_name: '42', map_url: 'https://m.test' },
      });
      expect(out).toBe('Bus 42\nhttps://m.test');
    });
  });

  describe('unregistered capability → generic formatter', () => {
    it('renders a truncated JSON summary', () => {
      const out = formatServiceQueryResult({
        response_status: 'success',
        capability: 'mystery_cap',
        service_name: 'Mystery Service',
        result: { value: 42 },
      });
      expect(out).toBe('Mystery Service — response received: {"value":42}');
    });

    it('truncates long payloads to 200 chars', () => {
      const big = { text: 'x'.repeat(500) };
      const out = formatServiceQueryResult({
        response_status: 'success',
        capability: 'mystery_cap',
        service_name: 'Mystery',
        result: big,
      });
      // "Mystery — response received: " + 200 chars
      expect(out.length).toBe('Mystery — response received: '.length + 200);
    });
  });
});
