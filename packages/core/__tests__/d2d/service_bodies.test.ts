/**
 * Tests for D2D service.query / service.response body validation.
 *
 * Source parity: core/test/d2d_v1_domain_test.go  (ValidateV1Body for
 * service.query and service.response)
 */

import {
  ServiceQueryBody,
  ServiceResponseBody,
  validateServiceQueryBody,
  validateServiceResponseBody,
  validateFutureSkew,
} from '../../src/d2d/service_bodies';
import {
  MAX_SERVICE_TTL,
  MsgTypeServiceQuery,
  MsgTypeServiceResponse,
} from '../../src/d2d/families';

describe('D2D service body validation', () => {
  describe('constants', () => {
    it('MAX_SERVICE_TTL is 300 seconds (5 minutes)', () => {
      expect(MAX_SERVICE_TTL).toBe(300);
    });

    it('exposes message-type string constants', () => {
      expect(MsgTypeServiceQuery).toBe('service.query');
      expect(MsgTypeServiceResponse).toBe('service.response');
    });
  });

  describe('validateServiceQueryBody', () => {
    const valid: ServiceQueryBody = {
      query_id: 'q-001',
      capability: 'eta_query',
      params: { location: { lat: 37.77, lng: -122.41 } },
      ttl_seconds: 60,
    };

    it('accepts a well-formed body', () => {
      expect(validateServiceQueryBody(valid)).toBeNull();
    });

    it('accepts body with schema_hash', () => {
      expect(validateServiceQueryBody({ ...valid, schema_hash: 'abc123' })).toBeNull();
    });

    it('accepts a JSON.parse-d wire body (snake_case fields)', () => {
      const wire = JSON.parse(JSON.stringify(valid));
      expect(validateServiceQueryBody(wire)).toBeNull();
    });

    it('rejects null / non-object bodies', () => {
      expect(validateServiceQueryBody(null)).toContain('must be a JSON object');
      expect(validateServiceQueryBody(undefined)).toContain('must be a JSON object');
      expect(validateServiceQueryBody('string')).toContain('must be a JSON object');
      expect(validateServiceQueryBody(42)).toContain('must be a JSON object');
    });

    it('rejects missing query_id', () => {
      expect(validateServiceQueryBody({ ...valid, query_id: '' })).toContain(
        'query_id is required',
      );
      const { query_id: _q, ...noId } = valid;
      expect(validateServiceQueryBody(noId)).toContain('query_id is required');
    });

    it('rejects missing capability', () => {
      expect(validateServiceQueryBody({ ...valid, capability: '' })).toContain(
        'capability is required',
      );
    });

    it('rejects missing params', () => {
      expect(validateServiceQueryBody({ ...valid, params: undefined })).toContain(
        'params is required',
      );
      expect(validateServiceQueryBody({ ...valid, params: null })).toContain('params is required');
    });

    it('rejects ttl_seconds ≤ 0', () => {
      expect(validateServiceQueryBody({ ...valid, ttl_seconds: 0 })).toContain(
        'ttl_seconds must be 1-300',
      );
      expect(validateServiceQueryBody({ ...valid, ttl_seconds: -1 })).toContain(
        'ttl_seconds must be 1-300',
      );
    });

    it('rejects ttl_seconds > MAX_SERVICE_TTL', () => {
      expect(validateServiceQueryBody({ ...valid, ttl_seconds: 301 })).toContain(
        'ttl_seconds must be 1-300',
      );
    });

    it('accepts ttl_seconds at the boundaries', () => {
      expect(validateServiceQueryBody({ ...valid, ttl_seconds: 1 })).toBeNull();
      expect(validateServiceQueryBody({ ...valid, ttl_seconds: MAX_SERVICE_TTL })).toBeNull();
    });

    it('rejects non-numeric / non-finite ttl_seconds', () => {
      expect(
        validateServiceQueryBody({ ...valid, ttl_seconds: 'soon' as unknown as number }),
      ).toContain('ttl_seconds is required');
      expect(validateServiceQueryBody({ ...valid, ttl_seconds: Number.NaN })).toContain(
        'ttl_seconds is required',
      );
      expect(
        validateServiceQueryBody({ ...valid, ttl_seconds: Number.POSITIVE_INFINITY }),
      ).toContain('ttl_seconds is required');
    });

    it('rejects non-string schema_hash when present', () => {
      expect(
        validateServiceQueryBody({ ...valid, schema_hash: 42 as unknown as string }),
      ).toContain('schema_hash must be a string');
    });
  });

  describe('validateServiceResponseBody', () => {
    const valid: ServiceResponseBody = {
      query_id: 'q-001',
      capability: 'eta_query',
      status: 'success',
      result: { eta_minutes: 45 },
      ttl_seconds: 60,
    };

    it('accepts a well-formed success body', () => {
      expect(validateServiceResponseBody(valid)).toBeNull();
    });

    it('accepts an unavailable body with no result', () => {
      expect(
        validateServiceResponseBody({
          query_id: 'q-001',
          capability: 'eta_query',
          status: 'unavailable',
          ttl_seconds: 30,
        }),
      ).toBeNull();
    });

    it('accepts an error body with detail', () => {
      expect(
        validateServiceResponseBody({
          query_id: 'q-001',
          capability: 'eta_query',
          status: 'error',
          error: 'schema_version_mismatch',
          ttl_seconds: 30,
        }),
      ).toBeNull();
    });

    it('accepts a JSON.parse-d wire body (snake_case fields)', () => {
      const wire = JSON.parse(JSON.stringify(valid));
      expect(validateServiceResponseBody(wire)).toBeNull();
    });

    it('rejects null / non-object bodies', () => {
      expect(validateServiceResponseBody(null)).toContain('must be a JSON object');
    });

    it('rejects missing query_id', () => {
      expect(validateServiceResponseBody({ ...valid, query_id: '' })).toContain(
        'query_id is required',
      );
    });

    it('rejects missing capability', () => {
      expect(validateServiceResponseBody({ ...valid, capability: '' })).toContain(
        'capability is required',
      );
    });

    it('rejects missing status', () => {
      expect(validateServiceResponseBody({ ...valid, status: '' as 'success' })).toContain(
        'status is required',
      );
    });

    it('rejects unknown status value', () => {
      expect(validateServiceResponseBody({ ...valid, status: 'partial' as 'success' })).toContain(
        'status must be success|unavailable|error',
      );
    });

    it('rejects ttl_seconds outside (0, 300]', () => {
      expect(validateServiceResponseBody({ ...valid, ttl_seconds: 0 })).toContain(
        'ttl_seconds must be 1-300',
      );
      expect(validateServiceResponseBody({ ...valid, ttl_seconds: 301 })).toContain(
        'ttl_seconds must be 1-300',
      );
    });

    it('accepts ttl_seconds at the boundaries', () => {
      expect(validateServiceResponseBody({ ...valid, ttl_seconds: 1 })).toBeNull();
      expect(validateServiceResponseBody({ ...valid, ttl_seconds: MAX_SERVICE_TTL })).toBeNull();
    });
  });

  describe('validateFutureSkew', () => {
    const now = 1_700_000_000;

    it('accepts same-time messages', () => {
      expect(validateFutureSkew(now, now)).toBeNull();
    });

    it('accepts past messages (any age)', () => {
      expect(validateFutureSkew(now - 3600, now)).toBeNull();
      expect(validateFutureSkew(now - 86400, now)).toBeNull();
    });

    it('accepts messages within default 60s future skew', () => {
      expect(validateFutureSkew(now + 30, now)).toBeNull();
      expect(validateFutureSkew(now + 60, now)).toBeNull();
    });

    it('rejects messages beyond default 60s future skew', () => {
      const err = validateFutureSkew(now + 61, now);
      expect(err).toContain('in the future');
    });

    it('honours custom max_skew_seconds', () => {
      expect(validateFutureSkew(now + 10, now, 5)).toContain('in the future');
      expect(validateFutureSkew(now + 10, now, 10)).toBeNull();
    });

    it('rejects non-finite created_time', () => {
      expect(validateFutureSkew(Number.NaN, now)).toContain('must be a finite number');
      expect(validateFutureSkew(Number.POSITIVE_INFINITY, now)).toContain(
        'must be a finite number',
      );
    });
  });
});
