/**
 * D2D cosig handshake tests (TN-PROTO-002).
 *
 * Three things being verified:
 *   1. Wire-message validators accept the contract shape and reject
 *      every documented divergence.
 *   2. The state machine implements pending → accepted/rejected/
 *      expired correctly and never transitions out of a terminal.
 *   3. Mismatched requestIds and bad clock input never crash and
 *      never silently transition the state.
 */

import {
  COSIG_ACCEPT_TYPE,
  COSIG_REJECT_TYPE,
  COSIG_REQUEST_TYPE,
  cosigInitial,
  cosigStep,
  validateCosigAccept,
  validateCosigReject,
  validateCosigRequest,
  type CosigAccept,
  type CosigReject,
  type CosigRequest,
  type CosigState,
} from '../src/index';

// Times are spaced widely so we don't have to think about clock skew
// boundaries in the assertions.
const T_CREATED = '2026-01-15T12:00:00.000Z';
const T_BEFORE_EXPIRY = '2026-01-15T13:00:00.000Z';
const T_EXPIRES = '2026-01-15T14:00:00.000Z';
const T_AFTER_EXPIRY = '2026-01-15T15:00:00.000Z';

function makeRequest(overrides: Partial<CosigRequest> = {}): CosigRequest {
  return {
    type: COSIG_REQUEST_TYPE,
    requestId: 'req-001',
    attestationUri: 'at://did:plc:author/com.dina.trust.attestation/abc',
    attestationCid: 'bafyreigzv4ig...example',
    expiresAt: T_EXPIRES,
    createdAt: T_CREATED,
    ...overrides,
  };
}

function makeAccept(overrides: Partial<CosigAccept> = {}): CosigAccept {
  return {
    type: COSIG_ACCEPT_TYPE,
    requestId: 'req-001',
    endorsementUri: 'at://did:plc:peer/com.dina.trust.endorsement/xyz',
    endorsementCid: 'bafyreiaccept...example',
    createdAt: T_BEFORE_EXPIRY,
    ...overrides,
  };
}

function makeReject(overrides: Partial<CosigReject> = {}): CosigReject {
  return {
    type: COSIG_REJECT_TYPE,
    requestId: 'req-001',
    reason: 'declined',
    createdAt: T_BEFORE_EXPIRY,
    ...overrides,
  };
}

describe('cosig validators (TN-PROTO-002)', () => {
  describe('validateCosigRequest', () => {
    it('accepts a fully populated request', () => {
      expect(validateCosigRequest(makeRequest())).toEqual([]);
    });

    it('accepts an optional reason field', () => {
      expect(validateCosigRequest(makeRequest({ reason: 'first-hand witness' }))).toEqual([]);
    });

    it('rejects wrong type literal', () => {
      const bad = { ...makeRequest(), type: 'trust.cosig.weird' };
      expect(validateCosigRequest(bad).some((e) => e.includes('type'))).toBe(true);
    });

    it('rejects missing requestId', () => {
      const bad = { ...makeRequest(), requestId: '' };
      expect(validateCosigRequest(bad).some((e) => e.includes('requestId'))).toBe(true);
    });

    it('rejects non-ISO createdAt', () => {
      const bad = { ...makeRequest(), createdAt: 'yesterday' };
      expect(validateCosigRequest(bad).some((e) => e.includes('createdAt'))).toBe(true);
    });

    it('rejects non-ISO expiresAt', () => {
      const bad = { ...makeRequest(), expiresAt: 'soon' };
      expect(validateCosigRequest(bad).some((e) => e.includes('expiresAt'))).toBe(true);
    });

    it('rejects non-object input', () => {
      expect(validateCosigRequest(null)).toEqual(['message must be an object']);
      expect(validateCosigRequest('string')).toEqual(['message must be an object']);
    });

    it('rejects oversized requestId', () => {
      const bad = { ...makeRequest(), requestId: 'x'.repeat(201) };
      expect(validateCosigRequest(bad).some((e) => e.includes('requestId'))).toBe(true);
    });

    it('rejects oversized attestationUri', () => {
      const bad = { ...makeRequest(), attestationUri: 'at://' + 'x'.repeat(2050) };
      expect(validateCosigRequest(bad).some((e) => e.includes('attestationUri'))).toBe(true);
    });
  });

  describe('validateCosigAccept', () => {
    it('accepts a valid accept', () => {
      expect(validateCosigAccept(makeAccept())).toEqual([]);
    });

    it('rejects wrong type literal', () => {
      expect(validateCosigAccept({ ...makeAccept(), type: 'something' }).some((e) => e.includes('type'))).toBe(
        true,
      );
    });

    it('rejects missing endorsementUri', () => {
      expect(
        validateCosigAccept({ ...makeAccept(), endorsementUri: '' }).some((e) =>
          e.includes('endorsementUri'),
        ),
      ).toBe(true);
    });

    it('rejects missing endorsementCid', () => {
      expect(
        validateCosigAccept({ ...makeAccept(), endorsementCid: '' }).some((e) =>
          e.includes('endorsementCid'),
        ),
      ).toBe(true);
    });
  });

  describe('validateCosigReject', () => {
    it('accepts every documented reason', () => {
      for (const reason of ['declined', 'unable-to-verify', 'not-applicable', 'other'] as const) {
        expect(validateCosigReject(makeReject({ reason }))).toEqual([]);
      }
    });

    it('accepts optional text elaboration', () => {
      expect(validateCosigReject(makeReject({ text: 'Conflict of interest.' }))).toEqual([]);
    });

    it('rejects unknown reason', () => {
      const bad = { ...makeReject(), reason: 'because' as never };
      expect(validateCosigReject(bad).some((e) => e.includes('reason'))).toBe(true);
    });

    it('rejects oversized text', () => {
      const bad = { ...makeReject(), text: 'x'.repeat(1001) };
      expect(validateCosigReject(bad).some((e) => e.includes('text'))).toBe(true);
    });
  });
});

describe('cosig state machine (TN-PROTO-002)', () => {
  it('initial state from request is pending with matching requestId + expiry', () => {
    const req = makeRequest();
    const s = cosigInitial(req);
    expect(s.status).toBe('pending');
    expect(s.requestId).toBe(req.requestId);
    expect(s.expiresAt).toBe(req.expiresAt);
  });

  it('pending → accepted on matching accept message', () => {
    const init = cosigInitial(makeRequest());
    const accept = makeAccept();
    const next = cosigStep(init, { kind: 'accept', message: accept });
    expect(next.status).toBe('accepted');
    if (next.status === 'accepted') {
      expect(next.endorsementUri).toBe(accept.endorsementUri);
      expect(next.endorsementCid).toBe(accept.endorsementCid);
      expect(next.acceptedAt).toBe(accept.createdAt);
    }
  });

  it('pending → rejected on matching reject message', () => {
    const init = cosigInitial(makeRequest());
    const reject = makeReject({ reason: 'unable-to-verify', text: 'cannot confirm' });
    const next = cosigStep(init, { kind: 'reject', message: reject });
    expect(next.status).toBe('rejected');
    if (next.status === 'rejected') {
      expect(next.reason).toBe('unable-to-verify');
      expect(next.text).toBe('cannot confirm');
      expect(next.rejectedAt).toBe(reject.createdAt);
    }
  });

  it('pending stays pending on tick before expiry', () => {
    const init = cosigInitial(makeRequest());
    const next = cosigStep(init, { kind: 'tick', now: T_BEFORE_EXPIRY });
    expect(next).toBe(init); // identity — no allocation, no re-render
  });

  it('pending → expired on tick at-or-after expiry', () => {
    const init = cosigInitial(makeRequest());
    const next = cosigStep(init, { kind: 'tick', now: T_AFTER_EXPIRY });
    expect(next.status).toBe('expired');
    if (next.status === 'expired') {
      expect(next.expiredAt).toBe(T_AFTER_EXPIRY);
    }
  });

  it('expiry boundary is inclusive — tick exactly at expiresAt → expired', () => {
    const init = cosigInitial(makeRequest());
    const next = cosigStep(init, { kind: 'tick', now: T_EXPIRES });
    expect(next.status).toBe('expired');
  });

  it('mismatched requestId on accept is silently ignored (pending preserved)', () => {
    const init = cosigInitial(makeRequest({ requestId: 'req-001' }));
    const accept = makeAccept({ requestId: 'req-002' });
    const next = cosigStep(init, { kind: 'accept', message: accept });
    expect(next).toBe(init); // identity
  });

  it('mismatched requestId on reject is silently ignored (pending preserved)', () => {
    const init = cosigInitial(makeRequest({ requestId: 'req-001' }));
    const reject = makeReject({ requestId: 'req-999' });
    const next = cosigStep(init, { kind: 'reject', message: reject });
    expect(next).toBe(init);
  });

  it('terminal state (accepted) ignores subsequent events — idempotent replay', () => {
    const init = cosigInitial(makeRequest());
    const accepted = cosigStep(init, { kind: 'accept', message: makeAccept() });
    expect(accepted.status).toBe('accepted');

    // Replay: accept again, then reject, then tick — none should
    // mutate the terminal state. This protects against duplicate
    // D2D delivery and clock-fired ticks.
    const a2 = cosigStep(accepted, { kind: 'accept', message: makeAccept() });
    const r2 = cosigStep(a2, { kind: 'reject', message: makeReject() });
    const t2 = cosigStep(r2, { kind: 'tick', now: T_AFTER_EXPIRY });
    expect(a2).toBe(accepted);
    expect(r2).toBe(accepted);
    expect(t2).toBe(accepted);
  });

  it('terminal state (rejected) ignores subsequent events', () => {
    const init = cosigInitial(makeRequest());
    const rejected = cosigStep(init, { kind: 'reject', message: makeReject() });
    expect(rejected.status).toBe('rejected');
    const after = cosigStep(rejected, { kind: 'accept', message: makeAccept() });
    expect(after).toBe(rejected);
  });

  it('terminal state (expired) ignores late accept', () => {
    // Late D2D delivery race: accept arrives AFTER expiry. The
    // recipient sent it in good faith but the requester has already
    // moved on. Pinning expired-stays-expired prevents UI flicker.
    const init = cosigInitial(makeRequest());
    const expired = cosigStep(init, { kind: 'tick', now: T_AFTER_EXPIRY });
    expect(expired.status).toBe('expired');
    const after = cosigStep(expired, {
      kind: 'accept',
      message: makeAccept({ createdAt: T_AFTER_EXPIRY }),
    });
    expect(after).toBe(expired);
  });

  it('garbage clock input on tick is a no-op (does not crash, does not transition)', () => {
    const init = cosigInitial(makeRequest());
    const after = cosigStep(init, { kind: 'tick', now: 'definitely-not-iso' } as never);
    expect(after).toBe(init);
  });

  it('garbage expiresAt on the request leaves the state pending forever (clock NaN)', () => {
    // If the requester accepts a malformed expiresAt at construction
    // time, every tick is a no-op. This is a *defensive* property —
    // validators should reject the request before it gets here, but
    // we want the state machine to stay deterministic if they don't.
    const init: CosigState = {
      status: 'pending',
      requestId: 'req-bad',
      expiresAt: 'not-a-date',
    };
    const after = cosigStep(init, { kind: 'tick', now: T_AFTER_EXPIRY });
    expect(after).toBe(init);
  });
});
