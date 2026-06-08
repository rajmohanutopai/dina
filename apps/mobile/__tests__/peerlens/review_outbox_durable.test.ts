/**
 * Durable review outbox (TN-MOB-007 / slice 4 of the real-publish build).
 *
 * Verifies: persist/load round-trip; drain publishes via the authed PDS
 * path and removes the row on success; a failed drain keeps the row and
 * bumps the attempt count; dead-lettering past MAX_ATTEMPTS; and the
 * idempotency invariant the user called out — a retry reuses the SAME
 * stable rkey, so a crash-after-accept can't duplicate the review.
 */

import { setCurrentDataScope } from '@dina/core';
import { resetKVStore, kvSet } from '@dina/core/kv';

import {
  resetOutboxStore,
  getOutboxRows,
  enqueueLocal,
  enqueueDeadLetteredLocal,
} from '../../src/peerlens/outbox_store';
import {
  persistPendingReview,
  loadPendingReviews,
  removePendingReview,
  drainReviewOutbox,
  hydrateReviewOutbox,
  countActivePendingReviews,
  resetReviewAttempts,
  type PendingReview,
} from '../../src/peerlens/review_outbox_durable';

function fakePds(over: Partial<{ authenticate: () => Promise<string>; putRecord: (c: string, r: string, rec: Record<string, unknown>) => Promise<{ uri: string; cid: string }> }> = {}): never {
  return {
    authenticate: async () => 'did:plc:owner',
    putRecord: async () => ({ uri: 'at://did:plc:owner/c/r', cid: 'bafy' }),
    ...over,
  } as never;
}

function makeReview(over: Partial<PendingReview> = {}): PendingReview {
  return {
    clientId: 'c1',
    did: 'did:plc:owner',
    rkey: 'mob-rk-stable',
    record: {
      subject: { type: 'product', name: 'ErgoFlex Chair' },
      category: 'furniture',
      sentiment: 'positive',
      createdAt: '2026-06-08T00:00:00.000Z',
    },
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
  setCurrentDataScope('user');
});

afterEach(() => {
  setCurrentDataScope('user'); // never leak a guided-demo scope into the next test
});

describe('durable review outbox', () => {
  it('persists and loads a pending review across the KV boundary', async () => {
    await persistPendingReview(makeReview());
    const loaded = await loadPendingReviews();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].clientId).toBe('c1');
    expect(loaded[0].rkey).toBe('mob-rk-stable');
  });

  it('drains: publishes then removes the row, and reuses the stable rkey (idempotent retry)', async () => {
    await persistPendingReview(makeReview());
    let usedRkey: string | null = null;
    const pds = fakePds({
      putRecord: async (_c, rkey) => {
        usedRkey = rkey;
        return { uri: 'at://did:plc:owner/x/rk', cid: 'bafy' };
      },
    });

    const res = await drainReviewOutbox(pds, 'did:plc:owner');

    expect(res).toEqual({ published: 1, failed: 0 });
    expect(usedRkey).toBe('mob-rk-stable'); // retry reuses the persisted rkey
    expect(await loadPendingReviews()).toHaveLength(0); // removed on success
  });

  it('coalesces concurrent drains (single-flight) so a row publishes exactly once', async () => {
    // The screen mount, foreground listener, global autodrain, and manual retry
    // can all fire a drain at once over the SAME pending store. Without a guard,
    // two passes load the same row and race — one publishes+removes it while the
    // other re-persists a stale copy. The guard must collapse them into one pass.
    await persistPendingReview(makeReview());
    const putRecord = jest.fn(async () => {
      await new Promise((r) => setTimeout(r, 5)); // hold the pass in-flight so a 2nd would race
      return { uri: 'at://did:plc:owner/x/rk', cid: 'bafy' };
    });
    const pds = fakePds({ putRecord });

    const [r1, r2] = await Promise.all([
      drainReviewOutbox(pds, 'did:plc:owner'),
      drainReviewOutbox(pds, 'did:plc:owner'),
    ]);

    expect(putRecord).toHaveBeenCalledTimes(1); // 2nd caller coalesced — no double publish
    expect(r1).toBe(r2); // both saw the same in-flight pass
    expect(await loadPendingReviews()).toHaveLength(0); // published + removed, not resurrected
  });

  it('skips a row dismissed mid-pass (re-checks KV before the public write)', async () => {
    // `pending` is loaded once up front. If the user dismisses a queued row
    // while the pass is mid-flight on a slow PDS write, the loop must NOT
    // steamroll that cancel into a published review — it re-checks KV existence
    // right before putRecord. Here, publishing the first row deletes the other's
    // KV entry (standing in for a concurrent dismiss); the guard must skip it.
    await persistPendingReview(makeReview({ clientId: 'a', rkey: 'rk-a' }));
    await persistPendingReview(makeReview({ clientId: 'b', rkey: 'rk-b' }));
    const putRecord = jest.fn(async (_collection: string, rkey: string) => {
      await removePendingReview(rkey === 'rk-a' ? 'b' : 'a'); // dismiss the OTHER row
      return { uri: `at://did:plc:owner/x/${rkey}`, cid: 'bafy' };
    });
    const pds = fakePds({ putRecord });

    const res = await drainReviewOutbox(pds, 'did:plc:owner');

    expect(putRecord).toHaveBeenCalledTimes(1); // the dismissed row was NOT published
    expect(res).toEqual({ published: 1, failed: 0 });
    expect(await loadPendingReviews()).toHaveLength(0); // one published, one dismissed
  });

  it('does NOT resurrect a row dismissed while its publish was in flight, then failed', async () => {
    // The kvHas guard passes, then the user dismisses mid-write; the write then
    // fails transiently. The catch must re-check existence and NOT write the
    // stale row back — otherwise a review the user removed reappears.
    await persistPendingReview(makeReview());
    const pds = fakePds({
      putRecord: async () => {
        await removePendingReview('c1'); // dismiss lands while the write is in flight
        throw new Error('transient network drop after dismiss');
      },
    });

    const res = await drainReviewOutbox(pds, 'did:plc:owner');

    expect(res).toEqual({ published: 0, failed: 0 }); // not counted as a live failure
    expect(await loadPendingReviews()).toHaveLength(0); // stays dismissed, not resurrected
  });

  it('hydrate skips reviews queued under a DIFFERENT identity (restore / re-onboard)', async () => {
    await persistPendingReview(makeReview({ clientId: 'mine', did: 'did:plc:owner' }));
    await persistPendingReview(makeReview({ clientId: 'theirs', did: 'did:plc:other' }));

    await hydrateReviewOutbox('did:plc:owner');

    // Only this identity's review is surfaced; the foreign one stays in KV and
    // can't be dismissed / cap-occupied by the wrong identity.
    expect(getOutboxRows().map((r) => r.clientId)).toEqual(['mine']);
    expect(await loadPendingReviews()).toHaveLength(2); // both still durable
  });

  it('countActivePendingReviews counts only non-dead-lettered durable rows', async () => {
    await persistPendingReview(makeReview({ clientId: 'a', attempts: 0 }));
    await persistPendingReview(makeReview({ clientId: 'b', attempts: 8 })); // dead-lettered
    expect(await countActivePendingReviews()).toBe(1);
  });

  it('countActivePendingReviews filters by DID (foreign rows do not occupy the cap)', async () => {
    await persistPendingReview(makeReview({ clientId: 'mine', did: 'did:plc:owner' }));
    await persistPendingReview(makeReview({ clientId: 'theirs', did: 'did:plc:other' }));
    expect(await countActivePendingReviews()).toBe(2); // unfiltered
    expect(await countActivePendingReviews('did:plc:owner')).toBe(1); // only this identity's
  });

  it('hydrate surfaces a dead-letter as terminal EVEN when the active queue is at the cap', async () => {
    // Fill the mirror to the cap with active (queued-offline) rows.
    for (let i = 0; i < 50; i++) enqueueLocal(makeReview().draft, `q${i}`);
    expect(getOutboxRows()).toHaveLength(50);
    // A dead-lettered durable row must still hydrate (bypassing the cap), or it
    // would be hidden in KV with no visible row to dismiss / retry.
    await persistPendingReview(makeReview({ clientId: 'dead', attempts: 8 }));

    await hydrateReviewOutbox();

    const dead = getOutboxRows().find((r) => r.clientId === 'dead');
    expect(dead?.status).toBe('stuck-offline'); // visible terminal, not cap-rejected
  });

  it('a retried dead-letter leaves the failure state (goes in-flight) before the write', async () => {
    await persistPendingReview(makeReview({ clientId: 'c1', attempts: 8 }));
    enqueueDeadLetteredLocal(makeReview().draft, 'c1', '2026-06-08T00:00:00.000Z');
    expect(getOutboxRows()[0].status).toBe('stuck-offline');

    await resetReviewAttempts('c1'); // "Try again" resets the durable attempt count
    let statusDuringWrite: string | undefined;
    const pds = fakePds({
      putRecord: async () => {
        statusDuringWrite = getOutboxRows()[0]?.status;
        return { uri: 'at://x', cid: 'y' };
      },
    });

    await drainReviewOutbox(pds, 'did:plc:owner');

    // Left stuck-offline → submitted-pending before the write, so "Remove" can't
    // drop a review whose publish is already on the wire.
    expect(statusDuringWrite).toBe('submitted-pending');
    expect(getOutboxRows()).toHaveLength(0); // published + removed
  });

  it('marks the visible row in-flight during the write, then REMOVES it on success', async () => {
    enqueueLocal(makeReview().draft, 'c1'); // mirror row starts queued-offline
    await persistPendingReview(makeReview({ clientId: 'c1' }));
    let statusDuringWrite: string | undefined;
    const pds = fakePds({
      putRecord: async () => {
        statusDuringWrite = getOutboxRows()[0]?.status;
        return { uri: 'at://x', cid: 'y' };
      },
    });

    await drainReviewOutbox(pds, 'did:plc:owner');

    // In-flight → submitted-pending (drops out of the dismissable queued list).
    expect(statusDuringWrite).toBe('submitted-pending');
    expect(getOutboxRows()).toHaveLength(0); // removed on success
  });

  it('reverts the in-flight row back to queued-offline on a transient failure', async () => {
    enqueueLocal(makeReview().draft, 'c1');
    await persistPendingReview(makeReview({ clientId: 'c1' }));
    let statusDuringWrite: string | undefined;
    const pds = fakePds({
      putRecord: async () => {
        statusDuringWrite = getOutboxRows()[0]?.status;
        throw new Error('offline');
      },
    });

    await drainReviewOutbox(pds, 'did:plc:owner');

    expect(statusDuringWrite).toBe('submitted-pending'); // undismissable during the write
    expect(getOutboxRows()[0].status).toBe('queued-offline'); // Dismiss/Retry return on failure
  });

  it('defers cleanup when a guided demo starts mid-publish (keeps the durable row)', async () => {
    enqueueLocal(makeReview().draft, 'c1');
    await persistPendingReview(makeReview({ clientId: 'c1' }));
    const pds = fakePds({
      putRecord: async () => {
        setCurrentDataScope('guided_demo:mid'); // demo starts while the write is in flight
        return { uri: 'at://x', cid: 'y' };
      },
    });

    const res = await drainReviewOutbox(pds, 'did:plc:owner');

    // Don't touch the demo-scope chat thread: leave the durable row for a later
    // user-scope drain to finalize idempotently, and revert the in-flight marker.
    expect(res.published).toBe(0);
    expect(await loadPendingReviews()).toHaveLength(1);
    expect(getOutboxRows()[0].status).toBe('queued-offline');
  });

  it('keeps the row and bumps attempts when publish fails', async () => {
    await persistPendingReview(makeReview());
    const pds = fakePds({
      putRecord: async () => {
        throw new Error('offline');
      },
    });

    const res = await drainReviewOutbox(pds, 'did:plc:owner');

    expect(res).toEqual({ published: 0, failed: 1 });
    const after = await loadPendingReviews();
    expect(after).toHaveLength(1); // still queued for the next pass
    expect(after[0].attempts).toBe(1);
    expect(after[0].lastError).toContain('offline');
  });

  it('stops retrying a dead-lettered row (attempts at the cap)', async () => {
    await persistPendingReview(makeReview({ attempts: 8 }));
    let called = false;
    const pds = fakePds({
      putRecord: async () => {
        called = true;
        return { uri: 'x', cid: 'y' };
      },
    });

    const res = await drainReviewOutbox(pds, 'did:plc:owner');

    expect(called).toBe(false); // never re-attempted
    expect(res).toEqual({ published: 0, failed: 0 });
    expect(await loadPendingReviews()).toHaveLength(1); // kept for user dismiss
  });

  it('never publishes a review queued under a DIFFERENT identity (skips mismatched DID)', async () => {
    // Queued under identity A; the device is now booted as identity B.
    await persistPendingReview(makeReview({ did: 'did:plc:other-identity' }));
    let published = false;
    const pds = fakePds({
      putRecord: async () => {
        published = true;
        return { uri: 'x', cid: 'y' };
      },
    });

    const res = await drainReviewOutbox(pds, 'did:plc:owner'); // current identity differs

    expect(published).toBe(false); // must NOT post A's review under B
    expect(res).toEqual({ published: 0, failed: 0 });
    expect(await loadPendingReviews()).toHaveLength(1); // kept for if A returns
  });

  it('hydrate surfaces a dead-lettered review as a terminal failure (not perpetual queued)', async () => {
    await persistPendingReview(makeReview({ attempts: 8 }));
    await hydrateReviewOutbox();
    const rows = getOutboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('stuck-offline'); // terminal — shows as a failure, not "will publish"
  });

  it('marks the visible row dead-lettered when a drain exhausts retries (no restart needed)', async () => {
    await persistPendingReview(makeReview({ attempts: 7 })); // one away from the cap
    enqueueLocal(makeReview().draft, 'c1'); // already mirrored as queued-offline
    expect(getOutboxRows()[0].status).toBe('queued-offline');

    const pds = fakePds({
      putRecord: async () => {
        throw new Error('still offline');
      },
    });
    await drainReviewOutbox(pds, 'did:plc:owner'); // 7 -> 8 (cap) -> dead-letter

    expect(getOutboxRows()[0].status).toBe('stuck-offline'); // surfaced live, no restart
  });

  it('hydrate keeps a still-retriable review queued', async () => {
    await persistPendingReview(makeReview({ attempts: 2 }));
    await hydrateReviewOutbox();
    expect(getOutboxRows()[0].status).toBe('queued-offline');
  });

  it('loadPendingReviews skips a corrupt/older row missing createdAt + attempts', async () => {
    // A row from before these fields existed (or a corrupted value). It must be
    // skipped at load time — the loader's documented contract — so it can never
    // reach hydrate with an undefined timestamp/attempt count.
    await kvSet(
      'legacy-row',
      JSON.stringify({
        clientId: 'legacy-row',
        did: 'did:plc:owner',
        rkey: 'rk',
        record: { subject: {} },
        draft: { sentiment: 'positive', headline: 'h', body: 'b', confidence: 'high', subjectTitle: 't' },
        // no createdAt, no attempts
      }),
      'peerlens_outbox',
    );
    await persistPendingReview(makeReview()); // one well-formed row alongside it

    const loaded = await loadPendingReviews();
    expect(loaded).toHaveLength(1); // legacy row dropped, good row kept
    expect(loaded[0].clientId).toBe('c1');
  });

  it('hydrate does not abort the whole batch when one row has a non-ISO timestamp', async () => {
    // Passes the type guard (createdAt IS a string) but fails enqueueLocal's ISO
    // check. The per-row guard must skip just this row, not throw out of hydrate
    // and prevent every other queued review from showing/draining.
    await persistPendingReview(makeReview({ clientId: 'bad', createdAt: 'not-a-real-date' }));
    await persistPendingReview(makeReview({ clientId: 'good' }));

    await expect(hydrateReviewOutbox()).resolves.toBeUndefined(); // never throws
    const rows = getOutboxRows();
    expect(rows).toHaveLength(1); // bad row skipped, good row hydrated
    expect(rows[0].clientId).toBe('good');
  });

  it('resetReviewAttempts clears attempts so a dead-lettered review drains again', async () => {
    await persistPendingReview(makeReview({ attempts: 8, lastError: 'boom' }));
    await resetReviewAttempts('c1');
    expect((await loadPendingReviews())[0].attempts).toBe(0);

    let published = false;
    const pds = fakePds({
      putRecord: async () => {
        published = true;
        return { uri: 'x', cid: 'y' };
      },
    });
    await drainReviewOutbox(pds, 'did:plc:owner');
    expect(published).toBe(true); // no longer skipped as dead-lettered
  });
});
