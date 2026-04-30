/**
 * Task 6.15 — review.list xRPC client tests.
 */

import {
  DEFAULT_REVIEW_LIMIT,
  MAX_REVIEW_LIMIT,
  createReviewListClient,
  type Review,
  type ReviewListFetchFn,
  type ReviewListOutcome,
  type ReviewListRequest,
} from '../src/appview/review_list_client';

const SUBJECT = 'did:plc:abcdefghijklmnopqrstuvwx';
const AUTHOR = 'did:plc:bcdefghijklmnopqrstuvwxy';

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 'at://did:plc:abc/com.dina.review/r1',
    subject: SUBJECT,
    author: AUTHOR,
    rating: 5,
    summary: 'Great service.',
    createdAtMs: 1_700_000_000_000,
    verifiedActioned: true,
    context: 'transit',
    ...overrides,
  };
}

function okBody(reviews: Review[] = [review()], cursor: string | null = null): Record<string, unknown> {
  const body: Record<string, unknown> = { reviews, total: reviews.length };
  if (cursor !== null) body.cursor = cursor;
  return body;
}

function stubFetch(body: Record<string, unknown> | null, status = 200): ReviewListFetchFn {
  return async () => ({ body, status });
}

describe('createReviewListClient (task 6.15)', () => {
  describe('construction', () => {
    it('throws without fetchFn', () => {
      expect(() =>
        createReviewListClient({
          fetchFn: undefined as unknown as ReviewListFetchFn,
        }),
      ).toThrow(/fetchFn/);
    });

    it('constants', () => {
      expect(MAX_REVIEW_LIMIT).toBe(100);
      expect(DEFAULT_REVIEW_LIMIT).toBe(20);
    });
  });

  describe('happy path', () => {
    it('lists reviews by subject', async () => {
      const list = createReviewListClient({ fetchFn: stubFetch(okBody()) });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.ok).toBe(true);
      expect(out.response.reviews).toHaveLength(1);
      expect(out.response.cursor).toBeNull();
    });

    it('lists reviews by author', async () => {
      const list = createReviewListClient({ fetchFn: stubFetch(okBody()) });
      const out = await list({ author: AUTHOR });
      expect(out.ok).toBe(true);
    });

    it('default limit applied', async () => {
      let seen: ReviewListRequest | null = null;
      const fetchFn: ReviewListFetchFn = async (input) => {
        seen = input;
        return { body: okBody([]), status: 200 };
      };
      await createReviewListClient({ fetchFn })({ subject: SUBJECT });
      expect(seen!.limit).toBe(DEFAULT_REVIEW_LIMIT);
    });

    it('cursor passed through', async () => {
      const out = (await createReviewListClient({
        fetchFn: stubFetch(okBody([review()], 'next-page-cursor')),
      })({ subject: SUBJECT })) as Extract<ReviewListOutcome, { ok: true }>;
      expect(out.response.cursor).toBe('next-page-cursor');
    });

    it('null body on 2xx → empty reviews', async () => {
      const out = (await createReviewListClient({
        fetchFn: stubFetch(null, 200),
      })({ subject: SUBJECT })) as Extract<ReviewListOutcome, { ok: true }>;
      expect(out.response.reviews).toEqual([]);
      expect(out.response.total).toBe(0);
      expect(out.response.cursor).toBeNull();
    });

    it('drops malformed reviews but keeps good ones', async () => {
      const body = {
        reviews: [
          review(),
          null,
          review({ id: 'not-at-uri' }), // invalid id
          review({ rating: 0 }), // rating out of range
          review({ rating: 6 }), // rating out of range
          review({ subject: 'did:web:' }), // invalid DID
          review({ id: 'at://did:plc/com.dina.review/r2', rating: 3 }),
        ],
      };
      const list = createReviewListClient({ fetchFn: stubFetch(body) });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.reviews).toHaveLength(2);
      expect(out.response.reviews.map((r) => r.rating).sort()).toEqual([3, 5]);
    });

    // ── Entry-level skip taxonomy — full coverage ───────────────────
    // The previous test covers 3 of 7 skip guards (id prefix, rating
    // boundary, subject DID). Production also rejects: non-string id,
    // invalid author DID, non-integer rating, non-string summary,
    // non-integer/negative createdAtMs, plus the verifiedActioned
    // strict-equality (=== true only) and context type-strict
    // pinning.

    it.each([
      ['null entry', null],
      ['undefined entry', undefined],
      ['string entry', 'hello'],
      ['number entry', 42],
      ['boolean entry', true],
      ['array entry', ['x']],
    ])('parseResponse skips non-object entry: %s', async (_label, entry) => {
      const body = { reviews: [review(), entry, review({ id: 'at://x/y' })] };
      const list = createReviewListClient({
        fetchFn: stubFetch(body as unknown as Record<string, unknown>),
      });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.reviews).toHaveLength(2);
    });

    it.each([
      ['non-string id (number)', { id: 42 as unknown as string }],
      ['non-string id (null)', { id: null as unknown as string }],
      ['empty-string id', { id: '' }],
      ['id without at:// prefix', { id: 'https://example.com/r' }],
      ['id with at: but no //', { id: 'at:did:plc:abc' }],
    ])('parseResponse skips entry with %s', async (_label, override) => {
      const body = {
        reviews: [
          review(),
          { ...review(), ...override },
        ],
      };
      const list = createReviewListClient({ fetchFn: stubFetch(body) });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.reviews).toHaveLength(1);
    });

    it.each([
      ['invalid author', { author: 'not-a-did' }],
      ['empty author', { author: '' }],
      ['null author', { author: null as unknown as string }],
      ['number author', { author: 42 as unknown as string }],
    ])('parseResponse skips entry with %s', async (_label, override) => {
      const body = {
        reviews: [
          review(),
          { ...review(), ...override },
        ],
      };
      const list = createReviewListClient({ fetchFn: stubFetch(body) });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.reviews).toHaveLength(1);
    });

    it.each([
      ['rating=0 (below boundary)', 0],
      ['rating=6 (above boundary)', 6],
      ['rating=3.5 (non-integer)', 3.5],
      ['rating=-1 (negative)', -1],
      ['rating=NaN', Number.NaN],
      ['rating=+Infinity', Number.POSITIVE_INFINITY],
      ['rating="5" (non-number string)', '5'],
      ['rating=null', null],
      ['rating=true', true],
    ])('parseResponse skips entry with %s', async (_label, rating) => {
      const body = {
        reviews: [
          review(),
          { ...review(), rating: rating as unknown as number },
        ],
      };
      const list = createReviewListClient({ fetchFn: stubFetch(body) });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.reviews).toHaveLength(1);
    });

    it('rating boundary: 1 and 5 both accepted (inclusive)', async () => {
      // Counter-pin to the rating-out-of-range tests. The accepted
      // range is [1, 5] inclusive on both ends. Pin so a refactor
      // that wrote `> 0 && < 5` (off-by-one on either side) surfaces.
      const body = {
        reviews: [
          { ...review(), id: 'at://x/r1', rating: 1 },
          { ...review(), id: 'at://x/r2', rating: 5 },
          { ...review(), id: 'at://x/r3', rating: 3 },
        ],
      };
      const list = createReviewListClient({ fetchFn: stubFetch(body) });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.reviews).toHaveLength(3);
    });

    it.each([
      ['null summary', null],
      ['number summary', 42],
      ['undefined summary', undefined],
    ])('parseResponse skips entry with %s', async (_label, summary) => {
      const body = {
        reviews: [
          review(),
          { ...review(), summary: summary as unknown as string },
        ],
      };
      const list = createReviewListClient({ fetchFn: stubFetch(body) });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.reviews).toHaveLength(1);
    });

    it('parseResponse accepts empty-string summary (allowed contract)', async () => {
      // Counter-pin: `summary: ''` IS valid (production guard is
      // `typeof !== 'string'`, not `length === 0`). A reviewer with
      // a star rating but no text is allowed. Pin so a refactor
      // that "fixed" the summary to require non-empty surfaces.
      const body = { reviews: [{ ...review(), summary: '' }] };
      const list = createReviewListClient({ fetchFn: stubFetch(body) });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.reviews).toHaveLength(1);
      expect(out.response.reviews[0]?.summary).toBe('');
    });

    it.each([
      ['createdAtMs=0 — boundary, accepted', 0, true],
      ['createdAtMs=1.5 (non-integer)', 1.5, false],
      ['createdAtMs=-1 (negative)', -1, false],
      ['createdAtMs=NaN', Number.NaN, false],
      ['createdAtMs=+Infinity', Number.POSITIVE_INFINITY, false],
      ['createdAtMs="123" (non-number)', '123', false],
    ])('parseResponse: %s → kept=%s', async (_label, createdAtMs, kept) => {
      const body = {
        reviews: [{ ...review(), createdAtMs: createdAtMs as unknown as number }],
      };
      const list = createReviewListClient({ fetchFn: stubFetch(body) });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.reviews).toHaveLength(kept ? 1 : 0);
    });

    it('verifiedActioned: STRICT === true (truthy values do NOT count)', async () => {
      // Production line 280: `verifiedActioned: e.verifiedActioned === true`.
      // Strict equality — a refactor to `!!e.verifiedActioned` would
      // accept truthy values like 1, "yes", non-empty objects.
      // The contract is "explicitly true via the wire format, not
      // any-truthy-coercion".
      const body = {
        reviews: [
          { ...review(), id: 'at://x/r1', verifiedActioned: true },
          { ...review(), id: 'at://x/r2', verifiedActioned: 1 },
          { ...review(), id: 'at://x/r3', verifiedActioned: 'yes' },
          { ...review(), id: 'at://x/r4', verifiedActioned: {} },
          { ...review(), id: 'at://x/r5', verifiedActioned: 'true' },
          { ...review(), id: 'at://x/r6', verifiedActioned: undefined },
          { ...review(), id: 'at://x/r7', verifiedActioned: false },
          { ...review(), id: 'at://x/r8', verifiedActioned: null },
        ],
      };
      const list = createReviewListClient({ fetchFn: stubFetch(body) });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.reviews).toHaveLength(8); // all entries kept
      const flagsByid = Object.fromEntries(
        out.response.reviews.map((r) => [r.id, r.verifiedActioned]),
      );
      // Only r1 (literal true) is true.
      expect(flagsByid['at://x/r1']).toBe(true);
      // All others coerce to false.
      expect(flagsByid['at://x/r2']).toBe(false); // number 1
      expect(flagsByid['at://x/r3']).toBe(false); // string "yes"
      expect(flagsByid['at://x/r4']).toBe(false); // empty object (truthy in JS!)
      expect(flagsByid['at://x/r5']).toBe(false); // string "true" (truthy!)
      expect(flagsByid['at://x/r6']).toBe(false); // undefined
      expect(flagsByid['at://x/r7']).toBe(false); // explicit false
      expect(flagsByid['at://x/r8']).toBe(false); // null
    });

    it('context: STRICT typeof string (non-string → null, including empty string accepted)', async () => {
      // Production line 281: `context: typeof e.context === 'string' ? e.context : null`.
      // Note: empty string is a string and IS accepted (parallel to
      // summary). A refactor that added `&& e.context.length > 0`
      // would silently drop the empty-context contract.
      const body = {
        reviews: [
          { ...review(), id: 'at://x/r1', context: 'transit' },
          { ...review(), id: 'at://x/r2', context: '' }, // empty STRING — kept as ''
          { ...review(), id: 'at://x/r3', context: null },
          { ...review(), id: 'at://x/r4', context: undefined },
          { ...review(), id: 'at://x/r5', context: 42 },
          { ...review(), id: 'at://x/r6', context: { nested: 'x' } },
        ],
      };
      const list = createReviewListClient({ fetchFn: stubFetch(body) });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.reviews).toHaveLength(6);
      const ctxByid = Object.fromEntries(
        out.response.reviews.map((r) => [r.id, r.context]),
      );
      expect(ctxByid['at://x/r1']).toBe('transit');
      expect(ctxByid['at://x/r2']).toBe(''); // empty string preserved
      expect(ctxByid['at://x/r3']).toBeNull();
      expect(ctxByid['at://x/r4']).toBeNull();
      expect(ctxByid['at://x/r5']).toBeNull(); // number → null
      expect(ctxByid['at://x/r6']).toBeNull(); // object → null
    });

    it('preserves all fields', async () => {
      const out = (await createReviewListClient({
        fetchFn: stubFetch(okBody([review({ verifiedActioned: false, context: null })])),
      })({ subject: SUBJECT })) as Extract<ReviewListOutcome, { ok: true }>;
      const r = out.response.reviews[0]!;
      expect(r.verifiedActioned).toBe(false);
      expect(r.context).toBeNull();
    });

    it('fires listed event with count + hasMore', async () => {
      type Ev = { kind: 'listed'; count: number; hasMore: boolean };
      const events: Ev[] = [];
      const list = createReviewListClient({
        fetchFn: stubFetch(okBody([review()], 'cursor')),
        onEvent: (e) => {
          if (e.kind === 'listed') events.push(e);
        },
      });
      await list({ subject: SUBJECT });
      expect(events[0]!.count).toBe(1);
      expect(events[0]!.hasMore).toBe(true);
    });
  });

  describe('input validation', () => {
    it.each([
      ['missing both subject + author', {}],
      ['both subject + author', { subject: SUBJECT, author: AUTHOR }],
      ['invalid subject DID', { subject: 'nope' }],
      ['invalid author DID', { author: 'did:web:' }],
      ['limit < 1', { subject: SUBJECT, limit: 0 }],
      ['limit > max', { subject: SUBJECT, limit: 500 }],
      ['non-integer limit', { subject: SUBJECT, limit: 1.5 }],
      ['cursor not string', { subject: SUBJECT, cursor: 42 as unknown as string }],
      ['cursor too long', { subject: SUBJECT, cursor: 'x'.repeat(513) }],
      ['non-boolean verifiedActionedOnly', {
        subject: SUBJECT,
        verifiedActionedOnly: 'yes' as unknown as boolean,
      }],
    ])('rejects %s', async (_label, input) => {
      const list = createReviewListClient({ fetchFn: stubFetch(okBody()) });
      const out = await list(input as ReviewListRequest);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_input');
    });

    it('non-object rejected', async () => {
      const list = createReviewListClient({ fetchFn: stubFetch(okBody()) });
      const out = await list(null as unknown as ReviewListRequest);
      expect(out.ok).toBe(false);
    });
  });

  describe('HTTP failures', () => {
    it('5xx → rejected_by_appview', async () => {
      const out = await createReviewListClient({
        fetchFn: stubFetch({ error: 'db' }, 503),
      })({ subject: SUBJECT });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'rejected_by_appview') {
        expect(out.status).toBe(503);
      }
    });

    it('fetch throw → network_error', async () => {
      const out = await createReviewListClient({
        fetchFn: async () => {
          throw new Error('ENET');
        },
      })({ subject: SUBJECT });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('network_error');
    });

    it('reviews not array → malformed_response', async () => {
      const out = await createReviewListClient({
        fetchFn: stubFetch({ reviews: 'nope' }),
      })({ subject: SUBJECT });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });
  });

  describe('verifiedActioned filter', () => {
    it('verifiedActionedOnly=true threaded to fetcher', async () => {
      let seen: ReviewListRequest | null = null;
      const fetchFn: ReviewListFetchFn = async (input) => {
        seen = input;
        return { body: okBody([]), status: 200 };
      };
      await createReviewListClient({ fetchFn })({
        subject: SUBJECT,
        verifiedActionedOnly: true,
      });
      expect(seen!.verifiedActionedOnly).toBe(true);
    });
  });

  describe('realistic scenario', () => {
    it('paginate through reviews', async () => {
      const page1 = okBody(
        [review({ id: 'at://p1/r1' }), review({ id: 'at://p1/r2' })],
        'cursor-page-2',
      );
      const list = createReviewListClient({ fetchFn: stubFetch(page1) });
      const out = (await list({ subject: SUBJECT, limit: 2 })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.reviews).toHaveLength(2);
      expect(out.response.cursor).toBe('cursor-page-2');
    });
  });

  // ── rejected event payload pinning ───────────────────────────────────
  // Existing event tests pin only `listed`. Production emits `rejected`
  // with `reason` payload across 4 distinct paths. Same bug class
  // iter-67/iter-68/iter-69 closed for sibling clients. Note: the
  // ReviewList rejected event is shape-distinct — it carries ONLY a
  // `reason` field (no `query`/`operatorDid`/`did` payload). That's
  // because the request shape (subject XOR author) is more complex —
  // the listed event itself surfaces both. Pin the per-reason
  // emission contract.

  describe('events — rejected payloads (full reason taxonomy)', () => {
    interface RejectedEv {
      kind: 'rejected';
      reason:
        | 'invalid_input'
        | 'network_error'
        | 'rejected_by_appview'
        | 'malformed_response';
    }

    function captureRejected(): {
      events: RejectedEv[];
      onEvent: (e: { kind: string; reason?: string }) => void;
    } {
      const events: RejectedEv[] = [];
      return {
        events,
        onEvent: (e) => {
          if (e.kind === 'rejected') events.push(e as RejectedEv);
        },
      };
    }

    it('rejected.reason="invalid_input" emitted on validation failure', async () => {
      const { events, onEvent } = captureRejected();
      const list = createReviewListClient({ fetchFn: stubFetch(okBody()), onEvent });
      await list({}); // missing subject/author
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('invalid_input');
    });

    it('rejected.reason="network_error" emitted on fetch throw', async () => {
      const { events, onEvent } = captureRejected();
      const list = createReviewListClient({
        fetchFn: async () => {
          throw new Error('ECONNRESET');
        },
        onEvent,
      });
      await list({ subject: SUBJECT });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('network_error');
    });

    it('rejected.reason="rejected_by_appview" emitted on 5xx', async () => {
      const { events, onEvent } = captureRejected();
      const list = createReviewListClient({
        fetchFn: stubFetch({ error: 'db down' }, 503),
        onEvent,
      });
      await list({ subject: SUBJECT });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('rejected_by_appview');
    });

    it('rejected.reason="malformed_response" emitted on parse failure', async () => {
      const { events, onEvent } = captureRejected();
      const list = createReviewListClient({
        fetchFn: stubFetch({ reviews: 'not-an-array' }),
        onEvent,
      });
      await list({ subject: SUBJECT });
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe('malformed_response');
    });

    it('successful path emits NO rejected events (clean discrimination)', async () => {
      const { events, onEvent } = captureRejected();
      const list = createReviewListClient({
        fetchFn: stubFetch(okBody()),
        onEvent,
      });
      await list({ subject: SUBJECT });
      expect(events).toHaveLength(0);
    });
  });

  // ── listed event subject/author payload pinning ──────────────────────
  // The listed event carries `subject` + `author` + `count` + `hasMore`.
  // Existing test pins count + hasMore. Pin subject + author too —
  // observability dashboards filter listed events by who's being
  // queried about (subject) vs who's writing (author).

  describe('events — listed payload subject/author', () => {
    interface ListedEv {
      kind: 'listed';
      subject: string | null;
      author: string | null;
      count: number;
      hasMore: boolean;
    }

    it('listed for subject query carries subject DID, author=null', async () => {
      const events: ListedEv[] = [];
      const list = createReviewListClient({
        fetchFn: stubFetch(okBody([review()])),
        onEvent: (e) => {
          if (e.kind === 'listed') events.push(e as ListedEv);
        },
      });
      await list({ subject: SUBJECT });
      expect(events[0]?.subject).toBe(SUBJECT);
      expect(events[0]?.author).toBeNull();
    });

    it('listed for author query carries author DID, subject=null', async () => {
      const events: ListedEv[] = [];
      const list = createReviewListClient({
        fetchFn: stubFetch(okBody([review()])),
        onEvent: (e) => {
          if (e.kind === 'listed') events.push(e as ListedEv);
        },
      });
      await list({ author: AUTHOR });
      expect(events[0]?.author).toBe(AUTHOR);
      expect(events[0]?.subject).toBeNull();
    });

    it('listed.hasMore=false when no cursor in response', async () => {
      // Counter-pin to existing 'count + hasMore' test (which pins
      // hasMore=true). The hasMore field is `cursor !== null` —
      // verify the false case so a refactor that swapped the boolean
      // direction surfaces here.
      const events: ListedEv[] = [];
      const list = createReviewListClient({
        fetchFn: stubFetch(okBody([review()])),
        onEvent: (e) => {
          if (e.kind === 'listed') events.push(e as ListedEv);
        },
      });
      await list({ subject: SUBJECT });
      expect(events[0]?.hasMore).toBe(false);
    });

    it('null body on 2xx → listed event with count=0, hasMore=false', async () => {
      // Production line 162-168: null body emits listed with count=0,
      // hasMore=false. Pin so a refactor that "treated null body as
      // an error" (would route to malformed_response) surfaces here.
      const events: ListedEv[] = [];
      const list = createReviewListClient({
        fetchFn: stubFetch(null, 200),
        onEvent: (e) => {
          if (e.kind === 'listed') events.push(e as ListedEv);
        },
      });
      await list({ subject: SUBJECT });
      expect(events).toHaveLength(1);
      expect(events[0]?.count).toBe(0);
      expect(events[0]?.hasMore).toBe(false);
      expect(events[0]?.subject).toBe(SUBJECT);
    });
  });

  // ── total field handling ─────────────────────────────────────────────
  // Same guard as service_search/contact_resolve:
  // `Number.isInteger(body.total) && body.total >= 0`, fallback to
  // `reviews.length`. Same bug class iter-67/iter-68 closed.

  describe('parseResponse — total field guards', () => {
    it('valid integer total preserved', async () => {
      const list = createReviewListClient({
        fetchFn: stubFetch({ reviews: [review()], total: 47 }),
      });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.total).toBe(47);
    });

    it('total=0 with empty reviews preserved (boundary against `if (!body.total)`)', async () => {
      const list = createReviewListClient({
        fetchFn: stubFetch({ reviews: [], total: 0 }),
      });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.total).toBe(0);
    });

    it.each([
      ['non-integer 5.5', 5.5],
      ['negative -1', -1],
      ['NaN', Number.NaN],
      ['+Infinity', Number.POSITIVE_INFINITY],
      ['non-number string', '5'],
    ])('total=%s falls back to reviews.length', async (_label, value) => {
      const list = createReviewListClient({
        fetchFn: stubFetch({
          reviews: [review()],
          total: value as unknown as number,
        }),
      });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.total).toBe(1);
    });

    it('missing total falls back to reviews.length', async () => {
      const list = createReviewListClient({
        fetchFn: stubFetch({ reviews: [review(), review({ id: 'at://x/y' })] }),
      });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.total).toBe(2);
    });
  });

  // ── cursor field handling ────────────────────────────────────────────
  // Production guard (line 288): `typeof body.cursor === 'string' &&
  // body.cursor !== ''`. Empty-string cursor maps to null — important
  // because `hasMore` is computed from `cursor !== null`.

  describe('parseResponse — cursor field guards', () => {
    it('non-empty string cursor preserved', async () => {
      const list = createReviewListClient({
        fetchFn: stubFetch({
          reviews: [review()],
          cursor: 'opaque-token-abc123',
        }),
      });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.cursor).toBe('opaque-token-abc123');
    });

    it('empty-string cursor → null (no false hasMore=true)', async () => {
      // Counter-pin: AppView returning cursor='' would otherwise set
      // hasMore to "true" (`'' !== null`) — but the empty cursor is
      // useless for pagination. Pin so a refactor that loosened to
      // `typeof === 'string'` (dropping the !== '') surfaces here.
      const list = createReviewListClient({
        fetchFn: stubFetch({ reviews: [review()], cursor: '' }),
      });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.cursor).toBeNull();
    });

    it('non-string cursor → null', async () => {
      const list = createReviewListClient({
        fetchFn: stubFetch({
          reviews: [review()],
          cursor: 42 as unknown as string,
        }),
      });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.cursor).toBeNull();
    });

    it('missing cursor → null', async () => {
      const list = createReviewListClient({
        fetchFn: stubFetch({ reviews: [review()] }),
      });
      const out = (await list({ subject: SUBJECT })) as Extract<
        ReviewListOutcome,
        { ok: true }
      >;
      expect(out.response.cursor).toBeNull();
    });

    it('hasMore listed event tracks cursor null/non-null discrimination', async () => {
      // The listed event's `hasMore` is computed `cursor !== null`.
      // Pin both halves: empty-string cursor → hasMore=false (the
      // bug fix), non-empty cursor → hasMore=true (counter-pin).
      const events: { hasMore: boolean }[] = [];
      const handler = {
        onEvent: (e: { kind: string; hasMore?: boolean }) => {
          if (e.kind === 'listed') events.push({ hasMore: e.hasMore ?? false });
        },
      };
      const listEmpty = createReviewListClient({
        fetchFn: stubFetch({ reviews: [review()], cursor: '' }),
        onEvent: handler.onEvent,
      });
      await listEmpty({ subject: SUBJECT });
      expect(events[0]?.hasMore).toBe(false);

      events.length = 0;
      const listNonEmpty = createReviewListClient({
        fetchFn: stubFetch({ reviews: [review()], cursor: 'next-page' }),
        onEvent: handler.onEvent,
      });
      await listNonEmpty({ subject: SUBJECT });
      expect(events[0]?.hasMore).toBe(true);
    });
  });
});
