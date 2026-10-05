/**
 * Checkout sessions against the mock merchant over real TLS (UCP plan §3.7,
 * §3.10, §3.12; U2.4; T-U2-2, T-U2-5, T-U2-6, T-U2-7a, T-U2-9): the start
 * card raised with its session in one step, the permit its yes mints, the
 * create, update and cancel behind one gate, and every way a session ends
 * before the hand-off.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { checkoutIntentHash, type CheckoutIntent } from '@dina/ucp';

import { mockProduct, type MockProduct } from '../../../../test-harness/src/ucp_merchant/catalog';
import {
  startMockMerchant,
  type MockMerchant,
} from '../../../../test-harness/src/ucp_merchant/server';
import { A2AReleaseLog, installA2AReleaseLog } from '../../../src/a2a';
import { readConversationTaint } from '../../../src/chat/taint';
import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  OWNER_IN_PROCESS_PRINCIPAL,
  proveOwnerPresence,
} from '../../../src/commerce/owner_presence';
import {
  UCP_ARCHIVE_TABLES,
  ucpOrderForArchive,
  ucpRowsForArchive,
} from '../../../src/commerce/ucp/archive_rows';
import { UcpCartService } from '../../../src/commerce/ucp/carts';
import { UcpCheckoutStore } from '../../../src/commerce/ucp/checkout_store';
import {
  MAX_PENDING_STARTS,
  PERMIT_TTL_MS,
  UcpCheckoutService,
  makeUcpCheckoutDecisionHandler,
  readStoredIntent,
} from '../../../src/commerce/ucp/checkouts';
import { UcpDispatcher } from '../../../src/commerce/ucp/dispatch';
import { setUcpPolicySocket, ucpFetch } from '../../../src/commerce/ucp/fetch';
import { readHandoffCard, UCP_CHECKOUT_HANDOFF_TYPE } from '../../../src/commerce/ucp/handoff_card';
import { installUcpIdentity } from '../../../src/commerce/ucp/identity';
import { UcpLinkStore } from '../../../src/commerce/ucp/link_store';
import { UcpLinkService } from '../../../src/commerce/ucp/links';
import { installUcpLinkAuth, UcpMerchantClient } from '../../../src/commerce/ucp/merchant_client';
import { UcpOrderNotices } from '../../../src/commerce/ucp/order_notices';
import { UcpOrderStore } from '../../../src/commerce/ucp/order_store';
import { UcpOrderService } from '../../../src/commerce/ucp/orders';
import {
  createUcpCheckoutRuntime,
  installUcpCheckoutRuntime,
} from '../../../src/commerce/ucp/runtime';
import { searchView, startSearch, type SearchDeps } from '../../../src/commerce/ucp/search';
import { UcpSearchStore } from '../../../src/commerce/ucp/search_store';
import { readStartCard, UCP_CHECKOUT_START_TYPE } from '../../../src/commerce/ucp/start_card';
import { UcpHandoffWatcher, watchReadAt } from '../../../src/commerce/ucp/watcher';
import {
  ucpWebhookEnvelope,
  UcpWebhookService,
  UcpWebhookStore,
} from '../../../src/commerce/ucp/webhooks';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerUcpRoutes } from '../../../src/server/routes/ucp';
import {
  registerWorkflowRoutes,
  applyOwnerWorkflowDecision,
} from '../../../src/server/routes/workflow';
import { WorkflowTaskState } from '../../../src/workflow/domain';
import { SQLiteWorkflowRepository } from '../../../src/workflow/repository';
import { setWorkflowService, WorkflowService } from '../../../src/workflow/service';

import {
  CERT,
  IDENTITY,
  KEY,
  PROFILE_HOST,
  fetchProfile,
  freshDatabase,
  testSocket,
} from './mock_harness';

const SESSION = 'chat:main';

const TEAS: MockProduct[] = [
  mockProduct({
    id: 'gid://shop/Product/1',
    title: 'Sencha green tea',
    description: 'Steamed green tea.',
    variants: [
      { id: 'gid://shop/Variant/11', title: '100 g', price: 1250 },
      { id: 'gid://shop/Variant/12', title: '250 g', price: 2800 },
    ],
  }),
  mockProduct({
    id: 'gid://shop/Product/2',
    title: 'Earl Grey black tea',
    description: 'Black tea.',
    price: 900,
  }),
  mockProduct({
    id: 'gid://shop/Product/3',
    title: 'Rooibos tea by weight',
    description: 'Loose leaf.',
    variants: [
      {
        id: 'gid://shop/Variant/31',
        title: 'Loose',
        price: 2400,
        unit: { unit: 'KGM', scale: 3, display_text: 'kg', increment: 250 },
      },
    ],
  }),
];

let database: ReturnType<typeof freshDatabase>;
let shop: MockMerchant;
let clock: number;
let drop: Set<string>;
let soldOut: Set<string>;
let mcpPath: string;
let extraKeys: Record<string, unknown>[];
/** A state change the shop holds while it runs, until the test lets it go. */
let hold: ((operation: string) => Promise<void> | undefined) | null;
let messages: Record<string, unknown>[];
let continueUrlOn: boolean;
let orderSharing: 'share' | 'unauthorized' | 'identity_required';
let secondKeyListed: boolean;
/** The merchant answers a change to an ended session with the session as it stands. */
let endedAsIs: boolean;
/** The webhook URL this node lists; null once webhooks are off. */
let nodeWebhookUrl: string | null;
let store: UcpCheckoutStore;
let workflow: WorkflowService;
let checkouts: UcpCheckoutService;
let searchDeps: SearchDeps;
let n = 0;
/** When the owner last spoke: undefined means just now (every call), null means never. */
let ownerTurnAt: number | null | undefined;
/** Whether the workflow service tells checkouts of a decision (off: a missed handler). */
let handlerOn: boolean;

beforeAll(async () => {
  shop = await startMockMerchant({
    host: 'agent.test',
    cert: CERT,
    key: KEY,
    products: () => TEAS,
    fetchProfile,
    carts: true,
    checkouts: true,
    orders: true,
    orderSharing: () => orderSharing,
    signWebhooks: true,
    listSecondKey: () => secondKeyListed,
    endedAsIs: () => endedAsIs,
    now: () => clock,
    dropAnswer: (operation) => drop.delete(operation),
    outOfStock: (variantId) => soldOut.has(variantId),
    pickup: true,
    mcpPath: () => mcpPath,
    extraKeys: () => extraKeys,
    hold: (call) => hold?.(call.operation),
    checkoutMessages: () => messages,
    continueUrl: () => continueUrlOn,
    permalinkPath: '/cart-link',
  });
});

afterAll(async () => {
  await shop.close();
});

/** The order service on this test's database and clock. */
function orderService(webhooks = false): UcpOrderService {
  return new UcpOrderService({
    store: new UcpOrderStore(database.db),
    client: searchDeps.client,
    nowMs: () => clock,
    holder: 'test',
    takesWebhooks: () => webhooks,
    random: () => 0.5,
  });
}

const NODE_WEBHOOK_URL = 'https://node.example/ucp/webhooks/orders';

/** The webhook service on this test's database, for a node listing `NODE_WEBHOOK_URL`. */
function webhookService(orders = orderService(true)): UcpWebhookService {
  return new UcpWebhookService({
    store: new UcpWebhookStore(database.db),
    checkouts: store,
    orders: new UcpOrderStore(database.db),
    orderService: orders,
    client: searchDeps.client,
    nowMs: () => clock,
    newId: () => `wh${++n}`,
    webhookUrl: () => nodeWebhookUrl,
    onCompleted: (row, now) => orders.track(row, now),
  });
}

/** Fresh services on the same database (a restart is a new set). */
function services(): void {
  const client = new UcpMerchantClient({
    identity: () => IDENTITY,
    profileHost: PROFILE_HOST,
    now: () => clock,
  });
  store = new UcpCheckoutStore(database.db);
  const settings = () => ({ merchants: [shop.origin], context: { address_country: 'DE' } });
  workflow = new WorkflowService({
    repository: new SQLiteWorkflowRepository(database.db),
    nowMsFn: () => clock,
    approvalDecisionHandler: (args) => {
      if (handlerOn) makeUcpCheckoutDecisionHandler(() => checkouts)(args);
    },
  });
  const log = new A2AReleaseLog(database.db, () => clock, { chatLivesIn: 'brain' });
  installA2AReleaseLog(log);
  log.recordUtterance(SESSION, `t${++n}`, 'tea please');
  searchDeps = {
    store: new UcpSearchStore(database.db),
    client,
    check: { log, taint: (s) => readConversationTaint(database.db, log, s), nowMs: () => clock },
    workflow,
    nowMs: () => clock,
    newId: () => `id${++n}`,
    settings,
  };
  checkouts = new UcpCheckoutService({
    store,
    onCompleted: (row, now) => orderService().track(row, now),
    search: searchDeps.store,
    client,
    dispatcher: new UcpDispatcher({
      store,
      nowMs: () => clock,
      newKey: () => crypto.randomUUID(),
      holder: `h${++n}`,
    }),
    workflow: () => workflow,
    settings,
    trust: async () => ({ state: 'rated', recommendation: 'proceed', level: 'high', reviews: 12 }),
    ownerTurn: () => (ownerTurnAt === null ? null : (ownerTurnAt ?? clock)),
    nowMs: () => clock,
    newId: () => `${++n}`,
    sleep: async (ms) => {
      clock += ms;
      await new Promise((r) => setImmediate(r));
    },
  });
}

beforeEach(async () => {
  database = freshDatabase('checkouts');
  clock = Date.now();
  drop = new Set();
  ownerTurnAt = undefined;
  soldOut = new Set();
  mcpPath = '/ucp/mcp';
  extraKeys = [];
  hold = null;
  messages = [];
  continueUrlOn = true;
  orderSharing = 'share';
  secondKeyListed = false;
  endedAsIs = false;
  nodeWebhookUrl = 'https://node.example/ucp/webhooks/orders';
  handlerOn = true;
  setUcpPolicySocket(testSocket());
  installUcpIdentity(IDENTITY);
  shop.requests.length = 0;
  shop.logic.executed.length = 0;
  shop.logic.checkouts.clear();
  shop.logic.orders.clear();
  services();
  const found = await startSearch(
    { sessionId: SESSION, query: 'tea', merchants: [shop.origin] },
    searchDeps,
  );
  if (!found.ok) throw new Error(`search: ${found.reason}`);
  // p1 is Sencha (variants v1.1 100 g, v1.2 250 g), p2 Earl Grey (v2.1), p3 rooibos by the kg (v3.1).
  expect(
    searchView(searchDeps.store, found.searchId, SESSION, clock)?.products.map(
      (p) => p.product.handle,
    ),
  ).toEqual(['p1', 'p2', 'p3']);
});

afterEach(() => {
  setUcpPolicySocket(null);
  installUcpIdentity(null);
  installA2AReleaseLog(null);
  database.close();
});

const sent = (operation: string) => shop.requests.filter((r) => r.operation === operation);

/** Wait until the session leaves the given states (the yes starts the create on its own). */
async function settled(sessionId: string, from: string[] = ['awaiting_approval', 'creating']) {
  for (let i = 0; i < 200; i++) {
    const row = store.getCheckout(sessionId);
    // Moved on, and no send still holds the session (the yes starts one of its own).
    if (row !== null && !from.includes(row.state) && row.slot_holder === null) return row;
    await new Promise((r) => setTimeout(r, 5));
  }
  return store.getCheckout(sessionId);
}

async function proposeSencha() {
  const p = await checkouts.propose(SESSION, {
    lines: [
      { variant: 'v1.2', quantity: 2 },
      { variant: 'v2.1', quantity: 1 },
    ],
  });
  if (!p.ok) throw new Error(`propose: ${p.reason}`);
  return p.session;
}

describe('the start card', () => {
  it('is raised with its session in one step, names everything the yes covers, and sends nothing that opens a checkout', async () => {
    const session = await proposeSencha();
    expect(store.getCheckout(session.session_id)).toMatchObject({
      state: 'awaiting_approval',
      permit_id: null,
      merchant_origin: shop.origin,
      review_id: session.review_id,
    });
    const task = workflow.store().getById(session.review_id);
    expect(task?.status).toBe(WorkflowTaskState.PendingApproval);
    const card = readStartCard(task?.payload ?? '');
    expect(card).toMatchObject({
      type: UCP_CHECKOUT_START_TYPE,
      session_id: session.session_id,
      merchant: shop.origin,
      trust: { state: 'rated', recommendation: 'proceed' },
      lines: [
        {
          product: 'Sencha green tea',
          variant: '250 g',
          quantity: '2',
          unit: 'each',
          price: { amount: '2800', currency: 'EUR' },
        },
        { product: 'Earl Grey black tea', quantity: '1', price: { amount: '900' } },
      ],
      discount_codes: [],
      personal_data: [],
    });
    expect(card?.intent_hash).toBe(store.getCheckout(session.session_id)?.intent_hash);
    expect(task?.description).toContain('Start checkout at agent.test');
    expect(task?.description).toContain('No personal data is sent.');
    expect(sent('create_checkout')).toEqual([]);
    // Only the products were read again.
    expect(new Set(shop.requests.slice(-2).map((r) => r.operation))).toEqual(
      new Set(['get_product']),
    );
  });

  it('shows a quantity in its unit: 1500 steps of a kg at scale 3 is 1.5 kg', async () => {
    const p = await checkouts.propose(SESSION, { lines: [{ variant: 'v3.1', quantity: 1500 }] });
    if (!p.ok) throw new Error(p.reason);
    const task = workflow.store().getById(p.session.review_id);
    expect(readStartCard(task?.payload ?? '')?.lines[0]).toMatchObject({
      quantity: '1.5',
      unit: 'kg',
    });
    expect(task?.description).toContain('1.5 kg × Rooibos tea by weight');
  });

  it('comes only from the owner’s own request: no recent owner turn, no card and no merchant call', async () => {
    ownerTurnAt = null;
    const before = shop.requests.length;
    expect(await checkouts.propose(SESSION, { lines: [{ variant: 'v1.1', quantity: 1 }] })).toEqual(
      { ok: false, reason: 'no_owner_turn' },
    );
    ownerTurnAt = clock - 31 * 60_000;
    expect(await checkouts.propose(SESSION, { lines: [{ variant: 'v1.1', quantity: 1 }] })).toEqual(
      { ok: false, reason: 'no_owner_turn' },
    );
    expect(shop.requests.length).toBe(before);
  });

  it('only a few wait on the owner at once in one conversation', async () => {
    for (let i = 0; i < MAX_PENDING_STARTS; i++) await proposeSencha();
    expect(await checkouts.propose(SESSION, { lines: [{ variant: 'v1.1', quantity: 1 }] })).toEqual(
      { ok: false, reason: 'too_many_starts' },
    );
  });

  it('refuses what it cannot show faithfully: bad discount codes, an unknown handle, a merchant not allowed', async () => {
    expect(
      await checkouts.propose(SESSION, {
        lines: [{ variant: 'v1.1', quantity: 1 }],
        discountCodes: [' SPACE'],
      }),
    ).toEqual({ ok: false, reason: 'bad_discount_code' });
    expect(
      await checkouts.propose(SESSION, { lines: [{ variant: 'v9.9', quantity: 1 }] }),
    ).toMatchObject({ ok: false, reason: 'unknown_variant' });
    expect(sent('create_checkout')).toEqual([]);
  });
});

describe('the permit', () => {
  it('the owner’s yes mints it and the create goes: exactly the approved lines, units and context, never a cart id', async () => {
    const session = await proposeSencha();
    const approvedAt = clock;
    workflow.approve(session.review_id);
    const row = await settled(session.session_id);
    expect(row).toMatchObject({ state: 'open', permit_void_reason: null });
    expect(row?.permit_id).toMatch(/^ucp-permit-/);
    expect(row?.permit_expires_at).toBe(approvedAt + PERMIT_TTL_MS);
    expect(row?.merchant_checkout_id).toMatch(/^chk_/);
    expect(workflow.store().getById(session.review_id)?.status).toBe(WorkflowTaskState.Completed);
    const [create] = sent('create_checkout');
    expect(create?.payload).toEqual({
      line_items: [
        {
          item: {
            id: 'gid://shop/Variant/12',
            quantity_unit: { unit: 'C62', scale: 0, display_text: 'each' },
          },
          quantity: 2,
        },
        {
          item: {
            id: 'gid://shop/Product/2-v1',
            quantity_unit: { unit: 'C62', scale: 0, display_text: 'each' },
          },
          quantity: 1,
        },
      ],
      context: { address_country: 'DE' },
    });
    expect(sent('create_checkout')).toHaveLength(1);
  });

  it('a no declines the session, and a card that lapses does too; nothing is sent', async () => {
    const denied = await proposeSencha();
    workflow.cancel(denied.review_id, 'owner said no');
    expect(store.getCheckout(denied.session_id)?.state).toBe('declined');
    // The no stands until the owner speaks again.
    expect(await checkouts.propose(SESSION, { lines: [{ variant: 'v1.1', quantity: 1 }] })).toEqual(
      { ok: false, reason: 'start_declined' },
    );
    clock += 1_000;
    ownerTurnAt = clock;
    const lapsed = await proposeSencha();
    clock += 61 * 60_000;
    workflow.expireTasks(Math.floor(clock / 1000), clock);
    expect(store.getCheckout(lapsed.session_id)?.state).toBe('declined');
    await checkouts.sweep();
    expect(sent('create_checkout')).toEqual([]);
  });

  it('an approval the handler missed (a crash after the yes) is minted for by the sweep', async () => {
    const session = await proposeSencha();
    handlerOn = false;
    workflow.approve(session.review_id);
    expect(store.getCheckout(session.session_id)?.permit_id).toBeNull();
    handlerOn = true;
    await checkouts.sweep();
    expect(await settled(session.session_id)).toMatchObject({ state: 'open' });
    expect(sent('create_checkout')).toHaveLength(1);
  });

  it('a card that does not name its session’s intent mints nothing (the session’s stored intent was changed)', async () => {
    const session = await proposeSencha();
    database.db.run(`UPDATE ucp_checkouts SET intent_hash = ? WHERE session_id = ?`, [
      'f'.repeat(64),
      session.session_id,
    ]);
    workflow.approve(session.review_id);
    expect(store.getCheckout(session.session_id)).toMatchObject({
      state: 'declined',
      permit_id: null,
    });
    expect(workflow.store().getById(session.review_id)?.status).toBe(WorkflowTaskState.Failed);
    expect(sent('create_checkout')).toEqual([]);
  });

  it('a negotiation that changed since the yes (another version) voids the permit before anything is sent', async () => {
    const session = await proposeSencha();
    handlerOn = false;
    workflow.approve(session.review_id);
    // The merchant's profile moved on: the approved intent, re-bound to another version.
    const row = store.getCheckout(session.session_id);
    const intent = readStoredIntent(row as NonNullable<typeof row>) as CheckoutIntent;
    const moved: CheckoutIntent = { ...intent, version: '2026-01-11' };
    const stored = JSON.parse(row?.intent_json ?? '{}') as Record<string, unknown>;
    const hash = checkoutIntentHash(moved, sha256);
    database.db.run(
      `UPDATE ucp_checkouts SET intent_json = ?, intent_hash = ? WHERE session_id = ?`,
      [JSON.stringify({ ...stored, version: '2026-01-11' }), hash, session.session_id],
    );
    const card = JSON.parse(workflow.store().getById(session.review_id)?.payload ?? '{}') as Record<
      string,
      unknown
    >;
    database.db.run(`UPDATE workflow_tasks SET payload = ? WHERE id = ?`, [
      JSON.stringify({ ...card, intent_hash: hash }),
      session.review_id,
    ]);
    handlerOn = true;
    await checkouts.sweep();
    expect(await settled(session.session_id)).toMatchObject({
      state: 'stale',
      permit_void_reason: 'drift:version_changed',
    });
    expect(sent('create_checkout')).toEqual([]);
  });

  it('the merchant moved its endpoint after the yes: stale, the permit void, nothing sent', async () => {
    const session = await proposeSencha();
    mcpPath = '/ucp/mcp-v2';
    services(); // a fresh read of the profile
    workflow.approve(session.review_id);
    expect(await settled(session.session_id)).toMatchObject({
      state: 'stale',
      permit_void_reason: 'drift:endpoint_changed',
    });
    expect(sent('create_checkout')).toEqual([]);
  });

  describe('the linked account the yes was given under (plan §3.7; dual review R1-2)', () => {
    let link: { state: 'active'; link_id: string; auth_revision: number } | null;
    const auth = () =>
      installUcpLinkAuth({
        view: () => link,
        bearer: async () => (link === null ? null : 'tok'),
        refresh: async () => true,
        want: () => undefined,
      });
    afterEach(() => installUcpLinkAuth(null));

    it('an account linked after the yes: stale, the permit void, nothing sent', async () => {
      link = null;
      auth();
      const session = await proposeSencha();
      link = { state: 'active', link_id: 'L1', auth_revision: 1 };
      workflow.approve(session.review_id);
      expect(await settled(session.session_id)).toMatchObject({
        state: 'stale',
        permit_void_reason: 'drift:credential_changed',
      });
      expect(sent('create_checkout')).toEqual([]);
    });

    it('authorized again (a step-up) after the yes: stale, nothing sent', async () => {
      link = { state: 'active', link_id: 'L1', auth_revision: 1 };
      auth();
      const session = await proposeSencha();
      link = { state: 'active', link_id: 'L1', auth_revision: 2 };
      workflow.approve(session.review_id);
      expect(await settled(session.session_id)).toMatchObject({
        permit_void_reason: 'drift:credential_changed',
      });
      expect(sent('create_checkout')).toEqual([]);
    });

    it('the account replaced while its token is fetched (a refresh waiting): nothing goes under the new one, and the yes is void (dual review R2-1)', async () => {
      link = { state: 'active', link_id: 'L1', auth_revision: 1 };
      let release: () => void = () => undefined;
      const fetching = new Promise<void>((r) => (release = r));
      let asked = 0;
      // Held only once the proposal is made (it reads the shop too).
      let hold = false;
      installUcpLinkAuth({
        view: () => link,
        bearer: async () => {
          if (!hold) return 'tok';
          asked += 1;
          await fetching;
          return 'tok';
        },
        refresh: async () => true,
        want: () => undefined,
      });
      const session = await proposeSencha();
      hold = true;
      workflow.approve(session.review_id);
      for (let i = 0; i < 200 && asked === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(asked).toBeGreaterThan(0);
      // While the token is being fetched, the owner links another account at the shop.
      link = { state: 'active', link_id: 'L2', auth_revision: 1 };
      release();
      for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 5));
      await checkouts.sweep();
      for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 5));
      expect(sent('create_checkout')).toEqual([]);
      expect(store.getCheckout(session.session_id)?.permit_void_reason).toBe(
        'drift:credential_changed',
      );
    });

    it('the same account, refreshed or not: the create goes, under that account', async () => {
      link = { state: 'active', link_id: 'L1', auth_revision: 1 };
      auth();
      const session = await proposeSencha();
      workflow.approve(session.review_id);
      await settled(session.session_id);
      expect(sent('create_checkout')).toHaveLength(1);
    });
  });

  it('a key rotation alone changes nothing: the create goes', async () => {
    const session = await proposeSencha();
    extraKeys = [
      {
        kty: 'EC',
        crv: 'P-256',
        kid: 'rotated',
        x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
        y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
        use: 'sig',
        alg: 'ES256',
      },
    ];
    services();
    workflow.approve(session.review_id);
    expect(await settled(session.session_id)).toMatchObject({
      state: 'open',
      permit_void_reason: null,
    });
    expect(sent('create_checkout')).toHaveLength(1);
  });

  it('the yes and the sweep at once send one create', async () => {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await Promise.all([checkouts.sweep(), checkouts.sweep()]);
    expect(await settled(session.session_id)).toMatchObject({ state: 'open' });
    expect(sent('create_checkout')).toHaveLength(1);
    expect(shop.logic.checkouts.size).toBe(1);
  });

  it('a permit that runs out before the create is sent: lapsed, and the merchant is never asked', async () => {
    const session = await proposeSencha();
    handlerOn = false;
    workflow.approve(session.review_id);
    store.mintPermit(session.session_id, 'ucp-permit-x', clock - 1, clock);
    const before = shop.requests.length;
    await checkouts.sweep();
    expect(store.getCheckout(session.session_id)).toMatchObject({
      state: 'lapsed',
      permit_void_reason: 'permit_lapsed',
    });
    expect(shop.requests.length).toBe(before);
  });

  it('out of stock: the session failed, its permit void, the merchant’s handover link kept', async () => {
    soldOut.add('gid://shop/Variant/12');
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    const row = await settled(session.session_id);
    expect(row).toMatchObject({ state: 'create_failed', permit_void_reason: 'create_failed' });
    expect(JSON.parse(row?.last_answer_json ?? '{}')).toEqual({
      continue_url: `${shop.origin}/cart`,
    });
    await checkouts.sweep();
    expect(sent('create_checkout')).toHaveLength(1);
  });
});

describe('sending', () => {
  it('a create whose answer was lost is resent after a restart with the same bytes and key: the merchant made one session', async () => {
    drop.add('create_checkout');
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    expect(await settled(session.session_id, ['awaiting_approval'])).toMatchObject({
      state: 'creating',
    });
    const [row] = store.requests('checkout', session.session_id);
    expect(row).toMatchObject({ state: 'in_doubt', operation: 'create_checkout' });
    services(); // a restart
    await checkouts.sweep();
    expect(store.getCheckout(session.session_id)).toMatchObject({ state: 'open' });
    expect(shop.logic.executed.filter((o) => o === 'create_checkout')).toHaveLength(1);
    const creates = sent('create_checkout');
    expect(creates).toHaveLength(2);
    expect(creates[1]?.payload).toEqual(creates[0]?.payload);
    expect(shop.logic.checkouts.size).toBe(1);
  });

  it('a create still lost when its permit lapses is never sent again: the session is create_unknown', async () => {
    drop.add('create_checkout');
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await settled(session.session_id, ['awaiting_approval']);
    clock += PERMIT_TTL_MS;
    await checkouts.sweep();
    expect(store.getCheckout(session.session_id)).toMatchObject({
      state: 'create_unknown',
      permit_void_reason: 'create_deadline',
    });
    expect(sent('create_checkout')).toHaveLength(1);
  });

  it('an update the permit covers goes (the merchant’s line ids, the same lines); one outside it is refused and nothing is sent', async () => {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await settled(session.session_id);
    expect(await checkouts.update(SESSION, session.session_id)).toMatchObject({
      ok: true,
      outcome: 'settled',
      session: { state: 'open' },
    });
    const [update] = sent('update_checkout');
    expect((update?.payload.line_items as { id?: string }[]).map((l) => l.id)).toEqual([
      expect.stringMatching(/^li_/),
      expect.stringMatching(/^li_/),
    ]);
    expect(
      await checkouts.update(SESSION, session.session_id, { methodId: 'teleport' }),
    ).toMatchObject({ ok: false, reason: 'outside_permit' });
    expect(sent('update_checkout')).toHaveLength(1);
  });

  it('a pickup choice among the merchant’s own offers goes; an option it never offered is refused unsent', async () => {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await settled(session.session_id);
    expect(
      await checkouts.update(SESSION, session.session_id, {
        methodId: 'pickup',
        destinationId: 'loc_main',
        options: { g_pickup: 'same_day' },
      }),
    ).toMatchObject({ ok: true, outcome: 'settled' });
    const merchantId = store.getCheckout(session.session_id)?.merchant_checkout_id ?? '';
    expect(shop.logic.checkouts.get(merchantId)?.pickup).toEqual({
      destination: 'loc_main',
      option: 'same_day',
    });
    expect(
      await checkouts.update(SESSION, session.session_id, {
        methodId: 'pickup',
        options: { g_pickup: 'yesterday' },
      }),
    ).toEqual({ ok: false, reason: 'outside_permit', detail: 'option_not_offered' });
    expect(sent('update_checkout')).toHaveLength(1);
  });

  it('a profile change after the session opened voids the permit: no update is sent', async () => {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await settled(session.session_id);
    mcpPath = '/ucp/mcp-v2';
    services();
    expect(await checkouts.update(SESSION, session.session_id)).toEqual({
      ok: false,
      reason: 'session_closed',
    });
    expect(store.getCheckout(session.session_id)).toMatchObject({
      state: 'open',
      permit_void_reason: 'drift:endpoint_changed',
    });
    expect(sent('update_checkout')).toEqual([]);
  });

  it('an open session past its expiry ends without asking the merchant', async () => {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await settled(session.session_id);
    clock += 6 * 60 * 60_000 + 1;
    const before = shop.requests.length;
    await checkouts.sweep();
    expect(store.getCheckout(session.session_id)?.state).toBe('not_completed');
    expect(shop.requests.length).toBe(before);
  });

  it('an update to a session the merchant already ended (409 invalid_state) reads it back: canceled, not unsettled', async () => {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await settled(session.session_id);
    const merchantId = store.getCheckout(session.session_id)?.merchant_checkout_id ?? '';
    const held = shop.logic.checkouts.get(merchantId);
    if (held === undefined) throw new Error('no session at the merchant');
    held.status = 'canceled';
    expect(await checkouts.update(SESSION, session.session_id)).toMatchObject({
      ok: false,
      reason: 'refused',
    });
    expect(store.getCheckout(session.session_id)).toMatchObject({
      state: 'canceled',
      permit_void_reason: 'canceled',
    });
  });

  describe('a cancel answered with anything but canceled (checkout/index.md:484-486)', () => {
    async function openOne() {
      const session = await proposeSencha();
      workflow.approve(session.review_id);
      await settled(session.session_id);
      const id = store.getCheckout(session.session_id)?.merchant_checkout_id ?? '';
      const held = shop.logic.checkouts.get(id);
      if (held === undefined) throw new Error('no session');
      return { sessionId: session.session_id, held };
    }
    beforeEach(() => {
      endedAsIs = true;
    });

    it('answered completed (the owner paid first): completed, and its order followed', async () => {
      const { sessionId, held } = await openOne();
      shop.logic.completeInBrowser(held.id);
      await checkouts.cancel(SESSION, sessionId);
      const row = store.getCheckout(sessionId);
      expect(row).toMatchObject({ state: 'completed' });
      expect(row?.order_id).toMatch(/^ord_/);
      expect(new UcpOrderStore(database.db).bySession(sessionId)?.state).toBe('open');
    });

    it('answered still completing: not canceled', async () => {
      const { sessionId, held } = await openOne();
      (held as { status: string }).status = 'complete_in_progress';
      await checkouts.cancel(SESSION, sessionId);
      // Not canceled: the buyer is completing it, so it leaves Dina's hands to the watcher.
      expect(store.getCheckout(sessionId)).toMatchObject({
        state: 'handed_off',
        last_status: 'complete_in_progress',
        permit_void_reason: 'completing',
      });
      // No update is started meanwhile (checkout/index.md:451), and no hand-off card is raised.
      const updates = sent('update_checkout').length;
      expect((await checkouts.update(SESSION, sessionId)).ok).toBe(false);
      expect(sent('update_checkout').length).toBe(updates);
      expect((await checkouts.handoff(SESSION, sessionId)).ok).toBe(false);
      expect(
        workflow
          .store()
          .listByKindAndState('approval', 'pending_approval', 50)
          .filter((t) => (t.payload ?? '').includes('ucp_checkout_handoff')),
      ).toEqual([]);
    });

    it('a hand-off read that finds it completing raises no card and passes it to the watcher', async () => {
      const { sessionId, held } = await openOne();
      (held as { status: string }).status = 'complete_in_progress';
      expect(await checkouts.handoff(SESSION, sessionId)).toEqual({
        ok: false,
        reason: 'session_closed',
      });
      expect(store.getCheckout(sessionId)).toMatchObject({
        state: 'handed_off',
        last_status: 'complete_in_progress',
      });
    });

    it('answered about another checkout: not this session’s, and nothing changes', async () => {
      const a = await openOne();
      const b = await openOne();
      shop.logic.checkouts.set(a.held.id, b.held);
      await checkouts.cancel(SESSION, a.sessionId);
      expect(store.getCheckout(a.sessionId)?.state).toBe('open');
    });
  });

  it('cancel only while open; another conversation’s session reads as none', async () => {
    const session = await proposeSencha();
    expect(await checkouts.cancel(SESSION, session.session_id)).toEqual({
      ok: false,
      reason: 'session_closed',
    });
    workflow.approve(session.review_id);
    await settled(session.session_id);
    expect(await checkouts.cancel('chat:other', session.session_id)).toEqual({
      ok: false,
      reason: 'unknown_session',
    });
    expect(await checkouts.cancel(SESSION, session.session_id)).toMatchObject({
      ok: true,
      session: { state: 'canceled' },
    });
    expect(store.getCheckout(session.session_id)?.permit_void_reason).toBe('canceled');
    expect(await checkouts.cancel(SESSION, session.session_id)).toEqual({
      ok: false,
      reason: 'session_closed',
    });
    expect(sent('cancel_checkout')).toHaveLength(1);
  });

  it('past the permit’s six hours nothing more is sent on the session', async () => {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await settled(session.session_id);
    clock += PERMIT_TTL_MS;
    expect(await checkouts.update(SESSION, session.session_id)).toEqual({
      ok: false,
      reason: 'session_closed',
    });
    expect(sent('update_checkout')).toEqual([]);
  });
});

describe('what Brain cannot do with the start card', () => {
  function call(
    caller: 'brain' | 'owner',
    method: CoreRequest['method'],
    p: string,
    body: Record<string, unknown> = {},
    query: Record<string, string> = {},
  ) {
    const router = new CoreRouter();
    registerWorkflowRoutes(router, 'cap');
    return router.handle({
      method,
      path: p,
      query,
      headers: { 'x-did': 'did:key:brain' },
      body,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: caller,
      callerDID: 'did:key:brain',
      ...(caller === 'owner' ? { ownerCapability: 'cap' } : {}),
    } as CoreRequest);
  }

  beforeEach(() => setWorkflowService(workflow));
  afterEach(() => setWorkflowService(null));

  it('reads nothing of the merchant’s words: the card’s payload, text and result are redacted, in a task, a list and the events', async () => {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await settled(session.session_id);
    const leaks = /Sencha|Earl Grey|agent\.test|chk_/;
    const one = await call('brain', 'GET', `/v1/workflow/tasks/${session.review_id}`);
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).not.toMatch(leaks);
    expect((one.body as { task: { payload: string } }).task.payload).toContain('owner_only');
    const list = await call(
      'brain',
      'GET',
      '/v1/workflow/tasks',
      {},
      {
        kind: 'approval',
        state: 'completed',
      },
    );
    expect(JSON.stringify(list.body)).toContain(session.review_id);
    expect(JSON.stringify(list.body)).not.toMatch(leaks);
    const events = await call('brain', 'GET', '/v1/workflow/events');
    expect(events.status).toBe(200);
    // The approval's event embeds the card's payload; Brain reads it redacted.
    expect(JSON.stringify(events.body)).toContain('owner_only');
    expect(JSON.stringify(events.body)).not.toMatch(leaks);
    // The owner reads all of it.
    const owner = await call('owner', 'GET', `/v1/workflow/tasks/${session.review_id}`);
    expect(JSON.stringify(owner.body)).toMatch(/Sencha/);
  });

  it('create one, decide one, or move one after the owner said yes; the owner’s yes through the route mints the permit', async () => {
    const forged = await call('brain', 'POST', '/v1/workflow/tasks', {
      id: 'x1',
      kind: 'approval',
      description: 'x',
      payload: JSON.stringify({ type: UCP_CHECKOUT_START_TYPE }),
    });
    expect((forged.body as { error: string }).error).toBe('reserved_payload_type');
    const session = await proposeSencha();
    for (const verb of ['approve', 'cancel', 'fail']) {
      expect(
        (await call('brain', 'POST', `/v1/workflow/tasks/${session.review_id}/${verb}`)).status,
      ).toBe(403);
    }
    expect(store.getCheckout(session.session_id)?.state).toBe('awaiting_approval');
    expect(
      (await call('owner', 'POST', `/v1/workflow/tasks/${session.review_id}/approve`)).status,
    ).toBe(200);
    expect(await settled(session.session_id)).toMatchObject({ state: 'open' });
    for (const verb of ['complete', 'fail', 'heartbeat', 'progress']) {
      expect(
        (
          await call('brain', 'POST', `/v1/workflow/tasks/${session.review_id}/${verb}`, {
            result: '{}',
          })
        ).status,
      ).toBe(403);
    }
  });
});

describe('the hand-off', () => {
  /** A session the owner said yes to, open at the merchant. */
  async function openSession() {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    expect(await settled(session.session_id)).toMatchObject({ state: 'open' });
    return session;
  }

  it('raises the card from the merchant’s answer, fences the session in the same step, and opens the merchant’s own checkout', async () => {
    const session = await openSession();
    const handed = await checkouts.handoff(SESSION, session.session_id);
    if (!handed.ok) throw new Error(`handoff: ${handed.reason}`);
    expect(store.getCheckout(session.session_id)).toMatchObject({
      state: 'handed_off',
      permit_void_reason: 'handed_off',
    });
    const task = workflow.store().getById(handed.reviewId);
    expect(task?.status).toBe(WorkflowTaskState.PendingApproval);
    const card = readHandoffCard(task?.payload ?? '');
    const merchantId = store.getCheckout(session.session_id)?.merchant_checkout_id ?? '';
    expect(card).toMatchObject({
      type: UCP_CHECKOUT_HANDOFF_TYPE,
      session_id: session.session_id,
      merchant: shop.origin,
      lines: [
        {
          title: 'Sencha green tea — 250 g',
          quantity: '2',
          total: { amount: '5600', currency: 'EUR' },
        },
        { quantity: '1', total: { amount: '900' } },
      ],
      totals: [
        { type: 'subtotal', amount: { amount: '6500' } },
        { type: 'total', amount: { amount: '6500' } },
      ],
      links: [
        { type: 'terms_of_service', url: `${shop.origin}/terms` },
        { type: 'privacy_policy', url: `${shop.origin}/privacy` },
      ],
      handoff: {
        url: `${shop.origin}/checkout/${merchantId}`,
        source: 'continue_url',
        off_host: false,
      },
      notes: [],
    });
    expect(card?.expires_at).toBe(store.getCheckout(session.session_id)?.effective_expires_at);
    expect(task?.expires_at).toBe(Math.floor((card?.expires_at ?? 0) / 1000));
    expect(task?.description).toContain('Review and pay at agent.test');
    expect(task?.description).toContain('Dina never pays');
    // Asked again: the same card.
    expect(await checkouts.handoff(SESSION, session.session_id)).toMatchObject({
      ok: true,
      reviewId: handed.reviewId,
    });
    // Fenced: nothing more is sent, whatever happens to the card.
    expect(await checkouts.update(SESSION, session.session_id)).toEqual({
      ok: false,
      reason: 'session_closed',
    });
    expect(await checkouts.cancel(SESSION, session.session_id)).toEqual({
      ok: false,
      reason: 'session_closed',
    });
    expect(sent('update_checkout')).toEqual([]);
    expect(sent('cancel_checkout')).toEqual([]);
    expect(shop.logic.executed).not.toContain('complete_checkout');
  });

  it('the owner’s yes completes the card with the link to open; a no changes nothing at the merchant', async () => {
    const yes = await openSession();
    const handed = await checkouts.handoff(SESSION, yes.session_id);
    if (!handed.ok) throw new Error(handed.reason);
    workflow.approve(handed.reviewId);
    const done = workflow.store().getById(handed.reviewId);
    expect(done?.status).toBe(WorkflowTaskState.Completed);
    expect(JSON.parse(done?.result ?? '{}')).toEqual({
      session_id: yes.session_id,
      handoff_url: readHandoffCard(done?.payload ?? '')?.handoff.url,
    });
    const no = await openSession();
    const second = await checkouts.handoff(SESSION, no.session_id);
    if (!second.ok) throw new Error(second.reason);
    const before = shop.requests.length;
    workflow.cancel(second.reviewId, 'not now');
    expect(store.getCheckout(no.session_id)?.state).toBe('handed_off');
    expect(shop.requests.length).toBe(before);
  });

  it('the barrier: an update whose answer was lost, with a restart in between, is settled before the card', async () => {
    const session = await openSession();
    drop.add('update_checkout');
    expect(await checkouts.update(SESSION, session.session_id)).toMatchObject({
      ok: true,
      outcome: 'pending',
    });
    services(); // a restart
    const handed = await checkouts.handoff(SESSION, session.session_id);
    expect(handed).toMatchObject({ ok: true });
    // Resent with the same bytes and key; the merchant ran it once.
    const updates = sent('update_checkout');
    expect(updates).toHaveLength(2);
    expect(updates[1]?.payload).toEqual(updates[0]?.payload);
    expect(shop.logic.executed.filter((o) => o === 'update_checkout')).toHaveLength(1);
    expect(store.openRequest('checkout', session.session_id)).toBeNull();
  });

  it('the barrier: a 409 while the merchant still runs the first attempt raises no card; once it ends, the cached answer settles it', async () => {
    const session = await openSession();
    let release: () => void = () => undefined;
    const released = new Promise<void>((r) => (release = r));
    let held = 0;
    hold = (operation) => (operation === 'update_checkout' && held++ === 0 ? released : undefined);
    drop.add('update_checkout');
    const first = checkouts.update(SESSION, session.session_id);
    while (held === 0) await new Promise((r) => setImmediate(r));
    // The first attempt still runs at the merchant; its slot lease has passed (a stalled holder).
    clock += 10 * 60_000;
    expect(await checkouts.handoff(SESSION, session.session_id)).toEqual({
      ok: false,
      reason: 'not_settled',
    });
    expect(store.getCheckout(session.session_id)?.state).toBe('open');
    expect(
      workflow.store().getActiveByIdempotencyKey(`ucp-checkout-handoff:${session.session_id}`),
    ).toBeNull();
    release();
    await first;
    clock += 31_000;
    expect(await checkouts.handoff(SESSION, session.session_id)).toMatchObject({ ok: true });
    expect(shop.logic.executed.filter((o) => o === 'update_checkout')).toHaveLength(1);
  });

  it('a session that ended at the merchant first (completed in the browser) gets no card', async () => {
    const session = await openSession();
    const merchantId = store.getCheckout(session.session_id)?.merchant_checkout_id ?? '';
    shop.logic.completeInBrowser(merchantId);
    expect(await checkouts.handoff(SESSION, session.session_id)).toEqual({
      ok: false,
      reason: 'session_closed',
    });
    const done = store.getCheckout(session.session_id);
    expect(done).toMatchObject({ state: 'completed', permit_void_reason: 'completed' });
    // Its order is recorded and followed, as after a hand-off.
    expect(done?.order_id).toMatch(/^ord_/);
    expect(
      new UcpOrderStore(database.db).get({
        merchant_origin: shop.origin,
        order_id: done?.order_id ?? '',
      }),
    ).toMatchObject({ session_id: session.session_id, state: 'open' });
  });

  it('a refused change read back as completed records the order too', async () => {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await settled(session.session_id);
    const merchantId = store.getCheckout(session.session_id)?.merchant_checkout_id ?? '';
    shop.logic.completeInBrowser(merchantId);
    expect(await checkouts.update(SESSION, session.session_id)).toMatchObject({ ok: false });
    const done = store.getCheckout(session.session_id);
    expect(done).toMatchObject({
      state: 'completed',
      order_permalink_url: expect.stringContaining('/orders/'),
    });
    expect(new UcpOrderStore(database.db).bySession(session.session_id)?.state).toBe('open');
  });

  it('only for the conversation’s own open session', async () => {
    const session = await proposeSencha();
    expect(await checkouts.handoff(SESSION, session.session_id)).toEqual({
      ok: false,
      reason: 'session_closed',
    });
    expect(await checkouts.handoff('chat:other', session.session_id)).toEqual({
      ok: false,
      reason: 'unknown_session',
    });
  });

  it('carries everything the owner must see: the status, the pickup choice and its cost, every message, a disclosure beside its item, and notes for what it cannot show', async () => {
    const session = await openSession();
    await checkouts.update(SESSION, session.session_id, {
      methodId: 'pickup',
      destinationId: 'loc_main',
      options: { g_pickup: 'same_day' },
    });
    messages = [
      {
        type: 'warning',
        code: 'age_restricted',
        content: 'Contains caffeine.',
        presentation: 'disclosure',
        path: '$.line_items[1]',
      },
      {
        type: 'warning',
        code: 'x',
        content: 'About delivery.',
        presentation: 'disclosure',
        path: '$.fulfillment.methods[0]',
      },
      {
        type: 'warning',
        code: 'y',
        content: 'See the label.',
        presentation: 'notice',
        image_url: 'https://agent.test/label.png',
      },
      {
        type: 'error',
        code: 'item_unavailable',
        content: 'One size is low.',
        severity: 'recoverable',
      },
      { type: 'info', content: 'Free returns.' },
    ];
    const handed = await checkouts.handoff(SESSION, session.session_id);
    if (!handed.ok) throw new Error(handed.reason);
    const card = readHandoffCard(workflow.store().getById(handed.reviewId)?.payload ?? '');
    expect(card).toMatchObject({
      status: 'incomplete',
      fulfillment: [
        {
          method: 'pickup',
          destination: 'Main street shop',
          option: 'Same day',
          cost: { amount: '0' },
        },
      ],
      messages: [
        { kind: 'warning', code: 'other', text: 'Contains caffeine.', disclosure: true, line: 1 },
        { kind: 'warning', disclosure: true, line: null },
        { kind: 'warning', disclosure: false, line: null },
        { kind: 'error', code: 'item_unavailable', text: 'One size is low.' },
        { kind: 'info', code: '', text: 'Free returns.' },
      ],
    });
    expect(card?.notes).toEqual(
      expect.arrayContaining(['disclosure_on_merchant_page', 'merchant_image']),
    );
    const text = workflow.store().getById(handed.reviewId)?.description ?? '';
    // The disclosure sits right after the line it is about.
    expect(text).toMatch(/Earl Grey black tea.*\n {2}Disclosure: Contains caffeine\./);
    expect(text).toContain('pickup at Main street shop: Same day');
    expect(text).toContain('Problem: One size is low.');
  });

  it('with no continue_url, the permalink: a new cart at the merchant, said so on the card, and recorded as not this session', async () => {
    const session = await openSession();
    continueUrlOn = false;
    const handed = await checkouts.handoff(SESSION, session.session_id);
    if (!handed.ok) throw new Error(handed.reason);
    const card = readHandoffCard(workflow.store().getById(handed.reviewId)?.payload ?? '');
    expect(card?.handoff).toEqual({
      url: `${shop.origin}/cart-link/~${Buffer.from('gid://shop/Variant/12').toString('base64url')}:2,~${Buffer.from('gid://shop/Product/2-v1').toString('base64url')}:1`,
      source: 'permalink',
      off_host: false,
    });
    expect(card?.notes).toContain('permalink_new_cart');
    expect(store.getCheckout(session.session_id)?.handoff_source).toBe('permalink');
  });

  it('an update that may have reached the merchant and never settles leaves the session unsettled: no card, ever', async () => {
    const session = await openSession();
    drop.add('update_checkout');
    await checkouts.update(SESSION, session.session_id);
    // Its permit lapses before an answer comes: the gate closes on the resend.
    clock += PERMIT_TTL_MS;
    expect(await checkouts.handoff(SESSION, session.session_id)).toEqual({
      ok: false,
      reason: 'session_closed',
    });
    expect(store.getCheckout(session.session_id)?.state).toBe('unsettled');
    expect(await checkouts.handoff(SESSION, session.session_id)).toEqual({
      ok: false,
      reason: 'session_closed',
    });
  });

  it('a mirrored yes without proof of presence is refused; with it, applied', async () => {
    const session = await openSession();
    const handed = await checkouts.handoff(SESSION, session.session_id);
    if (!handed.ok) throw new Error(handed.reason);
    setWorkflowService(workflow);
    try {
      await expect(applyOwnerWorkflowDecision(handed.reviewId, 'approve')).rejects.toThrow(
        /person present/,
      );
      expect(workflow.store().getById(handed.reviewId)?.status).toBe(
        WorkflowTaskState.PendingApproval,
      );
      await applyOwnerWorkflowDecision(handed.reviewId, 'approve', null, {
        presenceVerified: true,
      });
      expect(workflow.store().getById(handed.reviewId)?.status).toBe(WorkflowTaskState.Completed);
    } finally {
      setWorkflowService(null);
    }
  });
});

describe('what Brain cannot do with the hand-off card', () => {
  function call(
    caller: 'brain' | 'owner',
    method: CoreRequest['method'],
    p: string,
    body: Record<string, unknown> = {},
  ) {
    const router = new CoreRouter();
    registerWorkflowRoutes(router, 'cap');
    return router.handle({
      method,
      path: p,
      query: {},
      headers: { 'x-did': 'did:key:brain' },
      body,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: caller,
      callerDID: 'did:key:brain',
      ...(caller === 'owner' ? { ownerCapability: 'cap' } : {}),
    } as CoreRequest);
  }

  beforeEach(() => {
    setWorkflowService(workflow);
    installOwnerPresenceVerifier(async (p) => p === 'pass phrase');
  });
  afterEach(() => {
    setWorkflowService(null);
    installOwnerPresenceVerifier(null);
    clearOwnerPresence();
  });

  it('the owner’s yes needs a person present; Brain can neither decide it nor read its words or its link', async () => {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await settled(session.session_id);
    const handed = await checkouts.handoff(SESSION, session.session_id);
    if (!handed.ok) throw new Error(handed.reason);
    expect(
      (await call('brain', 'POST', `/v1/workflow/tasks/${handed.reviewId}/approve`)).status,
    ).toBe(403);
    const absent = await call('owner', 'POST', `/v1/workflow/tasks/${handed.reviewId}/approve`);
    expect(absent.status).toBe(403);
    expect((absent.body as { error: string }).error).toBe('no_user_presence');
    expect(await proveOwnerPresence('pass phrase', Date.now(), OWNER_IN_PROCESS_PRINCIPAL)).toBe(
      true,
    );
    expect(
      (await call('owner', 'POST', `/v1/workflow/tasks/${handed.reviewId}/approve`)).status,
    ).toBe(200);
    const read = await call('brain', 'GET', `/v1/workflow/tasks/${handed.reviewId}`);
    expect(read.status).toBe(200);
    // Not the merchant's words, not its link, not its ids.
    expect(JSON.stringify(read.body)).not.toMatch(/agent\.test|chk_|Sencha|handoff_url/);
    const events = await call('brain', 'GET', '/v1/workflow/events');
    expect(JSON.stringify(events.body)).not.toMatch(/agent\.test|chk_|Sencha/);
  });
});

describe('Brain buys through Core’s routes (UCP plan §3.7, U2.7)', () => {
  /** Brain's call, as the in-process phone or the signed service key makes it. */
  async function brain(path: string, body: Record<string, unknown>) {
    const router = new CoreRouter();
    registerUcpRoutes(router, 'cap');
    return router.handle({
      method: 'POST',
      path,
      query: {},
      headers: {},
      body: { release_session: SESSION, ...body },
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'brain',
      callerDID: 'did:key:brain',
    } as unknown as CoreRequest);
  }
  /** Nothing the merchant wrote, nor its ids or URLs. */
  const LEAKS = /Sencha|Earl Grey|Main street|Same day|gid:|chk_|li_|agent\.test|https?:/;

  beforeEach(() => {
    const carts = new UcpCartService({
      store,
      search: searchDeps.store,
      client: searchDeps.client,
      dispatcher: new UcpDispatcher({
        store,
        nowMs: () => clock,
        newKey: () => crypto.randomUUID(),
        holder: 'hc',
      }),
      settings: searchDeps.settings,
      ownerTurn: () => (ownerTurnAt === null ? null : (ownerTurnAt ?? clock)),
      nowMs: () => clock,
      newId: () => `${++n}`,
    });
    installUcpCheckoutRuntime({
      checkouts,
      carts,
      watcher: new UcpHandoffWatcher({ store, client: searchDeps.client, nowMs: () => clock }),
      orders: orderService(),
      orderStore: new UcpOrderStore(database.db),
      webhooks: webhookService(),
      links: new UcpLinkService({
        store: new UcpLinkStore(database.db),
        client: searchDeps.client,
        fetch: ucpFetch,
        clientId: () => null,
        redirectUri: () => null,
        nowMs: () => clock,
        randomBytes: (k) => crypto.getRandomValues(new Uint8Array(k)),
        sha256: (b) => sha256(b),
        newId: () => `l${++n}`,
        holder: 'test',
      }),
      notices: new UcpOrderNotices({
        store: new UcpOrderStore(database.db),
        workflow: () => workflow,
        nowMs: () => clock,
        newId: () => `n${++n}`,
      }),
      processWebhooks: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    });
  });
  afterEach(() => installUcpCheckoutRuntime(null));

  it('the owner asking about a purchase whose outcome is not known reads it once more (at most once a minute)', async () => {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await settled(session.session_id);
    expect((await checkouts.handoff(SESSION, session.session_id)).ok).toBe(true);
    const merchantId = store.getCheckout(session.session_id)?.merchant_checkout_id ?? '';
    // The watch gave up on it; the owner then paid in the browser.
    database.db.run(
      `UPDATE ucp_checkouts SET state = 'not_completed', watch_next_at = NULL, updated_at = ? WHERE session_id = ?`,
      [clock - 120_000, session.session_id],
    );
    shop.logic.completeInBrowser(merchantId);
    const before = sent('get_checkout').length;
    const read = await brain('/v1/ucp/checkout', { op: 'view', session_id: session.session_id });
    expect((read.body as { checkout: { state: string } }).checkout.state).toBe('completed');
    expect(sent('get_checkout').length).toBe(before + 1);
    // Looking again within the minute asks the shop nothing more.
    await brain('/v1/ucp/checkout', { op: 'view', session_id: session.session_id });
    expect(sent('get_checkout').length).toBe(before + 1);
  });

  it('propose, the owner’s yes, read, choose an offer, hand off: handles and codes only, never the merchant’s words', async () => {
    const proposed = await brain('/v1/ucp/checkout', {
      op: 'propose',
      lines: [
        { variant: 'v1.2', quantity: 2 },
        { variant: 'v2.1', quantity: 1 },
      ],
    });
    expect(proposed.status).toBe(201);
    const view = (proposed.body as { checkout: { session_id: string; state: string } }).checkout;
    expect(view).toMatchObject({ state: 'awaiting_approval', merchant: 'm1' });
    expect(JSON.stringify(proposed.body)).not.toMatch(LEAKS);
    // The owner says yes on the card (Brain cannot).
    workflow.approve(store.getCheckout(view.session_id)?.review_id ?? '');
    await settled(view.session_id);
    const read = await brain('/v1/ucp/checkout', { op: 'view', session_id: view.session_id });
    const open = (read.body as { checkout: Record<string, unknown> }).checkout;
    expect(open).toMatchObject({
      state: 'open',
      status: 'incomplete',
      lines: [
        { variant: 'v1.2', quantity: 2, total: { amount: '5600', currency: 'EUR' } },
        { variant: 'v2.1', quantity: 1, total: { amount: '900' } },
      ],
      totals: [
        { type: 'subtotal', amount: '6500' },
        { type: 'total', amount: '6500' },
      ],
      choices: [
        { choice: 'c1', method: 'pickup', chosen: false, cost: { amount: '0' } },
        { choice: 'c2', method: 'pickup', chosen: false },
      ],
    });
    expect(JSON.stringify(read.body)).not.toMatch(LEAKS);
    const rev = String(open.rev);
    const chose = await brain('/v1/ucp/checkout', {
      op: 'choose',
      session_id: view.session_id,
      choice: 'c2',
      rev,
    });
    expect(chose.status).toBe(200);
    const merchantId = store.getCheckout(view.session_id)?.merchant_checkout_id ?? '';
    expect(shop.logic.checkouts.get(merchantId)?.pickup).toEqual({
      destination: 'loc_main',
      option: 'next_day',
    });
    // A choice made against the read before that one is refused: the checkout changed.
    expect(
      (
        await brain('/v1/ucp/checkout', {
          op: 'choose',
          session_id: view.session_id,
          choice: 'c1',
          rev,
        })
      ).body,
    ).toEqual({ error: 'checkout_changed' });
    const handed = await brain('/v1/ucp/checkout', { op: 'handoff', session_id: view.session_id });
    expect((handed.body as { checkout: { state: string } }).checkout.state).toBe('handed_off');
    expect(JSON.stringify(handed.body)).not.toMatch(LEAKS);
  });

  it('a cart by handles through the route, and refusals as codes', async () => {
    const made = await brain('/v1/ucp/cart', {
      op: 'create',
      lines: [{ variant: 'v1.1', quantity: 1 }],
    });
    expect(made.status).toBe(200);
    expect(JSON.stringify(made.body)).not.toMatch(LEAKS);
    const cartId = (made.body as { cart: { cart_id: string } }).cart.cart_id;
    const read = await brain('/v1/ucp/cart', { op: 'read', cart_id: cartId });
    expect(read.body).toMatchObject({ outcome: 'settled', cart: { state: 'open' } });
    expect(JSON.stringify(read.body)).not.toMatch(LEAKS);
    const cancelled = await brain('/v1/ucp/cart', { op: 'cancel', cart_id: cartId });
    expect(cancelled.body).toMatchObject({ cart: { state: 'gone' } });
    expect((await brain('/v1/ucp/cart', { op: 'read', cart_id: cartId })).body).toEqual({
      error: 'cart_gone',
    });
    expect(
      (await brain('/v1/ucp/cart', { op: 'create', lines: [{ variant: 'v9.9', quantity: 1 }] }))
        .body,
    ).toEqual({
      error: 'unknown_variant',
    });
    expect((await brain('/v1/ucp/checkout', { op: 'view', session_id: 'nope' })).status).toBe(404);
    expect((await brain('/v1/ucp/checkout', { op: 'buy' })).status).toBe(400);
  });

  it('only Brain may call them', async () => {
    const router = new CoreRouter();
    registerUcpRoutes(router, 'cap');
    const res = await router.handle({
      method: 'POST',
      path: '/v1/ucp/checkout',
      query: {},
      headers: {},
      body: { release_session: SESSION, op: 'view', session_id: 'x' },
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'agent',
      callerDID: 'did:key:agent',
    } as unknown as CoreRequest);
    expect(res.status).toBe(403);
  });
});

describe('after the hand-off: the watcher (UCP plan §3.12, U3.1) and the order (§3.14, U3.2)', () => {
  let watcher: UcpHandoffWatcher;
  let orders: UcpOrderService;
  const completed: string[] = [];
  beforeEach(() => {
    completed.length = 0;
    orders = orderService();
    watcher = new UcpHandoffWatcher({
      store,
      client: searchDeps.client,
      nowMs: () => clock,
      onCompleted: (row, now) => {
        completed.push(row.session_id);
        orders.track(row, now);
      },
    });
  });

  /** A session handed off to its own page, and the merchant's copy of it. */
  async function handedOff() {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await settled(session.session_id);
    const out = await checkouts.handoff(SESSION, session.session_id);
    if (!out.ok) throw new Error(out.reason);
    const row = store.getCheckout(session.session_id);
    const held = shop.logic.checkouts.get(row?.merchant_checkout_id ?? '');
    if (row === null || held === undefined) throw new Error('no session');
    return { id: session.session_id, row, held };
  }
  const gets = () => shop.requests.filter((r) => r.operation === 'get_checkout').length;

  it('reads at +2, +10 and +30 minutes, then hourly; a purchase made in the browser is recorded with its order', async () => {
    const { id, row } = await handedOff();
    expect(row.watch_next_at).toBe((row.handed_off_at ?? 0) + 2 * 60_000);
    expect([0, 1, 2, 3, 4].map((n) => watchReadAt(0, n) / 60_000)).toEqual([2, 10, 30, 90, 150]);
    const before = gets();
    await watcher.sweep();
    expect(gets()).toBe(before); // not due yet
    clock = row.watch_next_at as number;
    await watcher.sweep();
    expect(store.getCheckout(id)).toMatchObject({
      state: 'handed_off',
      watch_reads: 1,
      last_status: 'incomplete',
    });
    expect(store.getCheckout(id)?.watch_next_at).toBe((row.handed_off_at ?? 0) + 10 * 60_000);
    // The owner pays on the merchant's page.
    shop.logic.completeInBrowser(row.merchant_checkout_id ?? '');
    clock = store.getCheckout(id)?.watch_next_at as number;
    await watcher.sweep();
    const done = store.getCheckout(id);
    expect(done).toMatchObject({
      state: 'completed',
      last_status: 'completed',
      watch_next_at: null,
    });
    expect(done?.order_id).toMatch(/^ord_/);
    expect(done?.order_permalink_url).toContain('/orders/');
    expect(completed).toEqual([id]);
  });

  it('cancelled at the merchant: recorded; gone there before any terminal answer: unknown', async () => {
    const a = await handedOff();
    a.held.status = 'canceled';
    clock = a.row.watch_next_at as number;
    await watcher.sweep();
    expect(store.getCheckout(a.id)?.state).toBe('canceled');
    const b = await handedOff();
    shop.logic.checkouts.delete(b.row.merchant_checkout_id ?? '');
    clock = Math.max(clock, b.row.watch_next_at as number);
    await watcher.sweep();
    expect(store.getCheckout(b.id)?.state).toBe('unknown');
  });

  it('still completing at the expiry: unknown, and never asked again, not even on a reopen', async () => {
    const { id, row, held } = await handedOff();
    (held as { status: string }).status = 'complete_in_progress';
    clock = row.watch_next_at as number;
    await watcher.sweep();
    expect(store.getCheckout(id)).toMatchObject({
      state: 'handed_off',
      last_status: 'complete_in_progress',
    });
    // The merchant keeps it past the expiry Dina knew, so only Dina's rule can stop the reads.
    held.expiresAt = clock + 48 * 60 * 60_000;
    const expiry = row.effective_expires_at as number;
    // Sweep each wake until it settles: no wake falls after the expiry, and none at it reads.
    let reads = gets();
    for (let i = 0; i < 20 && store.getCheckout(id)?.state === 'handed_off'; i++) {
      const next = store.getCheckout(id)?.watch_next_at as number;
      expect(next).toBeLessThanOrEqual(expiry);
      clock = next;
      reads = gets();
      await watcher.sweep();
    }
    expect(clock).toBe(expiry);
    expect(gets()).toBe(reads);
    expect(store.getCheckout(id)).toMatchObject({ state: 'unknown', watch_next_at: null });
    const before = gets();
    await watcher.recover();
    expect(gets()).toBe(before);
  });

  it('still open an hour past its expiry: not completed; a reopen within 7 days that finds it completed records the order', async () => {
    const { id, row, held } = await handedOff();
    // The merchant keeps the session past the expiry Dina knew.
    held.expiresAt = clock + 48 * 60 * 60_000;
    clock = (row.effective_expires_at as number) + 60 * 60_000;
    database.db.run(`UPDATE ucp_checkouts SET watch_next_at = ? WHERE session_id = ?`, [clock, id]);
    await watcher.sweep();
    expect(store.getCheckout(id)).toMatchObject({ state: 'not_completed', watch_next_at: null });
    shop.logic.completeInBrowser(row.merchant_checkout_id ?? '');
    clock += 24 * 60 * 60_000;
    await watcher.recover();
    expect(store.getCheckout(id)?.state).toBe('completed');
    expect(completed).toEqual([id]);
  });

  it('a restart between reads carries on from the stored schedule (T-U3-1)', async () => {
    const { id, row } = await handedOff();
    clock = row.watch_next_at as number;
    await watcher.sweep();
    expect(store.getCheckout(id)?.watch_reads).toBe(1);
    // A new process: fresh services and watcher on the same database.
    services();
    const restarted = new UcpHandoffWatcher({
      store,
      client: searchDeps.client,
      nowMs: () => clock,
    });
    const due = store.getCheckout(id)?.watch_next_at as number;
    expect(due).toBe((row.handed_off_at as number) + 10 * 60_000);
    clock = due - 1;
    const before = gets();
    await restarted.sweep();
    expect(gets()).toBe(before);
    clock = due;
    await restarted.sweep();
    expect(store.getCheckout(id)).toMatchObject({ watch_reads: 2 });
    expect(store.getCheckout(id)?.watch_next_at).toBe((row.handed_off_at as number) + 30 * 60_000);
  });

  it('paid while the phone was closed, the app reopened the next day: the first read records the order (T-U3-2)', async () => {
    const { id, row, held } = await handedOff();
    held.expiresAt = clock + 48 * 60 * 60_000;
    shop.logic.completeInBrowser(row.merchant_checkout_id ?? '');
    // No sweep ran: the phone was closed through every scheduled read and past the deadline.
    clock = (row.effective_expires_at as number) + 24 * 60 * 60_000;
    await watcher.recover();
    await watcher.sweep();
    expect(store.getCheckout(id)?.state).toBe('completed');
    expect(completed).toEqual([id]);
  });

  it('closed past the deadline and not paid: the first read after reopening says not completed', async () => {
    const { id, row, held } = await handedOff();
    held.expiresAt = clock + 48 * 60 * 60_000;
    clock = (row.effective_expires_at as number) + 24 * 60 * 60_000;
    await watcher.sweep();
    expect(store.getCheckout(id)).toMatchObject({ state: 'not_completed', watch_next_at: null });
    expect(sent('get_checkout').length).toBeGreaterThan(0);
  });

  it('the runtime as a node builds it: a start reads what was handed off lately, and a completion it sees becomes a followed order', async () => {
    const { id, row } = await handedOff();
    database.db.run(
      `UPDATE ucp_checkouts SET state = 'not_completed', watch_next_at = NULL WHERE session_id = ?`,
      [id],
    );
    shop.logic.completeInBrowser(row.merchant_checkout_id ?? '');
    const rt = createUcpCheckoutRuntime(database.db, {
      client: { identity: () => IDENTITY, profileHost: PROFILE_HOST, now: () => clock },
    });
    try {
      rt.start();
      for (let i = 0; i < 100 && store.getCheckout(id)?.state !== 'completed'; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(store.getCheckout(id)?.state).toBe('completed');
      expect(rt.orderStore.bySession(id)).toMatchObject({ state: 'open' });
      // A second start does not read again.
      const before = gets();
      rt.start();
      await new Promise((r) => setTimeout(r, 50));
      expect(gets()).toBe(before);
    } finally {
      rt.stop();
    }
  });

  it('a session still open at backup time, handed off and paid after it, is read and completed on the restored node', async () => {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await settled(session.session_id);
    // The backup: rows in their archived form.
    const backup = ucpRowsForArchive(
      'ucp_checkouts',
      database.db.query(`SELECT * FROM ucp_checkouts`),
      clock,
    );
    // After the backup the owner was handed off and paid.
    expect((await checkouts.handoff(SESSION, session.session_id)).ok).toBe(true);
    shop.logic.completeInBrowser(store.getCheckout(session.session_id)?.merchant_checkout_id ?? '');
    // Restored onto a new device from that backup: the import puts the rows in their restored
    // form again, as a real archive does.
    clock += 60_000;
    database.db.run(`DELETE FROM ucp_checkouts`);
    for (const r of ucpRowsForArchive('ucp_checkouts', backup, clock)) {
      const cols = Object.keys(r);
      database.db.run(
        `INSERT INTO ucp_checkouts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        cols.map((c) => r[c]),
      );
    }
    expect(store.getCheckout(session.session_id)).toMatchObject({
      state: 'unknown',
      watch_next_at: clock,
    });
    services();
    await watcher.sweep();
    expect(store.getCheckout(session.session_id)).toMatchObject({
      state: 'completed',
      prompted_at: null,
    });
    expect(completed).toContain(session.session_id);
  });

  it('an answer about another checkout is not this session’s: nothing is recorded from it', async () => {
    const a = await handedOff();
    const b = await handedOff();
    shop.logic.completeInBrowser(b.row.merchant_checkout_id ?? '');
    // The merchant answers for A with B's completed session.
    shop.logic.checkouts.set(a.row.merchant_checkout_id ?? '', b.held);
    clock = Math.max(a.row.watch_next_at as number, clock);
    database.db.run(`UPDATE ucp_checkouts SET watch_next_at = ? WHERE session_id = ?`, [
      clock,
      b.id,
    ]);
    await watcher.sweep();
    expect(store.getCheckout(a.id)).toMatchObject({ state: 'handed_off', order_id: null });
    expect(completed).not.toContain(a.id);
  });

  it('after a long gap the next read is the next hourly slot, never a burst of catch-up reads', async () => {
    const { id, row, held } = await handedOff();
    held.expiresAt = clock + 48 * 60 * 60_000;
    const h = row.handed_off_at as number;
    clock = h + 2 * 60_000;
    await watcher.sweep();
    clock = h + 10 * 60_000;
    await watcher.sweep();
    // The phone was closed until +5 h.
    clock = h + 5 * 60 * 60_000;
    const before = gets();
    await watcher.sweep();
    expect(gets()).toBe(before + 1);
    expect(store.getCheckout(id)?.watch_next_at).toBe(h + 30 * 60_000 + 5 * 60 * 60_000);
    clock += 60_000;
    await watcher.sweep();
    expect(gets()).toBe(before + 1);
  });

  it('completing first seen at or after the expiry: unknown, and never asked again', async () => {
    const { id, row, held } = await handedOff();
    held.expiresAt = clock + 48 * 60 * 60_000;
    (held as { status: string }).status = 'complete_in_progress';
    clock = row.effective_expires_at as number;
    database.db.run(`UPDATE ucp_checkouts SET watch_next_at = ? WHERE session_id = ?`, [clock, id]);
    await watcher.sweep();
    expect(store.getCheckout(id)).toMatchObject({
      state: 'unknown',
      last_status: 'complete_in_progress',
      watch_next_at: null,
    });
    const before = gets();
    clock += 24 * 60 * 60_000;
    await watcher.sweep();
    await watcher.recover();
    expect(gets()).toBe(before);
  });

  it('a merchant that never answers until the deadline: unknown, never "not completed"', async () => {
    const { id, row } = await handedOff();
    for (let i = 0; i < 30 && store.getCheckout(id)?.state === 'handed_off'; i++) {
      clock = store.getCheckout(id)?.watch_next_at as number;
      drop.add('get_checkout');
      await watcher.sweep();
    }
    expect(clock).toBeGreaterThanOrEqual((row.effective_expires_at as number) + 60 * 60_000);
    expect(store.getCheckout(id)).toMatchObject({ state: 'unknown', watch_next_at: null });
  });

  it('a recovery read that finds it completing past the expiry is kept: the next reopen does not ask again', async () => {
    const { id, row, held } = await handedOff();
    held.expiresAt = clock + 48 * 60 * 60_000;
    clock = (row.effective_expires_at as number) + 60 * 60_000;
    database.db.run(`UPDATE ucp_checkouts SET watch_next_at = ? WHERE session_id = ?`, [clock, id]);
    await watcher.sweep();
    expect(store.getCheckout(id)?.state).toBe('not_completed');
    (held as { status: string }).status = 'complete_in_progress';
    clock += 24 * 60 * 60_000;
    const before = gets();
    await watcher.recover();
    expect(gets()).toBe(before + 1);
    expect(store.getCheckout(id)).toMatchObject({
      state: 'not_completed',
      last_status: 'complete_in_progress',
    });
    await watcher.recover();
    expect(gets()).toBe(before + 1);
  });

  it('a permalink hand-off is never watched: Dina cannot follow it', async () => {
    continueUrlOn = false;
    const { id, row } = await handedOff();
    expect(row).toMatchObject({ handoff_source: 'permalink', watch_next_at: null });
    // Nor read on a reopen, nor prompted by a webhook.
    const before = gets();
    await watcher.recover();
    expect(store.promptWatch(id, clock)).toBe(false);
    await watcher.sweep();
    expect(gets()).toBe(before);
    expect(store.getCheckout(id)?.state).toBe('handed_off');
  });

  it('a purchase made in the browser becomes an order Dina follows: Get Order reads it, a shipment is recorded quietly, a cancellation interrupts', async () => {
    const { id, row } = await handedOff();
    shop.logic.completeInBrowser(row.merchant_checkout_id ?? '');
    clock = row.watch_next_at as number;
    await watcher.sweep();
    const done = store.getCheckout(id);
    const key = { merchant_origin: shop.origin, order_id: done?.order_id ?? '' };
    const orderStore = new UcpOrderStore(database.db);
    // The completion and the order row landed together; its first read is due at once.
    expect(orderStore.get(key)).toMatchObject({
      session_id: id,
      state: 'open',
      next_poll_at: clock,
    });
    await orders.sweep();
    expect(sent('get_order')).toHaveLength(1);
    const summary = () => JSON.parse(orderStore.get(key)?.summary_json ?? 'null');
    expect(summary()).toMatchObject({
      currency: 'EUR',
      lines: [
        { title: expect.stringContaining('Sencha'), quantity: '2', status: 'processing' },
        { title: expect.stringContaining('Earl Grey'), quantity: '1', status: 'processing' },
      ],
      settled: false,
    });
    const held = shop.logic.orders.get(key.order_id);
    if (held === undefined) throw new Error('no order at the merchant');
    held.events.push({
      id: 'e1',
      type: 'shipped',
      occurredAt: clock,
      lineItems: [],
      trackingNumber: 'TRK1',
    });
    clock += 15 * 60_000;
    await orders.sweep();
    expect(summary().latest_event).toMatchObject({ type: 'shipped' });
    expect(JSON.parse(orderStore.get(key)?.notices_json ?? '[]')).toEqual([]);
    held.adjustments.push({ id: 'c1', type: 'cancellation', occurredAt: clock, status: 'pending' });
    clock += 15 * 60_000;
    await orders.sweep();
    expect(JSON.parse(orderStore.get(key)?.notices_json ?? '[]')).toMatchObject([
      { kind: 'adjustment', type: 'cancellation', reason: 'new' },
    ]);
  });
});

describe('order webhooks (UCP plan §3.13, U3.3)', () => {
  let watcher: UcpHandoffWatcher;
  let orders: UcpOrderService;
  let webhooks: UcpWebhookService;
  const orderStore = () => new UcpOrderStore(database.db);
  const inbox = () => new UcpWebhookStore(database.db).inboxSize();
  beforeEach(() => {
    orders = orderService(true);
    webhooks = webhookService(orders);
    watcher = new UcpHandoffWatcher({
      store,
      client: searchDeps.client,
      nowMs: () => clock,
      onCompleted: (row, now) => orders.track(row, now),
    });
  });

  /** Hand a delivery to Core as the gateway would. */
  const deliver = (w: { url: string; headers: Record<string, string>; body: Buffer }) =>
    webhooks.accept(
      ucpWebhookEnvelope(new URL(w.url).pathname, '', w.headers, new Uint8Array(w.body)),
    );

  async function handedOff() {
    const session = await proposeSencha();
    workflow.approve(session.review_id);
    await settled(session.session_id);
    const out = await checkouts.handoff(SESSION, session.session_id);
    if (!out.ok) throw new Error(out.reason);
    const row = store.getCheckout(session.session_id);
    if (row === null) throw new Error('no session');
    return { id: session.session_id, merchantId: row.merchant_checkout_id ?? '' };
  }

  /** A purchase completed in the browser and followed: its order key. */
  async function followed() {
    const { id, merchantId } = await handedOff();
    shop.logic.completeInBrowser(merchantId);
    clock = store.getCheckout(id)?.watch_next_at as number;
    await watcher.sweep();
    const orderId = store.getCheckout(id)?.order_id ?? '';
    await orders.sweep();
    return { id, merchantId, key: { merchant_origin: shop.origin, order_id: orderId } };
  }

  it('a delivery about nothing Dina holds is dropped unfetched, with a 200', async () => {
    const before = shop.requests.length;
    const answer = deliver(
      shop.webhook(NODE_WEBHOOK_URL, 'ord_x', { body: { id: 'ord_x', checkout_id: 'co_x' } }),
    );
    expect(answer).toEqual({ status: 200, body: { ucp: { version: '2026-08-25' } } });
    expect(inbox()).toBe(0);
    await webhooks.sweep();
    expect(shop.requests.length).toBe(before);
  });

  it('a valid webhook before the watcher’s first read settles the session at once, with no Get Checkout', async () => {
    const { id, merchantId } = await handedOff();
    shop.logic.completeInBrowser(merchantId);
    const orderId = shop.logic.checkouts.get(merchantId)?.orderId ?? '';
    deliver(shop.webhook(NODE_WEBHOOK_URL, orderId));
    expect(inbox()).toBe(1);
    const reads = sent('get_checkout').length;
    await webhooks.sweep();
    expect(inbox()).toBe(0);
    // The signed order is the merchant's word: completed, its order followed.
    expect(store.getCheckout(id)).toMatchObject({ state: 'completed', order_id: orderId });
    expect(orderStore().bySession(id)?.state).toBe('open');
    expect(sent('get_checkout').length).toBe(reads);
  });

  it('a signed order settles a session the watcher may no longer ask about (completing past its expiry)', async () => {
    const { id, merchantId } = await handedOff();
    database.db.run(
      `UPDATE ucp_checkouts SET last_status = 'complete_in_progress', state = 'unknown', watch_next_at = NULL WHERE session_id = ?`,
      [id],
    );
    clock = (store.getCheckout(id)?.effective_expires_at as number) + 60_000;
    shop.logic.completeInBrowser(merchantId);
    const orderId = shop.logic.checkouts.get(merchantId)?.orderId ?? '';
    const reads = sent('get_checkout').length;
    deliver(shop.webhook(NODE_WEBHOOK_URL, orderId));
    await webhooks.sweep();
    expect(store.getCheckout(id)?.state).toBe('completed');
    expect(orderStore().bySession(id)).not.toBeNull();
    expect(sent('get_checkout').length).toBe(reads);
  });

  it('a session Get Checkout called gone (unknown) is completed by a later signed order', async () => {
    const { id, merchantId } = await handedOff();
    shop.logic.completeInBrowser(merchantId);
    const orderId = shop.logic.checkouts.get(merchantId)?.orderId ?? '';
    const held = shop.logic.checkouts.get(merchantId);
    shop.logic.checkouts.delete(merchantId);
    clock = store.getCheckout(id)?.watch_next_at as number;
    await watcher.sweep();
    expect(store.getCheckout(id)?.state).toBe('unknown');
    if (held !== undefined) shop.logic.checkouts.set(merchantId, held);
    deliver(shop.webhook(NODE_WEBHOOK_URL, orderId));
    await webhooks.sweep();
    expect(store.getCheckout(id)?.state).toBe('completed');
  });

  it('a prompt that lands while a Get Order is in flight is not lost to that read', async () => {
    const { key } = await followed();
    // A scheduled poll asks, and its answer is held.
    let release: (() => void) | undefined;
    hold = (op) =>
      op === 'get_order'
        ? new Promise<void>((r) => {
            release = r;
          })
        : undefined;
    clock = orderStore().get(key)?.next_poll_at as number;
    const polling = orders.sweep();
    // Until the merchant holds the read (never a fixed wait).
    for (let i = 0; i < 200 && typeof release !== 'function'; i++)
      await new Promise((r) => setTimeout(r, 5));
    // Meanwhile a webhook prompts the order.
    hold = null;
    clock += 1000;
    const promptedAt = clock;
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id));
    await webhooks.sweep();
    release?.();
    await polling;
    // The older read could not answer the newer prompt: still due at it, not a day away.
    expect(orderStore().get(key)).toMatchObject({
      prompted_at: promptedAt,
      next_poll_at: promptedAt,
    });
    await orders.sweep();
    expect(orderStore().get(key)).toMatchObject({
      prompted_at: null,
      next_poll_at: clock + 24 * 60 * 60_000,
    });
  });

  it('a prompted Get Order that fails is tried again within minutes, not on the daily schedule', async () => {
    const { key } = await followed();
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id));
    await webhooks.sweep();
    drop.add('get_order');
    await orders.sweep();
    expect(orderStore().get(key)).toMatchObject({
      prompted_at: clock,
      next_poll_at: clock + 2 * 60_000,
    });
    clock += 2 * 60_000;
    await orders.sweep();
    expect(orderStore().get(key)).toMatchObject({
      prompted_at: null,
      next_poll_at: clock + 24 * 60 * 60_000,
    });
  });

  it('a key the merchant publishes after signing with it (a rotation) is found on a later read, and the delivery counts once', async () => {
    const { key } = await followed();
    deliver(
      shop.webhook(NODE_WEBHOOK_URL, key.order_id, { key: 'unlisted', webhookId: 'evt_rot' }),
    );
    await webhooks.sweep();
    expect(inbox()).toBe(1);
    expect(orderStore().get(key)?.prompted_at).toBeNull();
    secondKeyListed = true;
    // The profile is re-read at most once a minute; the retry comes after that.
    clock += 2 * 60_000;
    await webhooks.sweep();
    expect(inbox()).toBe(0);
    expect(orderStore().get(key)?.prompted_at).toBe(clock);
    const seen = database.db.query(
      `SELECT COUNT(*) AS n FROM ucp_webhook_seen WHERE webhook_id = 'evt_rot'`,
    );
    expect(Number(seen[0]?.n)).toBe(1);
  });

  it('webhooks turned off after a delivery was stored: it is dropped unchecked, and nothing is fetched or prompted', async () => {
    const { key } = await followed();
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id));
    expect(inbox()).toBe(1);
    nodeWebhookUrl = null;
    const before = shop.requests.length;
    await webhooks.sweep();
    expect(inbox()).toBe(0);
    expect(shop.requests.length).toBe(before);
    expect(orderStore().get(key)?.prompted_at).toBeNull();
    // At the door too: a 200, nothing kept.
    expect(deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id))).toMatchObject({ status: 200 });
    expect(inbox()).toBe(0);
  });

  it('the same Webhook-Id already seen from another merchant does not suppress this one', async () => {
    const { key } = await followed();
    database.db.run(
      `INSERT INTO ucp_webhook_seen (merchant_origin, webhook_id, seen_at) VALUES ('https://other-shop.example', 'evt_same', ?)`,
      [clock],
    );
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id, { webhookId: 'evt_same' }));
    await webhooks.sweep();
    expect(orderStore().get(key)?.prompted_at).toBe(clock);
  });

  /** A purchase completed and followed, with no poll of the order yet: its key. */
  async function trackedNotPolled() {
    const { id, merchantId } = await handedOff();
    shop.logic.completeInBrowser(merchantId);
    clock = store.getCheckout(id)?.watch_next_at as number;
    await watcher.sweep();
    const key = { merchant_origin: shop.origin, order_id: store.getCheckout(id)?.order_id ?? '' };
    expect(orderStore().get(key)?.state).toBe('open');
    return key;
  }

  it('a webhook before the first poll is kept: when the merchant then will not share the order, its body is what Dina has (dual review R1-6)', async () => {
    orderSharing = 'unauthorized';
    const key = await trackedNotPolled();
    const held = shop.logic.orders.get(key.order_id);
    if (held === undefined) throw new Error('no order');
    for (const l of held.lines) {
      l.status = 'fulfilled';
      l.fulfilled = l.quantity;
    }
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id));
    await webhooks.sweep();
    expect(orderStore().get(key)?.pushed_json).not.toBeNull();
    await orders.sweep();
    const row = orderStore().get(key);
    expect(row?.state).toBe('not_shared');
    expect(JSON.parse(row?.summary_json ?? '{}')).toMatchObject({ settled: true, as_sent: true });
    expect(row?.pushed_json).toBeNull();
  });

  it('many webhooks before the merchant is found not to share: a dispute seen only in the first still raises its card (dual review R2-2)', async () => {
    orderSharing = 'unauthorized';
    const key = await trackedNotPolled();
    const held = shop.logic.orders.get(key.order_id);
    if (held === undefined) throw new Error('no order');
    held.adjustments.push({
      id: 'adj_dispute',
      type: 'dispute',
      occurredAt: clock,
      status: 'pending',
    });
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id));
    // The merchant then leaves it out of every later body, more than any cap on kept bodies.
    held.adjustments = [];
    for (let i = 0; i < 22; i++) deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id));
    await webhooks.sweep();
    await orders.sweep();
    const row = orderStore().get(key);
    expect(row?.state).toBe('not_shared');
    expect(JSON.parse(row?.notices_json ?? '[]')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'adjustment', id: 'adj_dispute', type: 'dispute' }),
      ]),
    );
    expect(row?.pushed_json).toBeNull();
  });

  it('raw webhook bodies never outlive the order: closing drops them, and an archive leaves them out (dual review R2-4)', async () => {
    const key = await trackedNotPolled();
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id));
    await webhooks.sweep();
    const row = database.db.query(
      `SELECT * FROM ucp_orders WHERE merchant_origin = ? AND order_id = ?`,
      [key.merchant_origin, key.order_id],
    )[0] as Record<string, unknown>;
    expect(row.pushed_json).not.toBeNull();
    expect(ucpOrderForArchive(row as never, clock)?.pushed_json).toBeNull();
    // Aged out while bodies wait: closed, and they go with the snapshot.
    clock += 181 * 86_400_000;
    await orders.sweep();
    expect(orderStore().get(key)).toMatchObject({
      state: 'closed',
      pushed_json: null,
      snapshot_json: null,
    });
  });

  it('a webhook before the first poll is let go once Get Order answers after it', async () => {
    const key = await trackedNotPolled();
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id));
    await webhooks.sweep();
    expect(orderStore().get(key)?.pushed_json).not.toBeNull();
    clock += 1;
    await orders.sweep();
    expect(orderStore().get(key)).toMatchObject({ state: 'open', pushed_json: null });
  });

  it('a webhook-only order: a quantity edited up after a line was fulfilled is shown as sent, never closes it, and raises nothing', async () => {
    orderSharing = 'unauthorized';
    const { key } = await followed();
    const held = shop.logic.orders.get(key.order_id);
    if (held === undefined) throw new Error('no order');
    for (const l of held.lines) {
      l.status = 'fulfilled';
      l.fulfilled = l.quantity;
    }
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id));
    await webhooks.sweep();
    expect(JSON.parse(orderStore().get(key)?.summary_json ?? '{}')).toMatchObject({
      settled: true,
      as_sent: true,
    });
    const first = held.lines[0];
    if (first === undefined) throw new Error('no line');
    first.quantity += 2;
    first.status = 'partial';
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id));
    await webhooks.sweep();
    const row = orderStore().get(key);
    expect(JSON.parse(row?.summary_json ?? '{}').lines[0]).toMatchObject({
      quantity: String(first.quantity),
      status: 'partial',
    });
    expect(row).toMatchObject({
      state: 'not_shared',
      next_poll_at: (row?.created_at as number) + 180 * 86_400_000,
    });
    expect(JSON.parse(row?.notices_json ?? '[]')).toEqual([]);
  });

  it('a prompted read of a settled session that fails is tried again; a body that is not an order only prompts', async () => {
    const { id, merchantId } = await handedOff();
    database.db.run(
      `UPDATE ucp_checkouts SET state = 'not_completed', watch_next_at = NULL WHERE session_id = ?`,
      [id],
    );
    // A delivery whose body is not an order (only the two ids): it prompts a Get Checkout.
    deliver(
      shop.webhook(NODE_WEBHOOK_URL, 'ord_none', {
        body: { id: 'ord_none', checkout_id: merchantId },
      }),
    );
    await webhooks.sweep();
    expect(store.getCheckout(id)).toMatchObject({ prompted_at: clock, watch_next_at: clock });
    drop.add('get_checkout');
    await watcher.sweep();
    expect(store.getCheckout(id)).toMatchObject({
      state: 'not_completed',
      watch_next_at: clock + 2 * 60_000,
    });
    shop.logic.completeInBrowser(merchantId);
    clock += 2 * 60_000;
    await watcher.sweep();
    expect(store.getCheckout(id)).toMatchObject({ state: 'completed', prompted_at: null });
  });

  it('a prompted session whose merchant never answers is asked for a day, then no more', async () => {
    const { id, merchantId } = await handedOff();
    database.db.run(
      `UPDATE ucp_checkouts SET state = 'not_completed', watch_next_at = NULL WHERE session_id = ?`,
      [id],
    );
    deliver(
      shop.webhook(NODE_WEBHOOK_URL, 'ord_none', {
        body: { id: 'ord_none', checkout_id: merchantId },
      }),
    );
    await webhooks.sweep();
    const promptedAt = clock;
    drop.add('get_checkout');
    let reads = 0;
    // Each wake the merchant fails to answer, until the prompt's day is out.
    for (let i = 0; i < 100 && store.getCheckout(id)?.watch_next_at != null; i++) {
      clock = store.getCheckout(id)?.watch_next_at as number;
      drop.add('get_checkout');
      await watcher.sweep();
      reads++;
    }
    expect(reads).toBeGreaterThan(5);
    expect(clock - promptedAt).toBeGreaterThanOrEqual(24 * 60 * 60_000);
    expect(store.getCheckout(id)).toMatchObject({
      state: 'not_completed',
      watch_next_at: null,
      prompted_at: null,
    });
    const before = sent('get_checkout').length;
    clock += 7 * 24 * 60 * 60_000;
    await watcher.sweep();
    expect(sent('get_checkout').length).toBe(before);
  });

  it('restored onto a new device (rows in their restored form, new services): Get Order on the order still succeeds', async () => {
    const { id, key } = await followed();
    // What an archive carries back, put in place as the import does.
    for (const table of UCP_ARCHIVE_TABLES) {
      const rows = ucpRowsForArchive(table, database.db.query(`SELECT * FROM ${table}`), clock);
      database.db.run(`DELETE FROM ${table}`);
      for (const r of rows) {
        const cols = Object.keys(r);
        database.db.run(
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          cols.map((c) => r[c]),
        );
      }
    }
    expect(store.getCheckout(id)?.state).toBe('completed');
    expect(orderStore().get(key)).toMatchObject({
      state: 'open',
      next_poll_at: clock,
      lease_holder: null,
    });
    const held = shop.logic.orders.get(key.order_id);
    held?.events.push({ id: 'e1', type: 'delivered', occurredAt: clock, lineItems: [] });
    const before = sent('get_order').length;
    services();
    await orderService(true).sweep();
    expect(sent('get_order').length).toBe(before + 1);
    expect(JSON.parse(orderStore().get(key)?.summary_json ?? '{}').latest_event).toMatchObject({
      type: 'delivered',
    });
  });

  it('webhook-only orders close once the node stops taking webhooks', async () => {
    orderSharing = 'unauthorized';
    const { key } = await followed();
    expect(orderStore().get(key)?.state).toBe('not_shared');
    const polling = new UcpOrderService({
      store: new UcpOrderStore(database.db),
      client: searchDeps.client,
      nowMs: () => clock,
      holder: 'test',
      takesWebhooks: () => false,
    });
    await polling.sweep();
    expect(orderStore().get(key)).toMatchObject({ state: 'closed', close_reason: 'not_shared' });
  });

  it('a delivery stored before a crash is verified by the next process', async () => {
    const { key } = await followed();
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id));
    expect(inbox()).toBe(1);
    // A new process: a fresh service on the same database.
    await webhookService(orders).sweep();
    expect(inbox()).toBe(0);
    expect(orderStore().get(key)?.prompted_at).toBe(clock);
  });

  it('a crash after verification, before its record is written, verifies again and counts once', async () => {
    const { key } = await followed();
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id, { webhookId: 'evt_crash' }));
    const seen = jest.spyOn(UcpWebhookStore.prototype, 'markSeen').mockImplementationOnce(() => {
      throw new Error('crash');
    });
    await webhooks.sweep();
    seen.mockRestore();
    // Nothing recorded; the delivery waits for its retry.
    expect(inbox()).toBe(1);
    expect(orderStore().get(key)?.prompted_at).toBeNull();
    clock += 60_000;
    await webhooks.sweep();
    expect(inbox()).toBe(0);
    expect(orderStore().get(key)?.prompted_at).toBe(clock);
    const seenRows = database.db.query(
      `SELECT COUNT(*) AS n FROM ucp_webhook_seen WHERE webhook_id = 'evt_crash'`,
    );
    expect(Number(seenRows[0]?.n)).toBe(1);
  });

  it('two merchants holding the same order id: each delivery reaches only its sender’s order', async () => {
    const { key } = await followed();
    const other = { merchant_origin: 'https://other-shop.example', order_id: key.order_id };
    new UcpOrderStore(database.db).insert({
      ...other,
      checkout_id: 'co_other',
      session_id: null,
      leaf_profile_url: 'https://other-shop.example/.well-known/ucp',
      permalink_url: 'https://other-shop.example/orders/x',
      version: '2026-08-25',
      transport: 'rest',
      record_json: '{"events":{},"adjustments":{}}',
      next_poll_at: clock + 60 * 60_000,
      created_at: clock,
    });
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id));
    await webhooks.sweep();
    expect(orderStore().get(key)?.prompted_at).toBe(clock);
    expect(orderStore().get(other)).toMatchObject({
      prompted_at: null,
      next_poll_at: clock + 60 * 60_000,
    });
  });

  it('a session negotiated through a version leaf is found by its origin when the webhook names the root profile', async () => {
    const { id, merchantId } = await handedOff();
    database.db.run(`UPDATE ucp_checkouts SET leaf_profile_url = ? WHERE session_id = ?`, [
      `${shop.origin}/ucp/v2026-08-25.json`,
      id,
    ]);
    shop.logic.completeInBrowser(merchantId);
    deliver(shop.webhook(NODE_WEBHOOK_URL, shop.logic.checkouts.get(merchantId)?.orderId ?? ''));
    await webhooks.sweep();
    expect(store.getCheckout(id)?.state).toBe('completed');
  });

  it('an open order is prompted to poll now; a replay of the same Webhook-Id adds nothing', async () => {
    const { key } = await followed();
    const daily = orderStore().get(key)?.next_poll_at as number;
    expect(daily).toBe(clock + 24 * 60 * 60_000);
    const held = shop.logic.orders.get(key.order_id);
    held?.events.push({ id: 'e1', type: 'shipped', occurredAt: clock, lineItems: [] });
    const w = shop.webhook(NODE_WEBHOOK_URL, key.order_id, { webhookId: 'evt_ship' });
    deliver(w);
    await webhooks.sweep();
    expect(orderStore().get(key)?.next_poll_at).toBe(clock);
    await orders.sweep();
    expect(JSON.parse(orderStore().get(key)?.summary_json ?? '{}').latest_event).toMatchObject({
      type: 'shipped',
    });
    // The same delivery again: taken, verified, and adds nothing.
    deliver(w);
    await webhooks.sweep();
    expect(inbox()).toBe(0);
    expect(orderStore().get(key)?.next_poll_at).toBe(clock + 24 * 60 * 60_000);
  });

  it('an invalid delivery records nothing, so a valid one with the same Webhook-Id still counts', async () => {
    const { key } = await followed();
    const settledPoll = orderStore().get(key)?.next_poll_at;
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id, { webhookId: 'evt_1', tamper: true }));
    await webhooks.sweep();
    expect(inbox()).toBe(0);
    expect(orderStore().get(key)?.next_poll_at).toBe(settledPoll);
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id, { webhookId: 'evt_1' }));
    await webhooks.sweep();
    expect(orderStore().get(key)?.next_poll_at).toBe(clock);
  });

  it.each<[string, { key?: 'none'; target?: string }]>([
    ['unsigned', { key: 'none' }],
    ['signed for another host', { target: 'https://elsewhere.example/ucp/webhooks/orders' }],
  ])('a delivery %s is dropped after verification fails', async (_n, o) => {
    const { key } = await followed();
    const before = orderStore().get(key)?.next_poll_at;
    const w = shop.webhook(o.target ?? NODE_WEBHOOK_URL, key.order_id, {
      ...(o.key !== undefined ? { key: o.key } : {}),
    });
    deliver({ ...w, url: NODE_WEBHOOK_URL });
    await webhooks.sweep();
    expect(inbox()).toBe(0);
    expect(orderStore().get(key)?.next_poll_at).toBe(before);
  });

  it('a key the profile does not list is tried again later, and dropped after a day', async () => {
    const { key } = await followed();
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id, { key: 'unlisted' }));
    await webhooks.sweep();
    expect(inbox()).toBe(1);
    clock += 24 * 60 * 60_000;
    await webhooks.sweep();
    expect(inbox()).toBe(0);
  });

  it('another merchant naming the same order id is not this order’s sender: dropped unfetched', async () => {
    const { key } = await followed();
    deliver(
      shop.webhook(NODE_WEBHOOK_URL, key.order_id, {
        agent: 'https://other-shop.example/.well-known/ucp',
      }),
    );
    expect(inbox()).toBe(0);
  });

  it('a body whose checkout id names a different session than its order is dropped', async () => {
    const a = await followed();
    const b = await handedOff();
    deliver(
      shop.webhook(NODE_WEBHOOK_URL, a.key.order_id, {
        body: {
          ...JSON.parse(shop.webhook(NODE_WEBHOOK_URL, a.key.order_id).body.toString()),
          checkout_id: b.merchantId,
        },
      }),
    );
    expect(inbox()).toBe(0);
  });

  it('a webhook-only order (Get Order refused): bodies merge by id, show as sent, interrupt once, never close it', async () => {
    orderSharing = 'unauthorized';
    const { key } = await followed();
    expect(orderStore().get(key)?.state).toBe('not_shared');
    const held = shop.logic.orders.get(key.order_id);
    if (held === undefined) throw new Error('no order');
    // A newer body: a shipment, a pending dispute.
    held.events.push({ id: 'e1', type: 'shipped', occurredAt: clock, lineItems: [] });
    held.adjustments.push({ id: 'd1', type: 'dispute', occurredAt: clock, status: 'pending' });
    const newer = shop.webhook(NODE_WEBHOOK_URL, key.order_id);
    // An older body, with an event the newer one redacted.
    const older = shop.webhook(NODE_WEBHOOK_URL, key.order_id, {
      body: {
        ...JSON.parse(newer.body.toString()),
        fulfillment: {
          events: [
            {
              id: 'e0',
              type: 'processing',
              occurred_at: new Date(clock - 1000).toISOString(),
              line_items: [],
            },
          ],
        },
        adjustments: [],
      },
    });
    deliver(newer);
    deliver(older);
    await webhooks.sweep();
    const row = orderStore().get(key);
    expect(Object.keys(JSON.parse(row?.record_json ?? '{}').events).sort()).toEqual(['e0', 'e1']);
    expect(JSON.parse(row?.summary_json ?? '{}')).toMatchObject({ as_sent: true });
    expect(JSON.parse(row?.notices_json ?? '[]')).toMatchObject([
      { type: 'dispute', reason: 'new' },
    ]);
    // The same body under an altered Webhook-Id: nothing new.
    deliver({ ...newer, headers: { ...newer.headers, 'webhook-id': 'evt_altered' } });
    // The dispute settles: one more interruption, once.
    (held.adjustments[0] as { status: string }).status = 'completed';
    const settledBody = shop.webhook(NODE_WEBHOOK_URL, key.order_id);
    deliver(settledBody);
    deliver({ ...settledBody, headers: { ...settledBody.headers, 'webhook-id': 'evt_again' } });
    await webhooks.sweep();
    expect(JSON.parse(orderStore().get(key)?.notices_json ?? '[]')).toHaveLength(2);
    expect(orderStore().get(key)?.state).toBe('not_shared');
  });

  it('a body for a closed order adds unseen ids (and may interrupt) without reopening it', async () => {
    const { key } = await followed();
    const held = shop.logic.orders.get(key.order_id);
    if (held === undefined) throw new Error('no order');
    shop.logic.orders.delete(key.order_id);
    clock += 24 * 60 * 60_000;
    await orders.sweep();
    expect(orderStore().get(key)).toMatchObject({ state: 'closed', close_reason: 'not_found' });
    held.adjustments.push({
      id: 'c1',
      type: 'cancellation',
      occurredAt: clock,
      status: 'completed',
    });
    shop.logic.orders.set(key.order_id, held);
    deliver(shop.webhook(NODE_WEBHOOK_URL, key.order_id));
    await webhooks.sweep();
    expect(orderStore().get(key)).toMatchObject({ state: 'closed', next_poll_at: null });
    expect(JSON.parse(orderStore().get(key)?.notices_json ?? '[]')).toMatchObject([
      { type: 'cancellation' },
    ]);
  });
});
