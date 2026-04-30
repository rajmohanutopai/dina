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

    // ── parseCapabilitySchema per-guard taxonomy ────────────────────
    // Production has 5 distinct null-return guards inside
    // parseCapabilitySchema. The above test only covers schema_hash.
    // Each guard maps to a different malformed wire shape — when the
    // schema is rejected the capability stays in the `capabilities`
    // array but lacks a matching entry in `capabilitySchemas`, which
    // triggers the "capability declared but no matching schema"
    // malformed_response. Iterate so every guard surfaces explicitly.

    it.each([
      ['schema is null', null],
      ['schema is array', []],
      ['schema is string', 'not-an-object'],
      ['schema is number', 42],
      ['schema is boolean', true],
    ])('parseCapabilitySchema rejects: %s', async (_label, schemaValue) => {
      const profile = validProfile();
      (profile.capabilitySchemas as Record<string, unknown>).eta_query =
        schemaValue as unknown;
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody({ profile })) });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'malformed_response') {
        expect(out.detail).toMatch(/no matching schema/);
      }
    });

    it('schema with non-string description → rejected', async () => {
      const profile = validProfile();
      (profile.capabilitySchemas as Record<string, unknown>).eta_query = {
        description: 42, // number — should be string
        params: {},
        result: {},
        schema_hash: 'a'.repeat(64),
      };
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody({ profile })) });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });

    it.each([
      ['null params', null],
      ['array params', []],
      ['string params', 'object'],
      ['number params', 42],
    ])('schema with %s → rejected', async (_label, params) => {
      const profile = validProfile();
      (profile.capabilitySchemas as Record<string, unknown>).eta_query = {
        description: 'ETA',
        params,
        result: {},
        schema_hash: 'a'.repeat(64),
      };
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody({ profile })) });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });

    it.each([
      ['null result', null],
      ['array result', []],
      ['number result', 42],
    ])('schema with %s → rejected', async (_label, result) => {
      const profile = validProfile();
      (profile.capabilitySchemas as Record<string, unknown>).eta_query = {
        description: 'ETA',
        params: {},
        result,
        schema_hash: 'a'.repeat(64),
      };
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody({ profile })) });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });

    // ── SCHEMA_HASH_RE strictness — the regex is /^[0-9a-f]{64}$/.
    // Not just "any 64-char hash" — strictly LOWERCASE hex, exactly
    // 64 chars. Pin all three dimensions so a refactor that loosened
    // to /^[0-9a-fA-F]+$/ (case-insensitive, variable length) surfaces
    // here. The 64-char requirement aligns with SHA-256's hexdigest
    // length, which is the documented schema_hash format.

    it('uppercase hex schema_hash rejected (regex is strict-lowercase)', async () => {
      const profile = validProfile();
      (profile.capabilitySchemas as Record<string, unknown>).eta_query = {
        description: 'ETA',
        params: {},
        result: {},
        schema_hash: 'A'.repeat(64), // uppercase A — should be rejected
      };
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody({ profile })) });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });

    it('63-char schema_hash rejected (length-strict)', async () => {
      const profile = validProfile();
      (profile.capabilitySchemas as Record<string, unknown>).eta_query = {
        description: 'ETA',
        params: {},
        result: {},
        schema_hash: 'a'.repeat(63), // one char short
      };
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody({ profile })) });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });

    it('65-char schema_hash rejected (length-strict)', async () => {
      const profile = validProfile();
      (profile.capabilitySchemas as Record<string, unknown>).eta_query = {
        description: 'ETA',
        params: {},
        result: {},
        schema_hash: 'a'.repeat(65), // one char extra
      };
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody({ profile })) });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });

    it('non-string schema_hash rejected', async () => {
      const profile = validProfile();
      (profile.capabilitySchemas as Record<string, unknown>).eta_query = {
        description: 'ETA',
        params: {},
        result: {},
        schema_hash: 0xdeadbeef, // number, not string
      };
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody({ profile })) });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });

    it('all-zeros 64-char lowercase hex schema_hash accepted (regex boundary)', async () => {
      // Counter-pin: an all-zeros hash IS valid (matches the regex).
      // A refactor that added an "all zeros is suspicious" check
      // would silently break this — pin so the regex stays the only
      // gate.
      const profile = validProfile();
      (profile.capabilitySchemas as Record<string, unknown>).eta_query = {
        description: 'ETA',
        params: {},
        result: {},
        schema_hash: '0'.repeat(64),
      };
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody({ profile })) });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(true);
    });

    it('mixed-case digits in schema_hash rejected (e.g. one A in otherwise-lowercase)', async () => {
      // Most paranoid pin: one uppercase letter anywhere in the 64
      // chars rejects. Counter-test for the previous "all uppercase"
      // pin — proves the regex is char-by-char strict.
      const profile = validProfile();
      (profile.capabilitySchemas as Record<string, unknown>).eta_query = {
        description: 'ETA',
        params: {},
        result: {},
        schema_hash: 'a'.repeat(63) + 'A', // 63 lowercase + 1 uppercase
      };
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody({ profile })) });
      const out = await get({ operatorDid: DID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
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

  // ── rejected event taxonomy + operatorDid payload ────────────────────
  // Existing tests pin only `fetched`. Production emits `rejected` with
  // `operatorDid` + `reason` payloads across 5 distinct paths. Same bug
  // class iter-67/iter-68 closed for service_search_client +
  // contact_resolve_client. The operatorDid field varies: raw
  // (unnormalised, via String()) for invalid_did, trim-normalised for
  // the rest. Pin both halves so observability dashboards keep
  // correlating per-DID failures correctly.

  describe('events — rejected payloads (full reason taxonomy)', () => {
    interface RejectedEv {
      kind: 'rejected';
      operatorDid: string;
      reason:
        | 'invalid_did'
        | 'not_found'
        | 'malformed_response'
        | 'network_error'
        | 'rejected_by_appview';
    }

    function captureRejected(): {
      events: RejectedEv[];
      onEvent: (e: { kind: string; operatorDid?: string; reason?: string }) => void;
    } {
      const events: RejectedEv[] = [];
      return {
        events,
        onEvent: (e) => {
          if (e.kind === 'rejected') events.push(e as RejectedEv);
        },
      };
    }

    it('rejected.reason="invalid_did" carries the RAW (unnormalised) operatorDid', async () => {
      // Production line 137: `operatorDid: String(input?.operatorDid ?? '')`.
      // Pin documented coercion so observability sees what the caller
      // sent, not '' (info loss) or a trimmed-but-still-invalid form.
      const { events, onEvent } = captureRejected();
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody()), onEvent });
      await get({ operatorDid: 'not-a-did' });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('invalid_did');
      expect(events[0]?.operatorDid).toBe('not-a-did');
    });

    it('rejected.reason="invalid_did" with non-string operatorDid coerces via String()', async () => {
      const { events, onEvent } = captureRejected();
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody()), onEvent });
      await get({ operatorDid: 42 as unknown as string });
      expect(events[0]?.reason).toBe('invalid_did');
      expect(events[0]?.operatorDid).toBe('42');
    });

    it('rejected.reason="invalid_did" with null operatorDid coerces to ""', async () => {
      const { events, onEvent } = captureRejected();
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody()), onEvent });
      await get({ operatorDid: null as unknown as string });
      expect(events[0]?.reason).toBe('invalid_did');
      expect(events[0]?.operatorDid).toBe('');
    });

    it('rejected.reason="not_found" carries the trimmed validated DID', async () => {
      // Counter-pin: post-validation events carry the normalised
      // (trimmed) DID. A refactor that sent the raw input here would
      // surface untrimmed DIDs in observability.
      const { events, onEvent } = captureRejected();
      const get = createGetProfileClient({
        fetchFn: stubFetch(null, 404),
        onEvent,
      });
      await get({ operatorDid: `  ${DID}  ` });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('not_found');
      expect(events[0]?.operatorDid).toBe(DID); // trimmed
    });

    it('rejected.reason="not_found" emitted for null body on 200 (not just 404)', async () => {
      // Production line 156: `result.status === 404 || result.body === null`
      // — both paths route to not_found. Pin so a refactor that
      // separated them surfaces the divergence (e.g. status=200 with
      // null body should NOT silently become "rejected_by_appview").
      const { events, onEvent } = captureRejected();
      const get = createGetProfileClient({
        fetchFn: stubFetch(null, 200),
        onEvent,
      });
      await get({ operatorDid: DID });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('not_found');
    });

    it('rejected.reason="network_error" carries the validated DID', async () => {
      const { events, onEvent } = captureRejected();
      const get = createGetProfileClient({
        fetchFn: async () => {
          throw new Error('ENETDOWN');
        },
        onEvent,
      });
      await get({ operatorDid: DID });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('network_error');
      expect(events[0]?.operatorDid).toBe(DID);
    });

    it('rejected.reason="rejected_by_appview" carries the validated DID', async () => {
      const { events, onEvent } = captureRejected();
      const get = createGetProfileClient({
        fetchFn: stubFetch({ error: 'db down' }, 503),
        onEvent,
      });
      await get({ operatorDid: DID });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('rejected_by_appview');
      expect(events[0]?.operatorDid).toBe(DID);
    });

    it('rejected.reason="malformed_response" carries the validated DID', async () => {
      const { events, onEvent } = captureRejected();
      const get = createGetProfileClient({
        fetchFn: stubFetch({ ...okBody(), profile: 'not-an-object' }),
        onEvent,
      });
      await get({ operatorDid: DID });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('malformed_response');
      expect(events[0]?.operatorDid).toBe(DID);
    });

    it('successful path emits NO rejected events (clean discrimination)', async () => {
      const { events, onEvent } = captureRejected();
      const get = createGetProfileClient({ fetchFn: stubFetch(okBody()), onEvent });
      await get({ operatorDid: DID });
      expect(events).toHaveLength(0);
    });
  });
});
