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
});
