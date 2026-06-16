/**
 * PeerLens publish-job repository — contract tests.
 *
 * Runs the SAME suite against BOTH implementations so they can't diverge:
 *   - `InMemoryReviewPublishRepository` (the logic unit tests drive)
 *   - `SQLiteReviewPublishRepository` over a REAL `NodeSQLiteAdapter`
 *     (better-sqlite3-multiple-ciphers — the production identity-DB engine),
 *     which also validates the v14 migration SQL + the CHECK/indexes for real.
 *
 * Covers the state machine (every allowed transition + rejection of disallowed
 * ones), CAS single-flight, lease reclaim (crash recovery), per-DID isolation,
 * the cap/Outbox/due queries, the draft back-reference, purge, and transaction
 * rollback parity.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  MAX_PUBLISH_ATTEMPTS,
  PUBLISH_CLAIM_LEASE_MS,
  type ClassifiedError,
  type NewPublishJob,
} from '../../src/review/publish_job';
import {
  InMemoryReviewPublishRepository,
  SQLiteReviewPublishRepository,
  getReviewPublishRepository,
  setReviewPublishRepository,
  subscribeReviewPublishRegistry,
  type ReviewPublishRepository,
} from '../../src/review/publish_job_repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const DID = 'did:plc:owner';
const LEASE = PUBLISH_CLAIM_LEASE_MS;
const RETRYABLE: ClassifiedError = { class: 'retryable', code: 'network', message: 'net down' };
const PERMANENT: ClassifiedError = {
  class: 'permanent',
  code: 'identity_mismatch',
  message: 'wrong did',
};

function newJob(over: Partial<NewPublishJob> = {}): NewPublishJob {
  return {
    jobId: over.jobId ?? `job-${randomBytes(4).toString('hex')}`,
    ownerDid: over.ownerDid ?? DID,
    rkey: over.rkey ?? 'mob-rk-1',
    recordJSON: over.recordJSON ?? '{"subject":{"name":"Chair"}}',
    draftJSON: over.draftJSON ?? '{"headline":"Solid"}',
    threadId: over.threadId,
    draftId: over.draftId,
    createdAt: over.createdAt ?? 1_000,
  };
}

interface Factory {
  name: string;
  make: () => { repo: ReviewPublishRepository; cleanup: () => void };
}

const factories: Factory[] = [
  {
    name: 'InMemoryReviewPublishRepository',
    make: () => ({
      repo: new InMemoryReviewPublishRepository(),
      cleanup: () => {
        /* no-op */
      },
    }),
  },
  {
    name: 'SQLiteReviewPublishRepository (real NodeSQLiteAdapter)',
    make: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-ppj-'));
      const dbPath = path.join(dir, 'identity.sqlite');
      const adapter = new NodeSQLiteAdapter({
        path: dbPath,
        passphraseHex: randomBytes(32).toString('hex'),
        journalMode: 'WAL',
        synchronous: 'NORMAL',
      });
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
      return {
        repo: new SQLiteReviewPublishRepository(adapter),
        cleanup: () => {
          try {
            adapter.close();
          } catch {
            /* idempotent */
          }
          fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

describe.each(factories)('ReviewPublishRepository contract — $name', ({ make }) => {
  let repo: ReviewPublishRepository;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repo, cleanup } = make());
  });
  afterEach(() => cleanup());

  it('create + getById round-trips the row; create is idempotent', () => {
    repo.create(newJob({ jobId: 'j1', threadId: 't1', draftId: 'd1', createdAt: 5 }));
    const j = repo.getById('j1');
    expect(j).not.toBeNull();
    expect(j?.status).toBe('queued');
    expect(j?.ownerDid).toBe(DID);
    expect(j?.threadId).toBe('t1');
    expect(j?.attempts).toBe(0);
    expect(j?.dataScope).toBe('user');
    expect(j?.createdAt).toBe(5);

    repo.create(newJob({ jobId: 'j1', rkey: 'CHANGED' })); // idempotent: no clobber
    expect(repo.getById('j1')?.rkey).toBe('mob-rk-1');
  });

  it('claim is a single-flight CAS queued→publishing that stamps the lease', () => {
    repo.create(newJob({ jobId: 'j1' }));
    expect(repo.claim('j1', 1_000, LEASE)).toBe(true);
    const j = repo.getById('j1');
    expect(j?.status).toBe('publishing');
    expect(j?.claimedAt).toBe(1_000);
    expect(j?.claimExpiresAt).toBe(1_000 + LEASE);
    // second claim loses — already publishing
    expect(repo.claim('j1', 1_001, LEASE)).toBe(false);
  });

  it('complete: publishing→published only (rejected from other states)', () => {
    repo.create(newJob({ jobId: 'j1' }));
    expect(repo.complete('j1', 'at://x', 'cid1', 2_000, 1_000)).toBe(false); // not publishing
    repo.claim('j1', 1_000, LEASE);
    expect(repo.complete('j1', 'at://x', 'cid1', 2_000, 1_000)).toBe(true);
    const j = repo.getById('j1');
    expect(j?.status).toBe('published');
    expect(j?.publishedUri).toBe('at://x');
    expect(j?.publishedCid).toBe('cid1');
    expect(j?.claimExpiresAt).toBeNull();
  });

  it('requeue: publishing→queued with attempts/backoff/error + cleared lease', () => {
    repo.create(newJob({ jobId: 'j1' }));
    repo.claim('j1', 1_000, LEASE);
    expect(repo.requeue('j1', 1, 9_000, RETRYABLE, 2_000, 1_000)).toBe(true);
    const j = repo.getById('j1');
    expect(j?.status).toBe('queued');
    expect(j?.attempts).toBe(1);
    expect(j?.nextAttemptAt).toBe(9_000);
    expect(j?.lastErrorCode).toBe('network');
    expect(j?.claimExpiresAt).toBeNull();
    expect(repo.requeue('j1', 2, 1, RETRYABLE, 3_000, 1_000)).toBe(false); // not publishing now
  });

  it('fail: publishing→failed records the permanent error', () => {
    repo.create(newJob({ jobId: 'j1' }));
    repo.claim('j1', 1_000, LEASE);
    expect(repo.fail('j1', PERMANENT, 2_000, 1_000)).toBe(true);
    const j = repo.getById('j1');
    expect(j?.status).toBe('failed');
    expect(j?.lastErrorCode).toBe('identity_mismatch');
  });

  it('terminal transitions are FENCED by the claim lease (a stale attempt cannot finalize a re-claimed row)', () => {
    repo.create(newJob({ jobId: 'j1' }));
    repo.claim('j1', 1_000, LEASE); // attempt A owns claimed_at=1_000
    // A overran the lease; a later tick reclaims (→queued, attempts++) + re-claims.
    expect(repo.reclaimExpiredLeases(DID, 1_000 + LEASE + 1)).toBe(1);
    const reclaimAt = 1_000 + LEASE + 100;
    repo.claim('j1', reclaimAt, LEASE); // attempt B owns claimed_at=reclaimAt
    // Attempt A (stale claimed_at=1_000) must NOT finalize B's in-flight row.
    expect(repo.complete('j1', 'at://x', 'cid', 9_000_000, 1_000)).toBe(false);
    expect(repo.fail('j1', PERMANENT, 9_000_000, 1_000)).toBe(false);
    expect(repo.requeue('j1', 9, 9_000_000, RETRYABLE, 9_000_000, 1_000)).toBe(false);
    expect(repo.getById('j1')?.status).toBe('publishing'); // untouched — still B's
    // Attempt B (current lease) finalizes normally.
    expect(repo.complete('j1', 'at://x', 'cid', reclaimAt + 1, reclaimAt)).toBe(true);
    expect(repo.getById('j1')?.status).toBe('published');
  });

  it('retry: failed→queued resets attempts + backoff (rejected from non-failed)', () => {
    repo.create(newJob({ jobId: 'j1' }));
    repo.claim('j1', 1_000, LEASE);
    repo.requeue('j1', 3, 9_000, RETRYABLE, 2_000, 1_000);
    repo.claim('j1', 9_000, LEASE);
    repo.fail('j1', PERMANENT, 10_000, 9_000);
    expect(repo.retry('j1', 11_000)).toBe(true);
    const j = repo.getById('j1');
    expect(j?.status).toBe('queued');
    expect(j?.attempts).toBe(0);
    expect(j?.nextAttemptAt).toBeNull();
    expect(j?.lastErrorCode).toBeNull();
    expect(repo.retry('j1', 12_000)).toBe(false); // already queued
  });

  it('discard: deletes a queued or failed job; rejected while publishing', () => {
    repo.create(newJob({ jobId: 'jq' }));
    expect(repo.discard('jq')).toBe(true); // from queued
    expect(repo.getById('jq')).toBeNull();

    repo.create(newJob({ jobId: 'jp' }));
    repo.claim('jp', 1_000, LEASE);
    expect(repo.discard('jp')).toBe(false); // publishing — undismissable
    expect(repo.getById('jp')?.status).toBe('publishing');

    repo.fail('jp', PERMANENT, 2_000, 1_000);
    expect(repo.discard('jp')).toBe(true); // from failed
    expect(repo.getById('jp')).toBeNull();
  });

  it('reclaimExpiredLeases requeues only crashed (lease-expired) publishing rows', () => {
    repo.create(newJob({ jobId: 'crashed' }));
    repo.create(newJob({ jobId: 'fresh' }));
    repo.claim('crashed', 1_000, LEASE);
    repo.claim('fresh', 1_000, LEASE);

    // Within the lease: nothing reclaimed.
    expect(repo.reclaimExpiredLeases(DID, 1_000 + LEASE - 1)).toBe(0);
    // Past the lease for 'crashed' but advance the clock beyond both — both expire
    // at 1000+LEASE; reclaim at +1 reclaims both. Use a row claimed later to split.
    expect(repo.reclaimExpiredLeases(DID, 1_000 + LEASE + 1)).toBe(2);
    const c = repo.getById('crashed');
    expect(c?.status).toBe('queued');
    expect(c?.attempts).toBe(1);
    expect(c?.claimExpiresAt).toBeNull();
    expect(c?.lastErrorCode).toBe('lease_expired');
  });

  it('reclaim is scoped to the owner DID', () => {
    repo.create(newJob({ jobId: 'mine', ownerDid: DID }));
    repo.create(newJob({ jobId: 'theirs', ownerDid: 'did:plc:other' }));
    repo.claim('mine', 1_000, LEASE);
    repo.claim('theirs', 1_000, LEASE);
    expect(repo.reclaimExpiredLeases(DID, 1_000 + LEASE + 1)).toBe(1);
    expect(repo.getById('theirs')?.status).toBe('publishing'); // untouched
  });

  it('countActive counts queued+publishing for the DID only', () => {
    repo.create(newJob({ jobId: 'q', ownerDid: DID }));
    repo.create(newJob({ jobId: 'p', ownerDid: DID }));
    repo.claim('p', 1_000, LEASE);
    repo.create(newJob({ jobId: 'f', ownerDid: DID }));
    repo.claim('f', 1_000, LEASE);
    repo.fail('f', PERMANENT, 2_000, 1_000); // failed — NOT active
    repo.create(newJob({ jobId: 'other', ownerDid: 'did:plc:other' }));
    expect(repo.countActive(DID)).toBe(2); // q + p
    expect(repo.countActive('did:plc:other')).toBe(1);
  });

  it('listForOwner returns queued+publishing+failed, FIFO, DID-scoped', () => {
    repo.create(newJob({ jobId: 'a', createdAt: 1 }));
    repo.create(newJob({ jobId: 'b', createdAt: 2 }));
    repo.claim('b', 1_000, LEASE);
    repo.create(newJob({ jobId: 'c', createdAt: 3 }));
    repo.claim('c', 1_000, LEASE);
    repo.complete('c', 'at://x', 'cid', 2_000, 1_000); // published — NOT in Outbox
    repo.create(newJob({ jobId: 'other', ownerDid: 'did:plc:other', createdAt: 1 }));
    expect(repo.listForOwner(DID).map((j) => j.jobId)).toEqual(['a', 'b']);
  });

  it('listForOwnerWithReceipts adds published receipts (queued+publishing+failed+published), FIFO', () => {
    repo.create(newJob({ jobId: 'a', createdAt: 1 }));
    repo.create(newJob({ jobId: 'b', createdAt: 2 }));
    repo.claim('b', 1_000, LEASE);
    repo.create(newJob({ jobId: 'c', createdAt: 3 }));
    repo.claim('c', 1_000, LEASE);
    repo.complete('c', 'at://x', 'cid', 2_000, 1_000); // published — INCLUDED here as a receipt
    repo.create(newJob({ jobId: 'other', ownerDid: 'did:plc:other', createdAt: 1 }));
    // Same as listForOwner PLUS the published receipt 'c'; DID-scoped, FIFO.
    expect(repo.listForOwnerWithReceipts(DID).map((j) => j.jobId)).toEqual(['a', 'b', 'c']);
  });

  it('listDue returns queued jobs past their backoff gate, FIFO', () => {
    repo.create(newJob({ jobId: 'ready', createdAt: 1 })); // nextAttemptAt null → due
    repo.create(newJob({ jobId: 'gated', createdAt: 2 }));
    repo.claim('gated', 1_000, LEASE);
    repo.requeue('gated', 1, 50_000, RETRYABLE, 2_000, 1_000); // due at 50_000
    expect(repo.listDue(DID, 10_000).map((j) => j.jobId)).toEqual(['ready']);
    expect(repo.listDue(DID, 60_000).map((j) => j.jobId)).toEqual(['ready', 'gated']);
  });

  it('findLatestForDraft returns the most-recent job incl. published; null after prune', () => {
    repo.create(newJob({ jobId: 'j1', threadId: 't1', draftId: 'd1' }));
    expect(repo.findLatestForDraft(DID, 't1', 'd1')?.jobId).toBe('j1');
    expect(repo.findLatestForDraft(DID, 't1', 'nope')).toBeNull();
    repo.claim('j1', 1_000, LEASE);
    repo.complete('j1', 'at://x', 'cid', 2_000, 1_000); // published — RETAINED (receipt on the row)
    const pub = repo.findLatestForDraft(DID, 't1', 'd1');
    expect(pub?.status).toBe('published');
    expect(pub?.publishedUri).toBe('at://x'); // the card projects the receipt from here
    repo.prune('j1');
    expect(repo.findLatestForDraft(DID, 't1', 'd1')).toBeNull();
  });

  it('findLatestForRkey returns the most-recent job for (did, rkey); DID-scoped; null when none', () => {
    // The full-form dedup key — no thread/draft back-reference.
    repo.create(newJob({ jobId: 'a', rkey: 'mob-1', createdAt: 1_000 }));
    repo.create(newJob({ jobId: 'b', rkey: 'mob-1', createdAt: 2_000 })); // newer, same rkey
    repo.create(newJob({ jobId: 'c', rkey: 'mob-2', createdAt: 3_000 })); // different rkey
    repo.create(newJob({ jobId: 'x', ownerDid: 'did:plc:other', rkey: 'mob-1', createdAt: 9_000 }));

    expect(repo.findLatestForRkey(DID, 'mob-1')?.jobId).toBe('b'); // most-recent, this DID only
    expect(repo.findLatestForRkey(DID, 'mob-2')?.jobId).toBe('c');
    expect(repo.findLatestForRkey(DID, 'mob-absent')).toBeNull();
  });

  it('prunePublished deletes only published rows older than the cutoff', () => {
    repo.create(newJob({ jobId: 'old' }));
    repo.claim('old', 1, LEASE);
    repo.complete('old', 'u', 'c', 100, 1); // updatedAt=100
    repo.create(newJob({ jobId: 'recent' }));
    repo.claim('recent', 1, LEASE);
    repo.complete('recent', 'u', 'c', 5_000, 1); // updatedAt=5000
    repo.create(newJob({ jobId: 'active' })); // queued — never published
    expect(repo.prunePublished(DID, 1_000)).toBe(1); // only 'old'
    expect(repo.getById('old')).toBeNull();
    expect(repo.getById('recent')?.status).toBe('published');
    expect(repo.getById('active')?.status).toBe('queued');
  });

  it('purgeForeign drops other-DID rows, keeps the current identity', () => {
    repo.create(newJob({ jobId: 'mine', ownerDid: DID }));
    repo.create(newJob({ jobId: 'old1', ownerDid: 'did:plc:prev' }));
    repo.create(newJob({ jobId: 'old2', ownerDid: 'did:plc:prev' }));
    repo.purgeForeign(DID);
    expect(repo.getById('mine')).not.toBeNull();
    expect(repo.getById('old1')).toBeNull();
    expect(repo.getById('old2')).toBeNull();
  });

  it('transaction rolls back every write on a throw (atomic, both impls)', () => {
    repo.create(newJob({ jobId: 'pre' }));
    expect(() =>
      repo.transaction(() => {
        repo.create(newJob({ jobId: 'a' }));
        repo.discard('pre');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    // 'a' was never created; 'pre' was NOT discarded.
    expect(repo.getById('a')).toBeNull();
    expect(repo.getById('pre')).not.toBeNull();
  });

  it('a successful transaction commits its writes', () => {
    repo.transaction(() => {
      repo.create(newJob({ jobId: 'a' }));
      repo.create(newJob({ jobId: 'b' }));
    });
    expect(repo.getById('a')).not.toBeNull();
    expect(repo.getById('b')).not.toBeNull();
  });

  it('subscribe fires on mutation; a transaction fires once', () => {
    let n = 0;
    const unsub = repo.subscribe(() => n++);
    repo.create(newJob({ jobId: 'a' }));
    expect(n).toBe(1);
    n = 0;
    repo.transaction(() => {
      repo.create(newJob({ jobId: 'b' }));
      repo.create(newJob({ jobId: 'c' }));
    });
    expect(n).toBe(1); // coalesced to one notification on commit
    unsub();
    repo.create(newJob({ jobId: 'd' }));
    expect(n).toBe(1); // unsubscribed
  });

  it('dead-letter boundary: a job reclaimed to MAX_PUBLISH_ATTEMPTS is still queryable', () => {
    repo.create(newJob({ jobId: 'j1' }));
    for (let i = 0; i < MAX_PUBLISH_ATTEMPTS; i++) {
      repo.claim('j1', 1_000 + i, LEASE);
      repo.reclaimExpiredLeases(DID, 1_000 + i + LEASE + 1);
    }
    expect(repo.getById('j1')?.attempts).toBe(MAX_PUBLISH_ATTEMPTS);
    expect(repo.getById('j1')?.status).toBe('queued'); // worker decides to fail it on next tick
  });
});

// The global registry + its change notifier (round-4 P2d): projection hooks that
// mount before createNode wires the repo must be able to re-bind once it's set.
describe('review-publish repository registry', () => {
  afterEach(() => setReviewPublishRepository(null));

  it('set/get round-trips the global repo, and clears to null', () => {
    expect(getReviewPublishRepository()).toBeNull();
    const r = new InMemoryReviewPublishRepository();
    setReviewPublishRepository(r);
    expect(getReviewPublishRepository()).toBe(r);
    setReviewPublishRepository(null);
    expect(getReviewPublishRepository()).toBeNull();
  });

  it('fires registry listeners on every install/clear (so a hook re-binds to a later-wired repo)', () => {
    const seen: (ReviewPublishRepository | null)[] = [];
    const unsub = subscribeReviewPublishRegistry(() => seen.push(getReviewPublishRepository()));

    const r = new InMemoryReviewPublishRepository();
    setReviewPublishRepository(r); // hook mounted with null repo would re-read HERE
    setReviewPublishRepository(null);

    expect(seen).toEqual([r, null]);
    unsub();
  });

  it('unsubscribe stops further notifications', () => {
    const cb = jest.fn();
    const unsub = subscribeReviewPublishRegistry(cb);
    setReviewPublishRepository(new InMemoryReviewPublishRepository());
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    setReviewPublishRepository(null);
    expect(cb).toHaveBeenCalledTimes(1); // no further calls after unsubscribe
  });
});
