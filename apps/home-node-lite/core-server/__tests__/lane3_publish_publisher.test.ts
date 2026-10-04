/**
 * The Lane 3 card publisher (design §8.2, M5): the rules the first test set
 * left open. The read sequence and its bounds, the fence write's
 * preconditions, the activation races, two-phase deactivation across a
 * crash, stand-down on each kind of fence, quiet nodes, the retry schedule,
 * the session check before every write, and a restart while a retry waits.
 * Every test asserts what the repository holds, not only the row.
 */

import { A2A_CARD_COLLECTION, A2A_FENCE_COLLECTION } from '@dina/a2a';
import { DIRECTORY_FRESHNESS_CADENCE_MS } from '@dina/core';

import { PUBLISH_RETRY_DELAYS_MS } from '../src/appview/a2a_card_publisher';

import { CARD, KEY_A, KEY_B, NODE, PublishWorld, keyIdOf, tick } from './lane3_publish_fixture';

let w: PublishWorld;
beforeEach(() => {
  w = new PublishWorld();
});
afterEach(() => {
  w.close();
});

describe('activation', () => {
  // Plan E64
  it('two restores activating at the same moment cannot both win: the second fence write fails on the moved head', async () => {
    await w.activeNode();
    const r1 = w.node();
    const r2 = w.node();
    w.listOn(r1);
    w.listOn(r2);
    r2.keyReady = false; // only fences in this race
    let second: Awaited<ReturnType<typeof r2.publisher.activate>> | null = null;
    // r1 has read the fence and is about to write its own; r2 runs its whole ceremony first.
    w.repo.beforeWrite = async () => {
      second = await r2.publisher.activate({ refence: false });
    };
    const first = await r1.publisher.activate({ refence: false });
    await r2.publisher.flush();
    expect(second).toEqual({ ok: true, epoch: 2 });
    expect(first).toEqual({ ok: false, reason: 'lost_race' });
    expect(w.rowOf(r1).publication_active).toBe(0);
    expect(w.repo.fence()).toEqual(expect.objectContaining({ publisher_epoch: 2, publisher_instance: w.rowOf(r2).publisher_instance }));
  });

  // Plan E67
  it('an unreachable repository: activation writes nothing and the node stays inactive', async () => {
    const n = w.node();
    w.listOn(n);
    w.repo.reachable = false;
    expect(await n.publisher.activate({ refence: false })).toEqual({ ok: false, reason: 'repo_unreachable' });
    w.repo.reachable = true;
    await n.publisher.flush();
    expect(w.repo.writes).toEqual([]);
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ publication_active: 0, publisher_epoch: 0 }));
  });

  // Plan E68
  it.each([
    ['a fence it can verify', KEY_A, false],
    ['a fence it cannot verify, even on the owner’s word', KEY_B, true],
  ])('epochs stay bounded safe integers: above %s at the largest safe epoch, nothing is written', async (_name, signer, refence) => {
    await w.writeFence(signer, Number.MAX_SAFE_INTEGER, '00000000-0000-4000-8000-999999999999');
    const fenceBefore = w.repo.fenceCid();
    const n = w.node();
    w.listOn(n);
    expect((await n.publisher.activate({ refence })).ok).toBe(false);
    await n.publisher.flush();
    expect(w.repo.writes).toEqual([]);
    expect(w.repo.fenceCid()).toBe(fenceBefore);
    expect(w.rowOf(n).publication_active).toBe(0);
  });

  // Plan E81
  it('the fence write is conditional on the head and on the fence it replaces: null when there was none', async () => {
    const n = w.node();
    await n.publisher.activate({ refence: false });
    await n.publisher.flush();
    const first = w.repo.attempted.filter((a) => a.collection === A2A_FENCE_COLLECTION);
    expect(first).toHaveLength(1);
    expect(first[0]?.options).toEqual({ swapCommit: 'c0', swapRecord: null });
    expect('swapRecord' in (first[0]?.options ?? {})).toBe(true);
    const priorFence = w.repo.fenceCid();
    const head = w.repo.head;
    await n.publisher.activate({ refence: false });
    await n.publisher.flush();
    const second = w.repo.attempted.filter((a) => a.collection === A2A_FENCE_COLLECTION);
    expect(second[1]?.options).toEqual({ swapCommit: head, swapRecord: priorFence });
  });
});

describe('the read sequence', () => {
  // Plan E76
  it('a head that moves between the two head reads restarts the sequence, and the write then lands on the settled head', async () => {
    const n = await w.activeNode();
    n.card = CARD('Bus 44');
    await w.touchListing(n);
    const h0 = w.repo.head;
    let settled = '';
    w.repo.beforeRecordRead = () => {
      w.repo.writeDirect('com.example.other', { x: 1 });
      settled = w.repo.head;
    };
    const headReads = w.repo.headReads;
    await w.step(n);
    expect(w.repo.headReads - headReads).toBe(4); // two sequences: the first restarted
    expect(settled).not.toBe(h0);
    const put = w.repo.attempted.filter((a) => a.collection === A2A_CARD_COLLECTION).at(-1);
    expect(put?.options.swapCommit).toBe(settled);
    expect(w.nameInRepo()).toBe('Bus 44');
    expect(w.rowOf(n).state).toBe('published');
  });

  // Plan E77
  it('a head that never settles: the sequence runs three times, then claims, writes and stands down nothing', async () => {
    const n = await w.activeNode();
    const writes = w.repo.writes.length;
    n.card = CARD('Bus 45');
    await w.touchListing(n);
    w.repo.onEveryRecordRead = () => w.repo.writeDirect('com.example.other', { y: Math.random() });
    const headReads = w.repo.headReads;
    await w.step(n);
    const sequences = (w.repo.headReads - headReads) / 2;
    expect(sequences).toBe(3); // the notes' bound: three tries
    expect(w.repo.writes.length).toBe(writes);
    expect(w.nameInRepo()).toBe('Bus 42');
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'published', attempt_tuple_json: null, publication_active: 1, notice: null }));
    // Settled again, the next step publishes.
    w.repo.onEveryRecordRead = null;
    await w.step(n);
    expect(w.nameInRepo()).toBe('Bus 45');
  });

  // Plan E159
  it('a repository read that fails is never taken for a missing or foreign fence: no stand-down, no write', async () => {
    const n = await w.activeNode();
    const writes = w.repo.writes.length;
    n.card = CARD('Bus 46');
    await w.touchListing(n);
    w.repo.failReadsOf = A2A_FENCE_COLLECTION;
    await w.step(n);
    w.listOff(n);
    await w.step(n);
    expect(w.repo.writes.length).toBe(writes);
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ publication_active: 1, notice: null }));
    expect(w.rowOf(n).state).not.toBe('stood_down');
    w.repo.failReadsOf = null;
    await w.step(n);
    expect(w.repo.card()).toBeNull();
  });
});

describe('the predicate drives the card', () => {
  // Plan E25
  it('a card build refused for any reason counts as predicate-false: the card goes', async () => {
    const n = await w.activeNode();
    n.refuse = 'public_origin_invalid';
    await w.step(n);
    expect(w.repo.card()).toBeNull();
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'not_published', card_maybe_present: 0 }));
    n.refuse = null;
    await w.step(n);
    expect(w.nameInRepo()).toBe('Bus 42');
  });

  // Plan E26
  it('a card build that throws ends the step with nothing written or deleted; the next step recovers', async () => {
    const n = await w.activeNode();
    const writes = w.repo.writes.length;
    n.card = CARD('Bus 47');
    await w.touchListing(n);
    n.buildThrows = true;
    await w.step(n);
    expect(w.repo.writes.length).toBe(writes);
    expect(w.nameInRepo()).toBe('Bus 42');
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'published', attempt_tuple_json: null }));
    n.buildThrows = false;
    await w.step(n);
    expect(w.nameInRepo()).toBe('Bus 47');
  });

  // Plan E102
  it('an unpublish does not wait for the card key: switched off, the card goes though the DID document is not ready', async () => {
    const n = await w.activeNode();
    n.keyReady = false;
    w.listOff(n);
    await w.step(n);
    expect(w.repo.card()).toBeNull();
    expect(w.rowOf(n).card_maybe_present).toBe(0);
  });

  // Plan E158
  it('the session is checked before every card write: under another DID no put and no delete goes out', async () => {
    const n = await w.activeNode();
    w.repo.sessionAs = 'did:plc:someoneelse0000000000000';
    n.card = CARD('Bus 48');
    await w.touchListing(n);
    await w.step(n);
    expect(w.nameInRepo()).toBe('Bus 42');
    w.listOff(n);
    await w.step(n);
    expect(w.nameInRepo()).toBe('Bus 42');
    expect(w.repo.attempted.filter((a) => a.collection === A2A_CARD_COLLECTION)).toHaveLength(1);
    expect(w.rowOf(n).card_maybe_present).toBe(1);
    // Signed in as the node again (after the retry delay), the delete runs.
    w.repo.sessionAs = NODE;
    w.clock += PUBLISH_RETRY_DELAYS_MS[1];
    await w.step(n);
    expect(w.repo.card()).toBeNull();
  });
});

describe('the 14-day refresh', () => {
  // Plan E104
  it('14 days less 1 ms reads and writes nothing; at 14 days the record is a new commit with the same card', async () => {
    const n = await w.activeNode();
    const before = { cid: w.repo.cardCid(), card: w.repo.card()?.card, reads: w.repo.reads, writes: w.repo.writes.length };
    w.clock += DIRECTORY_FRESHNESS_CADENCE_MS - 1;
    await w.step(n);
    expect(w.repo.reads).toBe(before.reads);
    expect(w.repo.writes.length).toBe(before.writes);
    w.clock += 1;
    await w.step(n);
    expect(w.repo.cardCid()).not.toBe(before.cid);
    expect(w.repo.card()?.card).toBe(before.card);
    expect(w.envelopeInRepo().freshness_epoch).toBe(1);
  });
});

describe('retries', () => {
  // Plan E94
  it('a failing publish waits 5 s, 30 s, 2 min, 10 min, then 30 min, and reads nothing while it waits', async () => {
    const n = w.node();
    w.listOn(n);
    n.keyReady = false; // the fence first, the card held back
    await n.publisher.activate({ refence: false });
    await n.publisher.flush();
    n.keyReady = true;
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      w.repo.dropNextWrite = true;
      await w.step(n);
      const row = w.rowOf(n);
      expect(row.state).toBe('failed');
      delays.push((row.next_retry_at ?? 0) - w.clock);
      // Before it is due, the node does not touch the repository.
      const reads = w.repo.reads;
      w.clock = (row.next_retry_at ?? 0) - 1;
      await w.step(n);
      expect(w.repo.reads).toBe(reads);
      w.clock += 1;
    }
    expect(delays).toEqual([5_000, 30_000, 120_000, 600_000, 1_800_000, 1_800_000]);
    await w.step(n);
    expect(w.nameInRepo()).toBe('Bus 42');
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'published', attempts: 0, next_retry_at: null }));
  });

  // Cold audit C6-10: "predicate-false always drives an unpublish" (§8.2)
  it('a card withdrawn while a failed publish waits is deleted at the next step, not when the wait ends', async () => {
    const n = await w.activeNode();
    expect(w.nameInRepo()).toBe('Bus 42');
    // A change to the card fails to publish: the publish waits 5 s.
    n.card = CARD('Bus 78');
    await w.touchListing(n);
    w.repo.dropNextWrite = true;
    await w.step(n);
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'failed', retry_operation: 'publish', next_retry_at: w.clock + 5_000 }));
    // The owner removes the last public listing meanwhile: nothing is left to project.
    n.card = null;
    await w.touchListing(n);
    await w.step(n);
    expect(w.repo.card()).toBeNull();
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ card_maybe_present: 0, next_retry_at: null, retry_operation: null }));
  });

  it('control: a failed unpublish waits out its own retry time', async () => {
    const n = await w.activeNode();
    n.card = null;
    await w.touchListing(n);
    w.repo.dropNextWrite = true;
    await w.step(n);
    const row = w.rowOf(n);
    expect(row).toEqual(expect.objectContaining({ state: 'failed', retry_operation: 'unpublish' }));
    const reads = w.repo.reads;
    w.clock = (row.next_retry_at ?? 0) - 1;
    await w.step(n);
    expect(w.repo.reads).toBe(reads);
    expect(w.nameInRepo()).toBe('Bus 42');
    w.clock += 1;
    await w.step(n);
    expect(w.repo.card()).toBeNull();
  });

  // Plan X-2 (a publish fails, then core-server restarts before the retry is due)
  it('a failed publish across a restart: the new process waits out the stored backoff, then publishes once under a fresh claim', async () => {
    const n = w.node();
    w.listOn(n);
    n.keyReady = false;
    await n.publisher.activate({ refence: false });
    await n.publisher.flush();
    n.keyReady = true;
    w.repo.dropNextWrite = true;
    await w.step(n);
    const failed = w.rowOf(n);
    expect(failed).toEqual(expect.objectContaining({ state: 'failed', attempts: 1, attempt_tuple_json: null }));
    const due = failed.next_retry_at ?? 0;
    expect(due).toBe(w.clock + PUBLISH_RETRY_DELAYS_MS[0]);
    // The process restarts before the retry is due: its first step reads and writes nothing.
    w.clock = due - 1_000;
    const quiet = { reads: w.repo.reads, attempted: w.repo.attempted.length };
    w.restart(n);
    await n.publisher.flush();
    expect(w.repo.reads).toBe(quiet.reads);
    expect(w.repo.attempted.length).toBe(quiet.attempted);
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'failed', next_retry_at: due }));
    // Due: exactly one card put, recorded under its own claim.
    w.clock = due;
    await w.step(n);
    await w.step(n);
    expect(w.repo.attempted.length - quiet.attempted).toBe(1);
    expect(w.nameInRepo()).toBe('Bus 42');
    expect(w.rowOf(n)).toEqual(
      expect.objectContaining({ state: 'published', attempts: 0, attempt_tuple_json: null, last_published_cid: w.repo.cardCid() }),
    );
  });
});

describe('keys', () => {
  // Plan E110
  it('a rotation while deactivating: the delete still runs under the fence as it stands, and no fence is written', async () => {
    const n = await w.activeNode();
    w.repo.reachable = false;
    await n.publisher.deactivate();
    expect(w.rowOf(n).state).toBe('deactivating');
    w.repo.reachable = true;
    const writes = w.repo.writes.length;
    n.key = KEY_B;
    await w.step(n);
    expect(w.repo.writes.slice(writes)).toEqual([`delete ${A2A_CARD_COLLECTION}`]);
    expect(w.repo.card()).toBeNull();
    expect(w.fenceVerifiesUnder(KEY_A)).toBe(true);
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'not_published', publication_active: 0, card_maybe_present: 0 }));
  });
});

describe('two-phase deactivation', () => {
  // Plan E115
  it('a crash before the delete: the restarted node resumes in deactivating and finishes', async () => {
    const n = await w.activeNode();
    w.repo.reachable = false;
    await n.publisher.deactivate();
    expect(w.rowOf(n).state).toBe('deactivating');
    expect(w.nameInRepo()).toBe('Bus 42');
    w.repo.reachable = true;
    w.restart(n);
    await n.publisher.flush();
    expect(w.repo.card()).toBeNull();
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'not_published', publication_active: 0, card_maybe_present: 0 }));
  });

  // Plan E116
  it('a crash after the delete, before the local record: the restarted node reads no card, finishes, and writes nothing more', async () => {
    const n = await w.activeNode();
    // The delete lands; the process dies before its answer is handled.
    w.repo.afterLand = () => new Promise<void>(() => undefined);
    void n.publisher.deactivate();
    for (let i = 0; i < 50 && w.repo.card() !== null; i++) await tick();
    expect(w.repo.card()).toBeNull();
    expect(w.rowOf(n).state).toBe('deactivating');
    const attempted = w.repo.attempted.length;
    w.restart(n);
    await n.publisher.flush();
    expect(w.repo.attempted.length).toBe(attempted);
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'not_published', publication_active: 0, card_maybe_present: 0 }));
  });

  // Plan E117
  it('an activation elsewhere during the delete: the conditional delete fails, the node stands down, and the card stays', async () => {
    const a = await w.activeNode();
    const b = w.node();
    w.listOn(b);
    b.keyReady = false; // b writes only its fence
    let activated: unknown = null;
    // a has read the head and the fence and is about to delete; b activates first.
    w.repo.beforeWrite = async () => {
      activated = await b.publisher.activate({ refence: false });
    };
    await a.publisher.deactivate();
    await b.publisher.flush();
    expect(activated).toEqual({ ok: true, epoch: 2 });
    expect(w.nameInRepo()).toBe('Bus 42');
    expect(w.rowOf(a).state).toBe('deactivating');
    w.clock += PUBLISH_RETRY_DELAYS_MS[1];
    await w.step(a);
    expect(w.rowOf(a)).toEqual(expect.objectContaining({ state: 'stood_down', publication_active: 0, notice: 'another_server_publishing' }));
    expect(w.nameInRepo()).toBe('Bus 42');
    expect(w.repo.writes.filter((x) => x.startsWith('delete'))).toEqual([]);
    expect(w.rowOf(b).publication_active).toBe(1);
  });

  // Plan E118
  it('deactivating an inactive node is refused, and touches the repository not at all', async () => {
    const n = w.node();
    w.listOn(n);
    expect(await n.publisher.deactivate()).toEqual({ ok: false, reason: 'not_active' });
    expect(w.repo.writes).toEqual([]);
    expect(w.repo.reads).toBe(0);
  });

  // Plan E119
  it('while deactivating the one authority is the delete: a changed card and a due refresh put nothing', async () => {
    const n = await w.activeNode();
    n.card = CARD('Bus 49');
    await w.touchListing(n);
    w.clock += DIRECTORY_FRESHNESS_CADENCE_MS;
    w.repo.reachable = false;
    await n.publisher.deactivate();
    w.repo.reachable = true;
    const writes = w.repo.writes.length;
    await w.step(n);
    await w.step(n);
    expect(w.repo.writes.slice(writes)).toEqual([`delete ${A2A_CARD_COLLECTION}`]);
    expect(w.repo.card()).toBeNull();
  });
});

describe('stand-down', () => {
  // Plan E122
  it('a fence at this node’s epoch under another instance is foreign: the node stands down and writes nothing', async () => {
    const n = await w.activeNode();
    const writes = w.repo.writes.length;
    await w.writeFence(KEY_A, w.rowOf(n).publisher_epoch, '00000000-0000-4000-8000-777777777777');
    n.card = CARD('Bus 50');
    await w.touchListing(n);
    await w.step(n);
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'stood_down', publication_active: 0, notice: 'another_server_publishing' }));
    expect(w.repo.writes.length).toBe(writes);
    expect(w.nameInRepo()).toBe('Bus 42');
  });

  // Plan E123
  it('a fence gone while active stands the node down (fence_missing), with no write', async () => {
    const n = await w.activeNode();
    const writes = w.repo.writes.length;
    w.repo.deleteDirect(A2A_FENCE_COLLECTION);
    n.card = CARD('Bus 51');
    await w.touchListing(n);
    await w.step(n);
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'stood_down', notice: 'fence_missing' }));
    expect(w.repo.writes.length).toBe(writes);
  });
});

describe('quiet nodes', () => {
  // Plan E128
  it('an inactive node switched on reads nothing', async () => {
    const n = w.node();
    w.listOn(n);
    await w.touchListing(n);
    await w.step(n);
    w.clock += DIRECTORY_FRESHNESS_CADENCE_MS;
    await w.step(n);
    expect(w.repo.reads).toBe(0);
    expect(w.repo.writes).toEqual([]);
  });

  // Plan E129a and E125
  it('a stood-down node reads and writes nothing, whatever changes', async () => {
    const n = await w.activeNode();
    await w.writeFence(KEY_A, 9, '00000000-0000-4000-8000-888888888888');
    n.card = CARD('Bus 52');
    await w.touchListing(n);
    await w.step(n);
    expect(w.rowOf(n).state).toBe('stood_down');
    const quiet = { reads: w.repo.reads, attempted: w.repo.attempted.length };
    n.card = CARD('Bus 53');
    await w.touchListing(n);
    w.listOff(n);
    w.listOn(n);
    n.key = KEY_B;
    w.clock += DIRECTORY_FRESHNESS_CADENCE_MS;
    await w.step(n);
    await w.step(n);
    expect(w.repo.reads).toBe(quiet.reads);
    expect(w.repo.attempted.length).toBe(quiet.attempted);
    expect(keyIdOf(n.key)).not.toBe(w.rowOf(n).fence_key_id);
  });
});
