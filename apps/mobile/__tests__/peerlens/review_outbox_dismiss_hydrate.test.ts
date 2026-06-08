/**
 * Dismissing a queued review must un-stick its PERSISTED chat card even when the
 * originating thread hasn't been hydrated into the in-memory map yet — the
 * post-restart hazard. `dismissReview` removes the durable row; if it then
 * patches an absent in-memory thread the patch no-ops and the persisted card
 * stays stuck in `publishing` forever. The fix hydrates the thread (from the
 * repo) first, mirroring the drain path. This test drives the REAL chat repo +
 * real `setReviewDraftStatus` (no mocks) to prove the card actually flips.
 */

import {
  resetThreads,
  getThread,
  readLifecycle,
  type ReviewDraftLifecycle,
} from '@dina/brain/chat';
import { setChatMessageRepository, InMemoryChatMessageRepository } from '@dina/core';
import { resetKVStore } from '@dina/core/kv';

import { resetOutboxStore } from '../../src/peerlens/outbox_store';
import {
  persistPendingReview,
  dismissReview,
  type PendingReview,
} from '../../src/peerlens/review_outbox_durable';

function makeReview(over: Partial<PendingReview> = {}): PendingReview {
  return {
    clientId: 'c1',
    did: 'did:plc:owner',
    rkey: 'mob-rk',
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

let repo: InMemoryChatMessageRepository;

beforeEach(() => {
  resetKVStore();
  resetOutboxStore();
  resetThreads();
  repo = new InMemoryChatMessageRepository();
  setChatMessageRepository(repo);
});

afterEach(() => {
  setChatMessageRepository(null);
  resetThreads();
});

it('releases a persisted card stuck in publishing when dismissed pre-hydration (post-restart)', async () => {
  // Seed the review-draft card DIRECTLY into the repo (in 'publishing'), so it's
  // persisted but absent from the in-memory thread map — exactly the post-restart
  // state before the chat screen is opened. (Going through addLifecycleMessage
  // would also populate the map, hiding the bug.)
  const draftId = 'd1';
  const lifecycle: ReviewDraftLifecycle = {
    kind: 'review_draft',
    status: 'publishing',
    draftId,
    subject: { name: 'ErgoFlex Chair' },
    values: null,
  };
  await repo.append({
    id: 'm1',
    threadId: 'main',
    type: 'dina',
    content: 'Publishing your review…',
    metadata: { lifecycle: lifecycle as unknown as Record<string, unknown> },
    sources: [draftId],
    timestamp: 1,
  });
  await persistPendingReview(makeReview({ clientId: 'c1', threadId: 'main', draftId }));
  expect(getThread('main')).toHaveLength(0); // persisted, but not in the in-memory map

  await dismissReview('c1');

  // dismissReview hydrated 'main' from the repo, then flipped the card.
  const card = getThread('main').find((m) => readLifecycle(m)?.kind === 'review_draft');
  if (card === undefined) throw new Error('expected the review-draft card to be hydrated');
  expect((readLifecycle(card) as ReviewDraftLifecycle).status).toBe('discarded');
});
