/**
 * Validators smoke — task 1.20.
 *
 * Covers:
 *   (1) parseMessageJSON — happy path + every failure mode.
 *   (2) validateServiceQueryBody + validateServiceResponseBody —
 *       spot-checks on each invariant.
 *   (3) validateFutureSkew — within/outside skew + non-finite guard.
 *   (4) verifyMessageSignature — crypto-callback DI, rotation support,
 *       fail-closed on malformed signatures.
 *
 * Error messages are asserted exactly because Core + Brain logs tail
 * these strings (grep-ability matters).
 */

import {
  parseMessageJSON,
  validateServiceQueryBody,
  validateServiceResponseBody,
  validateFutureSkew,
  verifyMessageSignature,
  buildMessageJSON,
  type Ed25519VerifyFn,
} from '../src';

describe('parseMessageJSON (task 1.20)', () => {
  it('round-trips a buildMessageJSON output losslessly', () => {
    const json = buildMessageJSON({
      id: 'msg-1',
      type: 'coordination.request',
      from: 'did:plc:a',
      to: ['did:plc:b', 'did:plc:c'],
      created_time: 1776700000,
      bodyBase64: 'aGVsbG8=',
    });
    const parsed = parseMessageJSON(json);
    expect(parsed.id).toBe('msg-1');
    expect(parsed.type).toBe('coordination.request');
    expect(parsed.from).toBe('did:plc:a');
    expect(parsed.to).toEqual(['did:plc:b', 'did:plc:c']);
    expect(parsed.created_time).toBe(1776700000);
    expect(parsed.bodyBase64).toBe('aGVsbG8=');
  });

  it('accepts legacy bare-string `to` and normalises to array', () => {
    const parsed = parseMessageJSON(
      '{"id":"m","type":"t","from":"a","to":"did:plc:bob","created_time":0,"body":""}',
    );
    expect(parsed.to).toEqual(['did:plc:bob']);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseMessageJSON('{not json')).toThrow('envelope: invalid JSON');
  });

  it('throws on missing required fields', () => {
    expect(() => parseMessageJSON('{"id":"m","type":"t","from":"a","to":[],"created_time":0}'))
      .toThrow('envelope: missing required field "body"');
  });

  it('throws on wrong field types', () => {
    expect(() =>
      parseMessageJSON(
        '{"id":1,"type":"t","from":"a","to":[],"created_time":0,"body":""}',
      ),
    ).toThrow('envelope: id must be a string');
  });

  it('throws on non-string `to` array elements', () => {
    expect(() =>
      parseMessageJSON(
        '{"id":"m","type":"t","from":"a","to":[1,2],"created_time":0,"body":""}',
      ),
    ).toThrow('envelope: to must be a string or string array');
  });
});

describe('validateServiceQueryBody (task 1.20)', () => {
  const validBody = {
    query_id: 'q-1',
    capability: 'eta_query',
    params: { route_id: '42' },
    ttl_seconds: 60,
  };

  it('returns null for a well-formed body', () => {
    expect(validateServiceQueryBody(validBody)).toBeNull();
  });

  it('rejects non-object bodies', () => {
    expect(validateServiceQueryBody(null)).toBe('service.query: body must be a JSON object');
    expect(validateServiceQueryBody('string')).toBe(
      'service.query: body must be a JSON object',
    );
  });

  it('rejects empty query_id / capability', () => {
    expect(validateServiceQueryBody({ ...validBody, query_id: '' })).toBe(
      'service.query: query_id is required',
    );
    expect(validateServiceQueryBody({ ...validBody, capability: '' })).toBe(
      'service.query: capability is required',
    );
  });

  it('rejects ttl_seconds outside (0, MAX_SERVICE_TTL]', () => {
    expect(validateServiceQueryBody({ ...validBody, ttl_seconds: 0 })).toMatch(
      /ttl_seconds must be 1-/,
    );
    expect(validateServiceQueryBody({ ...validBody, ttl_seconds: 999999 })).toMatch(
      /ttl_seconds must be 1-/,
    );
  });

  it('requires params to be defined (not undefined/null)', () => {
    const { params, ...rest } = validBody;
    void params;
    expect(validateServiceQueryBody(rest)).toBe('service.query: params is required');
  });

  it('validates schema_hash type when present', () => {
    expect(validateServiceQueryBody({ ...validBody, schema_hash: 42 })).toBe(
      'service.query: schema_hash must be a string when present',
    );
  });
});

describe('validateServiceResponseBody (task 1.20)', () => {
  const validBody = {
    query_id: 'q-1',
    capability: 'eta_query',
    status: 'success',
    ttl_seconds: 60,
    result: { eta_minutes: 12 },
  };

  it('returns null for a well-formed success body', () => {
    expect(validateServiceResponseBody(validBody)).toBeNull();
  });

  it('accepts unavailable + error statuses', () => {
    expect(validateServiceResponseBody({ ...validBody, status: 'unavailable' })).toBeNull();
    expect(validateServiceResponseBody({ ...validBody, status: 'error' })).toBeNull();
  });

  it('rejects an invalid status literal', () => {
    expect(validateServiceResponseBody({ ...validBody, status: 'ok' })).toBe(
      'service.response: status must be success|unavailable|error, got "ok"',
    );
  });
});

describe('validateFutureSkew (task 1.20)', () => {
  it('accepts times within the skew window', () => {
    expect(validateFutureSkew(1000, 1000)).toBeNull();
    expect(validateFutureSkew(1050, 1000, 60)).toBeNull();
  });

  it('rejects times more than max_skew in the future', () => {
    expect(validateFutureSkew(1121, 1000, 60)).toBe(
      'created_time is 121s in the future (max skew 60s)',
    );
  });

  it('accepts times in the past (skew is future-only)', () => {
    expect(validateFutureSkew(0, 1000, 60)).toBeNull();
  });

  it('rejects non-finite created_time', () => {
    expect(validateFutureSkew(Number.NaN, 1000)).toBe('created_time must be a finite number');
    expect(validateFutureSkew(Number.POSITIVE_INFINITY, 1000)).toBe(
      'created_time must be a finite number',
    );
  });
});

describe('verifyMessageSignature (task 1.20)', () => {
  // A deterministic stub that passes iff the public key starts with
  // the expected byte. Lets us verify the rotation-support / early-out
  // behavior without pulling in a real crypto lib.
  const STUB_MATCHING_KEY = new Uint8Array([0xaa, 1, 2, 3]);
  const STUB_OTHER_KEY = new Uint8Array([0xbb, 1, 2, 3]);
  const fakeVerify: Ed25519VerifyFn = (pubKey) => pubKey[0] === 0xaa;
  const fakeHexToBytes = (hex: string): Uint8Array => {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  };

  const msg = {
    id: 'm',
    type: 't',
    from: 'a',
    to: ['b'],
    created_time: 0,
    bodyBase64: '',
  };
  const validHex = 'a'.repeat(128);

  it('returns true when any key in the rotation list matches', () => {
    expect(
      verifyMessageSignature({
        message: msg,
        signatureHex: validHex,
        verificationKeys: [STUB_OTHER_KEY, STUB_MATCHING_KEY],
        verify: fakeVerify,
        hexToBytes: fakeHexToBytes,
      }),
    ).toBe(true);
  });

  it('returns false when no key matches', () => {
    expect(
      verifyMessageSignature({
        message: msg,
        signatureHex: validHex,
        verificationKeys: [STUB_OTHER_KEY],
        verify: fakeVerify,
        hexToBytes: fakeHexToBytes,
      }),
    ).toBe(false);
  });

  it('fails closed on empty key list', () => {
    expect(
      verifyMessageSignature({
        message: msg,
        signatureHex: validHex,
        verificationKeys: [],
        verify: fakeVerify,
        hexToBytes: fakeHexToBytes,
      }),
    ).toBe(false);
  });

  it('fails closed on malformed hex signature (wrong length)', () => {
    expect(
      verifyMessageSignature({
        message: msg,
        signatureHex: 'aa',
        verificationKeys: [STUB_MATCHING_KEY],
        verify: fakeVerify,
        hexToBytes: fakeHexToBytes,
      }),
    ).toBe(false);
  });

  it('fails closed on non-hex chars in signature', () => {
    expect(
      verifyMessageSignature({
        message: msg,
        signatureHex: 'z'.repeat(128),
        verificationKeys: [STUB_MATCHING_KEY],
        verify: fakeVerify,
        hexToBytes: fakeHexToBytes,
      }),
    ).toBe(false);
  });

  it('catches verify() throws and moves to the next rotation key', () => {
    const throwingVerify: Ed25519VerifyFn = (pubKey) => {
      if (pubKey[0] === 0xbb) throw new Error('boom');
      return pubKey[0] === 0xaa;
    };
    expect(
      verifyMessageSignature({
        message: msg,
        signatureHex: validHex,
        verificationKeys: [STUB_OTHER_KEY, STUB_MATCHING_KEY],
        verify: throwingVerify,
        hexToBytes: fakeHexToBytes,
      }),
    ).toBe(true);
  });
});
