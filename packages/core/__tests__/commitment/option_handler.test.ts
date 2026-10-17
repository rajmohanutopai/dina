/**
 * COMMITMENT_KERNEL §6, §15 step 7 — the `commitment.option` family wired to
 * a node: two nodes in one process, each with its own database, joined by a
 * D2D sender that delivers to the other's handler.
 *
 *   H-01  a known shipper is a contact, not blocked, preferred for shipping;
 *   H-02  ask → option → take up → receipt, end to end through the handlers;
 *         the shipper's run is priced from its own model;
 *   H-03  a receipt from anyone but the shipper, a malformed body, an option
 *         for a request never made: refused, nothing changes;
 *   H-04  the seller's tick resends a lost acceptance; once answered, it sends
 *         nothing more.
 *
 * §15 step 11 — Brain picks the shipper's fee:
 *   H-10  the request waits for Brain, whose brief holds the day and crates,
 *         never the asking fee or the limits; Brain's fee goes out at once,
 *         one verdict charged, and a resend gets the same option;
 *   H-11  a fee over the asking fee goes at the asking fee, one under the
 *         automatic limit at the limit;
 *   H-12  no answer by the seller's resend: the asking fee goes;
 *   H-13  the owner on the fixed style: the asking fee at once, Brain not asked.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { installValueModelStore, ValueModelStore } from '../../src/commitment/model_store';
import {
  fallbackApplied,
  getOrderFallbackStore,
  getSellerOptionStore,
  handleOptionMessage,
  commitShipperFeeMove,
  shipperTurnId,
  installExitRightPort,
  installFallbackNoticeCheck,
  installOptionStores,
  knownShippers,
  openSmallerDeals,
  optionWorkflowHooks,
  runOptionLinkTick,
  setShipperFeeSubmitter,
  SHIPPER_FEE_WAIT_MS,
} from '../../src/commitment/option_handler';
import { installStrategyStore, StrategyStore } from '../../src/commitment/strategy_store';
import {
  addContact,
  resetContactDirectory,
  setPreferredFor,
  updateContact,
} from '../../src/contacts/directory';
import { setContactRepository, SQLiteContactRepository } from '../../src/contacts/repository';
import {
  clearSharingPolicies,
  installSharingPolicyStore,
  setSharingPolicy,
} from '../../src/gatekeeper/sharing';
import { setPeopleRepository, SQLitePeopleRepository } from '../../src/people/repository';
import { setD2DSender } from '../../src/server/routes/d2d_msg';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { WorkflowTaskState } from '../../src/workflow/domain';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

import type { NegotiationBrief } from '../../src/commitment/strategy_submit';

const SELLER = 'did:plc:seller';
const SHIPPER = 'did:plc:shipper';
const BUYER = 'did:plc:buyer';
const NOW = Date.parse('2026-11-02T09:00:00Z');
const RUN_AT = '2026-11-10T09:00:00Z'; // a Tuesday

interface Node {
  did: string;
  db: NodeSQLiteAdapter;
  models: ValueModelStore;
}

let dir: string;
let seller: Node;
let shipper: Node;
let wire: { from: string; to: string; body: Record<string, unknown> }[];
let current: Node;
let workflow: WorkflowService;
let repo: InMemoryWorkflowRepository;

function openNode(did: string): Node {
  const db = new NodeSQLiteAdapter({
    path: path.join(dir, `${did.split(':')[2] ?? 'x'}.sqlite`),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  return { did, db, models: new ValueModelStore(db) };
}

/** Act as one node: its stores are the ones the handler sees. */
function as(node: Node): void {
  current = node;
  installOptionStores(node.db);
  installValueModelStore(node.models);
}

/** Deliver everything on the wire, in order, to its recipient's handler. */
async function deliver(
  nowMs: number,
  lose: (m: (typeof wire)[number]) => boolean = () => false,
): Promise<void> {
  while (wire.length > 0) {
    const m = wire.shift();
    if (m === undefined || lose(m)) continue;
    as(m.to === SELLER ? seller : shipper);
    await handleOptionMessage(m.from, JSON.parse(JSON.stringify(m.body)), nowMs);
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-option-handler-'));
  seller = openNode(SELLER);
  shipper = openNode(SHIPPER);
  wire = [];
  setD2DSender(async (to, type, body) => {
    expect(type).toBe('commitment.option');
    wire.push({ from: current.did, to, body });
  });
  // The seller's own contacts, on its own database.
  setPeopleRepository(new SQLitePeopleRepository(seller.db));
  setContactRepository(new SQLiteContactRepository(seller.db));
  resetContactDirectory();
  addContact(SHIPPER, 'Ravi Transport');
  setPreferredFor(SHIPPER, ['shipper']);
  // The owner lets pincodes, and nothing finer, go to this shipper (§11).
  installSharingPolicyStore(seller.db);
  setSharingPolicy(SHIPPER, 'location', 'pincode_only');
  repo = new InMemoryWorkflowRepository();
  workflow = new WorkflowService({
    repository: repo,
    nowMsFn: () => NOW,
    ...optionWorkflowHooks({ nowMs: () => NOW }),
  });
  setWorkflowService(workflow);
  // The shipper's runs: Tuesday has one; a run carries 10 crates; the owner
  // asks ₹300 a run.
  const form = { limits: {}, totals: {}, asking: { fee: '30000' }, binding: 'card' as const };
  shipper.models.setForm('delivery.shipper', form, NOW);
  shipper.models.putEntry(
    {
      id: 'tue',
      kind: 'delivery.shipper',
      covers: ['delivery_day'],
      body: { type: 'choice', part: 'delivery_day', option: 'tue', rupees: -300n },
    },
    NOW,
  );
  shipper.models.putEntry(
    {
      id: 'room',
      kind: 'delivery.shipper',
      covers: ['run'],
      body: { type: 'capacity', part: 'run', dimension: 'crates', amount: 10n },
    },
    NOW,
  );
});

afterEach(() => {
  setWorkflowService(null);
  installFallbackNoticeCheck(null);
  clearSharingPolicies();
  installSharingPolicyStore(null);
  setD2DSender(null);
  installOptionStores(null);
  installValueModelStore(null);
  resetContactDirectory();
  setContactRepository(null);
  setPeopleRepository(null);
  seller.db.close();
  shipper.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function askAndHold(): Promise<void> {
  as(seller);
  const asked = await openSmallerDeals({
    dealRef: 'q-1',
    grant: { fields: ['postal_code'], recipientRole: 'shipper' },
    postalCode: '560001',
    serviceAt: RUN_AT,
    crates: 2,
    nowMs: NOW,
  });
  expect(asked).toBe('asked');
  await deliver(NOW);
  as(seller);
}

/** Ask, hold, and the seller's owner says yes on the clearance card. */
async function askHoldAndClear(): Promise<string> {
  await askAndHold();
  const [link] = getSellerOptionStore()?.forDeal('q-1') ?? [];
  const card = workflow.store().getById(`option-clear-${link?.requestId ?? ''}`);
  expect(card?.status).toBe('pending_approval');
  workflow.approve(card?.id ?? '');
  expect(getSellerOptionStore()?.get(link?.requestId ?? '')?.clearedAt).toBe(NOW);
  expect(workflow.store().getById(card?.id ?? '')?.status).toBe('completed');
  return link?.requestId ?? '';
}

const ORDER = 'did:plc:buyer po-1';

describe('the option family on two nodes', () => {
  it('H-01: known shippers', () => {
    expect(knownShippers()).toEqual([SHIPPER]);
    updateContact(SHIPPER, { trustLevel: 'blocked' });
    expect(knownShippers()).toEqual([]);
  });

  it('H-02: ask, option, clear, take up, receipt', async () => {
    await askHoldAndClear();
    const [link] = getSellerOptionStore()?.forDeal('q-1') ?? [];
    expect(link).toMatchObject({ state: 'held', shipperDid: SHIPPER });
    expect(link?.option).toMatchObject({ fee_minor: '30000', crates: 2 });
    // The buyer's yes: taken up, then the tick tells the shipper.
    expect(getSellerOptionStore()?.takeUp(link?.requestId ?? '', ORDER, NOW + 3600_000)).toBe(true);
    expect(await runOptionLinkTick(NOW + 3600_000)).toBe(1);
    await deliver(NOW + 3600_000);
    as(seller);
    expect(getSellerOptionStore()?.get(link?.requestId ?? '')?.state).toBe('bound');
    // Answered: the tick sends nothing more.
    expect(await runOptionLinkTick(NOW + 3 * 3600_000)).toBe(0);
  });

  it('H-03: refused bodies change nothing', async () => {
    await askHoldAndClear();
    const [link] = getSellerOptionStore()?.forDeal('q-1') ?? [];
    getSellerOptionStore()?.takeUp(link?.requestId ?? '', ORDER, NOW + 3600_000);
    const receipt = {
      v: 1,
      kind: 'receipt',
      option_id: link?.option?.option_id,
      answer: 'admitted',
      at: '2026-11-02T10:00:00.000Z',
    };
    expect(await handleOptionMessage('did:plc:other', receipt, NOW)).toBe('refused');
    expect(await handleOptionMessage(SHIPPER, { v: 1, kind: 'receipt' }, NOW)).toBe('refused');
    expect(
      await handleOptionMessage(SHIPPER, { ...link?.option, request_id: 'req-neverasked' }, NOW),
    ).toBe('refused');
    expect(getSellerOptionStore()?.get(link?.requestId ?? '')?.state).toBe('accepted');
  });

  it('H-04: a lost acceptance is sent again', async () => {
    await askHoldAndClear();
    const [link] = getSellerOptionStore()?.forDeal('q-1') ?? [];
    getSellerOptionStore()?.takeUp(link?.requestId ?? '', ORDER, NOW + 3600_000);
    await runOptionLinkTick(NOW + 3600_000);
    await deliver(NOW + 3600_000, () => true); // lost
    as(seller);
    expect(getSellerOptionStore()?.get(link?.requestId ?? '')?.state).toBe('accepted');
    expect(await runOptionLinkTick(NOW + 2 * 3600_000)).toBe(1);
    await deliver(NOW + 2 * 3600_000);
    as(seller);
    expect(getSellerOptionStore()?.get(link?.requestId ?? '')?.state).toBe('bound');
  });

  it('H-05: a firm kind needs no card; a shipper the rules keep pincodes from is not asked', async () => {
    seller.models.setForm(
      'goods.seller',
      { limits: {}, totals: {}, asking: {}, binding: 'firm' },
      NOW,
    );
    await askAndHold();
    const [link] = getSellerOptionStore()?.forDeal('q-1') ?? [];
    expect(link?.clearedAt).toBe(NOW);
    expect(workflow.store().getById(`option-clear-${link?.requestId ?? ''}`)).toBeNull();
    // Pincodes kept from the shipper: nothing goes to them, and the owner gets a card.
    setSharingPolicy(SHIPPER, 'location', 'eta_only');
    as(seller);
    const asked = await openSmallerDeals({
      dealRef: 'q-2',
      grant: { fields: ['postal_code'], recipientRole: 'shipper' },
      postalCode: '560001',
      serviceAt: RUN_AT,
      crates: 1,
      nowMs: NOW,
    });
    expect(asked).toBe('no_partner');
    expect(wire).toEqual([]);
    expect(workflow.store().getById(`option-disclose-${SHIPPER}`)?.status).toBe('pending_approval');
  });

  it('H-06: a run that ends without fault: the order falls back, and the buyer keeps the same record', async () => {
    const requestId = await askHoldAndClear();
    getSellerOptionStore()?.takeUp(requestId, ORDER, NOW + 3600_000);
    const link = getSellerOptionStore()?.get(requestId);
    // Every resend lost until past the grace; then the shipper answers late.
    const graceEnd = Date.parse(link?.option?.hold_until ?? '') + 48 * 3600_000;
    await runOptionLinkTick(NOW + 3600_000);
    wire = [];
    await runOptionLinkTick(graceEnd + 3600_000); // a status query now
    // The buyer's node: the notice is checked against its own order.
    installFallbackNoticeCheck(({ supplierDid, notice }) =>
      supplierDid === SELLER && notice.purchase_order_id === 'po-1' ? { buyerDid: BUYER, exitRight: false } : null,
    );
    const buyer = openNode(BUYER);
    try {
      while (wire.length > 0) {
        const m = wire.shift();
        if (m === undefined) continue;
        if (m.to === BUYER) {
          installOptionStores(buyer.db);
          current = buyer;
          await handleOptionMessage(
            m.from,
            JSON.parse(JSON.stringify(m.body)),
            graceEnd + 3600_000,
          );
          continue;
        }
        as(m.to === SELLER ? seller : shipper);
        await handleOptionMessage(m.from, JSON.parse(JSON.stringify(m.body)), graceEnd + 3600_000);
      }
      as(seller);
      expect(getSellerOptionStore()?.get(requestId)?.state).toBe('lapsed_no_fault');
      expect(fallbackApplied(BUYER, 'po-1')).toBe(true);
      expect(getOrderFallbackStore()?.get(BUYER, 'po-1')).toMatchObject({
        role: 'seller',
        noticeSent: true,
      });
      installOptionStores(buyer.db);
      expect(getOrderFallbackStore()?.get(BUYER, 'po-1')).toMatchObject({
        role: 'buyer',
        supplierDid: SELLER,
        quoteId: 'q-1',
        alternativeId: `partner_${requestId.slice(4, 12)}`,
      });
      // A notice the buyer's check does not recognise is not kept.
      expect(
        await handleOptionMessage(
          'did:plc:other',
          {
            v: 1,
            kind: 'fallback',
            purchase_order_id: 'po-1',
            quote_id: 'q-1',
            alternative_id: 'partner_00000000',
            at: '2026-11-02T09:00:00.000Z',
          },
          NOW,
        ),
      ).toBe('refused');
    } finally {
      buyer.db.close();
    }
  });

  /**
   * §15 step 12: a run that falls through on an order holding the exit right,
   * up to the buyer's card. Returns the card, the buyer's node, and a way to
   * deliver what is on the wire.
   */
  async function toExitCard(cancelled: { buyer: string; cancellation: Record<string, unknown> }[]) {
    const cancellation = { purchase_order_id: 'po-1', cancellation_id: 'exit-1' };
    installExitRightPort({
      sellerOrderHoldsExit: (buyerDid, po) => buyerDid === BUYER && po === 'po-1',
      quoteGrantsExit: (quoteId) => quoteId === 'q-1',
      buyerCancellation: (supplierDid, po) => (supplierDid === SELLER && po === 'po-1' ? cancellation : null),
      cancelForExit: (buyerDid, c) => {
        cancelled.push({ buyer: buyerDid, cancellation: c });
        return 'cancelled';
      },
    });
    const requestId = await askHoldAndClear();
    // The seller's owner saw the right on the card that let the run bind.
    expect(workflow.store().getById(`option-clear-${requestId}`)?.description).toContain(
      'they may cancel the order without charge',
    );
    getSellerOptionStore()?.takeUp(requestId, ORDER, NOW + 3600_000);
    const link = getSellerOptionStore()?.get(requestId);
    const later = Date.parse(link?.option?.hold_until ?? '') + 48 * 3600_000 + 3600_000;
    // An exit before any fallback is refused: the right holds only once the run fell through.
    as(seller);
    expect(await handleOptionMessage(BUYER, { v: 1, kind: 'exit', cancellation }, NOW)).toBe('refused');
    await runOptionLinkTick(NOW + 3600_000);
    wire = [];
    await runOptionLinkTick(later);
    installFallbackNoticeCheck(({ supplierDid, notice }) =>
      supplierDid === SELLER && notice.purchase_order_id === 'po-1' ? { buyerDid: BUYER, exitRight: true } : null,
    );
    const buyer = openNode(BUYER);
    const deliverAll = async (): Promise<void> => {
      while (wire.length > 0) {
        const m = wire.shift();
        if (m === undefined) continue;
        if (m.to === BUYER) {
          installOptionStores(buyer.db);
          current = buyer;
        } else as(m.to === SELLER ? seller : shipper);
        await handleOptionMessage(m.from, JSON.parse(JSON.stringify(m.body)), later);
      }
    };
    await deliverAll();
    const card = workflow.store().getById(`option-exit-${SELLER}-po-1`);
    expect(card?.status).toBe('pending_approval');
    // As the buyer's node from here on.
    installOptionStores(buyer.db);
    current = buyer;
    return { card, buyer, deliverAll, cancellation, later };
  }
  const settleSends = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  it('H-06b: §15 step 12 — an order that holds the exit right: the buyer may cancel it, and the seller cancels without asking its runner', async () => {
    const cancelled: { buyer: string; cancellation: Record<string, unknown> }[] = [];
    try {
      const { card, buyer, deliverAll, cancellation } = await toExitCard(cancelled);
      try {
        expect(JSON.parse(card?.payload ?? '{}')).toMatchObject({ type: 'option_exit', supplier_did: SELLER });
        expect(workflow.store().getById(`option-fallback-${SELLER}-po-1`)).toBeNull();
        workflow.approve(card?.id ?? '');
        await settleSends();
        expect(wire.map((m) => m.body.kind)).toEqual(['exit']);
        await deliverAll();
        expect(cancelled).toEqual([{ buyer: BUYER, cancellation }]);
        expect(workflow.store().getById(card?.id ?? '')?.status).toBe('completed');
      } finally {
        buyer.db.close();
      }
    } finally {
      installExitRightPort(null);
    }
  });

  it('H-06c: an approved exit whose send fails, or whose approval a crash kept from applying, goes on the next tick', async () => {
    const cancelled: { buyer: string; cancellation: Record<string, unknown> }[] = [];
    try {
      const { card, buyer, later } = await toExitCard(cancelled);
      try {
        // The transport refuses: the yes is kept, the card says so, nothing is lost.
        setD2DSender(async () => {
          throw new Error('relay down');
        });
        workflow.approve(card?.id ?? '');
        await settleSends();
        expect(workflow.store().getById(card?.id ?? '')?.status).toBe('completed');
        expect(wire).toEqual([]);
        // The relay is back: the tick sends it, once.
        setD2DSender(async (to, type, body) => {
          wire.push({ from: current.did, to, body });
        });
        installOptionStores(buyer.db);
        current = buyer;
        await runOptionLinkTick(later + 60_000);
        expect(wire.map((m) => m.body.kind)).toEqual(['exit']);
        await runOptionLinkTick(later + 120_000);
        expect(wire).toHaveLength(1);
      } finally {
        buyer.db.close();
      }
    } finally {
      installExitRightPort(null);
    }
  });

  it('H-06d: an approval that landed without its handler is finished by the tick', async () => {
    const cancelled: { buyer: string; cancellation: Record<string, unknown> }[] = [];
    try {
      const { card, buyer, later } = await toExitCard(cancelled);
      try {
        // The yes lands, but nothing applies it (Core stopped before the hook ran).
        new WorkflowService({ repository: repo, nowMsFn: () => NOW }).approve(card?.id ?? '');
        expect(workflow.store().getById(card?.id ?? '')?.status).toBe('queued');
        expect(wire).toEqual([]);
        await runOptionLinkTick(later + 60_000);
        await settleSends();
        expect(wire.map((m) => m.body.kind)).toEqual(['exit']);
        expect(workflow.store().getById(card?.id ?? '')?.status).toBe('completed');
      } finally {
        buyer.db.close();
      }
    } finally {
      installExitRightPort(null);
    }
  });

  async function exitCrashCase(stage: 'kept' | 'running'): Promise<void> {
    const cancelled: { buyer: string; cancellation: Record<string, unknown> }[] = [];
    try {
      const { card, buyer, later, cancellation } = await toExitCard(cancelled);
      try {
        new WorkflowService({ repository: repo, nowMsFn: () => NOW }).approve(card?.id ?? '');
        // The handler kept the cancellation, then Core stopped.
        buyer.db.execute(
          `INSERT INTO commitment_exit_asks (supplier_did, purchase_order_id, cancellation_json, asked_at, sent_at)
           VALUES (?, ?, ?, ?, NULL)`,
          [SELLER, 'po-1', JSON.stringify(cancellation), later],
        );
        if (stage === 'running')
          workflow.store().transition(card?.id ?? '', WorkflowTaskState.Queued, WorkflowTaskState.Running, later);
        await runOptionLinkTick(later + 60_000);
        await settleSends();
        expect(workflow.store().getById(card?.id ?? '')?.status).toBe('completed');
        expect(wire.map((m) => m.body.kind)).toEqual(['exit']);
      } finally {
        buyer.db.close();
      }
    } finally {
      installExitRightPort(null);
    }
  }

  it('H-06e: a crash after the cancellation was kept: the tick finishes the card and sends once', () =>
    exitCrashCase('kept'));

  it('H-06f: a crash after the card started running: the tick finishes it and sends once', () =>
    exitCrashCase('running'));

  it('H-07: a crash between two writes is repaired by the tick', async () => {
    await askAndHold();
    const [link] = getSellerOptionStore()?.forDeal('q-1') ?? [];
    const cardId = `option-clear-${link?.requestId ?? ''}`;
    // A second option held as a crash would leave it: stored, its card never made.
    as(seller);
    const store = getSellerOptionStore();
    const request = { ...(link?.request ?? ({} as never)), request_id: 'req-99887766554433aa' };
    store?.ask(
      { requestId: request.request_id, shipperDid: SHIPPER, dealRef: 'q-1', request },
      NOW,
    );
    store?.settleAsk(
      request.request_id,
      { ...(link?.option ?? ({} as never)), request_id: request.request_id },
      NOW,
    );
    expect(workflow.store().getById('option-clear-req-99887766554433aa')).toBeNull();
    await runOptionLinkTick(NOW + 60_000);
    expect(workflow.store().getById('option-clear-req-99887766554433aa')?.status).toBe(
      'pending_approval',
    );
    // A lapsed run whose fallback was never recorded.
    workflow.approve(cardId);
    getSellerOptionStore()?.takeUp(link?.requestId ?? '', ORDER, NOW + 3600_000);
    seller.db.execute(
      `UPDATE commitment_option_links SET state = 'lapsed_no_fault', answer_json = ? WHERE request_id = ?`,
      [JSON.stringify({ answer: 'arrived_after_grace', atMs: NOW }), link?.requestId ?? ''],
    );
    expect(fallbackApplied(BUYER, 'po-1')).toBe(false);
    await runOptionLinkTick(NOW + 2 * 3600_000);
    expect(fallbackApplied(BUYER, 'po-1')).toBe(true);
  });

  it('H-08: a notice the sender did not take is not counted as told', async () => {
    const requestId = await askHoldAndClear();
    getSellerOptionStore()?.takeUp(requestId, ORDER, NOW + 3600_000);
    seller.db.execute(
      `UPDATE commitment_option_links SET state = 'lapsed_no_fault', answer_json = ? WHERE request_id = ?`,
      [JSON.stringify({ answer: 'arrived_after_grace', atMs: NOW }), requestId],
    );
    setD2DSender(async () => ({
      messageId: 'm',
      delivered: false,
      buffered: false,
      queued: false,
    }));
    await runOptionLinkTick(NOW + 2 * 3600_000);
    expect(getOrderFallbackStore()?.get(BUYER, 'po-1')?.noticeSent).toBe(false);
    setD2DSender(async () => ({ messageId: 'm', delivered: false, buffered: false, queued: true }));
    await runOptionLinkTick(NOW + 3 * 3600_000);
    expect(getOrderFallbackStore()?.get(BUYER, 'po-1')?.noticeSent).toBe(true);
  });

  it('H-09: a yes on the clearance that a crash kept from applying is finished by the tick', async () => {
    await askAndHold();
    const [link] = getSellerOptionStore()?.forDeal('q-1') ?? [];
    const cardId = `option-clear-${link?.requestId ?? ''}`;
    // The approval lands, but nothing applies it (Core stopped before the hook ran).
    new WorkflowService({ repository: repo, nowMsFn: () => NOW }).approve(cardId);
    expect(workflow.store().getById(cardId)?.status).toBe('queued');
    expect(getSellerOptionStore()?.get(link?.requestId ?? '')?.clearedAt).toBeNull();
    await runOptionLinkTick(NOW + 60_000);
    expect(getSellerOptionStore()?.get(link?.requestId ?? '')?.clearedAt).toBe(NOW + 60_000);
    expect(workflow.store().getById(cardId)?.status).toBe('completed');
  });
});

describe('Brain picks the shipper’s fee (§15 step 11)', () => {
  let briefs: NegotiationBrief[];
  let strategies: StrategyStore;

  beforeEach(() => {
    briefs = [];
    strategies = new StrategyStore(shipper.db);
    installStrategyStore(strategies);
    strategies.setSettings('delivery.shipper', { strategy: 'brain', valuesOn: true }, NOW);
    shipper.models.setForm(
      'delivery.shipper',
      {
        limits: { fee: { hard: 15_000n, auto: 20_000n } },
        totals: {},
        asking: { fee: '30000' },
        binding: 'card',
      },
      NOW,
    );
    setShipperFeeSubmitter(
      (brief) => {
        briefs.push(brief);
        return { taskId: `task-${String(briefs.length)}` };
      },
      () => NOW,
    );
  });
  afterEach(() => {
    setShipperFeeSubmitter(null);
    installStrategyStore(null);
  });

  /** Let the shipper's answer, sent after Brain's move, reach the wire. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  }
  const offers = () => wire.filter((m) => m.body.kind === 'option');
  const feeMove = (requestId: string, fee: string, seller = SELLER) =>
    commitShipperFeeMove({
      input: { kind: 'delivery.shipper', ref: { negotiationId: shipperTurnId(seller, requestId), turn: 0 } },
      result: { move: { kind: 'propose', versions: [{ terms: [{ name: 'fee', value: fee }] }] } },
    });

  async function ask(): Promise<string> {
    as(seller);
    await openSmallerDeals({
      dealRef: 'q-1',
      grant: { fields: ['postal_code'], recipientRole: 'shipper' },
      postalCode: '560001',
      serviceAt: RUN_AT,
      crates: 2,
      nowMs: NOW,
    });
    const requestId = String(wire[0]?.body.request_id);
    await deliver(NOW);
    return requestId;
  }

  it('H-10: the request waits for Brain; its fee goes out at once; a resend gets the same option', async () => {
    const requestId = await ask();
    expect(wire).toEqual([]);
    const brief = briefs[0];
    expect(brief?.kind).toBe('delivery.shipper');
    expect(brief?.table).toEqual({ service_day: 'tue', crates: 2 });
    expect(JSON.stringify(brief)).not.toMatch(/30000|20000|15000|asking/);
    as(shipper);
    expect((await feeMove(requestId, '25000')).receipt).toEqual({ outcome: 'answered' });
    expect(offers().map((m) => m.body.fee_minor)).toEqual(['25000']);
    await deliver(NOW);
    // The seller's resend is answered with the same option.
    as(seller);
    await runOptionLinkTick(NOW + 2 * 3600_000);
    await deliver(NOW + 2 * 3600_000);
    as(seller);
    expect(getSellerOptionStore()?.get(requestId)?.option?.fee_minor).toBe('25000');
    expect(briefs).toHaveLength(1);
  });

  it('H-11: a fee over the asking fee goes at the asking fee', async () => {
    const requestId = await ask();
    as(shipper);
    await feeMove(requestId, '90000');
    expect(offers().map((m) => m.body.fee_minor)).toEqual(['30000']);
  });

  it('H-11b: under the automatic limit goes at the limit', async () => {
    const requestId = await ask();
    as(shipper);
    await feeMove(requestId, '100');
    expect(offers().map((m) => m.body.fee_minor)).toEqual(['20000']);
  });

  it('H-12: no answer by the seller’s resend: the asking fee goes', async () => {
    const requestId = await ask();
    expect(wire).toEqual([]);
    as(seller);
    const later = NOW + SHIPPER_FEE_WAIT_MS + 60 * 60_000;
    await runOptionLinkTick(later);
    await deliver(later);
    as(seller);
    expect(getSellerOptionStore()?.get(requestId)?.option?.fee_minor).toBe('30000');
    // Brain's late answer changes nothing.
    as(shipper);
    expect((await feeMove(requestId, '25000')).receipt).toEqual({ outcome: 'already_applied' });
  });

  it('H-13: the owner on the fixed style: the asking fee at once, Brain not asked', async () => {
    strategies.setSettings('delivery.shipper', { strategy: 'fixed', valuesOn: true }, NOW);
    await ask();
    as(seller);
    const [link] = getSellerOptionStore()?.forDeal('q-1') ?? [];
    expect(link?.option?.fee_minor).toBe('30000');
    expect(briefs).toEqual([]);
  });

  it('H-14: two sellers naming the same request id get a turn each (§15 step 11)', async () => {
    const requestId = await ask();
    as(shipper);
    const other = 'did:plc:otherseller';
    const request = {
      v: 1,
      kind: 'request',
      request_id: requestId,
      service_at: RUN_AT,
      crates: 1,
      postal_code: '560001',
    };
    await handleOptionMessage(other, request, NOW);
    expect(briefs.map((b) => b.ref.negotiationId)).toEqual([
      shipperTurnId(SELLER, requestId),
      shipperTurnId(other, requestId),
    ]);
    expect((await feeMove(requestId, '26000', other)).receipt).toEqual({ outcome: 'answered' });
    expect(wire.filter((m) => m.to === other && m.body.kind === 'option').map((m) => m.body.fee_minor)).toEqual([
      '26000',
    ]);
    // The first seller's turn is untouched.
    expect(offers().filter((m) => m.to === SELLER)).toEqual([]);
  });

  it('H-15: a run Core would decline, or one too near to wait for Brain, never asks Brain', async () => {
    // Full: the run carries 10 crates; ask for 11.
    as(shipper);
    await handleOptionMessage(
      SELLER,
      { v: 1, kind: 'request', request_id: 'req-full', service_at: RUN_AT, crates: 11, postal_code: '560001' },
      NOW,
    );
    expect(wire.map((m) => m.body)).toEqual([expect.objectContaining({ kind: 'decline', reason: 'full' })]);
    // A run whose hold would no longer fit after Brain's wait: the asking fee, at once.
    // The run is 98 h 20 min away: the hold (ending 72 h before it, at least
    // 26 h long) fits now, but not after 50 minutes.
    const late = Date.parse(RUN_AT) - (98 * 3600_000 + 20 * 60_000);
    await handleOptionMessage(
      SELLER,
      { v: 1, kind: 'request', request_id: 'req-soon', service_at: RUN_AT, crates: 1, postal_code: '560001' },
      late,
    );
    expect(briefs).toEqual([]);
    expect(wire.at(-1)?.body).toMatchObject({ kind: 'option', request_id: 'req-soon', fee_minor: '30000' });
  });

  it('H-16: a run whose hold would not fit by the seller’s next resend never waits for Brain', async () => {
    // 98 h 65 min away: 65 minutes of slack, under the hour's resend and its margin.
    const late = Date.parse(RUN_AT) - (98 * 3600_000 + 65 * 60_000);
    as(shipper);
    await handleOptionMessage(
      SELLER,
      { v: 1, kind: 'request', request_id: 'req-hour', service_at: RUN_AT, crates: 1, postal_code: '560001' },
      late,
    );
    expect(briefs).toEqual([]);
    expect(wire.at(-1)?.body).toMatchObject({ kind: 'option', fee_minor: '30000' });
  });

  it('H-17: Brain’s fee under a fee never-rule: the asking fee goes, the run is not lost', async () => {
    shipper.models.putEntry(
      {
        id: 'n-fee',
        kind: 'delivery.shipper',
        covers: ['fee'],
        body: { type: 'never', label: 'never under ₹250', all: [{ part: 'fee', below: 25_000n }] },
      },
      NOW,
    );
    const requestId = await ask();
    as(shipper);
    await feeMove(requestId, '22000');
    expect(offers().map((m) => m.body.fee_minor)).toEqual(['30000']);
  });
});
