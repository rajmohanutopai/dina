/**
 * CORE-P0-005 + CORE-P0-006 — response policy tests.
 */

import {
  assertEncryptedResponse,
  assertResponderDidNotKey,
  PolicyViolationError,
} from '../../src/rpc/response_policy';

describe('assertEncryptedResponse (CORE-P0-005)', () => {
  it('accepts an encrypted response in production', () => {
    expect(() => assertEncryptedResponse(true, 'production')).not.toThrow();
  });

  it('rejects a plaintext response in production', () => {
    const err = (() => {
      try {
        assertEncryptedResponse(false, 'production');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(PolicyViolationError);
    expect((err as PolicyViolationError).code).toBe('plaintext_response');
    expect((err as PolicyViolationError).status).toBe(403);
  });

  it('allows plaintext in dev mode', () => {
    expect(() => assertEncryptedResponse(false, 'dev')).not.toThrow();
    expect(() => assertEncryptedResponse(true, 'dev')).not.toThrow();
  });
});

describe('assertResponderDidNotKey (CORE-P0-006)', () => {
  it('accepts did:plc responder', () => {
    expect(() => assertResponderDidNotKey('did:plc:example')).not.toThrow();
  });

  it('accepts did:web responder', () => {
    expect(() => assertResponderDidNotKey('did:web:bus42.example')).not.toThrow();
  });

  it('rejects did:key responder with code=did_key_responder', () => {
    const err = (() => {
      try {
        assertResponderDidNotKey('did:key:z6Mk...');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(PolicyViolationError);
    expect((err as PolicyViolationError).code).toBe('did_key_responder');
    expect((err as PolicyViolationError).status).toBe(403);
  });

  it('error message includes the offending DID for debuggability', () => {
    try {
      assertResponderDidNotKey('did:key:zAlice');
    } catch (e) {
      expect((e as Error).message).toContain('did:key:zAlice');
    }
  });

  it('does not false-positive on DIDs that merely contain "key" in the method or id', () => {
    // Only did:key: (with colon) is rejected; "keyring" or "key-chain" should pass.
    expect(() => assertResponderDidNotKey('did:plc:keyring-holder')).not.toThrow();
    expect(() => assertResponderDidNotKey('did:keyring:foo')).not.toThrow();
  });
});
