/**
 * COMMITMENT_KERNEL §10 "Earned room", §15 step 13 — the kernel's counting.
 *
 *   ER-01  five yeses in a row within 90 days, in the limit's generation, with
 *          no broken promise in the kind, raise one offer in Core's words;
 *          four, a no or a lapse among them, an old one, a broken promise
 *          (even one before the last no), no way to check promises, or a
 *          figure that would not widen the room raise none;
 *   ER-02  an owner change to the limit (or its basis, even back again) starts
 *          the record again;
 *   ER-03  the owner's yes writes the furthest figure; a stale yes (the basis
 *          changed, a promise broken since) widens nothing; a no is kept and
 *          the next offer needs five more yeses; an offer whose card closed
 *          unanswered stops blocking the next;
 *   ER-04  a declined deal in the room or a broken promise puts the owner's
 *          figure back with a notice, and withdraws an open offer; a limit
 *          the owner changed since stays; one that cannot be read keeps its
 *          record for later;
 *   ER-05  crashes: a yes left queued, an offer card whose row was never
 *          written, and a yes with no port yet are all finished at boot; a
 *          broken promise a crash kept from narrowing is caught at install;
 *   ER-06  Core mints both cards, Brain reads no figure, and the offer needs
 *          a person present;
 *   ER-07  a broken shipper run takes back the seller's room in the same
 *          write as the record, and stops earning in the kind.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  EARNED_ROOM_NOTICE_TYPE,
  EARNED_ROOM_OFFER_TYPE,
  EarnedRoomStore,
  cancelWithdrawnOffers,
  installBrokenPromiseCheck,
  installEarnedRoomStore,
  installLimitPort,
  insideEarnedRoom,
  limitStamp,
  makeEarnedRoomDecisionHandler,
  narrowRoom,
  ownerChangedLimits,
  reconcileEarnedRoomAtBoot,
  recordLimitCard,
  uninstallLimitPort,
  type LimitNow,
  type LimitPort,
} from '../../src/commitment/earned_room';
import { EvidenceStore } from '../../src/commitment/evidence';
import {
  evidenceKind,
  installEvidenceStore,
  narrowForBroken,
} from '../../src/commitment/evidence_handler';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import {
  CORE_MINTED_PAYLOAD_TYPES,
  PRESENCE_GATED_PAYLOAD_TYPES,
  registerWorkflowRoutes,
} from '../../src/server/routes/workflow';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { WorkflowTaskState } from '../../src/workflow/domain';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { setWorkflowService, WorkflowService } from '../../src/workflow/service';

const KIND = 'test.kind';
const KEY = 'slot-a|fee';
const DAY = 24 * 3600_000;
const T0 = Date.parse('2026-10-01T00:00:00Z');

let dir: string;
let db: NodeSQLiteAdapter;
let store: EarnedRoomStore;
let repo: InMemoryWorkflowRepository;
let workflow: WorkflowService;
let limit: { hard: bigint; auto: bigint; currency: string } | null;
let unreadable: boolean;
let writes: bigint[];
let broken: boolean;
let now: number;

const basisOf = (l: NonNullable<typeof limit>) =>
  `${l.hard.toString(10)}|${l.auto.toString(10)}|${l.currency}`;

const port: LimitPort = {
  kind: KIND,
  read: (): LimitNow | null => {
    if (unreadable) throw new Error('unreadable');
    return limit === null ? null : { hard: limit.hard, auto: limit.auto, basis: basisOf(limit) };
  },
  writeAuto: (_key, value) => {
    if (limit === null || unreadable) return false;
    limit = { ...limit, auto: value };
    writes.push(value);
    return true;
  },
  describe: () => 'offers on the rent for slot-a',
  format: (_key, value) => `₹${value.toString(10)}`,
};

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('test: missing value');
  return value;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-earned-'));
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new EarnedRoomStore(db);
  installEarnedRoomStore(store);
  repo = new InMemoryWorkflowRepository();
  workflow = new WorkflowService({
    repository: repo,
    approvalDecisionHandler: makeEarnedRoomDecisionHandler({
      store: () => store,
      workflow: () => workflow,
      nowMs: () => now,
    }),
  });
  setWorkflowService(workflow);
  limit = { hard: 700n, auto: 1000n, currency: 'INR' };
  unreadable = false;
  writes = [];
  broken = false;
  now = T0;
  installBrokenPromiseCheck(() => broken);
  installLimitPort(port, now);
});

afterEach(() => {
  uninstallLimitPort(KIND);
  installBrokenPromiseCheck(null);
  installEarnedRoomStore(null);
  setWorkflowService(null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let cardNo = 0;
/** A card past the limit answered now, in the generation the limit has now. */
const answer = (figure: bigint, a: 'yes' | 'no' | 'lapsed' = 'yes') => {
  cardNo += 1;
  recordLimitCard(
    {
      kind: KIND,
      limitKey: KEY,
      cardId: `floor-${String(cardNo)}`,
      figure,
      stamp: limitStamp(KIND, KEY) ?? '',
      answer: a,
    },
    now,
  );
};
const openOffers = () =>
  workflow
    .store()
    .getByCorrelationId(EARNED_ROOM_OFFER_TYPE)
    .filter((t) => t.status === WorkflowTaskState.PendingApproval);
const notices = () => workflow.store().getByCorrelationId(EARNED_ROOM_NOTICE_TYPE);
const yeses = (figures: bigint[] = [950n, 900n, 850n, 920n, 980n]) => {
  for (const f of figures) {
    now += DAY;
    answer(f);
  }
};
/** Each check starts after a no, so earlier yeses do not join its run. */
const reset = () => {
  now += DAY;
  answer(870n, 'no');
};
const earn = () => {
  yeses();
  workflow.approve(must(openOffers()[0]).id);
};

describe('earned room (§15 step 13)', () => {
  it('ER-01: five yeses in a row earn one offer, in Core’s words', () => {
    yeses([950n, 900n, 850n, 920n]);
    expect(openOffers()).toEqual([]);
    now += DAY;
    answer(980n);
    const [card] = openOffers();
    expect(card?.description).toBe(
      'You said yes to the last 5 offers on the rent for slot-a below your automatic limit, the lowest at ₹850. ' +
        'Let Dina agree down to ₹850 alone? Your own limit, ₹1000, comes back if you decline a deal in the ' +
        'wider room or a promise in these deals is broken.',
    );
    expect(JSON.parse(card?.payload ?? '{}')).toMatchObject({
      type: EARNED_ROOM_OFFER_TYPE,
      figure: '850',
      owner_figure: '1000',
    });
    // One offer at a time.
    now += DAY;
    answer(860n);
    expect(openOffers()).toHaveLength(1);
  });

  it('ER-01b: a no or a lapse among the five, an old yes, a broken promise, nothing to check, or no widening earn nothing', () => {
    yeses([950n, 900n]);
    reset();
    yeses([950n, 900n, 850n, 920n]);
    expect(openOffers()).toEqual([]);
    now += DAY;
    answer(870n, 'lapsed');
    yeses([950n, 900n, 850n, 920n]);
    expect(openOffers()).toEqual([]);
    // The fifth yes 91 days after the first.
    reset();
    yeses([950n, 900n, 850n, 920n]);
    now += 88 * DAY;
    answer(980n);
    expect(openOffers()).toEqual([]);
    reset();
    broken = true;
    yeses();
    expect(openOffers()).toEqual([]);
    broken = false;
    reset();
    installBrokenPromiseCheck(null);
    yeses();
    expect(openOffers()).toEqual([]);
    installBrokenPromiseCheck(() => false);
    reset();
    limit = { hard: 700n, auto: 800n, currency: 'INR' };
    yeses();
    expect(openOffers()).toEqual([]);
  });

  it('ER-01c: a promise broken before the last no, inside 90 days, still blocks the next offer', () => {
    const evidence = new EvidenceStore(db);
    installBrokenPromiseCheck((_kind, since) => evidence.brokenSince(since).length > 0);
    yeses([950n]);
    evidence.record({
      counterpartyDid: 'did:plc:other',
      dealRef: 'deal-1',
      subject: 'promise',
      item: 'stock_run',
      occurrence: 'whole',
      outcome: 'broken',
      fault: 'counterparty',
      source: 'owner',
      note: '',
      facts: {},
      recordedAt: now,
    });
    reset();
    yeses();
    expect(openOffers()).toEqual([]);
    // Past the window, the record no longer blocks.
    now += 90 * DAY;
    reset();
    yeses();
    expect(openOffers()).toHaveLength(1);
  });

  it('ER-02: an owner change to the limit before the fifth yes starts the record again', () => {
    yeses([950n, 900n, 850n, 920n]);
    limit = { hard: 700n, auto: 990n, currency: 'INR' };
    // The fifth yes falls under the new basis: it is the first of a new run.
    now += DAY;
    answer(980n);
    expect(openOffers()).toEqual([]);
    yeses([950n, 900n, 850n]);
    expect(openOffers()).toEqual([]);
    now += DAY;
    answer(940n);
    expect(openOffers()).toHaveLength(1);
    // A changed currency is a new generation too.
    const inr = limitStamp(KIND, KEY);
    limit = { hard: 700n, auto: 990n, currency: 'USD' };
    expect(limitStamp(KIND, KEY)).not.toBe(inr);
  });

  it('ER-02b: an owner who changes a limit and changes it back starts the record again', () => {
    yeses([950n, 900n, 850n, 920n]);
    // A→B→A between cards: Core looks at each of the owner's saves.
    limit = { hard: 700n, auto: 990n, currency: 'INR' };
    ownerChangedLimits(KIND);
    limit = { hard: 700n, auto: 1000n, currency: 'INR' };
    ownerChangedLimits(KIND);
    now += DAY;
    answer(980n);
    expect(openOffers()).toEqual([]);
  });

  it('ER-02d: a limit removed and made again with the same figures starts a fresh record', () => {
    yeses([950n, 900n, 850n, 920n]);
    const saved = limit;
    limit = null;
    ownerChangedLimits(KIND);
    limit = saved;
    ownerChangedLimits(KIND);
    now += DAY;
    answer(980n);
    expect(openOffers()).toEqual([]);
    // While an offer waits, and after room is earned, the same holds.
    yeses([950n, 900n, 850n, 920n]);
    const offer = must(openOffers()[0]);
    limit = null;
    ownerChangedLimits(KIND);
    limit = saved;
    ownerChangedLimits(KIND);
    workflow.approve(offer.id);
    expect(writes).toEqual([]);
    reset();
    earn();
    expect(limit?.auto).toBe(850n);
    const earned = limit;
    limit = null;
    ownerChangedLimits(KIND);
    limit = earned;
    ownerChangedLimits(KIND);
    expect(narrowRoom(KIND, KEY, 'declined', now)).toBe(0);
    expect(limit?.auto).toBe(850n);
  });

  it('ER-02c: a save that leaves the limit as it stands keeps its record and its earned room', () => {
    yeses([950n, 900n, 850n, 920n]);
    ownerChangedLimits(KIND);
    now += DAY;
    answer(980n);
    workflow.approve(must(openOffers()[0]).id);
    expect(limit?.auto).toBe(850n);
    // An edit elsewhere in the policy: the earned limit still narrows back.
    ownerChangedLimits(KIND);
    expect(narrowRoom(KIND, KEY, 'declined', now)).toBe(1);
    expect(limit?.auto).toBe(1000n);
  });

  it('ER-03: the yes widens to the furthest figure; a stale yes widens nothing', () => {
    earn();
    expect(limit?.auto).toBe(850n);
    expect(store.room(KIND, KEY)).toMatchObject({
      state: 'earned',
      ownerFigure: 1000n,
      figure: 850n,
    });
    expect(insideEarnedRoom(KIND, KEY, 900n)).toBe(true);
    expect(insideEarnedRoom(KIND, KEY, 1000n)).toBe(false);
    expect(insideEarnedRoom(KIND, KEY, 800n)).toBe(false);
    // The owner sets their own figure: the next offer is judged afresh.
    limit = { hard: 700n, auto: 1000n, currency: 'INR' };
    now += DAY;
    answer(900n);
    expect(store.room(KIND, KEY)?.state).toBe('narrowed');
    yeses();
    const second = must(openOffers()[0]);
    // The basis changes while the offer waits: the yes widens nothing.
    limit = { hard: 700n, auto: 990n, currency: 'INR' };
    workflow.approve(second.id);
    expect(limit.auto).toBe(990n);
    expect(store.room(KIND, KEY)?.state).toBe('declined');
    expect(workflow.store().getById(second.id)?.status).toBe(WorkflowTaskState.Completed);
  });

  it('ER-03b: a promise broken while the offer waits withdraws it, and a late yes widens nothing', () => {
    yeses();
    const offer = must(openOffers()[0]);
    broken = true;
    narrowRoom(KIND, null, 'broken', now);
    expect(store.room(KIND, KEY)?.state).toBe('declined');
    // Withdrawn: once the withdrawing write commits, its card is cancelled,
    // so no yes can reach it.
    expect(cancelWithdrawnOffers()).toBe(1);
    expect(workflow.store().getById(offer.id)?.status).toBe(WorkflowTaskState.Cancelled);
    expect(() => workflow.approve(offer.id)).toThrow();
    expect(writes).toEqual([]);
  });

  it('ER-03c: a no is kept, and the next offer needs five more yeses; a card that closed unanswered stops blocking', () => {
    yeses();
    workflow.cancel(must(openOffers()[0]).id, 'owner said no');
    expect(store.room(KIND, KEY)?.state).toBe('declined');
    yeses([950n, 900n, 850n, 920n]);
    expect(openOffers()).toEqual([]);
    now += DAY;
    answer(980n);
    const second = must(openOffers()[0]);
    // The card fails without the handler seeing it.
    repo.transition(second.id, WorkflowTaskState.PendingApproval, WorkflowTaskState.Failed, now);
    reset();
    yeses();
    expect(openOffers()).toHaveLength(1);
  });

  it('ER-04: a declined deal in the room or a broken promise puts the owner’s figure back, with a notice', () => {
    earn();
    now += DAY;
    expect(narrowRoom(KIND, KEY, 'declined', now)).toBe(1);
    expect(limit?.auto).toBe(1000n);
    expect(store.room(KIND, KEY)?.state).toBe('narrowed');
    expect(notices()[0]?.description).toBe(
      'Dina is back to your own automatic limit for offers on the rent for slot-a: ₹1000. ' +
        'You declined a deal inside the room Dina had earned.',
    );
    // Earned again, then the owner sets their own figure: a narrowing leaves it.
    earn();
    expect(limit?.auto).toBe(850n);
    limit = { hard: 700n, auto: 900n, currency: 'INR' };
    expect(narrowRoom(KIND, null, 'broken', now)).toBe(0);
    expect(limit.auto).toBe(900n);
    expect(store.room(KIND, KEY)?.state).toBe('narrowed');
  });

  it('ER-04b: a limit that cannot be read keeps its record and the owner’s figure until it can', () => {
    earn();
    unreadable = true;
    expect(narrowRoom(KIND, KEY, 'broken', now)).toBe(0);
    expect(store.room(KIND, KEY)).toMatchObject({ state: 'earned', ownerFigure: 1000n });
    now += DAY;
    answer(900n);
    expect(store.room(KIND, KEY)?.state).toBe('earned');
    unreadable = false;
    expect(narrowRoom(KIND, KEY, 'broken', now)).toBe(1);
    expect(limit?.auto).toBe(1000n);
  });

  it('ER-05: a yes left queued, a card whose row was never written, and a yes with no port are finished at boot', () => {
    yeses();
    const first = must(openOffers()[0]);
    repo.transition(first.id, WorkflowTaskState.PendingApproval, WorkflowTaskState.Queued, now);
    reconcileEarnedRoomAtBoot(now);
    expect(limit?.auto).toBe(850n);
    // The offer card written, its row lost: the owner's yes still applies, once.
    limit = { hard: 700n, auto: 1000n, currency: 'INR' };
    store.putRoom({ ...must(store.room(KIND, KEY)), state: 'narrowed', since: now });
    yeses();
    const second = must(openOffers()[0]);
    db.execute(`DELETE FROM commitment_earned_room`);
    workflow.approve(second.id);
    expect(limit.auto).toBe(850n);
    expect(store.room(KIND, KEY)?.state).toBe('earned');
    // No port when the yes lands: the card stays running, and boot settles it.
    limit = { hard: 700n, auto: 1000n, currency: 'INR' };
    store.putRoom({ ...must(store.room(KIND, KEY)), state: 'narrowed', since: now });
    yeses();
    const third = must(openOffers()[0]);
    uninstallLimitPort(KIND);
    workflow.approve(third.id);
    expect(workflow.store().getById(third.id)?.status).toBe(WorkflowTaskState.Running);
    expect(limit.auto).toBe(1000n);
    installLimitPort(port, now);
    reconcileEarnedRoomAtBoot(now);
    expect(limit.auto).toBe(850n);
    expect(workflow.store().getById(third.id)?.status).toBe(WorkflowTaskState.Completed);
  });

  it('ER-05b: a narrowing made before the workflow is up raises its notice at boot', () => {
    earn();
    uninstallLimitPort(KIND);
    broken = true;
    setWorkflowService(null);
    installLimitPort(port, now + DAY);
    expect(limit?.auto).toBe(1000n);
    expect(store.room(KIND, KEY)?.noticePending).toBe('broken');
    setWorkflowService(workflow);
    expect(notices()).toHaveLength(0);
    reconcileEarnedRoomAtBoot(now + DAY);
    expect(notices()).toHaveLength(1);
    expect(store.room(KIND, KEY)?.noticePending).toBe('');
  });

  it('ER-05c: a widening that landed before a crash kept its card open is reported as widened', () => {
    yeses();
    const card = must(openOffers()[0]);
    // The yes landed and was applied; the card never completed.
    repo.transition(card.id, WorkflowTaskState.PendingApproval, WorkflowTaskState.Queued, now);
    repo.transition(card.id, WorkflowTaskState.Queued, WorkflowTaskState.Running, now);
    limit = { hard: 700n, auto: 850n, currency: 'INR' };
    store.putRoom({ ...must(store.room(KIND, KEY)), state: 'earned', since: now - 1 });
    reconcileEarnedRoomAtBoot(now);
    expect(JSON.parse(String(workflow.store().getById(card.id)?.result ?? '{}'))).toEqual({
      widened: true,
    });
    expect(store.room(KIND, KEY)?.since).toBe(now - 1);
  });

  it('ER-05d: a note edit on a record already broken narrows nothing and moves no window', () => {
    const evidence = new EvidenceStore(db);
    const e = evidence.record({
      counterpartyDid: 'did:plc:other',
      dealRef: 'deal-1',
      subject: 'promise',
      item: 'stock_run',
      occurrence: 'whole',
      outcome: 'broken',
      fault: 'counterparty',
      source: 'owner',
      note: '',
      facts: {},
      recordedAt: T0,
    });
    evidence.amend(e.evidenceId, { outcome: 'broken', note: 'still late' }, T0 + 100 * DAY);
    expect(evidence.brokenSince(T0 + DAY)).toEqual([]);
    evidence.amend(e.evidenceId, { outcome: 'kept', note: '' }, T0 + 101 * DAY);
    evidence.amend(e.evidenceId, { outcome: 'broken', note: '' }, T0 + 102 * DAY);
    expect(evidence.brokenSince(T0 + 101 * DAY)).toHaveLength(1);
  });

  it('ER-06: Core mints both cards, Brain reads no figure, and the offer needs a person present', async () => {
    expect(CORE_MINTED_PAYLOAD_TYPES.has(EARNED_ROOM_OFFER_TYPE)).toBe(true);
    expect(CORE_MINTED_PAYLOAD_TYPES.has(EARNED_ROOM_NOTICE_TYPE)).toBe(true);
    expect(PRESENCE_GATED_PAYLOAD_TYPES.has(EARNED_ROOM_OFFER_TYPE)).toBe(true);
    expect(PRESENCE_GATED_PAYLOAD_TYPES.has(EARNED_ROOM_NOTICE_TYPE)).toBe(false);
    yeses();
    const id = must(openOffers()[0]).id;
    const router = new CoreRouter();
    registerWorkflowRoutes(router);
    const asBrain = await router.handle({
      method: 'GET',
      path: `/v1/workflow/tasks/${id}`,
      query: {},
      headers: {},
      body: undefined,
      rawBody: new Uint8Array(),
      params: { id },
      trustedInProcess: true,
      callerType: 'brain',
      callerDID: 'did:key:brain',
    } as unknown as CoreRequest);
    const task = (asBrain.body as { task: Record<string, unknown> }).task;
    expect(task.payload).toBe(
      JSON.stringify({ type: EARNED_ROOM_OFFER_TYPE, redacted: 'owner_only' }),
    );
    expect(task.description).toBe('A card about the owner’s automatic limits');
    expect(JSON.stringify(task)).not.toContain('slot-a');
    expect(JSON.stringify(task)).not.toContain('₹');
  });

  it('ER-07: a broken shipper run takes back the seller’s room in the same write, and stops earning', () => {
    expect(evidenceKind('run', 'link-1')).toBe('goods.seller');
    const sellerPort: LimitPort = { ...port, kind: 'goods.seller' };
    installLimitPort(sellerPort, now);
    installEvidenceStore(db);
    try {
      limit = { hard: 700n, auto: 850n, currency: 'INR' };
      store.putRoom({
        kind: 'goods.seller',
        limitKey: KEY,
        state: 'earned',
        ownerFigure: 1000n,
        figure: 850n,
        stamp: limitStamp('goods.seller', KEY) ?? '',
        cardId: 'x',
        since: now,
        noticePending: '',
      });
      now += DAY;
      const evidence = new EvidenceStore(db);
      evidence.atomically(() => {
        evidence.record({
          counterpartyDid: 'did:plc:shipper',
          dealRef: 'link-1',
          subject: 'run',
          item: 'run',
          occurrence: 'whole',
          outcome: 'broken',
          fault: 'counterparty',
          source: 'owner',
          note: '',
          facts: {},
          recordedAt: now,
        });
        narrowForBroken('run', 'link-1', now);
      });
      expect(limit.auto).toBe(1000n);
      expect(store.room('goods.seller', KEY)?.state).toBe('narrowed');
      // With it on record, no room is earned in the kind for 90 days.
      for (let i = 0; i < 5; i += 1) {
        now += DAY;
        cardNo += 1;
        recordLimitCard(
          {
            kind: 'goods.seller',
            limitKey: KEY,
            cardId: `p-${String(cardNo)}`,
            figure: 850n,
            stamp: limitStamp('goods.seller', KEY) ?? '',
            answer: 'yes',
          },
          now,
        );
      }
      expect(openOffers()).toEqual([]);
    } finally {
      installEvidenceStore(null);
      installBrokenPromiseCheck(() => broken);
      uninstallLimitPort('goods.seller');
    }
  });

  it('ER-08: migration 81 counts a record amended to broken from its amendment', () => {
    const old = path.join(dir, 'old.sqlite');
    const legacy = new NodeSQLiteAdapter({
      path: old,
      passphraseHex: randomBytes(32).toString('hex'),
    });
    try {
      applyMigrations(
        legacy,
        IDENTITY_MIGRATIONS.filter((m) => m.version <= 80),
      );
      legacy.execute(
        `INSERT INTO commitment_evidence
           (evidence_id, counterparty_did, deal_ref, subject, item, occurrence, outcome, fault,
            source, note, facts_json, recorded_at, amended_at)
         VALUES ('e1', 'did:plc:x', 'deal-1', 'promise', 'stock_run', 'whole', 'broken',
                 'counterparty', 'owner', '', '{}', ?, ?)`,
        [T0 - 100 * DAY, T0 - DAY],
      );
      applyMigrations(legacy, IDENTITY_MIGRATIONS);
      expect(new EvidenceStore(legacy).brokenSince(T0 - 90 * DAY)).toHaveLength(1);
    } finally {
      legacy.close();
    }
  });
});
