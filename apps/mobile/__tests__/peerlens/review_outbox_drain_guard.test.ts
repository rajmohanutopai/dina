/**
 * The global review-outbox drainer must NOT run while a guided demo is active.
 * The demo holds a 'guided_demo:*' data scope; a boot/foreground drain would
 * publish a REAL user-scope review, hydrate + patch the demo-scope 'main'
 * thread, remove the durable row, and leave the actual user's draft card stuck
 * in 'publishing'. The guard lives in `drainBootedReviewOutbox` (the chokepoint
 * every node-aware drain goes through). The queued review must survive the demo
 * and drain once the scope returns to 'user'.
 */

jest.mock('../../src/hooks/useNodeBootstrap', () => ({
  __esModule: true,
  getBootedNode: jest.fn(),
}));

import { setCurrentDataScope } from '@dina/core';
import { resetKVStore } from '@dina/core/kv';

import { getBootedNode } from '../../src/hooks/useNodeBootstrap';
import { resetOutboxStore } from '../../src/peerlens/outbox_store';
import {
  persistPendingReview,
  drainBootedReviewOutbox,
  loadPendingReviews,
  type PendingReview,
} from '../../src/peerlens/review_outbox_durable';

const putRecord = jest.fn(async () => ({ uri: 'at://did:plc:owner/x/rk', cid: 'bafy' }));
const bootedNode = {
  did: 'did:plc:owner',
  pdsPublisher: { authenticate: async () => 'did:plc:owner', putRecord },
};

function makeReview(over: Partial<PendingReview> = {}): PendingReview {
  return {
    clientId: 'c1',
    did: 'did:plc:owner',
    rkey: 'mob-rk',
    record: { subject: { type: 'product', name: 'ErgoFlex Chair' } },
    draft: {
      sentiment: 'positive',
      headline: 'Solid',
      body: 'Good support.',
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
  putRecord.mockClear();
  (getBootedNode as jest.Mock).mockReturnValue(bootedNode);
  setCurrentDataScope('user');
});

afterEach(() => {
  setCurrentDataScope('user');
});

it('does NOT drain while a guided-demo scope is active (queued review survives)', async () => {
  await persistPendingReview(makeReview());
  setCurrentDataScope('guided_demo:run1');

  await drainBootedReviewOutbox();

  expect(putRecord).not.toHaveBeenCalled(); // no publish during the demo
  expect(await loadPendingReviews()).toHaveLength(1); // left queued for after
});

it('drains normally under the user scope', async () => {
  await persistPendingReview(makeReview());

  await drainBootedReviewOutbox(); // scope === 'user'

  expect(putRecord).toHaveBeenCalledTimes(1);
  expect(await loadPendingReviews()).toHaveLength(0);
});
