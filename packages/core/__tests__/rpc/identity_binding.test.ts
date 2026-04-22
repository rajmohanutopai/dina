/**
 * CORE-P0-004 — Identity-binding tests.
 */

import { assertIdentityBinding, IdentityBindingError } from '../../src/rpc/identity_binding';
import type { RPCInnerRequest } from '../../src/rpc/types';

function req(headers: Record<string, string>): RPCInnerRequest {
  return {
    method: 'GET',
    path: '/v1/identity',
    headers,
    body: new Uint8Array(0),
  };
}

describe('assertIdentityBinding', () => {
  const DID = 'did:plc:example';

  it('accepts matching envelope and inner X-DID', () => {
    expect(() => assertIdentityBinding(DID, req({ 'X-DID': DID }))).not.toThrow();
  });

  it('header lookup is case-insensitive (HTTP convention)', () => {
    expect(() => assertIdentityBinding(DID, req({ 'x-did': DID }))).not.toThrow();
    expect(() => assertIdentityBinding(DID, req({ 'X-Did': DID }))).not.toThrow();
  });

  it('throws IdentityBindingError with status 401 on mismatch', () => {
    const err = (() => {
      try {
        assertIdentityBinding(DID, req({ 'X-DID': 'did:plc:other' }));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(IdentityBindingError);
    expect((err as IdentityBindingError).status).toBe(401);
    expect((err as IdentityBindingError).envelopeDid).toBe(DID);
    expect((err as IdentityBindingError).innerDid).toBe('did:plc:other');
  });

  it('rejects missing X-DID header', () => {
    expect(() => assertIdentityBinding(DID, req({}))).toThrow(IdentityBindingError);
  });

  it('rejects empty-string envelope DID', () => {
    expect(() => assertIdentityBinding('', req({ 'X-DID': DID }))).toThrow(IdentityBindingError);
  });

  it('rejects empty-string inner DID', () => {
    expect(() => assertIdentityBinding(DID, req({ 'X-DID': '' }))).toThrow(IdentityBindingError);
  });

  it('error message includes both DIDs for debuggability', () => {
    try {
      assertIdentityBinding(DID, req({ 'X-DID': 'did:plc:other' }));
    } catch (e) {
      expect((e as Error).message).toContain(DID);
      expect((e as Error).message).toContain('did:plc:other');
    }
  });
});
