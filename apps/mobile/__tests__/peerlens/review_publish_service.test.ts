/**
 * Review publish service — the real-PDS path's error handling. A permanent
 * PDS identity mismatch must surface an actionable error (NOT be queued for
 * futile retries); a transient failure must queue durably.
 *
 * `appview_runtime` is mocked so `isTestPublishConfigured()` is false (forcing
 * the real-PDS path, not the dev test-inject shortcut).
 */

jest.mock('../../src/peerlens/appview_runtime', () => ({
  __esModule: true,
  injectAttestation: jest.fn(),
  isTestPublishConfigured: jest.fn().mockReturnValue(false),
}));

// Mock the durable persist + count primitives so we can simulate a SQLCipher/KV
// write failure and control the cap check. The real `enqueueLocal` (the
// in-memory mirror) still runs.
jest.mock('../../src/peerlens/review_outbox_durable', () => ({
  persistPendingReview: jest.fn(),
  countActivePendingReviews: jest.fn(async () => 0),
}));

import { PDSPublisherError } from '@dina/brain';
import { resetKVStore } from '@dina/core/kv';

import { getOutboxRows, resetOutboxStore } from '../../src/peerlens/outbox_store';
import { AttestationIdentityMismatchError } from '../../src/peerlens/publish_attestation';
import {
  persistPendingReview,
  countActivePendingReviews,
} from '../../src/peerlens/review_outbox_durable';
import { publishReview } from '../../src/peerlens/review_publish_service';

function fakePds(
  over: Partial<{ authenticate: () => Promise<string>; putRecord: () => Promise<unknown> }> = {},
): never {
  return {
    authenticate: async () => 'did:plc:owner',
    putRecord: async () => ({ uri: 'at://x', cid: 'y' }),
    ...over,
  } as never;
}

function input(pds: never) {
  return {
    did: 'did:plc:owner',
    pdsPublisher: pds,
    rkey: 'mob-1',
    record: {
      subject: { type: 'product', name: 'Chair' },
      category: 'furniture',
      sentiment: 'positive',
      createdAt: '2026-06-08T00:00:00.000Z',
    },
    draft: {
      sentiment: 'positive' as const,
      headline: 'Solid',
      body: 'Good support.',
      confidence: 'high' as const,
      subjectTitle: 'Chair',
    },
    threadId: undefined,
    draftId: undefined,
  };
}

beforeEach(() => {
  resetKVStore();
  resetOutboxStore();
  (persistPendingReview as jest.Mock).mockReset();
  (countActivePendingReviews as jest.Mock).mockReset();
  (countActivePendingReviews as jest.Mock).mockResolvedValue(0);
});

describe('publishReview — real PDS path', () => {
  it('surfaces an actionable error (does NOT queue) on a permanent identity mismatch', async () => {
    const pds = fakePds({ authenticate: async () => 'did:plc:someone-else' });
    const outcome = await publishReview(input(pds));

    expect(outcome.kind).toBe('error');
    expect(getOutboxRows()).toHaveLength(0); // not queued for futile retries
  });

  it('queues durably on a transient PDS failure', async () => {
    const pds = fakePds({
      putRecord: async () => {
        throw new Error('network request failed');
      },
    });
    const outcome = await publishReview(input(pds));

    expect(outcome.kind).toBe('queued');
    expect(getOutboxRows()).toHaveLength(1);
  });

  it('surfaces a credentials error (does NOT queue) on a 401 auth failure', async () => {
    // Wrong/expired PDS password — createSession 401. Retrying the same
    // credentials can never succeed, so this must surface, not queue.
    const pds = fakePds({
      authenticate: async () => {
        throw new PDSPublisherError('createSession: HTTP 401', 401);
      },
    });
    const outcome = await publishReview(input(pds));

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/credentials|sign-in/i);
    expect(getOutboxRows()).toHaveLength(0);
  });

  it('surfaces an error (does NOT queue) on a 400 rejected request', async () => {
    const pds = fakePds({
      putRecord: async () => {
        throw new PDSPublisherError('putRecord: HTTP 400', 400);
      },
    });
    const outcome = await publishReview(input(pds));

    expect(outcome.kind).toBe('error');
    expect(getOutboxRows()).toHaveLength(0);
  });

  it('queues durably on a 5xx server error (genuinely transient)', async () => {
    const pds = fakePds({
      putRecord: async () => {
        throw new PDSPublisherError('putRecord: HTTP 503', 503);
      },
    });
    const outcome = await publishReview(input(pds));

    expect(outcome.kind).toBe('queued');
    expect(getOutboxRows()).toHaveLength(1);
  });

  it('queues durably on a network error (PDSPublisherError status=null)', async () => {
    const pds = fakePds({
      putRecord: async () => {
        throw new PDSPublisherError('network error: timeout', null);
      },
    });
    const outcome = await publishReview(input(pds));

    expect(outcome.kind).toBe('queued');
    expect(getOutboxRows()).toHaveLength(1);
  });

  it('rejects (and rolls back the mirror) when the DURABLE store is already at the cap', async () => {
    // The mirror may undercount if it hasn't hydrated; the durable count is
    // authoritative. At the cap, a new review must be refused and NOT persisted.
    (countActivePendingReviews as jest.Mock).mockResolvedValue(50); // MAX_QUEUE_SIZE
    const pds = fakePds({
      putRecord: async () => {
        throw new Error('offline'); // transient → would otherwise queue
      },
    });
    const outcome = await publishReview(input(pds));

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/full/i);
    expect(persistPendingReview).not.toHaveBeenCalled(); // never written durably
    expect(getOutboxRows()).toHaveLength(0); // optimistic mirror row rolled back
  });

  it('rolls back the in-memory row and surfaces an error when the durable persist fails', async () => {
    // Transient PDS error → falls through to the durable queue, but the KV write
    // itself fails. The mirror row must be rolled back so the user never sees a
    // "queued" review that exists only in memory and vanishes on restart.
    (persistPendingReview as jest.Mock).mockRejectedValueOnce(new Error('kv write failed'));
    const pds = fakePds({
      putRecord: async () => {
        throw new Error('offline');
      },
    });
    const outcome = await publishReview(input(pds));

    expect(outcome.kind).toBe('error');
    expect(getOutboxRows()).toHaveLength(0); // mirror rolled back — no orphaned queued row
  });

  it('returns published on a successful PDS write', async () => {
    const outcome = await publishReview(input(fakePds()));
    expect(outcome).toEqual({ kind: 'published', attestation: { uri: 'at://x', cid: 'y' } });
    expect(getOutboxRows()).toHaveLength(0);
  });

  it('mismatch error is an AttestationIdentityMismatchError at the publisher layer', () => {
    expect(new AttestationIdentityMismatchError('a', 'b')).toBeInstanceOf(Error);
  });
});
