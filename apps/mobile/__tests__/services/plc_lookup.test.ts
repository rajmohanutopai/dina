/**
 * Tests for `services/plc_lookup` — the PLC document fetcher used by
 * the IdentityModal.
 *
 * Covered:
 *   - Round-trip parsing of a real-shaped PLC response
 *   - 404 → registered-friendly error
 *   - Mismatched `id` field rejected (defensive against PLC-side bug
 *     or evil-twin response)
 *   - In-memory TTL cache: second call within window doesn't refetch
 *   - `invalidatePlcCache` re-fetches
 *   - `at://` prefix stripped from canonical handle
 *   - Defensive shape: missing/odd fields don't crash
 */

import {
  lookupPlc,
  invalidatePlcCache,
  clearPlcCache,
} from '../../src/services/plc_lookup';

const SANCHO_DID = 'did:plc:zaxxz2vts2umzfk2r5fpzes4';

function makeFakePlcResponse(): Record<string, unknown> {
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
    ],
    id: SANCHO_DID,
    alsoKnownAs: ['at://rajmohanddc9.test-pds.dinakernel.com'],
    verificationMethod: [
      {
        id: `${SANCHO_DID}#dina_signing`,
        type: 'Multikey',
        controller: SANCHO_DID,
        publicKeyMultibase: 'z6Mkiup6CNAw2w3t6adaYNv12jd81jNz9XHiExBwpugbeEBN',
      },
    ],
    service: [
      {
        id: '#dina-messaging',
        type: 'DinaMsgBox',
        serviceEndpoint: 'wss://test-mailbox.dinakernel.com',
      },
    ],
    created: '2026-04-30T11:23:00Z',
  };
}

function makeFetchMock(response: unknown, ok = true, status = 200): jest.Mock {
  return jest.fn(async () => ({
    ok,
    status,
    json: async () => response,
  }));
}

beforeEach(() => {
  clearPlcCache();
});

describe('lookupPlc', () => {
  it('parses a real-shaped PLC response', async () => {
    const fetchFn = makeFetchMock(makeFakePlcResponse()) as unknown as typeof fetch;
    const result = await lookupPlc(SANCHO_DID, { fetchFn });

    expect(result.did).toBe(SANCHO_DID);
    expect(result.handle).toBe('rajmohanddc9.test-pds.dinakernel.com');
    expect(result.alsoKnownAs).toEqual(['at://rajmohanddc9.test-pds.dinakernel.com']);
    expect(result.verificationMethods).toHaveLength(1);
    expect(result.verificationMethods[0]).toMatchObject({
      id: `${SANCHO_DID}#dina_signing`,
      type: 'Multikey',
      publicKeyMultibase: 'z6Mkiup6CNAw2w3t6adaYNv12jd81jNz9XHiExBwpugbeEBN',
    });
    expect(result.services).toEqual([
      {
        id: '#dina-messaging',
        type: 'DinaMsgBox',
        serviceEndpoint: 'wss://test-mailbox.dinakernel.com',
      },
    ]);
    expect(result.created).toBe('2026-04-30T11:23:00Z');
  });

  it('strips the at:// prefix from the canonical handle', async () => {
    const fetchFn = makeFetchMock(makeFakePlcResponse()) as unknown as typeof fetch;
    const result = await lookupPlc(SANCHO_DID, { fetchFn });
    expect(result.handle).not.toMatch(/^at:\/\//);
  });

  it('returns null handle when alsoKnownAs is absent', async () => {
    const doc = makeFakePlcResponse();
    delete (doc as { alsoKnownAs?: unknown }).alsoKnownAs;
    const fetchFn = makeFetchMock(doc) as unknown as typeof fetch;
    const result = await lookupPlc(SANCHO_DID, { fetchFn });
    expect(result.handle).toBeNull();
    expect(result.alsoKnownAs).toEqual([]);
  });

  it('returns null handle when alsoKnownAs[0] is just `at://` (degenerate)', async () => {
    const doc = makeFakePlcResponse();
    (doc as { alsoKnownAs: string[] }).alsoKnownAs = ['at://'];
    const fetchFn = makeFetchMock(doc) as unknown as typeof fetch;
    const result = await lookupPlc(SANCHO_DID, { fetchFn });
    expect(result.handle).toBeNull();
  });

  it('throws a friendly error on 404', async () => {
    const fetchFn = makeFetchMock({}, false, 404) as unknown as typeof fetch;
    await expect(lookupPlc(SANCHO_DID, { fetchFn })).rejects.toThrow(
      `${SANCHO_DID} is not registered on plc.directory`,
    );
  });

  it('throws on non-OK responses other than 404', async () => {
    const fetchFn = makeFetchMock({}, false, 500) as unknown as typeof fetch;
    await expect(lookupPlc(SANCHO_DID, { fetchFn })).rejects.toThrow(
      'plc.directory returned HTTP 500',
    );
  });

  it('rejects a response whose `id` field does not match the requested DID', async () => {
    // Defensive: an evil-twin or buggy PLC response that returns
    // someone else's document for the requested DID would silently
    // mislabel the user. Reject it so the modal shows the error
    // state, not a wrong identity.
    const doc = makeFakePlcResponse();
    (doc as { id: string }).id = 'did:plc:somethingelse';
    const fetchFn = makeFetchMock(doc) as unknown as typeof fetch;
    await expect(lookupPlc(SANCHO_DID, { fetchFn })).rejects.toThrow(
      'returned a document for a different DID',
    );
  });

  it('caches within TTL — second call skips the network', async () => {
    const fetchFn = makeFetchMock(makeFakePlcResponse());
    const fetchAsTyped = fetchFn as unknown as typeof fetch;
    await lookupPlc(SANCHO_DID, { fetchFn: fetchAsTyped });
    await lookupPlc(SANCHO_DID, { fetchFn: fetchAsTyped });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('invalidatePlcCache forces a refetch', async () => {
    const fetchFn = makeFetchMock(makeFakePlcResponse());
    const fetchAsTyped = fetchFn as unknown as typeof fetch;
    await lookupPlc(SANCHO_DID, { fetchFn: fetchAsTyped });
    invalidatePlcCache(SANCHO_DID);
    await lookupPlc(SANCHO_DID, { fetchFn: fetchAsTyped });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('handles a missing service[] array without crashing', async () => {
    const doc = makeFakePlcResponse();
    delete (doc as { service?: unknown }).service;
    const fetchFn = makeFetchMock(doc) as unknown as typeof fetch;
    const result = await lookupPlc(SANCHO_DID, { fetchFn });
    expect(result.services).toEqual([]);
  });

  it('handles malformed verificationMethod entries defensively', async () => {
    const doc = makeFakePlcResponse();
    (doc as { verificationMethod: unknown[] }).verificationMethod = [
      // missing publicKeyMultibase, missing controller — common when
      // a non-Multikey method was registered. Don't crash.
      { id: `${SANCHO_DID}#k1`, type: 'JsonWebKey2020' },
      null,
    ];
    const fetchFn = makeFetchMock(doc) as unknown as typeof fetch;
    const result = await lookupPlc(SANCHO_DID, { fetchFn });
    expect(result.verificationMethods).toHaveLength(1);
    expect(result.verificationMethods[0].id).toBe(`${SANCHO_DID}#k1`);
    expect(result.verificationMethods[0].publicKeyMultibase).toBeUndefined();
  });

  it('strips a trailing slash from the plcDirectory option', async () => {
    const fetchFn = makeFetchMock(makeFakePlcResponse());
    const fetchAsTyped = fetchFn as unknown as typeof fetch;
    await lookupPlc(SANCHO_DID, {
      fetchFn: fetchAsTyped,
      plcDirectory: 'https://plc.example.com/',
    });
    expect(fetchFn).toHaveBeenCalledWith(
      `https://plc.example.com/${SANCHO_DID}`,
      expect.any(Object),
    );
  });
});
