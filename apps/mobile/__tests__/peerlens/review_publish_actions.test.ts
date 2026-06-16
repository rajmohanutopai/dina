/**
 * `cancelReviewPublishJob` / `retryReviewPublishJob` — the shared UI actions over
 * the durable job. The drainability seam (`canDrainReviewPublish`) and the worker
 * pass (`drainReviewPublishNow`) are mocked so these tests pin the GUARD logic in
 * isolation from the real PDS: retry only resets + drains when a drain can run,
 * else it leaves the failed row intact (round-4 P2f).
 */

import { InMemoryReviewPublishRepository, setReviewPublishRepository } from '@dina/core';

jest.mock('../../src/peerlens/review_publish_autodrain', () => ({
  __esModule: true,
  canDrainReviewPublish: jest.fn(),
  drainReviewPublishNow: jest.fn(async () => undefined),
}));

const DID = 'did:plc:owner';
jest.mock('../../src/hooks/useNodeBootstrap', () => ({
  __esModule: true,
  getBootedNode: jest.fn(() => ({ did: 'did:plc:owner' })),
  subscribeBootedNode: jest.fn(() => () => undefined),
}));

import {
  cancelReviewPublishJob,
  dismissReviewPublishReceipt,
  pruneStaleReviewReceipts,
  retryReviewPublishJob,
} from '../../src/peerlens/review_publish_actions';
import { canDrainReviewPublish, drainReviewPublishNow } from '../../src/peerlens/review_publish_autodrain';
import { getBootedNode } from '../../src/hooks/useNodeBootstrap';

const mockGetBootedNode = getBootedNode as jest.MockedFunction<typeof getBootedNode>;
const mockCanDrain = canDrainReviewPublish as jest.MockedFunction<typeof canDrainReviewPublish>;
const mockDrain = drainReviewPublishNow as jest.MockedFunction<typeof drainReviewPublishNow>;

function failedRepo(): InMemoryReviewPublishRepository {
  const repo = new InMemoryReviewPublishRepository();
  repo.create({ jobId: 'f1', ownerDid: DID, rkey: 'rk', recordJSON: '{}', draftJSON: '{}', createdAt: 1 });
  repo.claim('f1', 1, 60_000);
  repo.fail('f1', { class: 'permanent', code: 'bad_request', message: 'x' }, 2, 1);
  return repo;
}

afterEach(() => {
  setReviewPublishRepository(null);
  jest.clearAllMocks();
});

describe('cancelReviewPublishJob', () => {
  it('discards the job and returns true', () => {
    const repo = failedRepo();
    setReviewPublishRepository(repo);
    expect(cancelReviewPublishJob('f1')).toBe(true);
    expect(repo.getById('f1')).toBeNull();
  });

  it('returns false when no repo is wired', () => {
    expect(cancelReviewPublishJob('f1')).toBe(false);
  });
});

describe('retryReviewPublishJob', () => {
  it('resets the failed job to queued + drains when a drain can run', async () => {
    const repo = failedRepo();
    setReviewPublishRepository(repo);
    mockCanDrain.mockReturnValue(true);

    const ok = await retryReviewPublishJob('f1');

    expect(ok).toBe(true);
    expect(repo.getById('f1')?.status).toBe('queued');
    expect(repo.getById('f1')?.attempts).toBe(0);
    expect(mockDrain).toHaveBeenCalledTimes(1);
  });

  it('does NOT drain (returns false) when the retry CAS fails — already queued/dismissed', async () => {
    const repo = new InMemoryReviewPublishRepository();
    // A QUEUED job: retry() refuses (it only resets failed→queued), so a
    // double-tap / stale UI must not drain or report a reset that never happened.
    repo.create({ jobId: 'q1', ownerDid: DID, rkey: 'r', recordJSON: '{}', draftJSON: '{}', createdAt: 1 });
    setReviewPublishRepository(repo);
    mockCanDrain.mockReturnValue(true);

    const ok = await retryReviewPublishJob('q1');

    expect(ok).toBe(false);
    expect(mockDrain).not.toHaveBeenCalled();
    expect(repo.getById('q1')?.status).toBe('queued'); // untouched
  });

  it('is a no-op (preserves the failed row) when no drain can run', async () => {
    const repo = failedRepo();
    setReviewPublishRepository(repo);
    mockCanDrain.mockReturnValue(false);

    const ok = await retryReviewPublishJob('f1');

    // Without a publisher / under demo scope the worker would only no-op, so
    // resetting would strand an undrainable `queued` job + hide the failure.
    expect(ok).toBe(false);
    expect(repo.getById('f1')?.status).toBe('failed'); // preserved
    expect(mockDrain).not.toHaveBeenCalled();
  });

  it('returns false when no repo is wired (short-circuits before the drain gate)', async () => {
    mockCanDrain.mockReturnValue(true);
    expect(await retryReviewPublishJob('f1')).toBe(false);
    expect(mockCanDrain).not.toHaveBeenCalled();
    expect(mockDrain).not.toHaveBeenCalled();
  });
});

/** A repo holding one `published` receipt (claimed → completed), updated at `at`. */
function publishedRepo(at: number): InMemoryReviewPublishRepository {
  const repo = new InMemoryReviewPublishRepository();
  repo.create({ jobId: 'p1', ownerDid: DID, rkey: 'rk', recordJSON: '{}', draftJSON: '{}', createdAt: 1 });
  repo.claim('p1', 1, 60_000);
  repo.complete('p1', 'at://x', 'cid', at, 1); // publishing → published, updatedAt = at
  return repo;
}

describe('dismissReviewPublishReceipt', () => {
  it('prunes a published receipt and returns true (review stays public)', () => {
    const repo = publishedRepo(2);
    setReviewPublishRepository(repo);
    expect(repo.getById('p1')?.status).toBe('published');
    expect(dismissReviewPublishReceipt('p1')).toBe(true);
    expect(repo.getById('p1')).toBeNull(); // local placeholder gone; PDS record untouched
  });

  it('returns false when no repo is wired', () => {
    expect(dismissReviewPublishReceipt('p1')).toBe(false);
  });
});

describe('pruneStaleReviewReceipts', () => {
  it('prunes published receipts older than the TTL cutoff (now − ttl)', () => {
    const repo = publishedRepo(1_000); // ancient updatedAt
    setReviewPublishRepository(repo);
    expect(pruneStaleReviewReceipts(10 * 60_000)).toBe(1);
    expect(repo.getById('p1')).toBeNull();
  });

  it('keeps recent published receipts (updatedAt within the TTL window)', () => {
    const repo = publishedRepo(Date.now()); // just published
    setReviewPublishRepository(repo);
    expect(pruneStaleReviewReceipts(10 * 60_000)).toBe(0);
    expect(repo.getById('p1')?.status).toBe('published');
  });

  it('is a no-op without a repo or a booted node', () => {
    expect(pruneStaleReviewReceipts(10 * 60_000)).toBe(0); // no repo wired
    setReviewPublishRepository(publishedRepo(1_000));
    mockGetBootedNode.mockReturnValueOnce(null);
    expect(pruneStaleReviewReceipts(10 * 60_000)).toBe(0); // no booted node
  });
});
