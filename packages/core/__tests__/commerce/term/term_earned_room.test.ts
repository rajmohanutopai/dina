/**
 * COMMITMENT_KERNEL §15 step 13 — earned room on the store's shelf floors,
 * end to end through the term engine.
 *
 *   TE-01  five floor cards said yes to raise Core's offer, with the lowest
 *          rent asked; the owner's yes moves the automatic floor there, and a
 *          brand's counter at that rent is then signed with no card;
 *   TE-02  the owner declines an agreement whose rent sits inside the earned
 *          room: the owner's own floor is back at once, with a notice;
 *   TE-03  a floor card that lapses is recorded as a lapse; a policy figure
 *          behind a premium is the largest whose raised value does not pass it.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import {
  floorBase,
  shelfLimitKey,
  shelfLimitPort,
} from '../../../src/commerce/term/term_earned_room';
import { SHELF_HOST_KIND } from '../../../src/commerce/term/term_model';
import { applyHoldingPremium } from '../../../src/commerce/term/term_policy';
import { TERM_DECISION_CARD, TERM_FLOOR_CARD } from '../../../src/commerce/term/term_seller';
import {
  EARNED_ROOM_NOTICE_TYPE,
  EARNED_ROOM_OFFER_TYPE,
  EarnedRoomStore,
  installBrokenPromiseCheck,
  installEarnedRoomStore,
  installLimitPort,
  makeEarnedRoomDecisionHandler,
  uninstallLimitPort,
} from '../../../src/commitment/earned_room';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';
import { WorkflowTaskState } from '../../../src/workflow/domain';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { setWorkflowService, WorkflowService } from '../../../src/workflow/service';

import {
  DAY,
  Fleet,
  juicePolicy,
  must,
  publishListing,
  STORE_DID,
  type Node,
} from './term_harness';

import type { TermListing } from '@dina/commerce-protocol';

const brandDid = (i: number) => `did:plc:${`brand${String(i)}`.padEnd(26, '0')}`;
const KEY = shelfLimitKey('slot-3', 'fee');
const tick = () => new Promise((r) => setTimeout(r, 0));

let fleet: Fleet;
let roomDir: string;
let roomDb: NodeSQLiteAdapter;
let room: EarnedRoomStore;
let workflow: WorkflowService;

function setUpStore(): { store: Node; listing: TermListing; uri: string } {
  const policy = juicePolicy();
  must(policy.resources[0]).floors.fee = { hard: '150000', auto: '240000' };
  const store = fleet.add(STORE_DID);
  const set = store.engine.setPolicy(policy);
  if (!set.ok) throw new Error(set.refusal);
  const published = publishListing(store, {
    listingId: 'slot-3',
    resourceRef: 'slot-3',
    kind: 'shelf',
    region: { scheme: 'postal_area', value: 'IN-560034' },
    tags: ['beverages.juice', 'snacks'],
  });
  if (!published.ok) throw new Error(published.refusal);
  return { store, listing: published.listing, uri: published.uri };
}

function ask(brand: Node, listing: TermListing, uri: string): string {
  const started = brand.engine.startNegotiation({
    listing,
    listingUri: uri,
    tag: 'beverages.juice',
    attributes: { skus: 4 },
    start: '2027-02-01T00:00:00Z',
    end: '2027-08-01T00:00:00Z',
    policy: {
      currency: 'INR',
      targets: { fee: '170000', share_bps: '600' },
      ceilings: { fee: '300000', share_bps: '1000' },
      max_rounds: 2,
      deadline_seconds: 3 * 24 * 60 * 60,
    },
  });
  if (!started.ok) throw new Error(started.refusal);
  return started.request.request_id;
}

function card(node: Node, type: string, requestId?: string) {
  const found = node.cards.filter(
    (c) => c.type === type && (requestId === undefined || c.payload.request_id === requestId),
  );
  return found[found.length - 1];
}

const feeFloor = (store: Node) => must(store.engine.policy().resources[0]).floors.fee;
const pending = (type: string) =>
  workflow
    .store()
    .getByCorrelationId(type)
    .filter((t) => t.status === WorkflowTaskState.PendingApproval);

beforeEach(() => {
  fleet = new Fleet();
  roomDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-term-room-'));
  roomDb = new NodeSQLiteAdapter({
    path: path.join(roomDir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(roomDb, IDENTITY_MIGRATIONS);
  room = new EarnedRoomStore(roomDb);
  installEarnedRoomStore(room);
  let service: WorkflowService | null = null;
  workflow = new WorkflowService({
    repository: new InMemoryWorkflowRepository(),
    approvalDecisionHandler: makeEarnedRoomDecisionHandler({
      store: () => room,
      workflow: () => service,
      nowMs: () => fleet.nowMs,
    }),
  });
  service = workflow;
  setWorkflowService(workflow);
  installBrokenPromiseCheck(() => false);
});

afterEach(() => {
  uninstallLimitPort(SHELF_HOST_KIND);
  installBrokenPromiseCheck(null);
  installEarnedRoomStore(null);
  setWorkflowService(null);
  fleet.closeAll();
  roomDb.close();
  fs.rmSync(roomDir, { recursive: true, force: true });
});

/** Five brands each bring a floor card; the owner says yes to each. */
async function fiveYeses(store: Node, listing: TermListing, uri: string): Promise<void> {
  for (let i = 1; i <= 5; i += 1) {
    const brand = fleet.add(brandDid(i));
    const requestId = ask(brand, listing, uri);
    fleet.pump();
    const floorCard = must(card(store, TERM_FLOOR_CARD, requestId), 'floor card');
    expect(floorCard.payload).toMatchObject({
      asked: { fee: '210000' },
      asked_base: { fee: '210000' },
      asked_stamp: { fee: expect.stringMatching(/^\d+$/) },
    });
    store.engine.decideCard(floorCard.cardId, true);
    fleet.pump();
    await tick();
    fleet.advance(DAY);
  }
}

describe('earned room on shelf floors (§15 step 13)', () => {
  it('TE-01: five yeses earn an offer; the yes moves the automatic floor, and the next counter needs no card', async () => {
    const { store, listing, uri } = setUpStore();
    installLimitPort(shelfLimitPort(store.engine));
    await fiveYeses(store, listing, uri);
    const [offer] = pending(EARNED_ROOM_OFFER_TYPE);
    expect(offer?.description).toBe(
      'You said yes to the last 5 offers on the rent for slot-3 below your automatic limit, the lowest at INR 2100.00. ' +
        'Let Dina agree down to INR 2100.00 alone? Your own limit, INR 2400.00, comes back if you decline a deal in ' +
        'the wider room or a promise in these deals is broken.',
    );
    workflow.approve(must(offer).id);
    await tick();
    expect(feeFloor(store)).toEqual({ hard: '150000', auto: '210000' });
    // A sixth brand's counter at 210000 is now Dina's alone: no floor card.
    const brand = fleet.add(brandDid(6));
    const requestId = ask(brand, listing, uri);
    fleet.pump();
    const offers = store.store
      .listByRequest(requestId, 'term_offer')
      .filter((r) => r.direction === 'outbound');
    const fees = offers.map(
      (r) =>
        (JSON.parse(r.recordJson) as { terms: { name: string; value: string }[] }).terms.find(
          (t) => t.name === 'fee',
        )?.value,
    );
    expect(fees).toContain('210000');
  });

  it('TE-02: a declined agreement inside the earned room puts the owner’s floor back, with a notice', async () => {
    const { store, listing, uri } = setUpStore();
    installLimitPort(shelfLimitPort(store.engine));
    await fiveYeses(store, listing, uri);
    workflow.approve(must(pending(EARNED_ROOM_OFFER_TYPE)[0]).id);
    await tick();
    const brand = fleet.add(brandDid(6));
    const requestId = ask(brand, listing, uri);
    fleet.pump();
    const proposalCard = must(card(brand, TERM_PROPOSAL_CARD, requestId), 'proposal card');
    brand.engine.decideCard(proposalCard.cardId, true);
    fleet.pump();
    const decision = must(card(store, TERM_DECISION_CARD, requestId), 'decision card');
    expect(decision.payload).toMatchObject({
      terms: expect.arrayContaining([{ name: 'fee', value: '210000' }]),
    });
    store.engine.decideCard(decision.cardId, false);
    await tick();
    await tick();
    expect(feeFloor(store)).toEqual({ hard: '150000', auto: '240000' });
    expect(room.room(SHELF_HOST_KIND, KEY)?.state).toBe('narrowed');
    expect(pending(EARNED_ROOM_NOTICE_TYPE)[0]?.description).toBe(
      'Dina is back to your own automatic limit for offers on the rent for slot-3: INR 2400.00. ' +
        'You declined a deal inside the room Dina had earned.',
    );
  });

  it('TE-03: a lapse is recorded as one; a figure behind a premium maps to its policy figure', async () => {
    const { store, listing, uri } = setUpStore();
    installLimitPort(shelfLimitPort(store.engine));
    const brand = fleet.add(brandDid(1));
    const requestId = ask(brand, listing, uri);
    fleet.pump();
    const floorCard = must(card(store, TERM_FLOOR_CARD, requestId));
    store.engine.lapseCard(floorCard.cardId);
    await tick();
    const stamp = (floorCard.payload.asked_stamp as { fee: string }).fee;
    expect(room.latestCards(SHELF_HOST_KIND, KEY, 0, stamp, 5)).toEqual([
      { figure: 210000n, answer: 'lapsed', decidedAt: fleet.nowMs },
    ]);
    // Two juice brands held at 15% each: 210000 asked is a policy figure of 161538.
    const base = floorBase('fee', 210000n, 2, 1500);
    expect(applyHoldingPremium('fee', base, 2, 1500) <= 210000n).toBe(true);
    expect(applyHoldingPremium('fee', base + 1n, 2, 1500) > 210000n).toBe(true);
    expect(floorBase('fee', 210000n, 0, 1500)).toBe(210000n);
  });
});
