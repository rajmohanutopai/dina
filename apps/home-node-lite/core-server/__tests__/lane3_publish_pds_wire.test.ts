/**
 * The card publisher over the real PDS client (design §8.2; plan §3.15), as
 * boot wires it: `cardRepoOverPds(new PDSPublisher(...))`, with only the
 * network faked. The fake answers the five XRPC calls the publisher makes
 * and enforces `swapCommit` and `swapRecord` the way a PDS does. These
 * tests hold what goes over the wire: the fence write's "nothing there"
 * precondition, and a server failure kept apart from a lost swap.
 */

import { A2A_FENCE_COLLECTION } from '@dina/a2a';
import { PDSPublisher, PDSPublisherError } from '@dina/brain';

import { PUBLISH_RETRY_DELAYS_MS, cardRepoOverPds } from '../src/appview/a2a_card_publisher';

import { CARD, KEY_A, NODE, PublishWorld, WirePds, type PubNode } from './lane3_publish_fixture';

const PDS = 'https://pds.example';

let w: PublishWorld;
let pds: WirePds;

beforeEach(() => {
  w = new PublishWorld();
  pds = new WirePds();
});
afterEach(() => {
  w.close();
});

/** A node whose publisher talks to the fake PDS through the real client, as boot wires it. */
function wiredNode(): PubNode {
  const repo = cardRepoOverPds(new PDSPublisher({ pdsUrl: PDS, handle: 'node.example', password: 'pw', fetch: pds.fetch }), NODE);
  // The lost-swap predicate boot passes.
  return w.node(KEY_A, { repo, isLostSwap: (err) => err instanceof PDSPublisherError && err.casLost });
}

// Plan E156
it('the first fence goes out with swapRecord: null on the wire, and a later one names the fence it replaces', async () => {
  const n = wiredNode();
  expect((await n.publisher.activate({ refence: false })).ok).toBe(true);
  await n.publisher.flush();
  const [first] = pds.writesTo(A2A_FENCE_COLLECTION);
  expect(first?.body).toEqual(expect.objectContaining({ swapCommit: 'bafyhead0', swapRecord: null }));
  expect(Object.prototype.hasOwnProperty.call(first?.body, 'swapRecord')).toBe(true);
  const fenceCid = pds.records.get(`${A2A_FENCE_COLLECTION}/self`)?.cid;
  const head = pds.head;
  expect((await n.publisher.activate({ refence: false })).ok).toBe(true);
  await n.publisher.flush();
  const second = pds.writesTo(A2A_FENCE_COLLECTION)[1];
  expect(second?.body).toEqual(expect.objectContaining({ swapCommit: head, swapRecord: fenceCid }));
});

// Plan E157
describe('a server failure is not a lost swap', () => {
  it('a 5xx on the card put waits the failure schedule; only an InvalidSwap waits the short lost-swap delay', async () => {
    const n = wiredNode();
    w.listOn(n);
    expect((await n.publisher.activate({ refence: false })).ok).toBe(true);
    await n.publisher.flush();
    expect(pds.card()).not.toBeNull();
    n.card = CARD('Bus 55');
    await w.touchListing(n);
    // Two server failures in a row: 5 s, then 30 s.
    pds.failNext.set('com.atproto.repo.putRecord', { status: 503, error: 'InternalServerError' });
    await w.step(n);
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'failed', attempts: 1, next_retry_at: w.clock + PUBLISH_RETRY_DELAYS_MS[0] }));
    w.clock += PUBLISH_RETRY_DELAYS_MS[0];
    pds.failNext.set('com.atproto.repo.putRecord', { status: 503, error: 'InternalServerError' });
    await w.step(n);
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'failed', attempts: 2, next_retry_at: w.clock + PUBLISH_RETRY_DELAYS_MS[1] }));
    // Then a lost swap: back to the short delay, though two failures came before it.
    w.clock += PUBLISH_RETRY_DELAYS_MS[1];
    pds.failNext.set('com.atproto.repo.putRecord', { status: 400, error: 'InvalidSwap' });
    await w.step(n);
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'failed', attempts: 3, next_retry_at: w.clock + PUBLISH_RETRY_DELAYS_MS[0] }));
    w.clock += PUBLISH_RETRY_DELAYS_MS[0];
    await w.step(n);
    expect(JSON.parse(pds.card()?.card as string)).toEqual(expect.objectContaining({ name: 'Bus 55' }));
  });

  it.each([
    ['answered 502', { status: 502, error: 'InternalServerError' }],
    ['answered with no cid', { status: 200, error: 'no_cid' }],
  ])('a head read %s fails closed: nothing is claimed, written or stood down', async (_name, failure) => {
    const n = wiredNode();
    w.listOn(n);
    expect((await n.publisher.activate({ refence: false })).ok).toBe(true);
    await n.publisher.flush();
    n.card = CARD('Bus 56');
    await w.touchListing(n);
    const posts = pds.calls.filter((c) => c.method === 'POST').length;
    pds.failNext.set('com.atproto.sync.getLatestCommit', failure);
    await w.step(n);
    expect(pds.calls.filter((c) => c.method === 'POST').length).toBe(posts);
    expect(w.rowOf(n)).toEqual(expect.objectContaining({ state: 'published', attempt_tuple_json: null, publication_active: 1, notice: null }));
    await w.step(n);
    expect(JSON.parse(pds.card()?.card as string)).toEqual(expect.objectContaining({ name: 'Bus 56' }));
  });
});

// Cold audit C3-13: every read names the node's own repository, whatever account the session holds
it('a session signed in as another account still reads the node’s own fence and card: no false stand-down, no write anywhere', async () => {
  const client = new PDSPublisher({ pdsUrl: PDS, handle: 'node.example', password: 'pw', fetch: pds.fetch });
  const n = w.node(KEY_A, { repo: cardRepoOverPds(client, NODE), isLostSwap: (err) => err instanceof PDSPublisherError && err.casLost });
  w.listOn(n);
  expect((await n.publisher.activate({ refence: false })).ok).toBe(true);
  await n.publisher.flush();
  const before = JSON.parse(pds.card()?.card as string) as { name: string };
  // The handle now signs in to another account (a moved handle, a reused password).
  pds.sessionAs = 'did:plc:someoneelse0000000000000';
  client.invalidateSession();
  n.card = CARD('Bus 48');
  await w.touchListing(n);
  await w.step(n);
  // The fence the node reads is its own, so nothing stands it down; and no write goes to the other account.
  expect(w.rowOf(n)).toEqual(expect.objectContaining({ publication_active: 1, notice: null }));
  expect(w.rowOf(n).state).not.toBe('stood_down');
  expect(pds.foreignWrites).toEqual([]);
  expect((JSON.parse(pds.card()?.card as string) as { name: string }).name).toBe(before.name);
  // Every read named the node's repository: the head as much as the records, so one sequence reads one repository.
  const reads = pds.calls.filter((c) => c.method === 'GET');
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.map((c) => c.query.did ?? c.query.repo)).toEqual(reads.map(() => NODE));
  // Signed in as the node again (after the retry delay), the change goes out.
  pds.sessionAs = NODE;
  client.invalidateSession();
  w.clock += PUBLISH_RETRY_DELAYS_MS[1];
  await w.step(n);
  expect(JSON.parse(pds.card()?.card as string)).toEqual(expect.objectContaining({ name: 'Bus 48' }));
});
