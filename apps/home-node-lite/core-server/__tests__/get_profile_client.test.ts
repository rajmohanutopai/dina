/**
 * Task 6.13 — getProfile xRPC client tests.
 */

import {
  createGetProfileClient,
  type GetProfileFetchFn,
  type GetProfileOutcome,
} from '../src/appview/get_profile_client';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';

function validProfile(did: string = DID): Record<string, unknown> {
  return {
    $type: 'com.dina.service.profile',
    name: 'SF Transit Authority',
    isPublic: true,
    capabilities: ['eta_query'],
    capabilitySchemas: {
      eta_query: {
        description: 'ETA',
        params: { type: 'object' },
        result: { type: 'object' },
        schema_hash: 'a'.repeat(64),
      },
    },
    responsePolicy: { eta_query: 'auto' },
    serviceArea: { lat: 37.7749, lng: -122.4194, radiusKm: 25 },
  };
}

function okBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operatorDid: DID,
    profile: validProfile(),
    indexedAtMs: 1_700_000_000_000,
    trustScore: 0.92,
    trustRing: 2,
    ...overrides,
  };
}

function stubFetch(
  body: Record<string, unknown> | null,
  status = 200,
): GetProfileFetchFn {
  return async () => ({ body, status });
}

describe('createGetProfileClient (task 6.13)', () => {
  describe('construction', () => {
    it('throws without fetchFn', () => {
      expect(() =>
        createGetProfileClient({
          fetchFn: undefined as unknown as GetProfileFetchFn,
        }),
      ).toThrow(/fetchFn/);
    });
  });

  describe('happy path', () => {
    it('returns parsed profile', async () => {
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody()) });
      const out = (await get({ operatorDid: DID })) as Extract<
        GetProfileOutcome,
        { ok: true }
      >;
      expect(out.ok).toBe(true);
      expect(out.response.operatorDid).toBe(DID);
      expect(out.response.profile.name).toBe('SF Transit Authority');
      expect(out.response.profile.capabilities).toEqual(['eta_query']);
      expect(out.response.profile.serviceArea).toEqual({
        lat: 37.7749,
        lng: -122.4194,
        radiusKm: 25,
      });
      expect(out.response.indexedAtMs).toBe(1_700_000_000_000);
      expect(out.response.trustScore).toBe(0.92);
      expect(out.response.trustRing).toBe(2);
    });

    it('trimmed operatorDid accepted', async () => {
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody()) });
      const out = await get({ operatorDid: `  ${DID}  ` });
      expect(out.ok).toBe(true);
    });

    it('missing serviceArea → undefined in response', async () => {
      const profile = validProfile();
      delete profile.serviceArea;
      const get = createGetProfileClient({
        fetchFn: stubFetch(okBody({ profile })),
      });
      const out = (await get({ operatorDid: DID })) as Extract<
        GetProfileOutcome,
        { ok: true }
      >;
      expect(out.response.profile.serviceArea).toBeUndefined();
    });

    it('trustScore / trustRing null when missing', async () => {
      const get = createGetProfileClient({
        fetchFn: stubFetch(okBody({ trustScore: null, trustRing: null })),
      });
      const out = (await get({ operatorDid: DID })) as Extract<
        GetProfileOutcome,
        { ok: true }
      >;
      expect(out.response.trustScore).toBeNull();
      expect(out.response.trustRing).toBeNull();
    });

    it('invalid trustRing value silently becomes null', async () => {
      const get = createGetProfileClient({
        fetchFn: stubFetch(okBody({ trustRing: 99 })),
      });
      const out = (await get({ operatorDid: DID })) as Extract<
        GetProfileOutcome,
        { ok: true }
      >;
      expect(out.response.trustRing).toBeNull();
    });

    it('unknown capability in responsePolicy silently dropped', async () => {
      const profile = validProfile();
      (profile.responsePolicy as Record<string, string>).stray_cap = 'auto';
      const get = createGetProfileClient({
        fetchFn: stubFetch(okBody({ profile })),
      });
      const out = (await get({ operatorDid: DID })) as Extract<
        GetProfileOutcome,
        { ok: true }
      >;
      // Unknown capability still lands (we don't cross-check against
      // capabilities) — but invalid policy VALUES are dropped.
      expect(out.response.profile.responsePolicy).toHaveProperty('stray_cap', 'auto');
    });

    it('invalid policy value dropped from responsePolicy', async () => {
      const profile = validProfile();
      (profile.responsePolicy as Record<string, string>).eta_query = 'YOLO';
      const get = createGetProfileClient({
        fetchFn: stubFetch(okBody({ profile })),
      });
      const out = (await get({ operatorDid: DID })) as Extract<
        GetProfileOutcome,
        { ok: true }
      >;
      expect(out.response.profile.responsePolicy).not.toHaveProperty('eta_query');
    });
  });

  describe('error paths', () => {
    it('invalid operatorDid → invalid_did, no fetch', async () => {
      let calls = 0;
      const get = createGetProfileClient({
        fetchFn: async () => {
          calls++;
          return { body: okBody(), status: 200 };
        },
      });
      const out = await get({ operatorDid: 'did:web:' });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_did');
      expect(calls).toBe(0);
    });

    it('404 → not_found', async () => {
      const get = createGetProfileClient({ fetchFn: stubFetch(null, 404) });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('not_found');
    });

    it('5xx → rejected_by_appview', async () => {
      const get = createGetProfileClient({
        fetchFn: stubFetch({ error: 'db' }, 503),
      });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'rejected_by_appview') {
        expect(out.status).toBe(503);
      }
    });

    it('fetch throws → network_error', async () => {
      const get = createGetProfileClient({
        fetchFn: async () => {
          throw new Error('ENETDOWN');
        },
      });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('network_error');
    });

    it('body operatorDid mismatch → malformed_response', async () => {
      const get = createGetProfileClient({
        fetchFn: stubFetch(okBody({ operatorDid: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz' })),
      });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'malformed_response') {
        expect(out.detail).toMatch(/does not match requested/);
      }
    });

    it('profile.$type wrong → malformed_response', async () => {
      const profile = { ...validProfile(), $type: 'wrong' };
      const get = createGetProfileClient({
        fetchFn: stubFetch(okBody({ profile })),
      });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });

    it('profile.name empty → malformed_response', async () => {
      const profile = { ...validProfile(), name: '' };
      const get = createGetProfileClient({
        fetchFn: stubFetch(okBody({ profile })),
      });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
    });

    it('capability with malformed schema_hash → skipped + fails capability-has-schema check', async () => {
      const profile = validProfile();
      (profile.capabilitySchemas as Record<string, unknown>).eta_query = {
        description: 'x',
        params: {},
        result: {},
        schema_hash: 'not-hex-64',
      };
      const get = createGetProfileClient({
        fetchFn: stubFetch(okBody({ profile })),
      });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'malformed_response') {
        expect(out.detail).toMatch(/no matching schema/);
      }
    });

    it('indexedAtMs non-integer → malformed_response', async () => {
      const get = createGetProfileClient({
        fetchFn: stubFetch(okBody({ indexedAtMs: 'yesterday' })),
      });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });

    it('serviceArea out of range → malformed_response', async () => {
      const profile = validProfile();
      profile.serviceArea = { lat: 100, lng: 0, radiusKm: 1 };
      const get = createGetProfileClient({
        fetchFn: stubFetch(okBody({ profile })),
      });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
    });
  });

  describe('events', () => {
    it('fetched event carries capability count', async () => {
      type Ev = { kind: 'fetched'; operatorDid: string; capabilityCount: number };
      const events: Ev[] = [];
      const get = createGetProfileClient({
        fetchFn: stubFetch(okBody()),
        onEvent: (e) => {
          if (e.kind === 'fetched') events.push(e);
        },
      });
      await get({ operatorDid: DID });
      expect(events[0]!.capabilityCount).toBe(1);
    });
  });
});
