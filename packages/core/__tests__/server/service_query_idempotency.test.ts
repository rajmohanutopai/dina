/**
 * `computeIdempotencyKey` — the dedupe identity for outbound service.query
 * tasks. It must segregate by the dimensions that change the response/authority:
 * schema_hash, service_uri (chosen listing), AND grant_id (the exercised grant,
 * for one-time/quota/paid grants later).
 */

import { computeIdempotencyKey } from '../../src/server/routes/service_query';

const DID = 'did:plc:provider';
const CAP = 'eta_query';
const PARAMS = { route: '42' };

describe('computeIdempotencyKey', () => {
  it('is stable for identical inputs', () => {
    expect(computeIdempotencyKey(DID, CAP, PARAMS)).toBe(computeIdempotencyKey(DID, CAP, PARAMS));
  });

  it('segregates by grant_id (different grants must NOT dedupe into one task)', () => {
    const a = computeIdempotencyKey(DID, CAP, PARAMS, undefined, undefined, 'grant-1');
    const b = computeIdempotencyKey(DID, CAP, PARAMS, undefined, undefined, 'grant-2');
    expect(a).not.toBe(b);
  });

  it('same grant_id dedupes', () => {
    const a = computeIdempotencyKey(DID, CAP, PARAMS, undefined, undefined, 'grant-1');
    const b = computeIdempotencyKey(DID, CAP, PARAMS, undefined, undefined, 'grant-1');
    expect(a).toBe(b);
  });

  it('a grant-pinned key differs from an unpinned one (back-compat identity preserved)', () => {
    const pinned = computeIdempotencyKey(DID, CAP, PARAMS, undefined, undefined, 'grant-1');
    const unpinned = computeIdempotencyKey(DID, CAP, PARAMS);
    expect(pinned).not.toBe(unpinned);
  });

  it('still segregates by service_uri + schema_hash (regression)', () => {
    const u1 = computeIdempotencyKey(DID, CAP, PARAMS, undefined, 'at://did:plc:provider/com.dinakernel.service.profile/a');
    const u2 = computeIdempotencyKey(DID, CAP, PARAMS, undefined, 'at://did:plc:provider/com.dinakernel.service.profile/b');
    expect(u1).not.toBe(u2);
    const s1 = computeIdempotencyKey(DID, CAP, PARAMS, 'sha-1');
    const s2 = computeIdempotencyKey(DID, CAP, PARAMS, 'sha-2');
    expect(s1).not.toBe(s2);
  });
});
