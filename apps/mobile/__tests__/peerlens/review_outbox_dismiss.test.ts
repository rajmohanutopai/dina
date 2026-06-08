/**
 * Dismissing a queued review must un-stick its originating chat card.
 *
 * A review launched from an inline chat-draft card flips that card to
 * `publishing` when it queues offline (the card disables its publish button in
 * that state). If the user then dismisses the queued row from the Outbox
 * screen, the drainer never runs for it — so `dismissReview` is the only thing
 * that can release the card. These tests pin that behaviour (regression: it
 * used to leave the card stuck in `publishing` forever).
 */

import { resetKVStore } from '@dina/core/kv';

import { resetOutboxStore } from '../../src/peerlens/outbox_store';
import { setReviewDraftStatus } from '../../src/peerlens/review_draft';
import {
  persistPendingReview,
  loadPendingReviews,
  dismissReview,
  type PendingReview,
} from '../../src/peerlens/review_outbox_durable';

jest.mock('../../src/peerlens/review_draft', () => ({
  setReviewDraftStatus: jest.fn(),
}));

function makeReview(over: Partial<PendingReview> = {}): PendingReview {
  return {
    clientId: 'c1',
    did: 'did:plc:owner',
    rkey: 'mob-rk-stable',
    record: { subject: { type: 'product', name: 'ErgoFlex Chair' } },
    draft: {
      sentiment: 'positive',
      headline: 'Solid support',
      body: 'Good lower-back support.',
      confidence: 'high',
      subjectTitle: 'ErgoFlex Chair',
    },
    attempts: 0,
    createdAt: '2026-06-08T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  resetKVStore();
  resetOutboxStore();
  (setReviewDraftStatus as jest.Mock).mockClear();
});

describe('dismissReview', () => {
  it('removes the durable row AND releases the originating chat card from publishing', async () => {
    await persistPendingReview(makeReview({ threadId: 't1', draftId: 'd1' }));

    await dismissReview('c1');

    expect(await loadPendingReviews()).toHaveLength(0); // durable row gone
    expect(setReviewDraftStatus).toHaveBeenCalledWith(
      't1',
      'd1',
      'discarded',
      expect.objectContaining({ content: expect.stringContaining('ErgoFlex Chair') }),
    );
  });

  it('does not touch any chat card when the review had no originating draft', async () => {
    await persistPendingReview(makeReview()); // no threadId/draftId

    await dismissReview('c1');

    expect(await loadPendingReviews()).toHaveLength(0);
    expect(setReviewDraftStatus).not.toHaveBeenCalled();
  });

  it('is a no-op-safe dismiss for an unknown clientId (no card reset)', async () => {
    await dismissReview('does-not-exist');

    expect(setReviewDraftStatus).not.toHaveBeenCalled();
  });
});
