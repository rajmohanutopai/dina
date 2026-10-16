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
  installFallbackNoticeCheck,
  installOptionStores,
  knownShippers,
  openSmallerDeals,
  optionWorkflowHooks,
  runOptionLinkTick,
} from '../../src/commitment/option_handler';
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
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

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
      supplierDid === SELLER && notice.purchase_order_id === 'po-1' ? { buyerDid: BUYER } : null,
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

