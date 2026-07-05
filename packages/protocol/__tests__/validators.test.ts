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
  validateServiceOfferBody,
  validateServiceGrantRequestBody,
  validateFutureSkew,
  verifyMessageSignature,
  buildMessageJSON,
  isValidServiceListingRkey,
  parseServiceListingUri,
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

  it('accepts grant_id when present + rejects a non-string', () => {
    expect(validateServiceQueryBody({ ...validBody, grant_id: 'grant-1' })).toBeNull();
    expect(validateServiceQueryBody({ ...validBody, grant_id: 42 })).toBe(
      'service.query: grant_id must be a string when present',
    );
  });

  it('validates service_uri type when present', () => {
    expect(validateServiceQueryBody({ ...validBody, service_uri: 42 })).toBe(
      'service.query: service_uri must be a string when present',
    );
  });

  it('accepts a well-formed listing service_uri (P2: bound listing URI)', () => {
    expect(
      validateServiceQueryBody({
        ...validBody,
        service_uri: 'at://did:plc:bus42/com.dinakernel.service.profile/store-2',
      }),
    ).toBeNull();
    // Empty string = "absent" → accepted.
    expect(validateServiceQueryBody({ ...validBody, service_uri: '' })).toBeNull();
    // Absent entirely → accepted.
    expect(validateServiceQueryBody(validBody)).toBeNull();
  });

  it('rejects a structurally-malformed service_uri (P2)', () => {
    const expected =
      'service.query: service_uri must be an at://<did>/com.dinakernel.service.profile/<rkey> URI';
    // Wrong scheme.
    expect(validateServiceQueryBody({ ...validBody, service_uri: 'https://x/y/z' })).toBe(
      expected,
    );
    // Authority not a DID.
    expect(validateServiceQueryBody({ ...validBody, service_uri: 'at://x/y/z' })).toBe(expected);
    // Wrong collection.
    expect(
      validateServiceQueryBody({
        ...validBody,
        service_uri: 'at://did:plc:bus42/app.bsky.feed.post/store-2',
      }),
    ).toBe(expected);
    // Missing rkey (2 segments).
    expect(
      validateServiceQueryBody({
        ...validBody,
        service_uri: 'at://did:plc:bus42/com.dinakernel.service.profile',
      }),
    ).toBe(expected);
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

  it('requires ttl_seconds (the unified-contract invariant)', () => {
    const { ttl_seconds, ...noTtl } = validBody;
    void ttl_seconds;
    expect(validateServiceResponseBody(noTtl)).toMatch(/ttl_seconds is required/);
  });

  it('rejects ttl_seconds outside (0, MAX_SERVICE_TTL]', () => {
    expect(validateServiceResponseBody({ ...validBody, ttl_seconds: 0 })).toMatch(
      /ttl_seconds must be 1-/,
    );
    expect(validateServiceResponseBody({ ...validBody, ttl_seconds: 99_999_999 })).toMatch(
      /ttl_seconds must be 1-/,
    );
  });

  it('validates schema_hash type when present', () => {
    expect(validateServiceResponseBody({ ...validBody, schema_hash: 42 })).toMatch(/schema_hash/);
    expect(validateServiceResponseBody({ ...validBody, schema_hash: 'abc' })).toBeNull();
  });

  it('accepts an optional card object (opaque at the wire layer)', () => {
    const card = { version: 1, blocks: [{ kind: 'title', text: 'X' }] };
    expect(validateServiceResponseBody({ ...validBody, card })).toBeNull();
  });

  it('rejects a non-object card (scalar / array / null)', () => {
    expect(validateServiceResponseBody({ ...validBody, card: 'nope' })).toMatch(/card/);
    expect(validateServiceResponseBody({ ...validBody, card: [] })).toMatch(/card/);
    expect(validateServiceResponseBody({ ...validBody, card: null })).toMatch(/card/);
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

describe('isValidServiceListingRkey', () => {
  // SINGLE SOURCE OF TRUTH for the service-listing rkey charset, shared by the
  // PARSE side (parseServiceListingUri, run over a requester-supplied
  // service_uri) and the PUBLISH side (Brain + Home-Node-Lite publishers). A
  // key a publisher mints must be exactly the set a parser later accepts.
  it('accepts the single-listing default and ordinary marketplace keys', () => {
    expect(isValidServiceListingRkey('self')).toBe(true);
    expect(isValidServiceListingRkey('route-42')).toBe(true);
    // The full charset the regex allows: A-Za-z0-9 . _ ~ -
    expect(isValidServiceListingRkey('a.b_c~d-e')).toBe(true);
    expect(isValidServiceListingRkey('3lk2j4h5')).toBe(true);
    expect(isValidServiceListingRkey('a'.repeat(512))).toBe(true);
  });

  it('rejects empty, path-traversal, and over-long keys', () => {
    expect(isValidServiceListingRkey('')).toBe(false);
    expect(isValidServiceListingRkey('.')).toBe(false);
    expect(isValidServiceListingRkey('..')).toBe(false);
    expect(isValidServiceListingRkey('a'.repeat(513))).toBe(false);
  });

  it('rejects characters outside the charset (no smuggling into a uri)', () => {
    expect(isValidServiceListingRkey('bad/rkey')).toBe(false);
    expect(isValidServiceListingRkey('a b')).toBe(false);
    expect(isValidServiceListingRkey('a:b')).toBe(false);
    expect(isValidServiceListingRkey('a%2f')).toBe(false);
  });

  it('is the same gate parseServiceListingUri applies to the uri rkey segment', () => {
    const good = 'at://did:plc:op/com.dinakernel.service.profile/route-42';
    const parsed = parseServiceListingUri(good);
    expect(parsed).not.toBeNull();
    expect(parsed?.rkey).toBe('route-42');
    // An rkey the publisher would reject is also rejected at parse time.
    expect(isValidServiceListingRkey('bad/rkey')).toBe(false);
    expect(
      parseServiceListingUri('at://did:plc:op/com.dinakernel.service.profile/bad/rkey'),
    ).toBeNull();
  });
});

describe('validateServiceGrantRequestBody (Contact Services §5.2)', () => {
  const valid = {
    request_id: 'req-1',
    capability: 'availability_coordination',
    intent: 'find a time next week',
    requested_surface: 'talk' as const,
  };
  it('accepts a well-formed request (intent optional)', () => {
    expect(validateServiceGrantRequestBody(valid)).toBeNull();
    const { intent: _i, ...noIntent } = valid;
    expect(validateServiceGrantRequestBody(noIntent)).toBeNull();
  });
  it('rejects a non-object', () => {
    expect(validateServiceGrantRequestBody(null)).toMatch(/JSON object/);
    expect(validateServiceGrantRequestBody('x')).toMatch(/JSON object/);
  });
  it('requires request_id + capability', () => {
    expect(validateServiceGrantRequestBody({ ...valid, request_id: '' })).toMatch(/request_id/);
    expect(validateServiceGrantRequestBody({ ...valid, capability: '' })).toMatch(/capability/);
  });
  it('rejects a non-string intent', () => {
    expect(validateServiceGrantRequestBody({ ...valid, intent: 42 })).toMatch(/intent/);
  });
  it('requires requested_surface === "talk" (never another surface, never an rkey)', () => {
    expect(validateServiceGrantRequestBody({ ...valid, requested_surface: 'services' })).toMatch(
      /requested_surface/,
    );
    expect(validateServiceGrantRequestBody({ ...valid, requested_surface: undefined })).toMatch(
      /requested_surface/,
    );
    // a stray rkey field is simply ignored — the requester cannot pick a listing
    expect(validateServiceGrantRequestBody({ ...valid, rkey: 'self' })).toBeNull();
  });
});

describe('validateServiceOfferBody (protocol v1.1)', () => {
  const validOffer = {
    grant_id: 'grant-1',
    capability: 'eta_query',
    service_name: 'Bus 42 (private)',
    service_uri: 'at://did:plc:bus42/com.dinakernel.service.profile/route-42',
    schema_hash: 'abc123',
    params_schema: { type: 'object' },
    default_ttl_seconds: 120,
  };

  it('accepts a well-formed offer', () => {
    expect(validateServiceOfferBody(validOffer)).toBeNull();
  });

  it('accepts a minimal offer (only required fields)', () => {
    expect(
      validateServiceOfferBody({
        grant_id: 'g',
        capability: 'com.acme.widget_price',
        service_name: 'Acme',
        service_uri: 'at://did:plc:acme/com.dinakernel.service.profile/widgets',
      }),
    ).toBeNull();
  });

  it('accepts an optional request_id (correlation echo) and rejects a non-string one', () => {
    expect(validateServiceOfferBody({ ...validOffer, request_id: 'req-1' })).toBeNull();
    expect(validateServiceOfferBody({ ...validOffer, request_id: 123 })).toMatch(/request_id/);
  });

  it('rejects a non-object body', () => {
    expect(validateServiceOfferBody(null)).toBe('service.offer: body must be a JSON object');
    expect(validateServiceOfferBody('x')).toBe('service.offer: body must be a JSON object');
  });

  it('requires grant_id, capability, service_name', () => {
    expect(validateServiceOfferBody({ ...validOffer, grant_id: '' })).toMatch(/grant_id/);
    expect(validateServiceOfferBody({ ...validOffer, capability: '' })).toMatch(/capability/);
    expect(validateServiceOfferBody({ ...validOffer, service_name: '' })).toMatch(/service_name/);
  });

  it('requires a well-formed service_uri (REQUIRED, unlike service.query)', () => {
    expect(validateServiceOfferBody({ ...validOffer, service_uri: '' })).toMatch(/service_uri/);
    expect(validateServiceOfferBody({ ...validOffer, service_uri: 'https://x/y' })).toMatch(
      /at:\/\/<did>/,
    );
  });

  it('validates optional field types', () => {
    expect(validateServiceOfferBody({ ...validOffer, schema_hash: 42 })).toMatch(/schema_hash/);
    expect(validateServiceOfferBody({ ...validOffer, params_schema: 'no' })).toMatch(
      /params_schema/,
    );
    expect(validateServiceOfferBody({ ...validOffer, default_ttl_seconds: 0 })).toMatch(
      /default_ttl_seconds/,
    );
    expect(validateServiceOfferBody({ ...validOffer, default_ttl_seconds: 99999 })).toMatch(
      /default_ttl_seconds/,
    );
    expect(validateServiceOfferBody({ ...validOffer, expires_at: 'soon' })).toMatch(/expires_at/);
  });
});
