/**
 * NEGOTIATION_PLAN §4.5 / §6 — the tender routes: a policy on creation, the
 * ranking, the award (presence, the from_quote builder, one award only, the
 * not-awarded notices) and a manual counter. Real SQLite stores throughout.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { OwnerCommerceClient } from '../../../src/client/owner-commerce-client';
import { inProcessOwnerDispatcher } from '../../../src/client/owner-dispatch';
import {
  installBuyerAuthorityProvider,
  singleOwnerAuthority,
} from '../../../src/commerce/buyer_authority';
import {
  installBuyerOrderSender,
  type BuyerOrderSender,
} from '../../../src/commerce/buyer_executor';
import {
  retireSettledTenderReadyCards,
  runNegotiationTick,
} from '../../../src/commerce/buyer_negotiation';
import { installCommerceServiceQueryDispatch } from '../../../src/commerce/buyer_sender';
import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  installStaffPresenceVerifier,
  proveOwnerPresence,
  proveStaffPresence,
  OWNER_IN_PROCESS_PRINCIPAL,
} from '../../../src/commerce/owner_presence';
import {
  createCommerceRuntime,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../../src/commerce/runtime';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import { registerWorkflowRoutes } from '../../../src/server/routes/workflow';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';
import {
  BUYER_DID,
  installActiveBuyerPack,
  makeProjection,
  makeSignedQuote,
  type InstalledBuyerPack,
} from '../../commerce/helpers';

import type { QuoteRequest, SignedQuote } from '@dina/commerce-protocol';

const OWNER_CAP = 'test-owner-capability-secret';
const SUPPLIER_A = 'did:plc:supplieraaaa';
const SUPPLIER_B = 'did:plc:supplierbbbb';

let dir: string;
let adapter: NodeSQLiteAdapter;
let runtime: CommerceRuntime;
let router: CoreRouter;
let pack: InstalledBuyerPack;
let sent: { toDid: string; body: Record<string, unknown> }[];
/** How far the commerce clock runs ahead of the wall clock. */
let clockOffset = 0;

const call = (
  method: 'GET' | 'POST',
  p: string,
  body: Record<string, unknown> = {},
  query: Record<string, string> = {},
): CoreRequest => ({
  method,
  path: p,
  query,
  headers: {},
  body,
  rawBody: new Uint8Array(),
  params: {},
  trustedInProcess: true,
  callerType: 'owner',
  ownerCapability: OWNER_CAP,
});

beforeEach(() => {
  setNodeDID(BUYER_DID);
  clockOffset = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-tender-award-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  runtime = createCommerceRuntime({
    adapter,
    supplierDid: () => BUYER_DID,
    currentEpoch: () => '1',
    now: () => Date.now() + clockOffset,
  });
  installCommerceRuntime(runtime);
  pack = installActiveBuyerPack(Date.now());
  sent = [];
  installCommerceServiceQueryDispatch(async (args) => {
    sent.push({ toDid: args.toDid, body: args.body as unknown as Record<string, unknown> });
    return { sent: true };
  });
  installBuyerAuthorityProvider(({ order, context, serviceRkey }) =>
    singleOwnerAuthority({ ownerDid: 'did:plc:testowner00000000', order, context, serviceRkey }),
  );
  installOwnerPresenceVerifier(async (p) => p === 'correct horse');
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  pack.dispose();
  installOwnerPresenceVerifier(null);
  clearOwnerPresence();
  installBuyerAuthorityProvider(null);
  installCommerceServiceQueryDispatch(null);
  installCommerceRuntime(null);
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const LINES = [
  {
    line_id: 'l1',
    product: { scheme: 'gtin', value: '09506000134352' },
    quantity: { value: '100', unit_code: 'each' },
  },
];

async function openTender(
  negotiation?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await router.handle(
    call('POST', '/v1/commerce/trade/tender', {
      suppliers: [
        { supplier_did: SUPPLIER_A, service_rkey: 'self' },
        { supplier_did: SUPPLIER_B, service_rkey: 'shop' },
      ],
      lines: LINES,
      projection: makeProjection(),
      currency: 'INR',
      ...(negotiation === undefined ? {} : { negotiation }),
    }),
  );
  return { status: res.status, body: res.body as Record<string, unknown> };
}

/** Each supplier's quote lands, exactly as the response lane would put it. */
function quotesArrive(unitBySupplier: Record<string, string>): void {
  for (const wire of sent.filter(
    (w) => w.body.capability === 'com.dinakernel.commerce.request_quote',
  )) {
    const request = wire.body.params as QuoteRequest;
    const unit = unitBySupplier[wire.toDid] as string;
    const product = request.lines[0]?.product;
    if (product === undefined) throw new Error('request has no line');
    const quote = makeSignedQuote(request, {
      quote_id: `q-${wire.toDid.slice(-4)}`,
      valid_until: '2036-01-01T00:00:00.000Z',
      lines: [
        {
          line_id: 'l1',
          requested_product: product,
          offered_product: product,
          quantity: { value: '100', unit_code: 'each' },
          price_basis: { value: '1', unit_code: 'each' },
          unit_price: { currency: 'INR', minor_units: unit },
          line_subtotal: { currency: 'INR', minor_units: String(Number(unit) * 100) },
          stock_status: 'available',
        },
      ],
      total: { currency: 'INR', minor_units: String(Number(unit) * 100) },
    });
    runtime.buyerQuotes.append({
      supplierDid: wire.toDid,
      quoteId: quote.quote_id,
      quote,
      acceptedAt: Date.now(),
    });
    runtime.tenders.setMemberQuote(request.request_id, quote.quote_id);
  }
}

describe('the owner client starts a tender (ASK_FOR_QUOTES_PLAN §2)', () => {
  const client = (): OwnerCommerceClient =>
    new OwnerCommerceClient(inProcessOwnerDispatcher(router, OWNER_CAP));

  it('a supplier set aside for PeerLens rides along as not asked, and reads back on the ranking', async () => {
    const answer = await client().createTender({
      suppliers: [{ supplierDid: SUPPLIER_A, serviceRkey: 'self' }],
      notAsked: [
        {
          supplierDid: SUPPLIER_B,
          serviceRkey: 'shop',
          reason: 'low_peerlens_trust',
        },
      ],
      lines: [{ lineId: 'l1', text: 'Sourdough loaves', quantity: '10', unitCode: 'each' }],
      region: { scheme: 'postal_area', value: '560001' },
      currency: 'INR',
    });
    expect(answer.members.map((m) => m.supplierDid)).toEqual([SUPPLIER_A]);
    expect(sent.map((w) => w.toDid)).not.toContain(SUPPLIER_B);
    const ranking = await client().tenderRanking(answer.tenderId);
    expect(ranking.not_asked).toEqual([
      { supplier_did: SUPPLIER_B, service_rkey: 'shop', reason: 'low_peerlens_trust', note: '' },
    ]);
  });

  it('described lines, a region and limits reach every supplier as Core’s requests', async () => {
    const answer = await client().createTender({
      suppliers: [
        { supplierDid: SUPPLIER_A, serviceRkey: 'self' },
        { supplierDid: SUPPLIER_B, serviceRkey: 'shop' },
      ],
      lines: [
        {
          lineId: 'l1',
          text: 'Floral celebration cake, 20 servings',
          quantity: '1',
          unitCode: 'each',
        },
      ],
      region: { scheme: 'postal_area', value: '560001' },
      currency: 'INR',
      limits: {
        targetMinorUnits: '250000',
        ceilingMinorUnits: '300000',
        maxRounds: 2,
        deadlineSeconds: 7200,
      },
    });
    expect(answer.tenderId).toMatch(/^tnd/);
    expect(answer.negotiating).toBe(true);
    expect(answer.members.map((m) => [m.supplierDid, m.sent])).toEqual([
      [SUPPLIER_A, true],
      [SUPPLIER_B, true],
    ]);
    const requests = sent
      .filter((w) => w.body.capability === 'com.dinakernel.commerce.request_quote')
      .map((w) => [w.toDid, w.body.params as QuoteRequest] as const);
    expect(requests.map(([did]) => did)).toEqual([SUPPLIER_A, SUPPLIER_B]);
    for (const [, request] of requests) {
      expect(request.lines[0]).toMatchObject({
        line_id: 'l1',
        requirement: { text: 'Floral celebration cake, 20 servings' },
        requested_quantity: { value: '1', unit_code: 'each' },
        // A described need: the supplier answers with its own item.
        acceptable_substitutions: 'supplier_may_propose',
      });
      expect(request.delivery.projection.region).toEqual({
        scheme: 'postal_area',
        value: '560001',
      });
    }
  });

  it('limits Core refuses are raised with its key, and nothing is sent', async () => {
    await expect(
      client().createTender({
        suppliers: [{ supplierDid: SUPPLIER_A, serviceRkey: 'self' }],
        lines: [{ lineId: 'l1', text: 'Cake', quantity: '1', unitCode: 'each' }],
        region: { scheme: 'postal_area', value: '560001' },
        currency: 'INR',
        limits: { targetMinorUnits: '300000', ceilingMinorUnits: '250000' },
      }),
    ).rejects.toMatchObject({ status: 400, errorKey: 'negotiation_invalid' });
    expect(sent).toEqual([]);
  });

  it('reads the buyer settings the screen defaults from', async () => {
    expect(await client().buyerSettings()).toEqual({ configured: false });
  });
});

describe('tender policy on creation', () => {
  it('a valid policy starts negotiation; a bad one is refused before any request leaves', async () => {
    const bad = await openTender({ target_total: '50000', budget_ceiling: '40000' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({
      error: 'negotiation_invalid',
      detail: 'budget_ceiling cannot be below target_total',
    });
    expect(sent).toHaveLength(0);
    const good = await openTender({
      target_total: '42000',
      budget_ceiling: '48000',
      max_rounds: 2,
      deadline_seconds: 120,
    });
    expect(good.status).toBe(200);
    expect(good.body.negotiating).toBe(true);
    expect(runtime.buyerNegotiation.getTender(String(good.body.tender_id))).toMatchObject({
      state: 'negotiating',
      maxRounds: 2,
      targetTotalMinor: '42000',
    });
  });
});

describe('ranking and award', () => {
  it('ranks within budget, awards the best offer with the owner present, notifies the other supplier, and a retry gets the same award back', async () => {
    const opened = await openTender({ target_total: '42000', budget_ceiling: '49000' });
    const tenderId = String(opened.body.tender_id);
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });

    const ranking = await router.handle(
      call('GET', '/v1/commerce/trade/tender/ranking', {}, { tender_id: tenderId }),
    );
    expect(ranking.status).toBe(200);
    expect(ranking.body).toMatchObject({
      state: 'negotiating',
      ranked: [{ supplier_did: SUPPLIER_B, total_minor: '48000', service_rkey: 'shop' }],
      excluded: [{ supplier_did: SUPPLIER_A, reason: 'over_budget', service_rkey: 'self' }],
    });
    const wider = await router.handle(
      call(
        'GET',
        '/v1/commerce/trade/tender/ranking',
        {},
        { tender_id: tenderId, budget_ceiling: '60000' },
      ),
    );
    expect(
      (wider.body as { ranked: { supplier_did: string }[] }).ranked.map((r) => r.supplier_did),
    ).toEqual([SUPPLIER_B, SUPPLIER_A]);

    const noPresence = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }),
    );
    expect(noPresence.status).toBe(403);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const mark = sent.length;
    const award = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }),
    );
    expect(award.status).toBe(200);
    const body = award.body as {
      approval_id: string;
      awarded: { supplier_did: string };
      not_awarded_notices: unknown;
    };
    expect(body.awarded.supplier_did).toBe(SUPPLIER_B);
    expect(runtime.orderApprovals.get(body.approval_id)?.order.supplier_did).toBe(SUPPLIER_B);
    expect(body.not_awarded_notices).toEqual([{ supplier_did: SUPPLIER_A, sent: true }]);
    const notices = sent.slice(mark);
    expect(notices.map((n) => [n.toDid, n.body.capability])).toEqual([
      [SUPPLIER_A, 'com.dinakernel.commerce.quote_outcome'],
    ]);
    expect(runtime.buyerNegotiation.getTender(tenderId)).toMatchObject({
      state: 'awarded',
      awardedSupplierDid: SUPPLIER_B,
      approvalId: body.approval_id,
    });
    // A retry after a lost response gets the same award back, never a second one.
    const again = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }),
    );
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      replayed: true,
      approval_id: body.approval_id,
      awarded_supplier_did: SUPPLIER_B,
      purchase_order_id: runtime.orderApprovals.get(body.approval_id)?.order.purchase_order_id,
      // A retry still reads whether each loser's notice went.
      not_awarded_notices: [{ supplier_did: SUPPLIER_A, sent: true, state: 'sent' }],
    });
    expect(sent.length).toBe(mark + 1);
    const ranked = await router.handle(
      call('GET', '/v1/commerce/trade/tender/ranking', {}, { tender_id: tenderId }),
    );
    expect(ranked.body).toMatchObject({
      state: 'awarded',
      approval_id: body.approval_id,
      held_order: 'held',
    });
    // Naming a different supplier is a new decision, and the tender is closed to it.
    const other = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', {
        tender_id: tenderId,
        supplier_did: SUPPLIER_A,
      }),
    );
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ error: 'tender_closed', awarded_supplier_did: SUPPLIER_B });
  });

  it('an offer over budget cannot be named for the award; a tender with no policy is still awarded once, and a retry replays it', async () => {
    const opened = await openTender();
    const tenderId = String(opened.body.tender_id);
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const named = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', {
        tender_id: tenderId,
        supplier_did: SUPPLIER_A,
      }),
    );
    // No policy, no ceiling: the named supplier passes the filters.
    expect(named.status).toBe(200);
    expect((named.body as { awarded: { supplier_did: string } }).awarded.supplier_did).toBe(
      SUPPLIER_A,
    );
    const retried = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }),
    );
    expect(retried.body).toMatchObject({
      replayed: true,
      approval_id: (named.body as { approval_id: string }).approval_id,
      awarded_supplier_did: SUPPLIER_A,
    });
    expect(
      (
        await router.handle(
          call('POST', '/v1/commerce/trade/tender/award', {
            tender_id: tenderId,
            supplier_did: SUPPLIER_B,
          }),
        )
      ).status,
    ).toBe(409);

    const capped = await openTender({ target_total: '42000', budget_ceiling: '49000' });
    const cappedId = String(capped.body.tender_id);
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    const over = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', {
        tender_id: cappedId,
        supplier_did: SUPPLIER_A,
      }),
    );
    expect(over.status).toBe(409);
    expect((over.body as { error: string }).error).toBe('no_awardable_offer');
  });

  it('a tender with no policy, awarded to the cheaper offer, names no budget: the dearer one is not "over budget"', async () => {
    const opened = await openTender();
    const tenderId = String(opened.body.tender_id);
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const awarded = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', {
        tender_id: tenderId,
        supplier_did: SUPPLIER_B,
      }),
    );
    expect(awarded.status).toBe(200);
    const ranking = await router.handle(
      call('GET', '/v1/commerce/trade/tender/ranking', {}, { tender_id: tenderId }),
    );
    const body = ranking.body as {
      state: string;
      ranked: { supplier_did: string }[];
      excluded: unknown[];
    };
    expect(body.state).toBe('awarded');
    // The 2026-09-26 simulator run showed the award price as a "budget" the
    // owner never set, and the losing offer as over it.
    expect(body).not.toHaveProperty('target_total');
    expect(body).not.toHaveProperty('budget_ceiling');
    expect(body.excluded).toEqual([]);
    expect(body.ranked.map((r) => r.supplier_did)).toEqual([SUPPLIER_B, SUPPLIER_A]);
  });
});

describe('a supplier set aside for poor PeerLens reviews is shown, never asked', () => {
  const SET_ASIDE = 'did:plc:supplierpoor';
  const tenderBody = (extra: Record<string, unknown>): Record<string, unknown> => ({
    suppliers: [
      { supplier_did: SUPPLIER_A, service_rkey: 'self' },
      { supplier_did: SUPPLIER_B, service_rkey: 'shop' },
    ],
    lines: LINES,
    projection: makeProjection(),
    currency: 'INR',
    ...extra,
  });

  it('the tender keeps who was left out and why, and its ranking says so', async () => {
    const opened = await router.handle(
      call(
        'POST',
        '/v1/commerce/trade/tender',
        tenderBody({
          not_asked: [
            {
              supplier_did: SET_ASIDE,
              service_rkey: 'bakery',
              reason: 'own_poor_review',
              note: 'Stale bread, delivered late.',
            },
          ],
        }),
      ),
    );
    expect(opened.status).toBe(200);
    const tenderId = String((opened.body as { tender_id: string }).tender_id);
    expect(sent.some((w) => w.toDid === SET_ASIDE)).toBe(false);
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    const ranking = await router.handle(
      call('GET', '/v1/commerce/trade/tender/ranking', {}, { tender_id: tenderId }),
    );
    expect(ranking.status).toBe(200);
    const body = ranking.body as {
      ranked: { supplier_did: string }[];
      excluded: { supplier_did: string }[];
      not_asked: Record<string, unknown>[];
    };
    expect(body.not_asked).toEqual([
      {
        supplier_did: SET_ASIDE,
        service_rkey: 'bakery',
        reason: 'own_poor_review',
        note: 'Stale bread, delivered late.',
      },
    ]);
    // Never ranked, never excluded: it was never in the tender to begin with.
    expect([...body.ranked, ...body.excluded].map((r) => r.supplier_did)).not.toContain(SET_ASIDE);
  });

  it('a tender with nobody set aside answers an empty list', async () => {
    const opened = await openTender();
    const ranking = await router.handle(
      call(
        'GET',
        '/v1/commerce/trade/tender/ranking',
        {},
        { tender_id: String(opened.body.tender_id) },
      ),
    );
    expect((ranking.body as { not_asked: unknown[] }).not_asked).toEqual([]);
  });

  it('refuses a malformed entry (400) and a supplier both asked and set aside (409), sending nothing', async () => {
    const before = sent.length;
    const badReason = await router.handle(
      call(
        'POST',
        '/v1/commerce/trade/tender',
        tenderBody({ not_asked: [{ supplier_did: SET_ASIDE, service_rkey: 'b', reason: 'rude' }] }),
      ),
    );
    expect(badReason.status).toBe(400);
    const notArray = await router.handle(
      call('POST', '/v1/commerce/trade/tender', tenderBody({ not_asked: 'everyone' })),
    );
    expect(notArray.status).toBe(400);
    const both = await router.handle(
      call(
        'POST',
        '/v1/commerce/trade/tender',
        tenderBody({
          not_asked: [
            { supplier_did: SUPPLIER_A, service_rkey: 'self', reason: 'low_peerlens_trust' },
          ],
        }),
      ),
    );
    expect(both.status).toBe(409);
    expect((both.body as { error: string }).error).toBe('asked_and_not_asked');
    expect(sent.length).toBe(before);
  });
});

describe('the tender story: what each supplier offered and how it moved', () => {
  const client = (): OwnerCommerceClient =>
    new OwnerCommerceClient(inProcessOwnerDispatcher(router, OWNER_CAP));

  /** One supplier's opening quote, with the runner's signed evidence naming its item. */
  function quoteArrivesNamed(supplierDid: string, unit: string, name: string): SignedQuote {
    const wire = sent.find(
      (w) =>
        w.toDid === supplierDid && w.body.capability === 'com.dinakernel.commerce.request_quote',
    );
    const request = wire?.body.params as QuoteRequest;
    const product = request.lines[0]?.product;
    if (product === undefined) throw new Error('request has no line');
    const quote = makeSignedQuote(request, {
      quote_id: `q-${supplierDid.slice(-4)}`,
      valid_until: '2036-01-01T00:00:00.000Z',
      lines: [
        {
          line_id: 'l1',
          requested_product: product,
          offered_product: product,
          quantity: { value: '100', unit_code: 'each' },
          price_basis: { value: '1', unit_code: 'each' },
          unit_price: { currency: 'INR', minor_units: unit },
          line_subtotal: { currency: 'INR', minor_units: String(Number(unit) * 100) },
          stock_status: 'available',
          substitution_evidence: [`matched "cake for 20" to "${name}" (3 of 4 words)`],
        },
      ],
      total: { currency: 'INR', minor_units: String(Number(unit) * 100) },
    });
    runtime.buyerQuotes.append({
      supplierDid,
      quoteId: quote.quote_id,
      quote,
      acceptedAt: Date.now(),
    });
    runtime.tenders.setMemberQuote(request.request_id, quote.quote_id);
    return quote;
  }

  it('names the offered item, where each supplier opened, and the counter Dina sent', async () => {
    const opened = await openTender();
    const tenderId = String(opened.body.tender_id);
    quoteArrivesNamed(SUPPLIER_A, '500', 'Floral Celebration Cake, 10-inch');
    // Evidence that names nothing gives no name, never an empty one.
    quoteArrivesNamed(SUPPLIER_B, '480', '');
    const counter = await router.handle(
      call('POST', '/v1/commerce/trade/counter', {
        supplier_did: SUPPLIER_A,
        quote_id: 'q-aaaa',
        target_total: { currency: 'INR', minor_units: '45000' },
        tender_id: tenderId,
      }),
    );
    expect(counter.status).toBe(202);

    const res = await client().tenderStory(tenderId);
    const byDid = new Map(res.suppliers.map((s) => [s.supplier_did, s]));
    const a = byDid.get(SUPPLIER_A);
    expect(a?.lines).toEqual([
      expect.objectContaining({
        line_id: 'l1',
        name: 'Floral Celebration Cake, 10-inch',
        unit_price: { currency: 'INR', minor_units: '500' },
      }),
    ]);
    expect(a?.revisions).toEqual([
      expect.objectContaining({ total: { currency: 'INR', minor_units: '50000' } }),
    ]);
    const b = byDid.get(SUPPLIER_B);
    expect(b?.lines[0]?.name).toBeNull();
    expect(b?.counters).toEqual([]);
    // A counter the owner sent by hand on this tender's quote is part of its story.
    expect(a?.counters.map((c) => [c.round, c.target_total, c.state])).toEqual([
      [1, { currency: 'INR', minor_units: '45000' }, 'sent'],
    ]);
  });

  it('a supplier that has not answered has no revisions and no lines yet', async () => {
    const opened = await openTender();
    const res = await client().tenderStory(String(opened.body.tender_id));
    expect(res.suppliers.map((s) => [s.quote_id, s.revisions.length, s.lines.length])).toEqual([
      ['', 0, 0],
      ['', 0, 0],
    ]);
  });

  it('refuses a missing tender id (400) and an unknown tender (404)', async () => {
    const missing = await router.handle(call('GET', '/v1/commerce/trade/tender/story', {}, {}));
    expect(missing.status).toBe(400);
    const unknown = await router.handle(
      call('GET', '/v1/commerce/trade/tender/story', {}, { tender_id: 'tnd_nope' }),
    );
    expect(unknown.status).toBe(404);
  });

  it("a set-aside supplier's listed price rides along and reads back on the ranking", async () => {
    const answer = await client().createTender({
      suppliers: [{ supplierDid: SUPPLIER_A, serviceRkey: 'self' }],
      notAsked: [
        {
          supplierDid: SUPPLIER_B,
          serviceRkey: 'shop',
          reason: 'own_poor_review',
          note: 'Late',
          listedFrom: { currency: 'INR', minorUnits: '12900' },
        },
      ],
      lines: [{ lineId: 'l1', text: 'Cake', quantity: '1', unitCode: 'each' }],
      region: { scheme: 'postal_area', value: '560001' },
      currency: 'INR',
    });
    const ranking = await client().tenderRanking(answer.tenderId);
    expect(ranking.not_asked?.[0]?.listed_from).toEqual({ currency: 'INR', minor_units: '12900' });
    const bad = await router.handle(
      call('POST', '/v1/commerce/trade/tender', {
        suppliers: [{ supplier_did: SUPPLIER_A, service_rkey: 'self' }],
        not_asked: [
          {
            supplier_did: SUPPLIER_B,
            service_rkey: 'shop',
            reason: 'own_poor_review',
            listed_from: { currency: 'inr', minor_units: '-5' },
          },
        ],
        lines: LINES,
        projection: makeProjection(),
        currency: 'INR',
      }),
    );
    expect(bad.status).toBe(400);
  });
});

describe('owner cards that outlive their question (integration report 2026-09-27)', () => {
  let workflow: WorkflowService;
  const DAY = 24 * 60 * 60 * 1000;
  const outcomes = (from: number): [string, string][] =>
    sent
      .slice(from)
      .filter((w) => w.body.capability === 'com.dinakernel.commerce.quote_outcome')
      .map((w): [string, string] => [w.toDid, (w.body.params as { outcome: string }).outcome])
      .sort();

  beforeEach(() => {
    workflow = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
    setWorkflowService(workflow);
    registerWorkflowRoutes(router, OWNER_CAP);
  });
  afterEach(() => setWorkflowService(null));

  /**
   * The retired card as the Activity list reads it: cancelled, with WHY, so it
   * never reads as the owner's "Denied" (iPhone buyer run 2026-09-29).
   */
  async function cardAsListed(tenderId: string): Promise<Record<string, unknown> | undefined> {
    const res = await router.handle(
      call('GET', '/v1/workflow/tasks', {}, { kind: 'approval', state: 'cancelled' }),
    );
    expect(res.status).toBe(200);
    return (res.body as { tasks: Record<string, unknown>[] }).tasks.find(
      (t) => t.id === `tender-ready-${tenderId}`,
    );
  }

  /** Counters out to both, the deadline passes: the tender is ready, with its card. */
  async function readyTender(): Promise<{ tenderId: string; start: number }> {
    const opened = await openTender({ target_total: '42000', budget_ceiling: '60000' });
    const tenderId = String(opened.body.tender_id);
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    const start = Date.now();
    expect(await runNegotiationTick(start)).toBe(2);
    clockOffset = 100_000;
    await runNegotiationTick(start + 100_000);
    expect(runtime.buyerNegotiation.getTender(tenderId)?.state).toBe('ready');
    expect(workflow.store().getById(`tender-ready-${tenderId}`)?.status).toBe('pending_approval');
    return { tenderId, start };
  }

  it('reaching ready tells each countered supplier no more counters are coming', async () => {
    const mark = sent.length;
    await readyTender();
    expect(outcomes(mark)).toEqual(
      [
        [SUPPLIER_A, 'negotiation_closed'],
        [SUPPLIER_B, 'negotiation_closed'],
      ].sort(),
    );
  });

  it('an award takes the "tender ready" card down', async () => {
    const { tenderId, start } = await readyTender();
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    // The counters' windows close, so the award is free to go.
    clockOffset = 200_000;
    await runNegotiationTick(start + 200_000);
    clockOffset = 400_000;
    await runNegotiationTick(start + 400_000);
    const award = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }),
    );
    expect(award.status).toBe(200);
    expect(workflow.store().getById(`tender-ready-${tenderId}`)?.status).toBe('cancelled');
    expect(await cardAsListed(tenderId)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'tender_awarded',
    });
    // The replay lists only the loser's not-awarded notice.
    const replay = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }),
    );
    expect(
      (replay.body as { not_awarded_notices: { supplier_did: string }[] }).not_awarded_notices.map(
        (n) => n.supplier_did,
      ),
    ).toEqual([SUPPLIER_A]);
  });

  it("the owner's own deny of the card reads back with the owner's reason", async () => {
    const { tenderId } = await readyTender();
    const denied = await router.handle(
      call('POST', `/v1/workflow/tasks/tender-ready-${tenderId}/cancel`, {
        reason: 'denied_by_operator',
      }),
    );
    expect(denied.status).toBe(200);
    expect(await cardAsListed(tenderId)).toMatchObject({ cancel_reason: 'denied_by_operator' });
  });

  it('a window that runs out unawarded closes the tender, takes the card down and tells every supplier', async () => {
    const { tenderId, start } = await readyTender();
    const mark = sent.length;
    clockOffset = DAY + 60_000;
    await runNegotiationTick(start + DAY + 60_000);
    expect(runtime.buyerNegotiation.getTender(tenderId)?.state).toBe('closed');
    expect(workflow.store().getById(`tender-ready-${tenderId}`)?.status).toBe('cancelled');
    expect(await cardAsListed(tenderId)).toMatchObject({ cancel_reason: 'tender_expired' });
    const single = await router.handle(
      call('GET', `/v1/workflow/tasks/tender-ready-${tenderId}`, {}, {}),
    );
    expect((single.body as { task: Record<string, unknown> }).task.cancel_reason).toBe(
      'tender_expired',
    );
    // No counter goes on a closing tender; only the notices.
    expect(
      sent.slice(mark).filter((w) => w.body.capability === 'com.dinakernel.commerce.counter_offer'),
    ).toEqual([]);
    expect(outcomes(mark)).toEqual(
      [
        [SUPPLIER_A, 'not_awarded'],
        [SUPPLIER_B, 'not_awarded'],
      ].sort(),
    );
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const late = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }),
    );
    expect(late.status).toBe(409);
    expect((late.body as { error: string }).error).toBe('tender_closed');
    // A later tick changes nothing and sends nothing more.
    const after = sent.length;
    await runNegotiationTick(start + DAY + 120_000);
    expect(sent.length).toBe(after);
  });

  it('on start, cards left pending by awards made before this fix are taken down', async () => {
    const { tenderId } = await readyTender();
    // Awarded the old way: the tender moved, the card was never touched.
    expect(
      runtime.buyerNegotiation.moveTender(tenderId, 'ready', 'awarded', Date.now(), {
        supplierDid: SUPPLIER_B,
        approvalId: 'oap_legacy',
      }),
    ).toBe(true);
    expect(workflow.store().getById(`tender-ready-${tenderId}`)?.status).toBe('pending_approval');
    retireSettledTenderReadyCards();
    expect(workflow.store().getById(`tender-ready-${tenderId}`)?.status).toBe('cancelled');
  });

  it('a tender opened without a policy closes the same way when its window runs out', async () => {
    const opened = await openTender();
    const tenderId = String(opened.body.tender_id);
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    const mark = sent.length;
    clockOffset = DAY + 60_000;
    await runNegotiationTick(Date.now() + DAY);
    expect(runtime.buyerNegotiation.getTender(tenderId)?.state).toBe('closed');
    expect(outcomes(mark)).toEqual(
      [
        [SUPPLIER_A, 'not_awarded'],
        [SUPPLIER_B, 'not_awarded'],
      ].sort(),
    );
  });
});

describe('a manual counter', () => {
  it('goes to the supplier of the quote on the counter lane; a target not below the quote is refused', async () => {
    await openTender();
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    const same = await router.handle(
      call('POST', '/v1/commerce/trade/counter', {
        supplier_did: SUPPLIER_A,
        quote_id: 'q-aaaa',
        target_total: { currency: 'INR', minor_units: '50000' },
      }),
    );
    expect(same.status).toBe(409);
    expect((same.body as { error: string }).error).toBe('target_not_lower');
    const res = await router.handle(
      call('POST', '/v1/commerce/trade/counter', {
        supplier_did: SUPPLIER_A,
        quote_id: 'q-aaaa',
        target_total: { currency: 'INR', minor_units: '45000' },
      }),
    );
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: 'sent', round: '1' });
    expect(sent.at(-1)).toMatchObject({
      toDid: SUPPLIER_A,
      body: { capability: 'com.dinakernel.commerce.counter_offer' },
    });
    const again = await router.handle(
      call('POST', '/v1/commerce/trade/counter', {
        supplier_did: SUPPLIER_A,
        quote_id: 'q-aaaa',
        target_total: { currency: 'INR', minor_units: '44000' },
      }),
    );
    expect((again.body as { error: string }).error).toBe('counter_in_flight');
    const unknown = await router.handle(
      call('POST', '/v1/commerce/trade/counter', {
        supplier_did: SUPPLIER_A,
        quote_id: 'q-nope',
        target_total: { currency: 'INR', minor_units: '1' },
      }),
    );
    expect(unknown.status).toBe(404);
  });
});

describe('review fixes on the routes', () => {
  it('an award waits while a counter to the chosen supplier is still on its way', async () => {
    const opened = await openTender({ target_total: '42000', budget_ceiling: '49000' });
    const tenderId = String(opened.body.tender_id);
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    await router.handle(
      call('POST', '/v1/commerce/trade/counter', {
        supplier_did: SUPPLIER_B,
        quote_id: 'q-bbbb',
        service_rkey: 'shop',
        target_total: { currency: 'INR', minor_units: '45000' },
      }),
    );
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const award = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }),
    );
    expect(award.status).toBe(409);
    expect((award.body as { error: string }).error).toBe('counter_in_flight');
  });

  it('a counter whose send was ambiguous still blocks a second one', async () => {
    await openTender();
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    installCommerceServiceQueryDispatch(async () => ({ sent: false, error: 'relay timeout' }));
    const first = await router.handle(
      call('POST', '/v1/commerce/trade/counter', {
        supplier_did: SUPPLIER_A,
        quote_id: 'q-aaaa',
        target_total: { currency: 'INR', minor_units: '45000' },
      }),
    );
    expect(first.body).toMatchObject({ state: 'ambiguous' });
    const second = await router.handle(
      call('POST', '/v1/commerce/trade/counter', {
        supplier_did: SUPPLIER_A,
        quote_id: 'q-aaaa',
        target_total: { currency: 'INR', minor_units: '44000' },
      }),
    );
    expect((second.body as { error: string }).error).toBe('counter_in_flight');
  });

  it('with no policy, offers in different currencies are not ranked against each other', async () => {
    const opened = await openTender();
    const tenderId = String(opened.body.tender_id);
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    // Re-price B's quote in another currency, as a different chain.
    const wire = sent.find(
      (w) =>
        w.toDid === SUPPLIER_B && w.body.capability === 'com.dinakernel.commerce.request_quote',
    );
    const request = wire?.body.params as QuoteRequest;
    const product = request.lines[0]?.product;
    if (product === undefined) throw new Error('no line');
    const usd = makeSignedQuote(request, {
      quote_id: 'q-usd',
      valid_until: '2036-01-01T00:00:00.000Z',
      lines: [
        {
          line_id: 'l1',
          requested_product: product,
          offered_product: product,
          quantity: { value: '100', unit_code: 'each' },
          price_basis: { value: '1', unit_code: 'each' },
          unit_price: { currency: 'USD', minor_units: '6' },
          line_subtotal: { currency: 'USD', minor_units: '600' },
          stock_status: 'available',
        },
      ],
      total: { currency: 'USD', minor_units: '600' },
    });
    runtime.buyerQuotes.append({
      supplierDid: SUPPLIER_B,
      quoteId: 'q-usd',
      quote: usd,
      acceptedAt: Date.now(),
    });
    runtime.tenders.setMemberQuote(request.request_id, 'q-usd');
    const ranking = await router.handle(
      call('GET', '/v1/commerce/trade/tender/ranking', {}, { tender_id: tenderId }),
    );
    expect(ranking.status).toBe(409);
    expect((ranking.body as { error: string }).error).toBe('mixed_currencies');
  });
});

describe('dual review round 2 — pinned fixes', () => {
  const COUNTER_LANE = 'com.dinakernel.commerce.counter_offer';
  const counters = (): { toDid: string; body: Record<string, unknown> }[] =>
    sent.filter((w) => w.body.capability === COUNTER_LANE);

  it('a silent supplier never blocks the award past its windows, on the default deadline', async () => {
    // Default deadline (90 s) is shorter than a counter's window (180 s): the
    // tender is ready while the counters are still out.
    const opened = await openTender({ target_total: '42000', budget_ceiling: '60000' });
    const tenderId = String(opened.body.tender_id);
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    const start = Date.now();
    expect(await runNegotiationTick(start)).toBe(2);
    clockOffset = 100_000;
    expect(await runNegotiationTick(start + 100_000)).toBe(0);
    expect(runtime.buyerNegotiation.getTender(tenderId)?.state).toBe('ready');
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const early = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }),
    );
    expect((early.body as { error: string }).error).toBe('counter_in_flight');
    // First windows closed: each silent counter goes once more, same id, on the READY tender.
    const mark = counters().length;
    clockOffset = 200_000;
    await runNegotiationTick(start + 200_000);
    const again = counters().slice(mark);
    expect(again.map((w) => w.body.query_id).sort()).toEqual(
      counters()
        .slice(0, mark)
        .map((w) => w.body.query_id)
        .sort(),
    );
    const retried = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }),
    );
    expect((retried.body as { error: string }).error).toBe('counter_in_flight');
    // Second windows closed: the suppliers are silent, nothing more goes, and the award proceeds.
    clockOffset = 400_000;
    const settled = counters().length;
    await runNegotiationTick(start + 400_000);
    expect(counters().length).toBe(settled);
    const award = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }),
    );
    expect(award.status).toBe(200);
    expect((award.body as { awarded: { supplier_did: string } }).awarded.supplier_did).toBe(
      SUPPLIER_B,
    );
  });

  it('a manual counter nobody answers stops blocking the award once its window closes', async () => {
    const opened = await openTender({ target_total: '42000', budget_ceiling: '49000' });
    const tenderId = String(opened.body.tender_id);
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    const manual = await router.handle(
      call('POST', '/v1/commerce/trade/counter', {
        supplier_did: SUPPLIER_B,
        quote_id: 'q-bbbb',
        service_rkey: 'shop',
        target_total: { currency: 'INR', minor_units: '45000' },
      }),
    );
    expect(manual.status).toBe(202);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    clockOffset = 181_000;
    const award = await router.handle(
      call('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }),
    );
    expect(award.status).toBe(200);
  });

  it('a manual counter on a quote in a ready or awarded tender is refused, and nothing is retained or sent', async () => {
    const opened = await openTender({ target_total: '42000', budget_ceiling: '49000' });
    const tenderId = String(opened.body.tender_id);
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    const start = Date.now();
    clockOffset = 100_000;
    await runNegotiationTick(start + 100_000);
    expect(runtime.buyerNegotiation.getTender(tenderId)?.state).toBe('ready');
    const counterOn = (supplierDid: string, quoteId: string) =>
      router.handle(
        call('POST', '/v1/commerce/trade/counter', {
          supplier_did: supplierDid,
          quote_id: quoteId,
          target_total: { currency: 'INR', minor_units: '40000' },
        }),
      );
    const onReady = await counterOn(SUPPLIER_B, 'q-bbbb');
    expect(onReady.status).toBe(409);
    expect((onReady.body as { error: string }).error).toBe('tender_closed');
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    expect(
      (
        await router.handle(
          call('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }),
        )
      ).status,
    ).toBe(200);
    const onAwarded = await counterOn(SUPPLIER_B, 'q-bbbb');
    expect((onAwarded.body as { error: string }).error).toBe('tender_closed');
    expect(counters()).toHaveLength(0);
    expect(runtime.buyerNegotiation.countersForQuote(SUPPLIER_B, 'q-bbbb')).toHaveLength(0);
  });
});

describe('dual review round 3 — pinned fixes', () => {
  const COUNTER_LANE = 'com.dinakernel.commerce.counter_offer';
  const counters = (): { toDid: string; body: Record<string, unknown> }[] =>
    sent.filter((w) => w.body.capability === COUNTER_LANE);
  const award = (tenderId: string) =>
    router.handle(call('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }));

  it("R3-1: after a loop counter's first window and before its resend, the award still waits — even mid-sweep", async () => {
    const opened = await openTender({ target_total: '42000', budget_ceiling: '60000' });
    const tenderId = String(opened.body.tender_id);
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    const start = Date.now();
    expect(await runNegotiationTick(start)).toBe(2);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    // First windows closed, no sweep yet: a revision may have been lost.
    clockOffset = 181_000;
    expect(((await award(tenderId)).body as { error: string }).error).toBe('counter_in_flight');
    // The sweep resends A first; while that send awaits, the award for B (the
    // best offer, not yet asked again) is tried — and still waits.
    let midSweep: Awaited<ReturnType<typeof award>> | null = null;
    installCommerceServiceQueryDispatch(async (args) => {
      sent.push({ toDid: args.toDid, body: args.body as unknown as Record<string, unknown> });
      if (args.toDid === SUPPLIER_A && midSweep === null) midSweep = await award(tenderId);
      return { sent: true };
    });
    await runNegotiationTick(start + 181_000);
    expect((midSweep as { body: { error: string } } | null)?.body.error).toBe('counter_in_flight');
    expect(runtime.buyerNegotiation.getTender(tenderId)?.state).toBe('ready');
    // Both asked twice and both second windows closed: silent, and the award proceeds.
    clockOffset = 400_000;
    await runNegotiationTick(start + 400_000);
    const done = await award(tenderId);
    expect(done.status).toBe(200);
  });

  it('R3-2: a manual counter on a tender quote is never resent by the sweeps, and stops blocking after its window', async () => {
    const opened = await openTender({ target_total: '42000', budget_ceiling: '49000' });
    const tenderId = String(opened.body.tender_id);
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    const manual = await router.handle(
      call('POST', '/v1/commerce/trade/counter', {
        supplier_did: SUPPLIER_B,
        quote_id: 'q-bbbb',
        service_rkey: 'shop',
        target_total: { currency: 'INR', minor_units: '45000' },
      }),
    );
    const counterId = (manual.body as { counter_id: string }).counter_id;
    const start = Date.now();
    clockOffset = 100_000; // the deadline passes: ready
    await runNegotiationTick(start + 100_000);
    expect(runtime.buyerNegotiation.getTender(tenderId)?.state).toBe('ready');
    clockOffset = 200_000; // its window has closed: the ready sweep leaves it alone
    await runNegotiationTick(start + 200_000);
    expect(counters().filter((w) => w.body.query_id === counterId)).toHaveLength(1);
    expect(runtime.buyerNegotiation.getCounter(counterId)?.attempts).toBe(1);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    expect((await award(tenderId)).status).toBe(200);
  });
});

describe('NEGOTIATION_PLAN §4.7 — a clerk awards inside the cap the owner set', () => {
  const STAFF = 'did:key:zpurchasingclerk';
  const PIN = '2468';
  let workflow: WorkflowService;
  let orders: unknown[];

  const staffCall = (
    method: 'GET' | 'POST',
    p: string,
    body: Record<string, unknown> = {},
    query: Record<string, string> = {},
    device: string = STAFF,
  ): CoreRequest =>
    ({
      method,
      path: p,
      query,
      headers: {},
      body,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'staff',
      callerDID: device,
    }) as unknown as CoreRequest;
  const grant = (
    maxMinor: string,
    installs: 'buyer' | 'supplier' = 'buyer',
    device: string = STAFF,
  ): void => {
    // The first staff grant crosses the attribution boundary, as the grant
    // route does; from then on every approval names who vouched for it.
    runtime.attributionBoundary.cross(Date.now(), []);
    runtime.staffGrants.put({
      deviceDid: device,
      scope: 'commerce_submit',
      maxOrderMinorUnits: maxMinor,
      currency: 'INR',
      installs,
      createdAt: Date.now(),
      revokedAt: null,
    });
  };
  const staffAward = (tenderId: string) =>
    router.handle(staffCall('POST', '/v1/commerce/trade/tender/award', { tender_id: tenderId }));
  async function tender(): Promise<string> {
    const opened = await openTender({ target_total: '42000', budget_ceiling: '60000' });
    quotesArrive({ [SUPPLIER_A]: '500', [SUPPLIER_B]: '480' });
    return String(opened.body.tender_id);
  }

  beforeEach(async () => {
    workflow = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
    setWorkflowService(workflow);
    orders = [];
    const sender: BuyerOrderSender = async ({ order }) => {
      orders.push(order);
      return { kind: 'ambiguous', reason: 'sent' };
    };
    installBuyerOrderSender(sender);
    installStaffPresenceVerifier(async (device, pin) => device === STAFF && pin === PIN);
    expect(await proveStaffPresence(STAFF, PIN, Date.now())).toBe(true);
  });
  afterEach(() => {
    installStaffPresenceVerifier(null);
    installBuyerOrderSender(null);
    setWorkflowService(null);
  });

  it('under the cap: the clerk reads the ranking, awards, and sends — the order is vouched by the clerk', async () => {
    grant('50000');
    const tenderId = await tender();
    const ranking = await router.handle(
      staffCall('GET', '/v1/commerce/trade/tender/ranking', {}, { tender_id: tenderId }),
    );
    expect(ranking.status).toBe(200);
    const award = await staffAward(tenderId);
    expect(award.status).toBe(200);
    const body = award.body as {
      approval_id: string;
      awarded: { supplier_did: string };
      approved: { attribution?: { vouchedBy: string } };
    };
    expect(body.awarded.supplier_did).toBe(SUPPLIER_B);
    expect(body.approved.attribution?.vouchedBy).toBe(STAFF);
    const submitted = await router.handle(
      staffCall('POST', '/v1/commerce/orders/submit', { approval_id: body.approval_id }),
    );
    expect(submitted.status).toBe(200);
    expect(orders).toHaveLength(1);
    // Once sent, the tender says so: no surface offers "Send" again.
    const after = await router.handle(
      staffCall('GET', '/v1/commerce/trade/tender/ranking', {}, { tender_id: tenderId }),
    );
    expect(after.body).toMatchObject({ state: 'awarded', held_order: 'sent' });
  });

  it('over the cap: the owner gets one card before anything changes, and the same yes lets the award and the send through', async () => {
    grant('40000'); // the best offer is 48000
    const tenderId = await tender();
    const mark = sent.length;
    const asked = await staffAward(tenderId);
    expect(asked.status).toBe(202);
    const taskId = (asked.body as { task_id: string }).task_id;
    // Nothing moved: no award, no held order, no notice.
    expect(runtime.buyerNegotiation.getTender(tenderId)?.state).toBe('negotiating');
    expect(sent.length).toBe(mark);
    // Asking again is the same card, not a second one.
    expect(((await staffAward(tenderId)).body as { task_id: string }).task_id).toBe(taskId);
    workflow.approve(taskId);
    const award = await staffAward(tenderId);
    expect(award.status).toBe(200);
    const approvalId = (award.body as { approval_id: string }).approval_id;
    const submitted = await router.handle(
      staffCall('POST', '/v1/commerce/orders/submit', { approval_id: approvalId }),
    );
    expect(submitted.status).toBe(200);
    expect(orders).toHaveLength(1);
  });

  it('refused without a live buyer-side grant or without presence, and nothing is read or changed', async () => {
    const tenderId = await tender();
    const refusedBare = await staffAward(tenderId);
    expect(refusedBare.status).toBe(403);
    expect(
      (
        await router.handle(
          staffCall('GET', '/v1/commerce/trade/tender/ranking', {}, { tender_id: tenderId }),
        )
      ).status,
    ).toBe(403);
    grant('50000', 'supplier');
    expect((await staffAward(tenderId)).status).toBe(403);
    grant('50000');
    installStaffPresenceVerifier(async () => true); // swapping the verifier drops the stamp
    const noPresence = await staffAward(tenderId);
    expect(noPresence.status).toBe(403);
    expect((noPresence.body as { error: string }).error).toBe('no_user_presence');
    expect(runtime.buyerNegotiation.getTender(tenderId)?.state).toBe('negotiating');
  });

  it('from a held quote: the clerk lists held quotes and holds an order under the cap; over it, the owner is asked', async () => {
    grant('49000');
    await tender();
    const quotes = await router.handle(staffCall('GET', '/v1/commerce/buyer/quotes'));
    expect(quotes.status).toBe(200);
    const under = await router.handle(
      staffCall('POST', '/v1/commerce/orders/from_quote', {
        supplier_did: SUPPLIER_B,
        quote_id: 'q-bbbb',
        service_rkey: 'shop',
      }),
    );
    expect(under.status).toBe(200);
    const over = await router.handle(
      staffCall('POST', '/v1/commerce/orders/from_quote', {
        supplier_did: SUPPLIER_A,
        quote_id: 'q-aaaa',
      }),
    );
    expect(over.status).toBe(202);
  });

  it('R4-1/R5-1: one owner yes above the cap covers ONE held order; the card reads approved, spent on that order', async () => {
    grant('40000');
    await tender();
    const hold = () =>
      router.handle(
        staffCall('POST', '/v1/commerce/orders/from_quote', {
          supplier_did: SUPPLIER_B,
          quote_id: 'q-bbbb',
          service_rkey: 'shop',
        }),
      );
    const send = (approvalId: string) =>
      router.handle(staffCall('POST', '/v1/commerce/orders/submit', { approval_id: approvalId }));
    const asked = await hold();
    expect(asked.status).toBe(202);
    const firstCard = (asked.body as { task_id: string }).task_id;
    workflow.approve(firstCard);
    const a = (await hold()).body as { approval_id: string };
    // The yes was spent on that hold: the card is COMPLETED (the owner's
    // history reads approved), naming the order, never cancelled.
    const card = workflow.store().getById(firstCard);
    expect(card?.status).toBe('completed');
    expect(JSON.parse(card?.result ?? '{}')).toEqual({ spent_on: a.approval_id });
    // A second order from the same quote asks the owner again…
    const second = await hold();
    expect(second.status).toBe(202);
    expect((second.body as { task_id: string }).task_id).not.toBe(firstCard);
    // …while the cleared order goes out with no further card.
    expect((await send(a.approval_id)).status).toBe(200);
    expect(orders).toHaveLength(1);
  });

  it("R5-3: a send that fails before leaving keeps the owner's yes for that order; the retry needs no new card", async () => {
    grant('40000');
    await tender();
    const hold = () =>
      router.handle(
        staffCall('POST', '/v1/commerce/orders/from_quote', {
          supplier_did: SUPPLIER_B,
          quote_id: 'q-bbbb',
          service_rkey: 'shop',
        }),
      );
    workflow.approve(((await hold()).body as { task_id: string }).task_id);
    const approvalId = ((await hold()).body as { approval_id: string }).approval_id;
    installBuyerOrderSender(null);
    const failed = await router.handle(
      staffCall('POST', '/v1/commerce/orders/submit', { approval_id: approvalId }),
    );
    expect(failed.status).toBe(503);
    installBuyerOrderSender(async ({ order }) => {
      orders.push(order);
      return { kind: 'ambiguous', reason: 'sent' };
    });
    const retried = await router.handle(
      staffCall('POST', '/v1/commerce/orders/submit', { approval_id: approvalId }),
    );
    expect(retried.status).toBe(200);
    expect(orders).toHaveLength(1);
  });

  it('R6-1: an owner yes for one clerk does not carry to another clerk sending the same order', async () => {
    const OTHER = 'did:key:zsecondclerk';
    installStaffPresenceVerifier(
      async (device, pin) => (device === STAFF || device === OTHER) && pin === PIN,
    );
    expect(await proveStaffPresence(STAFF, PIN, Date.now())).toBe(true);
    expect(await proveStaffPresence(OTHER, PIN, Date.now())).toBe(true);
    grant('40000');
    grant('40000', 'buyer', OTHER);
    await tender();
    const holdBody = { supplier_did: SUPPLIER_B, quote_id: 'q-bbbb', service_rkey: 'shop' };
    const asked = await router.handle(
      staffCall('POST', '/v1/commerce/orders/from_quote', holdBody),
    );
    workflow.approve((asked.body as { task_id: string }).task_id);
    const held = await router.handle(staffCall('POST', '/v1/commerce/orders/from_quote', holdBody));
    const approvalId = (held.body as { approval_id: string }).approval_id;
    const byOther = await router.handle(
      staffCall('POST', '/v1/commerce/orders/submit', { approval_id: approvalId }, {}, OTHER),
    );
    expect(byOther.status).toBe(202);
    expect(orders).toHaveLength(0);
    const byHolder = await router.handle(
      staffCall('POST', '/v1/commerce/orders/submit', { approval_id: approvalId }),
    );
    expect(byHolder.status).toBe(200);
    expect(orders).toHaveLength(1);
  });

  describe('R6-2: the clearance is the record of the spend; a crash between it and the card never reuses the yes', () => {
    const holdBody = { supplier_did: SUPPLIER_B, quote_id: 'q-bbbb', service_rkey: 'shop' };
    /** An approved card and a clearance naming it, as a crash after the clearance would leave them. */
    async function interrupted(): Promise<{ card: string; approvalId: string }> {
      grant('40000');
      await tender();
      const asked = await router.handle(
        staffCall('POST', '/v1/commerce/orders/from_quote', holdBody),
      );
      const card = (asked.body as { task_id: string }).task_id;
      workflow.approve(card);
      await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
      const held = await router.handle(call('POST', '/v1/commerce/orders/from_quote', holdBody));
      const approvalId = (held.body as { approval_id: string }).approval_id;
      expect(
        runtime.staffClearances.put({
          approvalId,
          deviceDid: STAFF,
          escalationId: card,
          createdAt: Date.now(),
        }),
      ).toBe(true);
      return { card, approvalId };
    }

    it('card still approved: the cleared order sends, and the next order gets a new card, not the spent one', async () => {
      const { card, approvalId } = await interrupted();
      const sentOrder = await router.handle(
        staffCall('POST', '/v1/commerce/orders/submit', { approval_id: approvalId }),
      );
      expect(sentOrder.status).toBe(200);
      const next = await router.handle(
        staffCall('POST', '/v1/commerce/orders/from_quote', holdBody),
      );
      expect(next.status).toBe(202);
      expect((next.body as { task_id: string }).task_id).not.toBe(card);
      expect(workflow.store().getById(card)?.status).toBe('completed');
    });

    it('card stuck running: the next order is not stuck behind it; the spend is finished and a new card raised', async () => {
      const { card } = await interrupted();
      workflow.store().transition(card, 'queued' as never, 'running' as never, Date.now());
      const next = await router.handle(
        staffCall('POST', '/v1/commerce/orders/from_quote', holdBody),
      );
      expect(next.status).toBe(202);
      expect((next.body as { task_id: string }).task_id).not.toBe(card);
      expect(workflow.store().getById(card)?.status).toBe('completed');
    });
  });

  it("R5-2: Brain can neither mint, forge nor decide the owner's yes above a clerk's cap", async () => {
    registerWorkflowRoutes(router);
    grant('40000');
    await tender();
    const brain = (p: string, body: Record<string, unknown>, params: Record<string, string> = {}) =>
      router.handle({
        method: 'POST',
        path: p,
        query: {},
        headers: {},
        body,
        rawBody: new Uint8Array(),
        params,
        trustedInProcess: true,
        callerType: 'brain',
        callerDID: 'did:key:brain',
      } as unknown as CoreRequest);
    const key = `commerce_staff_escalation:${STAFF}:commerce_submit:quote:${SUPPLIER_B}:q-bbbb:INR:48000`;
    // Neither the key namespace nor the card type can be created through the API.
    const underKey = await brain('/v1/workflow/tasks', {
      id: 'forged-1',
      kind: 'approval',
      description: 'x',
      payload: '{}',
      idempotency_key: key,
      initial_state: 'queued',
    });
    expect((underKey.body as { error: string }).error).toBe('reserved_idempotency_key');
    const asCard = await brain('/v1/workflow/tasks', {
      id: 'forged-2',
      kind: 'approval',
      description: 'x',
      payload: JSON.stringify({ type: 'commerce_staff_escalation' }),
      initial_state: 'queued',
    });
    expect((asCard.body as { error: string }).error).toBe('reserved_payload_type');
    // A real card: Brain may not approve it.
    const asked = await router.handle(
      staffCall('POST', '/v1/commerce/orders/from_quote', {
        supplier_did: SUPPLIER_B,
        quote_id: 'q-bbbb',
        service_rkey: 'shop',
      }),
    );
    const cardId = (asked.body as { task_id: string }).task_id;
    const approved = await brain(`/v1/workflow/tasks/${cardId}/approve`, {}, { id: cardId });
    expect(approved.status).toBe(403);
    expect(workflow.store().getById(cardId)?.status).toBe('pending_approval');
    // Even a task planted under the key by some other path is never read as a yes.
    workflow.cancel(cardId, 'owner said no');
    workflow.create({
      id: 'planted',
      kind: 'approval',
      description: 'x',
      payload: '{}',
      idempotencyKey: key,
      initialState: 'queued' as never,
    });
    const refused = await router.handle(
      staffCall('POST', '/v1/commerce/orders/from_quote', {
        supplier_did: SUPPLIER_B,
        quote_id: 'q-bbbb',
        service_rkey: 'shop',
      }),
    );
    expect(refused.status).toBe(403);
  });

  it('R4-2: a clerk cannot send a draft-bound order around the draft send', async () => {
    grant('50000');
    await tender();
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const held = await router.handle(
      call('POST', '/v1/commerce/orders/from_quote', {
        supplier_did: SUPPLIER_B,
        quote_id: 'q-bbbb',
        service_rkey: 'shop',
      }),
    );
    const record = runtime.orderApprovals.get((held.body as { approval_id: string }).approval_id);
    if (record === null) throw new Error('no held order');
    const draftBound = `oap_${'d'.repeat(32)}`;
    expect(
      runtime.orderApprovals.put({
        approvalId: draftBound,
        order: record.order,
        context: {
          ...record.context,
          source: {
            origin: 'photo_order_draft',
            binding_version: 1,
            draft_id: 'draft-1',
            conversation_id: 'conv-1',
            assignment_generations: [{ line_id: 'l1', generation: 1 }],
            requirement_generations: [],
            snapshot_digest: '0'.repeat(64),
          },
        },
        serviceRkey: record.serviceRkey,
        createdAt: Date.now(),
        expiresAt: record.expiresAt,
      }),
    ).toBe(true);
    const refused = await router.handle(
      staffCall('POST', '/v1/commerce/orders/submit', { approval_id: draftBound }),
    );
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toBe('use_draft_submit');
    expect(orders).toHaveLength(0);
  });

  it('a clerk still cannot open a tender, compare one, or counter', async () => {
    grant('50000');
    const tenderId = await tender();
    for (const [method, p, body] of [
      ['POST', '/v1/commerce/trade/tender', {}],
      ['POST', '/v1/commerce/trade/counter', { supplier_did: SUPPLIER_B, quote_id: 'q-bbbb' }],
    ] as const) {
      expect((await router.handle(staffCall(method, p, body))).status).toBe(403);
    }
    expect(
      (
        await router.handle(
          staffCall('GET', '/v1/commerce/trade/tender/comparison', {}, { tender_id: tenderId }),
        )
      ).status,
    ).toBe(403);
  });
});
