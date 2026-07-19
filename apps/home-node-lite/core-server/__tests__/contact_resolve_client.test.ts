/**
 * Task 6.14 — contact.resolve xRPC client tests.
 */

import {
  DEFAULT_CONTACT_LIMIT,
  MAX_CONTACT_LIMIT,
  MAX_CONTACT_QUERY_LEN,
  createContactResolveClient,
  type ContactMatch,
  type ContactResolveFetchFn,
  type ContactResolveOutcome,
  type ContactResolveRequest,
} from '../src/appview/contact_resolve_client';

function contact(overrides: Partial<ContactMatch> = {}): ContactMatch {
  return {
    did: 'did:plc:abcdefghijklmnopqrstuvwx',
    handle: 'alice.bsky.social',
    displayName: 'Alice',
    trustScore: 0.9,
    ring: 2,
    lastSeenMs: 1_700_000_000_000,
    ...overrides,
  };
}

function okBody(contacts: ContactMatch[] = [contact()], total?: number): Record<string, unknown> {
  return { contacts, total: total ?? contacts.length };
}

function stubFetch(
  body: Record<string, unknown> | null,
  status = 200,
): ContactResolveFetchFn {
  return async () => ({ body, status });
}

describe('createContactResolveClient (task 6.14)', () => {
  describe('construction', () => {
    it('throws without fetchFn', () => {
      expect(() =>
        createContactResolveClient({
          fetchFn: undefined as unknown as ContactResolveFetchFn,
        }),
      ).toThrow(/fetchFn/);
    });

    it('constants', () => {
      expect(MAX_CONTACT_QUERY_LEN).toBe(128);
      expect(MAX_CONTACT_LIMIT).toBe(20);
      expect(DEFAULT_CONTACT_LIMIT).toBe(10);
    });
  });

  describe('happy path', () => {
    it('resolves a single contact', async () => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch(okBody()),
      });
      const out = (await resolve({ query: 'Alice' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.ok).toBe(true);
      expect(out.response.contacts).toHaveLength(1);
      expect(out.response.contacts[0]!.displayName).toBe('Alice');
      expect(out.response.total).toBe(1);
    });

    it('trims query before fetching', async () => {
      let seen: ContactResolveRequest | null = null;
      const fetchFn: ContactResolveFetchFn = async (input) => {
        seen = input;
        return { body: okBody([]), status: 200 };
      };
      await createContactResolveClient({ fetchFn })({
        query: '   Alice   ',
      });
      expect(seen!.query).toBe('Alice');
    });

    it('default limit applied when missing', async () => {
      let seen: ContactResolveRequest | null = null;
      const fetchFn: ContactResolveFetchFn = async (input) => {
        seen = input;
        return { body: okBody([]), status: 200 };
      };
      await createContactResolveClient({ fetchFn })({ query: 'x' });
      expect(seen!.limit).toBe(DEFAULT_CONTACT_LIMIT);
    });

    it('null body on 2xx → empty contacts', async () => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch(null, 200),
      });
      const out = (await resolve({ query: 'ghost' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.contacts).toEqual([]);
      expect(out.response.total).toBe(0);
    });

    it('drops malformed entries but keeps good ones', async () => {
      const body = {
        contacts: [
          contact(),
          null,
          { ...contact(), did: 'nope' }, // invalid DID
          { ...contact(), handle: '' }, // empty handle
          contact({ did: 'did:plc:bcdefghijklmnopqrstuvwxa', displayName: 'Other' }),
        ],
      };
      const resolve = createContactResolveClient({ fetchFn: stubFetch(body) });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.contacts).toHaveLength(2);
      expect(out.response.contacts.map((c) => c.displayName).sort()).toEqual([
        'Alice',
        'Other',
      ]);
    });

    // ── Entry-level skip taxonomy — full coverage ───────────────────
    // The previous test covers 2 of the 7 skip guards (invalid DID,
    // empty handle). Production also rejects: non-string did,
    // non-string handle, non-string displayName, null/non-object
    // entries inside the array, and non-object scalars (string,
    // number, boolean). Iterate them so a refactor that loosened
    // any guard surfaces explicitly. Counter-pin: did:web variants
    // pass the DID_RE check (the regex admits both methods).

    it.each([
      ['null entry', null],
      ['undefined entry', undefined],
      ['string entry', 'hello'],
      ['number entry', 42],
      ['boolean entry', true],
      ['array entry', ['x']],
    ])('parseResponse skips non-object entry: %s', async (_label, entry) => {
      const body = { contacts: [contact(), entry, contact({ did: 'did:plc:bcdefghijklmnopqrstuvwxa', displayName: 'B' })] };
      const resolve = createContactResolveClient({ fetchFn: stubFetch(body) });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.contacts).toHaveLength(2);
      expect(out.response.contacts.map((c) => c.displayName)).toEqual(['Alice', 'B']);
    });

    it('parseResponse skips entry with non-string did (number/null/object)', async () => {
      const body = {
        contacts: [
          contact(),
          { ...contact(), did: 42 }, // number
          { ...contact(), did: null }, // null
          { ...contact(), did: { nested: 'object' } }, // object
          contact({ did: 'did:plc:bcdefghijklmnopqrstuvwxa', displayName: 'B' }),
        ],
      };
      const resolve = createContactResolveClient({ fetchFn: stubFetch(body) });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.contacts).toHaveLength(2);
    });

    it('parseResponse skips entry with non-string handle', async () => {
      const body = {
        contacts: [
          contact(),
          { ...contact(), handle: 42 },
          { ...contact(), handle: null },
        ],
      };
      const resolve = createContactResolveClient({ fetchFn: stubFetch(body) });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.contacts).toHaveLength(1);
      expect(out.response.contacts[0]?.handle).toBe('alice.bsky.social');
    });

    it('parseResponse skips entry with non-string displayName', async () => {
      // displayName guard is `typeof e.displayName !== 'string'` (line
      // 247 of contact_resolve_client.ts) — pin so a refactor can't
      // accept null/number/object and surface them in chooser UIs.
      const body = {
        contacts: [
          contact(),
          { ...contact(), displayName: null }, // would crash <Text> in RN
          { ...contact(), displayName: 42 },
          { ...contact(), displayName: undefined },
        ],
      };
      const resolve = createContactResolveClient({ fetchFn: stubFetch(body) });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.contacts).toHaveLength(1);
    });

    it('parseResponse accepts empty-string displayName (allowed contract)', async () => {
      // Counter-pin: while empty handle is rejected (line 246), empty
      // displayName is allowed (line 247 only checks typeof). Pin
      // both halves of the asymmetry so a refactor that "fixed" them
      // to symmetric "non-empty required" rules would surface here.
      const body = { contacts: [{ ...contact(), displayName: '' }] };
      const resolve = createContactResolveClient({ fetchFn: stubFetch(body) });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.contacts).toHaveLength(1);
      expect(out.response.contacts[0]?.displayName).toBe('');
    });

    it('parseResponse: ring guard accepts ONLY 1, 2, 3 (boolean/string/4 → null)', async () => {
      // Production line 256: `e.ring === 1 || e.ring === 2 || e.ring === 3`.
      // The closed enum check rejects everything else (no coercion).
      // `true` ≠ 1 (strict equality), `'1'` ≠ 1, etc.
      const body = {
        contacts: [
          { ...contact(), did: 'did:plc:abcdefghijklmnopqrstuvwx', ring: 1 },
          { ...contact(), did: 'did:plc:bcdefghijklmnopqrstuvwxa', ring: 2 },
          { ...contact(), did: 'did:plc:cdefghijklmnopqrstuvwxab', ring: 3 },
          { ...contact(), did: 'did:plc:defghijklmnopqrstuvwxabc', ring: 4 }, // out of enum
          { ...contact(), did: 'did:plc:efghijklmnopqrstuvwxabcd', ring: '1' as unknown as 1 }, // string coerce
          { ...contact(), did: 'did:plc:fghijklmnopqrstuvwxabcde', ring: true as unknown as 1 }, // boolean coerce
          { ...contact(), did: 'did:plc:ghijklmnopqrstuvwxabcdef', ring: 0 as unknown as 1 }, // zero
        ],
      };
      const resolve = createContactResolveClient({ fetchFn: stubFetch(body) });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      // All 7 entries are kept (their other fields are valid); only
      // the `ring` field varies. Pin: rings 1/2/3 preserved, others
      // collapse to null.
      expect(out.response.contacts).toHaveLength(7);
      const ringsByDid = Object.fromEntries(
        out.response.contacts.map((c) => [c.did, c.ring]),
      );
      expect(ringsByDid['did:plc:abcdefghijklmnopqrstuvwx']).toBe(1);
      expect(ringsByDid['did:plc:bcdefghijklmnopqrstuvwxa']).toBe(2);
      expect(ringsByDid['did:plc:cdefghijklmnopqrstuvwxab']).toBe(3);
      expect(ringsByDid['did:plc:defghijklmnopqrstuvwxabc']).toBeNull();
      expect(ringsByDid['did:plc:efghijklmnopqrstuvwxabcd']).toBeNull();
      expect(ringsByDid['did:plc:fghijklmnopqrstuvwxabcde']).toBeNull();
      expect(ringsByDid['did:plc:ghijklmnopqrstuvwxabcdef']).toBeNull();
    });

    it('parseResponse: lastSeenMs guard requires non-negative integer', async () => {
      // Production line 258-261: integer + non-negative. Float, NaN,
      // negative, ±Infinity all collapse to null.
      const body = {
        contacts: [
          { ...contact(), did: 'did:plc:abcdefghijklmnopqrstuvwx', lastSeenMs: 1_700_000_000_000 },
          { ...contact(), did: 'did:plc:bcdefghijklmnopqrstuvwxa', lastSeenMs: 0 }, // boundary — accepted
          { ...contact(), did: 'did:plc:cdefghijklmnopqrstuvwxab', lastSeenMs: 1.5 }, // float
          { ...contact(), did: 'did:plc:defghijklmnopqrstuvwxabc', lastSeenMs: -1 }, // negative
          { ...contact(), did: 'did:plc:efghijklmnopqrstuvwxabcd', lastSeenMs: Number.NaN },
          { ...contact(), did: 'did:plc:fghijklmnopqrstuvwxabcde', lastSeenMs: Number.POSITIVE_INFINITY },
        ],
      };
      const resolve = createContactResolveClient({ fetchFn: stubFetch(body) });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.contacts).toHaveLength(6);
      const lsByDid = Object.fromEntries(
        out.response.contacts.map((c) => [c.did, c.lastSeenMs]),
      );
      expect(lsByDid['did:plc:abcdefghijklmnopqrstuvwx']).toBe(1_700_000_000_000);
      expect(lsByDid['did:plc:bcdefghijklmnopqrstuvwxa']).toBe(0); // boundary preserved
      expect(lsByDid['did:plc:cdefghijklmnopqrstuvwxab']).toBeNull(); // float
      expect(lsByDid['did:plc:defghijklmnopqrstuvwxabc']).toBeNull(); // negative
      expect(lsByDid['did:plc:efghijklmnopqrstuvwxabcd']).toBeNull(); // NaN
      expect(lsByDid['did:plc:fghijklmnopqrstuvwxabcde']).toBeNull(); // Infinity
    });

    it('null trustScore / ring / lastSeenMs preserved', async () => {
      const body = {
        contacts: [
          {
            did: 'did:plc:abcdefghijklmnopqrstuvwx',
            handle: 'alice',
            displayName: 'Alice',
            trustScore: null,
            ring: null,
            lastSeenMs: null,
          },
        ],
      };
      const resolve = createContactResolveClient({ fetchFn: stubFetch(body) });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      const c = out.response.contacts[0]!;
      expect(c.trustScore).toBeNull();
      expect(c.ring).toBeNull();
      expect(c.lastSeenMs).toBeNull();
    });

    it('did:web contacts accepted', async () => {
      const webContact: ContactMatch = {
        ...contact(),
        did: 'did:web:example.com',
      };
      const resolve = createContactResolveClient({
        fetchFn: stubFetch(okBody([webContact])),
      });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.contacts[0]!.did).toBe('did:web:example.com');
    });

    it('fires resolved event with contact count', async () => {
      interface Ev { kind: 'resolved'; query: string; contactCount: number }
      const events: Ev[] = [];
      const resolve = createContactResolveClient({
        fetchFn: stubFetch(okBody([contact(), contact({ did: 'did:plc:bcdefghijklmnopqrstuvwxa' })])),
        onEvent: (e) => {
          if (e.kind === 'resolved') events.push(e);
        },
      });
      await resolve({ query: 'Alice' });
      expect(events[0]!.contactCount).toBe(2);
      expect(events[0]!.query).toBe('Alice');
    });
  });

  describe('input validation', () => {
    it.each([
      ['empty query', { query: '' }],
      ['whitespace query', { query: '   ' }],
      ['non-string query', { query: 42 as unknown as string }],
      ['query too long', { query: 'x'.repeat(129) }],
      ['query with NUL', { query: 'ali ce' }],
      ['query with control char', { query: 'alice' }],
      ['limit below min', { query: 'x', limit: 0 }],
      ['limit above max', { query: 'x', limit: 99 }],
      ['non-integer limit', { query: 'x', limit: 1.5 }],
      ['bad minRing', { query: 'x', minRing: 5 as unknown as 1 | 2 | 3 }],
    ])('rejects %s', async (_label, input) => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch(okBody()),
      });
      const out = await resolve(input as ContactResolveRequest);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_input');
    });

    it('non-object rejected', async () => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch(okBody()),
      });
      const out = await resolve(null as unknown as ContactResolveRequest);
      expect(out.ok).toBe(false);
    });

    it('query at exact max length accepted', async () => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch(okBody([])),
      });
      const out = await resolve({ query: 'x'.repeat(MAX_CONTACT_QUERY_LEN) });
      expect(out.ok).toBe(true);
    });
  });

  describe('HTTP failures', () => {
    it('5xx → rejected_by_appview', async () => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch({ error: 'db' }, 503),
      });
      const out = await resolve({ query: 'x' });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'rejected_by_appview') {
        expect(out.status).toBe(503);
      }
    });

    it('fetch throw → network_error', async () => {
      const resolve = createContactResolveClient({
        fetchFn: async () => {
          throw new Error('ENET');
        },
      });
      const out = await resolve({ query: 'x' });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'network_error') {
        expect(out.error).toMatch(/ENET/);
      }
    });
  });

  describe('malformed response', () => {
    it('contacts not array → malformed_response', async () => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch({ contacts: 'nope' }),
      });
      const out = await resolve({ query: 'x' });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });
  });

  describe('realistic scenario', () => {
    it('user types "Alice" → returns ranked candidates', async () => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch(
          okBody([
            contact({
              did: 'did:plc:abcdefghijklmnopqrstuvwx',
              displayName: 'Alice Watson',
              trustScore: 0.95,
              ring: 1,
            }),
            contact({
              did: 'did:plc:bcdefghijklmnopqrstuvwxa',
              displayName: 'Alice Chen',
              trustScore: 0.7,
              ring: 2,
            }),
            contact({
              did: 'did:plc:cdefghijklmnopqrstuvwxab',
              displayName: 'alice.random',
              trustScore: 0.3,
              ring: 3,
            }),
          ]),
        ),
      });
      const out = (await resolve({ query: 'Alice' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.contacts).toHaveLength(3);
      // Ring 1 comes first (the caller's direct contact).
      expect(out.response.contacts[0]!.ring).toBe(1);
      expect(out.response.contacts[0]!.displayName).toBe('Alice Watson');
    });
  });

  // ── rejected event payload pinning ───────────────────────────────────
  // Existing event tests pin only `resolved`. Production emits a
  // `rejected` event with `query` + `reason` payload across 4
  // distinct paths (invalid_input, network_error, rejected_by_appview,
  // malformed_response). Same bug class iter-67 closed for
  // service_search_client — `events.some(e => e.kind === 'rejected')`
  // only verifies emission, not the payload.

  describe('events — rejected payloads (full reason taxonomy)', () => {
    interface RejectedEv {
      kind: 'rejected';
      query: string;
      reason: 'invalid_input' | 'network_error' | 'rejected_by_appview' | 'malformed_response';
    }

    function captureRejected(): {
      events: RejectedEv[];
      onEvent: (e: { kind: string; query?: string; reason?: string }) => void;
    } {
      const events: RejectedEv[] = [];
      return {
        events,
        onEvent: (e) => {
          if (e.kind === 'rejected') events.push(e as RejectedEv);
        },
      };
    }

    it('rejected.reason="invalid_input" carries the (coerced) query string', async () => {
      // Production at line 123: `query: String(input?.query ?? '')`.
      // Pin the documented coercion so a refactor can't silently
      // swap to '' (info loss) or leak the entire input object.
      const { events, onEvent } = captureRejected();
      const resolve = createContactResolveClient({
        fetchFn: stubFetch(okBody()),
        onEvent,
      });
      await resolve({ query: '' });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('invalid_input');
      expect(events[0]?.query).toBe('');
    });

    it('rejected.reason="invalid_input" with non-string query coerces via String()', async () => {
      // Counter-pin: when query is a number/null/undefined, the event
      // carries the String() coercion. Observability dashboards see
      // "what the caller actually sent", not a sanitized empty string.
      const { events, onEvent } = captureRejected();
      const resolve = createContactResolveClient({
        fetchFn: stubFetch(okBody()),
        onEvent,
      });
      await resolve({ query: 42 as unknown as string });
      expect(events[0]?.reason).toBe('invalid_input');
      expect(events[0]?.query).toBe('42');
    });

    it('rejected.reason="network_error" carries the trimmed normalised query', async () => {
      // After validation, the event carries the trimmed normalised
      // query (the actual one we tried to fetch with), NOT the raw
      // input. Pin this so per-query error dashboards correlate to
      // the actual outbound calls, not the user's typo.
      const { events, onEvent } = captureRejected();
      const resolve = createContactResolveClient({
        fetchFn: async () => {
          throw new Error('ECONNRESET');
        },
        onEvent,
      });
      await resolve({ query: '  Alice  ' });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('network_error');
      expect(events[0]?.query).toBe('Alice'); // trimmed
    });

    it('rejected.reason="rejected_by_appview" carries the trimmed query', async () => {
      const { events, onEvent } = captureRejected();
      const resolve = createContactResolveClient({
        fetchFn: stubFetch({ error: 'db down' }, 503),
        onEvent,
      });
      await resolve({ query: 'Bob' });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('rejected_by_appview');
      expect(events[0]?.query).toBe('Bob');
    });

    it('rejected.reason="malformed_response" carries the trimmed query', async () => {
      const { events, onEvent } = captureRejected();
      const resolve = createContactResolveClient({
        fetchFn: stubFetch({ contacts: 'not-array' }),
        onEvent,
      });
      await resolve({ query: 'Carol' });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('malformed_response');
      expect(events[0]?.query).toBe('Carol');
    });

    it('successful path emits NO rejected events (clean discrimination)', async () => {
      const { events, onEvent } = captureRejected();
      const resolve = createContactResolveClient({
        fetchFn: stubFetch(okBody([contact()])),
        onEvent,
      });
      await resolve({ query: 'alice' });
      expect(events).toHaveLength(0);
    });
  });

  // ── total field handling ─────────────────────────────────────────────
  // Same guard as service_search_client: `Number.isInteger(body.total)
  // && body.total >= 0`, fallback to `contacts.length`. Same bug class
  // iter-67 closed there.

  describe('parseResponse — total field guards', () => {
    it('valid integer total preserved', async () => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch({ contacts: [contact()], total: 47 }),
      });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.total).toBe(47);
    });

    it('total=0 with empty contacts preserved (boundary against `if (!body.total)`)', async () => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch({ contacts: [], total: 0 }),
      });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.total).toBe(0);
    });

    it('non-integer total falls back to contacts.length', async () => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch({ contacts: [contact(), contact({ did: 'did:plc:bcdefghijklmnopqrstuvwxa' })], total: 5.5 }),
      });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.total).toBe(2);
    });

    it('negative total falls back to contacts.length', async () => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch({ contacts: [contact()], total: -1 }),
      });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.total).toBe(1);
    });

    it.each([
      ['NaN', Number.NaN],
      ['+Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('non-finite total %s falls back to contacts.length', async (_label, value) => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch({ contacts: [contact()], total: value }),
      });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.total).toBe(1);
    });

    it('non-number total falls back to contacts.length', async () => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch({ contacts: [contact()], total: '5' as unknown as number }),
      });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.total).toBe(1);
    });

    it('missing total falls back to contacts.length', async () => {
      const resolve = createContactResolveClient({
        fetchFn: stubFetch({ contacts: [contact(), contact({ did: 'did:plc:bcdefghijklmnopqrstuvwxa' }), contact({ did: 'did:plc:cdefghijklmnopqrstuvwxab' })] }),
      });
      const out = (await resolve({ query: 'x' })) as Extract<
        ContactResolveOutcome,
        { ok: true }
      >;
      expect(out.response.total).toBe(3);
    });
  });
});
