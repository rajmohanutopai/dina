/**
 * Review item 7 — the quote-first buyer lane on a node with no photo: read
 * the quotes this node received, build the order from one of them in Core,
 * retain the owner's approval, and send it through the existing submit door.
 */

import {
  validatePurchaseOrderProposal,
  type PurchaseOrderProposal,
  type QuoteRequest,
} from '@dina/commerce-protocol';

import { InMemoryAttributionBoundaryRepository } from '../../../src/commerce/attribution_boundary';
import {
  installBuyerAuthorityProvider,
  singleOwnerAuthority,
} from '../../../src/commerce/buyer_authority';
import {
  installBuyerOrderSender,
  type BuyerOrderSender,
} from '../../../src/commerce/buyer_executor';
import { InMemoryBuyerOrderRepository } from '../../../src/commerce/buyer_orders';
import { InMemoryBuyerQuoteRepository } from '../../../src/commerce/buyer_quotes';
import { InMemoryBuyerQuoteRequestRepository } from '../../../src/commerce/buyer_requests';
import { InMemoryOrderApprovalRepository } from '../../../src/commerce/order_approvals';
import { InMemoryOrderDraftRepository } from '../../../src/commerce/order_draft_store';
import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  proveOwnerPresence,
  OWNER_IN_PROCESS_PRINCIPAL,
} from '../../../src/commerce/owner_presence';
import { InMemoryCommerceReceiptRepository } from '../../../src/commerce/receipts';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { InMemoryCommerceSettingsRepository } from '../../../src/commerce/settings_store';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import {
  BUYER_DID,
  hash,
  installActiveBuyerPack,
  makeQuoteRequest,
  makeSignedQuote,
  type InstalledBuyerPack,
} from '../../commerce/helpers';

const OWNER_CAP = 'test-owner-capability-secret';
const T0 = Date.parse('2026-08-08T09:00:00.000Z');
const REQUEST = makeQuoteRequest();
const QUOTE = makeSignedQuote(REQUEST, {
  quote_id: 'q-typed',
  valid_until: '2036-01-01T00:00:00.000Z',
});
const REQUEST_OLD: QuoteRequest = makeQuoteRequest({
  request_id: 'req-old',
  idempotency_key: 'idem-old',
});
const QUOTE_OLD = makeSignedQuote(REQUEST_OLD, {
  quote_id: 'q-old',
  valid_until: '2026-08-08T10:00:00.000Z',
});
const SUPPLIER = QUOTE.supplier_did;

let pack: InstalledBuyerPack;
let approvals: InMemoryOrderApprovalRepository;
let router: CoreRouter;
let sent: PurchaseOrderProposal[];

const call = (
  method: 'GET' | 'POST',
  path: string,
  body: Record<string, unknown> = {},
  caller = 'owner',
): CoreRequest => ({
  method,
  path,
  query: {},
  headers: {},
  body,
  rawBody: new Uint8Array(),
  params: {},
  trustedInProcess: true,
  callerType: caller,
  ...(caller === 'owner' ? { ownerCapability: OWNER_CAP } : { callerDID: 'did:key:someone' }),
});

beforeEach(async () => {
  setNodeDID(BUYER_DID);
  pack = installActiveBuyerPack(T0);
  approvals = new InMemoryOrderApprovalRepository();
  const buyerQuotes = new InMemoryBuyerQuoteRepository();
  buyerQuotes.append({ supplierDid: SUPPLIER, quoteId: 'q-old', quote: QUOTE_OLD, acceptedAt: T0 });
  buyerQuotes.append({
    supplierDid: SUPPLIER,
    quoteId: 'q-typed',
    quote: QUOTE,
    acceptedAt: T0 + 1,
  });
  const buyerQuoteRequests = new InMemoryBuyerQuoteRequestRepository();
  buyerQuoteRequests.put(REQUEST, T0);
  buyerQuoteRequests.put(REQUEST_OLD, T0);
  installCommerceRuntime({
    receipts: new InMemoryCommerceReceiptRepository(),
    attributionBoundary: new InMemoryAttributionBoundaryRepository(),
    buyerOrders: new InMemoryBuyerOrderRepository(),
    buyerQuotes,
    buyerQuoteRequests,
    orderApprovals: approvals,
    orderDrafts: new InMemoryOrderDraftRepository(),
    settings: new InMemoryCommerceSettingsRepository(),
    runInTransaction: (fn: () => unknown) => fn(),
  } as unknown as CommerceRuntime);
  sent = [];
  const sender: BuyerOrderSender = async ({ order }) => {
    sent.push(order);
    return { kind: 'ambiguous', reason: 'sent; awaiting the supplier acknowledgement' };
  };
  installBuyerOrderSender(sender);
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
  installCommerceRuntime(null);
  installBuyerOrderSender(null);
  installBuyerAuthorityProvider(null);
});

describe('the quotes this node received', () => {
  it('lists each quote’s head revision, newest first, with its lines and whether it has lapsed', async () => {
    const res = await router.handle(call('GET', '/v1/commerce/buyer/quotes'));
    expect(res.status).toBe(200);
    const quotes = (
      res.body as {
        quotes: {
          quote_id: string;
          expired: boolean;
          total: unknown;
          lines: { product: unknown; unit_price: unknown }[];
        }[];
      }
    ).quotes;
    expect(quotes.map((q) => [q.quote_id, q.expired])).toEqual([
      ['q-typed', false],
      ['q-old', true],
    ]);
    expect(quotes[0]?.total).toEqual(QUOTE.total);
    expect(quotes[0]?.lines[0]).toMatchObject({
      product: QUOTE.lines[0]?.offered_product,
      unit_price: QUOTE.lines[0]?.unit_price,
    });
    expect(
      (await router.handle(call('GET', '/v1/commerce/buyer/quotes', {}, 'brain'))).status,
    ).toBe(403);
  });
});

describe('an order built from a held quote', () => {
  it('needs the owner present, then Core builds the order from the quote and its retained request; submit sends exactly that order', async () => {
    const refused = await router.handle(
      call('POST', '/v1/commerce/orders/from_quote', {
        supplier_did: SUPPLIER,
        quote_id: 'q-typed',
      }),
    );
    expect(refused.status).toBe(403);
    expect((refused.body as { error: string }).error).toBe('no_user_presence');
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const res = await router.handle(
      call('POST', '/v1/commerce/orders/from_quote', {
        supplier_did: SUPPLIER,
        quote_id: 'q-typed',
        // A caller cannot steer lines, prices or totals: none of these are read.
        lines: [{ line_id: 'l1', quantity: { value: '1', unit_code: 'each' } }],
        total: { currency: 'INR', minor_units: '1' },
      }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { approval_id: string; purchase_order_id: string };
    const held = approvals.get(body.approval_id);
    const order = held?.order;
    if (order === undefined) throw new Error('approval not retained');
    expect(validatePurchaseOrderProposal(order, hash)).toBeNull();
    expect(order).toMatchObject({
      purchase_order_id: body.purchase_order_id,
      buyer_did: BUYER_DID,
      supplier_did: SUPPLIER,
      quote_id: 'q-typed',
      quote_digest: QUOTE.quote_digest,
      approved_total: QUOTE.total,
      accepted_terms_digest: QUOTE.terms_digest,
    });
    expect(order.accepted_lines).toEqual(
      QUOTE.lines.map((l) => ({
        line_id: l.line_id,
        product: l.offered_product,
        quantity: l.quantity,
      })),
    );
    expect(order.delivery).toMatchObject({
      projection_digest: REQUEST.delivery.projection.projection_digest,
    });
    expect(held?.serviceRkey).toBe('self');
    const submitted = await router.handle(
      call('POST', '/v1/commerce/orders/submit', { approval_id: body.approval_id }),
    );
    expect(submitted.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.order_digest).toBe(order.order_digest);
  });

  it('refuses an unknown quote, a lapsed one, a missing field, and a non-owner', async () => {
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    expect(
      (
        await router.handle(
          call('POST', '/v1/commerce/orders/from_quote', {
            supplier_did: SUPPLIER,
            quote_id: 'q-none',
          }),
        )
      ).status,
    ).toBe(404);
    const lapsed = await router.handle(
      call('POST', '/v1/commerce/orders/from_quote', { supplier_did: SUPPLIER, quote_id: 'q-old' }),
    );
    expect(lapsed.status).toBe(409);
    expect((lapsed.body as { error: string }).error).toBe('quote_expired');
    expect(
      (await router.handle(call('POST', '/v1/commerce/orders/from_quote', { quote_id: 'q-typed' })))
        .status,
    ).toBe(400);
    expect(
      (
        await router.handle(
          call(
            'POST',
            '/v1/commerce/orders/from_quote',
            { supplier_did: SUPPLIER, quote_id: 'q-typed' },
            'staff',
          ),
        )
      ).status,
    ).toBe(403);
    // No approval was retained by any refused call.
    expect(sent).toEqual([]);
  });
});
