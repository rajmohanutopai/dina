/**
 * The attachment doors (JIFFY_MERCHANT_INTEGRATION_PLAN §3.3): who may attach,
 * what the supplier node checks, what leaves over D2D, what the buyer node
 * does with it — through the real routes and the real trade ingress.
 */

import { readOrderAttachment, type OrderAttachment } from '@dina/commerce-protocol';

import { InMemoryCatalogDraftRepository } from '../../../src/commerce/catalog_draft_store';
import { InMemoryCatalogPointerRepository } from '../../../src/commerce/catalog_pointer_store';
import { InMemoryCatalogRefreshCommandRepository } from '../../../src/commerce/catalog_refresh_commands';
import { InMemoryCatalogSourceBindingRepository } from '../../../src/commerce/catalog_source_bindings';
import { CommerceOrderStore } from '../../../src/commerce/commerce_order';
import {
  ORDER_CHECKOUT_LINK_TYPE,
  PAYMENT_EVIDENCE_RECORD_TYPE,
} from '../../../src/commerce/integration';
import { InMemoryOrderAttachmentRepository } from '../../../src/commerce/order_attachments';
import { InMemoryCommerceOrderRefRepository } from '../../../src/commerce/order_refs';
import { InMemoryCommerceReceiptRepository } from '../../../src/commerce/receipts';
import {
  installCommerceRuntime,
  type CommerceMoneyAccess,
  type CommerceRuntime,
} from '../../../src/commerce/runtime';
import { InMemoryCommerceSettingsRepository } from '../../../src/commerce/settings_store';
import { InMemoryStaffGrantRepository } from '../../../src/commerce/staff_grants';
import { applyInboundTradeDocument } from '../../../src/commerce/trade_ingress';
import { InMemoryTradeDocumentRepository } from '../../../src/commerce/trade_ledger';
import { InMemoryTradeSpoolRepository } from '../../../src/commerce/trade_spool';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import { setD2DSender } from '../../../src/server/routes/d2d_msg';
import { registerWorkflowRoutes } from '../../../src/server/routes/workflow';
import { WorkflowTaskState } from '../../../src/workflow/domain';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';
import {
  BUYER_DID,
  SUPPLIER_DID,
  hash,
  makeAcknowledgement,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
  moneyClosed,
  moneyOpen,
} from '../../commerce/helpers';

const OWNER_CAP = 'test-owner-capability';
const DEVICE = 'did:key:zJiffyIntegration';
const T0 = 1_800_000_000_000;
const EXPIRES = new Date(T0 + 86_400_000).toISOString();
const REQUEST = makeQuoteRequest();
const QUOTE = makeSignedQuote(REQUEST);
const ORDER = makeOrder(QUOTE, REQUEST.delivery.projection);
const ACK = makeAcknowledgement({
  purchase_order_id: ORDER.purchase_order_id,
  order_digest: ORDER.order_digest,
  accepted_quote_digest: QUOTE.quote_digest,
});
const ATTACH = '/v1/commerce/integration/orders/attachments';
const CHECKOUT = {
  session_ref: 'cs_1',
  url: 'https://pay.example.com/s/cs_1',
  amount: ORDER.approved_total,
};

let router: CoreRouter;
let staffGrants: InMemoryStaffGrantRepository;
let orders: CommerceOrderStore;
let receipts: InMemoryCommerceReceiptRepository;
let attachments: InMemoryOrderAttachmentRepository;
let sent: { to: string; type: string; body: Record<string, unknown> }[];
let money: () => CommerceMoneyAccess;

function request(
  method: 'GET' | 'POST',
  path: string,
  caller: Partial<CoreRequest>,
  body: Record<string, unknown> = {},
  query: Record<string, string> = {},
): CoreRequest {
  return {
    method,
    path,
    query,
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...caller,
  } as CoreRequest;
}
const owner = (
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>,
): CoreRequest =>
  request(
    method,
    path,
    { callerType: 'owner', callerDID: 'did:key:owner', ownerCapability: OWNER_CAP },
    body,
    query,
  );
const device = (
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>,
): CoreRequest => request(method, path, { callerType: 'staff', callerDID: DEVICE }, body, query);

function supplierRuntime(): CommerceRuntime {
  return {
    staffGrants,
    orders,
    receipts,
    catalogPointers: new InMemoryCatalogPointerRepository(),
    catalogDrafts: new InMemoryCatalogDraftRepository(),
    catalogSourceBindings: new InMemoryCatalogSourceBindingRepository(),
    catalogRefreshCommands: new InMemoryCatalogRefreshCommandRepository(),
    settings: new InMemoryCommerceSettingsRepository(),
    tradeSpool: new InMemoryTradeSpoolRepository(),
    nodeDid: () => SUPPLIER_DID,
    now: () => T0,
    money: () => money(),
    runInTransaction: (body: () => void) => body(),
  } as unknown as CommerceRuntime;
}

beforeEach(() => {
  setNodeDID(SUPPLIER_DID);
  staffGrants = new InMemoryStaffGrantRepository();
  receipts = new InMemoryCommerceReceiptRepository();
  receipts.put({
    recordDigest: ORDER.order_digest,
    domain: 'order',
    buyerDid: BUYER_DID,
    quoteId: QUOTE.quote_id,
    purchaseOrderId: ORDER.purchase_order_id,
    recordJson: JSON.stringify(ORDER),
    evidenceJson: '{}',
    createdAt: T0,
  });
  orders = new CommerceOrderStore({
    refs: new InMemoryCommerceOrderRefRepository(),
    now: () => T0,
  });
  expect(
    orders.createReserved({
      buyerDid: BUYER_DID,
      purchaseOrderId: ORDER.purchase_order_id,
      idempotencyKey: 'idem-1',
      orderDigest: ORDER.order_digest,
      quoteId: QUOTE.quote_id,
      quoteDigest: QUOTE.quote_digest,
      pinnedVersion: '1.0',
      servingManifestCid: '',
      servingInstallId: '',
      admittedEpoch: '1',
      reconciliationRequired: false,
      decisionDeadlineAt: null,
      createdAt: T0,
    }),
  ).toBe(true);
  const loaded = orders.load(BUYER_DID, ORDER.purchase_order_id);
  if (loaded === null) throw new Error('fixture');
  expect(loaded.decide({ acknowledgementJson: JSON.stringify(ACK), decidedAt: T0 + 1 }).ok).toBe(
    true,
  );
  attachments = new InMemoryOrderAttachmentRepository();
  money = moneyOpen({ orderAttachments: attachments });
  installCommerceRuntime(supplierRuntime());
  setWorkflowService(
    new WorkflowService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => T0 }),
  );
  sent = [];
  setD2DSender(async (to, type, body) => {
    sent.push({ to, type, body });
    return { messageId: 'm-1', delivered: true, buffered: false, queued: false };
  });
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installCommerceRuntime(null);
  setWorkflowService(null);
  setD2DSender(null);
});

const grant = (): void => {
  staffGrants.put({
    deviceDid: DEVICE,
    scope: 'integration_trade_evidence',
    maxOrderMinorUnits: '',
    currency: '',
    installs: 'supplier',
    createdAt: T0,
    revokedAt: null,
  });
};

describe('who may attach', () => {
  it('the owner is refused on this one door (an attachment is a connector’s document); a device needs the trade-evidence grant on the supplier install', async () => {
    const asOwner = await router.handle(
      owner('POST', ATTACH, {
        command_id: 'c-1',
        order_digest: ORDER.order_digest,
        kind: 'checkout_handoff',
        payload: CHECKOUT,
        provider: 'clover',
      }),
    );
    expect(asOwner.status).toBe(403);
    expect((asOwner.body as { error: string }).error).toBe('integration_device_required');
    const noGrant = await router.handle(
      device('POST', ATTACH, {
        command_id: 'c-1',
        order_digest: ORDER.order_digest,
        kind: 'checkout_handoff',
        payload: CHECKOUT,
        provider: 'clover',
      }),
    );
    expect(noGrant.status).toBe(403);
    expect((noGrant.body as { error: string }).error).toBe('access_denied');
    staffGrants.put({
      deviceDid: DEVICE,
      scope: 'integration_status',
      maxOrderMinorUnits: '',
      currency: '',
      installs: 'supplier',
      createdAt: T0,
      revokedAt: null,
    });
    expect(
      (
        await router.handle(
          device('POST', ATTACH, {
            command_id: 'c-1',
            order_digest: ORDER.order_digest,
            kind: 'checkout_handoff',
            payload: CHECKOUT,
            provider: 'clover',
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await router.handle(device('GET', ATTACH, undefined, { order_digest: ORDER.order_digest })))
        .status,
    ).toBe(403);
    // Nothing left the node.
    expect(sent).toEqual([]);
    expect(attachments.listByOrder(ORDER.order_digest)).toEqual([]);
    // The owner reads the list through the same door.
    expect(
      (await router.handle(owner('GET', ATTACH, undefined, { order_digest: ORDER.order_digest })))
        .status,
    ).toBe(200);
  });
});

describe('the supplier node attaches and pushes', () => {
  beforeEach(grant);

  it('binds, attributes to the caller (a body `source` is ignored), retains, and pushes ONE commerce.trade message; a replay pushes nothing', async () => {
    const res = await router.handle(
      device('POST', ATTACH, {
        command_id: 'c-10',
        order_digest: ORDER.order_digest,
        kind: 'checkout_handoff',
        payload: CHECKOUT,
        provider: 'clover',
        expires_at: EXPIRES,
        source: { kind: 'integration', device_did: 'did:key:zForged', provider: 'forged' },
      }),
    );
    expect(res.status).toBe(201);
    const body = res.body as {
      ok: boolean;
      replayed: boolean;
      dispatched: boolean;
      attachment: OrderAttachment;
    };
    expect(body).toMatchObject({ ok: true, replayed: false, dispatched: true });
    expect(body.attachment.source).toEqual({
      kind: 'integration',
      device_did: DEVICE,
      provider: 'clover',
    });
    expect(readOrderAttachment(body.attachment, hash).ok).toBe(true);
    expect(sent).toEqual([
      {
        to: BUYER_DID,
        type: 'commerce.trade',
        body: { kind: 'order_attachment', document: body.attachment },
      },
    ]);
    const replay = await router.handle(
      device('POST', ATTACH, {
        command_id: 'c-10',
        order_digest: ORDER.order_digest,
        kind: 'checkout_handoff',
        payload: CHECKOUT,
        provider: 'clover',
        expires_at: EXPIRES,
      }),
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      ok: true,
      replayed: true,
      dispatched: false,
      attachment: body.attachment,
    });
    expect(sent).toHaveLength(1);
    // The order's state is untouched: evidence advances nothing.
    expect(orders.load(BUYER_DID, ORDER.purchase_order_id)?.ref.state).toBe('decided');
    const listed = await router.handle(
      device('GET', ATTACH, undefined, { order_digest: ORDER.order_digest }),
    );
    expect(listed.body).toEqual({
      attachments: [{ direction: 'outbound', created_at: T0, attachment: body.attachment }],
    });
  });

  it('refuses at the door: bad ids, an unknown kind, a non-object payload, a missing provider; then 404 / 409 / 400 from the binding, and 503 with the money line closed', async () => {
    const base = {
      command_id: 'c-20',
      order_digest: ORDER.order_digest,
      kind: 'checkout_handoff',
      payload: CHECKOUT,
      provider: 'clover',
    };
    for (const bad of [
      { ...base, command_id: 'has space' },
      { ...base, order_digest: 'nope' },
      { ...base, kind: 'refund' },
      { ...base, payload: 'x' },
      { ...base, provider: '' },
      { ...base, expires_at: 5 },
    ]) {
      expect((await router.handle(device('POST', ATTACH, bad))).status).toBe(400);
    }
    expect(
      (await router.handle(device('POST', ATTACH, { ...base, order_digest: 'f'.repeat(64) }))).body,
    ).toMatchObject({ error: 'unknown_order' });
    expect(
      (
        await router.handle(
          device('POST', ATTACH, {
            ...base,
            payload: { ...CHECKOUT, amount: { currency: 'INR', minor_units: '999' } },
          }),
        )
      ).body,
    ).toMatchObject({ error: 'amount_mismatch' });
    expect(
      (
        await router.handle(
          device('POST', ATTACH, {
            ...base,
            payload: { ...CHECKOUT, url: 'http://pay.example.com/x' },
          }),
        )
      ).body,
    ).toMatchObject({ error: 'invalid_attachment' });
    expect(sent).toEqual([]);
    money = moneyClosed();
    const closed = await router.handle(device('POST', ATTACH, base));
    expect(closed.status).toBe(503);
    expect((closed.body as { error: string }).error).toBe('commerce_pack_inactive');
    expect(
      (await router.handle(device('GET', ATTACH, undefined, { order_digest: ORDER.order_digest })))
        .status,
    ).toBe(503);
  });
});

describe('the buyer node receives what left', () => {
  let buyerAttachments: InMemoryOrderAttachmentRepository;
  let tradeDocuments: InMemoryTradeDocumentRepository;
  let workflowRepo: InMemoryWorkflowRepository;

  /** Author on the supplier, then become the buyer holding the same order. */
  async function authoredThenBuyer(
    kind: string,
    payload: unknown,
    commandId: string,
  ): Promise<Record<string, unknown>> {
    grant();
    const res = await router.handle(
      device('POST', ATTACH, {
        command_id: commandId,
        order_digest: ORDER.order_digest,
        kind,
        payload,
        provider: 'clover',
        ...(kind === 'checkout_handoff' ? { expires_at: EXPIRES } : {}),
      }),
    );
    expect(res.status).toBe(201);
    const pushed = sent[sent.length - 1]?.body;
    if (pushed === undefined) throw new Error('fixture: nothing was pushed');
    const buyerReceipts = new InMemoryCommerceReceiptRepository();
    buyerReceipts.put({
      recordDigest: ORDER.order_digest,
      domain: 'order',
      buyerDid: BUYER_DID,
      quoteId: QUOTE.quote_id,
      purchaseOrderId: ORDER.purchase_order_id,
      recordJson: JSON.stringify(ORDER),
      evidenceJson: '{}',
      createdAt: T0,
    });
    buyerReceipts.put({
      recordDigest: ACK.acknowledgement_digest,
      domain: 'acknowledgement',
      buyerDid: BUYER_DID,
      quoteId: QUOTE.quote_id,
      purchaseOrderId: ORDER.purchase_order_id,
      recordJson: JSON.stringify(ACK),
      evidenceJson: '{}',
      createdAt: T0,
    });
    buyerAttachments = new InMemoryOrderAttachmentRepository();
    tradeDocuments = new InMemoryTradeDocumentRepository();
    installCommerceRuntime({
      ...supplierRuntime(),
      receipts: buyerReceipts,
      nodeDid: () => BUYER_DID,
      money: moneyOpen({ orderAttachments: buyerAttachments, tradeDocuments }),
    } as unknown as CommerceRuntime);
    workflowRepo = new InMemoryWorkflowRepository();
    setWorkflowService(new WorkflowService({ repository: workflowRepo, nowMsFn: () => T0 }));
    setNodeDID(BUYER_DID);
    return pushed;
  }

  it('a checkout link is verified against the buyer’s own order, retained inbound with the envelope, and becomes the owner’s "open the payment link?" card', async () => {
    const pushed = await authoredThenBuyer('checkout_handoff', CHECKOUT, 'c-30');
    const applied = applyInboundTradeDocument({
      senderDid: SUPPLIER_DID,
      body: pushed,
      evidenceJson: '{"envelope":"e1"}',
      nowMs: T0 + 5,
    });
    expect(applied).toMatchObject({ outcome: 'applied', kind: 'order_attachment' });
    const digest = (pushed.document as OrderAttachment).attachment_digest;
    expect(buyerAttachments.get(digest)).toMatchObject({
      direction: 'inbound',
      counterpartyDid: SUPPLIER_DID,
      evidenceJson: '{"envelope":"e1"}',
      commandId: null,
    });
    const cards = workflowRepo.getByCorrelationId(ORDER.purchase_order_id);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.status).toBe(WorkflowTaskState.PendingApproval);
    expect(JSON.parse(cards[0]?.payload ?? '{}')).toMatchObject({
      type: ORDER_CHECKOUT_LINK_TYPE,
      url: CHECKOUT.url,
      amount: ORDER.approved_total,
      supplier_did: SUPPLIER_DID,
    });
    // Again is a duplicate, and no second card.
    expect(
      applyInboundTradeDocument({
        senderDid: SUPPLIER_DID,
        body: pushed,
        evidenceJson: '{}',
        nowMs: T0 + 6,
      }),
    ).toMatchObject({ outcome: 'duplicate' });
    expect(workflowRepo.getByCorrelationId(ORDER.purchase_order_id)).toHaveLength(1);
    // A stranger relaying the same bytes is not the order's supplier.
    expect(
      applyInboundTradeDocument({
        senderDid: 'did:plc:stranger',
        body: pushed,
        evidenceJson: '{}',
        nowMs: T0 + 7,
      }),
    ).toMatchObject({ outcome: 'not_ours' });
    // Brain may neither create nor decide the card.
    registerWorkflowRoutes(router, OWNER_CAP);
    const brain = (method: 'POST', path: string, body: Record<string, unknown>): CoreRequest =>
      request(method, path, { callerType: 'brain', callerDID: 'did:key:brain' }, body);
    expect(
      (await router.handle(brain('POST', `/v1/workflow/tasks/${cards[0]?.id}/approve`, {}))).status,
    ).toBe(403);
    expect(
      (
        await router.handle(
          brain('POST', `/v1/workflow/tasks/${cards[0]?.id}/fail`, { error: 'x' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await router.handle(brain('POST', `/v1/workflow/tasks/${cards[0]?.id}/cancel`, {}))).status,
    ).toBe(403);
    expect(
      (
        await router.handle(
          brain('POST', '/v1/workflow/tasks', {
            id: 'planted',
            kind: 'approval',
            description: 'x',
            payload: JSON.stringify({ type: PAYMENT_EVIDENCE_RECORD_TYPE }),
            initial_state: 'pending_approval',
          }),
        )
      ).status,
    ).toBe(400);
    expect(workflowRepo.getById(cards[0]?.id ?? '')?.status).toBe(
      WorkflowTaskState.PendingApproval,
    );
  });

  it('captured payment evidence becomes "record this as paid?"; an authorized one is retained and asks nothing', async () => {
    const authorized = await authoredThenBuyer(
      'payment_evidence',
      { provider_ref: 'ch_1', amount: ORDER.approved_total, state: 'authorized', version: '1' },
      'c-40',
    );
    expect(
      applyInboundTradeDocument({
        senderDid: SUPPLIER_DID,
        body: authorized,
        evidenceJson: '{}',
        nowMs: T0 + 5,
      }),
    ).toMatchObject({ outcome: 'applied' });
    expect(workflowRepo.getByCorrelationId(ORDER.purchase_order_id)).toEqual([]);
    // The supplier attaches the capture; the buyer becomes the buyer again with the same stores.
    setNodeDID(SUPPLIER_DID);
    installCommerceRuntime(supplierRuntime());
    const captured = await authoredThenBuyer(
      'payment_evidence',
      {
        provider_ref: 'ch_1',
        amount: ORDER.approved_total,
        state: 'captured',
        version: '2',
        method: 'upi',
      },
      'c-41',
    );
    expect(
      applyInboundTradeDocument({
        senderDid: SUPPLIER_DID,
        body: captured,
        evidenceJson: '{}',
        nowMs: T0 + 6,
      }),
    ).toMatchObject({ outcome: 'applied' });
    const cards = workflowRepo.getByCorrelationId(ORDER.purchase_order_id);
    expect(cards).toHaveLength(1);
    expect(JSON.parse(cards[0]?.payload ?? '{}')).toMatchObject({
      type: PAYMENT_EVIDENCE_RECORD_TYPE,
      provider_ref: 'ch_1',
      method: 'upi',
      amount: ORDER.approved_total,
    });
    expect(tradeDocuments.listByCounterparty(SUPPLIER_DID, 'payment_note')).toEqual([]);
    // Brain may neither fail nor cancel the payment card.
    registerWorkflowRoutes(router, OWNER_CAP);
    const brain = (path: string, body: Record<string, unknown>): CoreRequest =>
      request('POST', path, { callerType: 'brain', callerDID: 'did:key:brain' }, body);
    expect(
      (await router.handle(brain(`/v1/workflow/tasks/${cards[0]?.id}/fail`, { error: 'x' })))
        .status,
    ).toBe(403);
    expect(
      (await router.handle(brain(`/v1/workflow/tasks/${cards[0]?.id}/cancel`, {}))).status,
    ).toBe(403);
    expect(workflowRepo.getById(cards[0]?.id ?? '')?.status).toBe(
      WorkflowTaskState.PendingApproval,
    );
  });

  it('a staff device reads only the orders this node SUPPLIES: on a node that also buys, the inbound rows of a bought order are the owner’s alone', async () => {
    const pushed = await authoredThenBuyer('checkout_handoff', CHECKOUT, 'c-50');
    expect(
      applyInboundTradeDocument({
        senderDid: SUPPLIER_DID,
        body: pushed,
        evidenceJson: '{}',
        nowMs: T0 + 5,
      }),
    ).toMatchObject({ outcome: 'applied' });
    // The buyer node now also runs a connector of its own (a dual-role node).
    staffGrants.put({
      deviceDid: DEVICE,
      scope: 'integration_trade_evidence',
      maxOrderMinorUnits: '',
      currency: '',
      installs: 'supplier',
      createdAt: T0,
      revokedAt: null,
    });
    const asStaff = await router.handle(
      device('GET', ATTACH, undefined, { order_digest: ORDER.order_digest }),
    );
    expect(asStaff.status).toBe(404);
    expect((asStaff.body as { error: string }).error).toBe('unknown_order');
    const asOwner = await router.handle(
      request(
        'GET',
        ATTACH,
        { callerType: 'owner', callerDID: 'did:key:owner', ownerCapability: OWNER_CAP },
        {},
        { order_digest: ORDER.order_digest },
      ),
    );
    expect(asOwner.status).toBe(200);
    expect(
      (asOwner.body as { attachments: { direction: string }[] }).attachments.map(
        (a) => a.direction,
      ),
    ).toEqual(['inbound']);
  });
});
