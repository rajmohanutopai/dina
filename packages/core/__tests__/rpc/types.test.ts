/**
 * CORE-P0-001 + CORE-P0-003 — RPC inner request/response + body-size guard tests.
 */

import {
  MAX_INNER_BODY_SIZE,
  InnerBodyTooLargeError,
  assertInnerBodyWithinSize,
  type RPCInnerRequest,
  type RPCInnerResponse,
} from '../../src/rpc/types';

describe('RPC inner-body size cap', () => {
  it('MAX_INNER_BODY_SIZE = 1 MiB', () => {
    expect(MAX_INNER_BODY_SIZE).toBe(1024 * 1024);
  });

  it('accepts an empty body', () => {
    expect(() => assertInnerBodyWithinSize(new Uint8Array(0))).not.toThrow();
  });

  it('accepts a body exactly at the cap', () => {
    const body = new Uint8Array(MAX_INNER_BODY_SIZE);
    expect(() => assertInnerBodyWithinSize(body)).not.toThrow();
  });

  it('throws InnerBodyTooLargeError for bodies above the cap', () => {
    const body = new Uint8Array(MAX_INNER_BODY_SIZE + 1);
    const err = (() => {
      try {
        assertInnerBodyWithinSize(body);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InnerBodyTooLargeError);
    expect((err as InnerBodyTooLargeError).status).toBe(413);
    expect((err as InnerBodyTooLargeError).size).toBe(MAX_INNER_BODY_SIZE + 1);
  });

  it('error message mentions the concrete sizes', () => {
    const body = new Uint8Array(MAX_INNER_BODY_SIZE + 42);
    try {
      assertInnerBodyWithinSize(body);
    } catch (e) {
      expect((e as Error).message).toContain(String(MAX_INNER_BODY_SIZE));
      expect((e as Error).message).toContain(String(MAX_INNER_BODY_SIZE + 42));
    }
  });
});

describe('RPC inner request / response types', () => {
  it('RPCInnerRequest accepts a canonical shape', () => {
    const req: RPCInnerRequest = {
      method: 'GET',
      path: '/v1/identity',
      headers: { 'X-DID': 'did:plc:example', 'Content-Type': 'application/json' },
      body: new Uint8Array(0),
    };
    expect(req.method).toBe('GET');
    expect(req.path).toBe('/v1/identity');
    expect(Object.keys(req.headers)).toContain('X-DID');
    expect(req.body).toBeInstanceOf(Uint8Array);
  });

  it('RPCInnerResponse accepts a canonical shape', () => {
    const res: RPCInnerResponse = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: new TextEncoder().encode('{"ok":true}'),
    };
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/json');
    expect(new TextDecoder().decode(res.body)).toBe('{"ok":true}');
  });
});
