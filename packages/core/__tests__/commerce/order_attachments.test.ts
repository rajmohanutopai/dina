/**
 * Order attachments (JIFFY_MERCHANT_INTEGRATION_PLAN §3.3) — the store on
 * both backends, the supplier's authoring rules, the buyer's verification,
 * the two owner cards and the decision that authors a PaymentNote.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  readOrderAttachment,
  readPaymentNote,
  tradeRecordDigest,
  type OrderAttachment,
} from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { setAcceptanceObserver } from '../../src/commerce/acceptance_seam';
import { retainAcceptedAcknowledgement } from '../../src/commerce/buyer_retention';
import { CommerceOrderStore } from '../../src/commerce/commerce_order';
import {
  ORDER_CHECKOUT_LINK_TYPE,
  PAYMENT_EVIDENCE_RECORD_TYPE,
} from '../../src/commerce/integration';
import {
  InMemoryOrderAttachmentRepository,
  SQLiteOrderAttachmentRepository,
  attachOrderEvidence,
  makeOrderAttachmentDecisionHandler,
  pendingEvidenceRefs,
  raiseCardsForRetainedAttachments,
  raiseOrderAttachmentCard,
  verifyInboundOrderAttachment,
  type OrderAttachmentRepository,
  type OrderAttachmentRow,
} from '../../src/commerce/order_attachments';
import { InMemoryCommerceOrderRefRepository } from '../../src/commerce/order_refs';
import { InMemoryCommerceReceiptRepository } from '../../src/commerce/receipts';
import { installTradeDocumentDispatcher } from '../../src/commerce/trade_dispatch';
import { InMemoryTradeDocumentRepository } from '../../src/commerce/trade_ledger';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { WorkflowTaskState } from '../../src/workflow/domain';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService } from '../../src/workflow/service';

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
} from './helpers';

import type { CommerceRuntime } from '../../src/commerce/runtime';

const DEVICE = 'did:key:zJiffyIntegration';
const T0 = 1_800_000_000_000;
const EXPIRES = new Date(T0 + 86_400_000).toISOString();
const REQUEST = makeQuoteRequest();
const QUOTE = makeSignedQuote(REQUEST);
const ORDER = makeOrder(QUOTE, REQUEST.delivery.projection);

function sqliteAdapter(): { adapter: NodeSQLiteAdapter; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-attachments-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return {
    adapter,
    close: () => {
      adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function row(over: Partial<OrderAttachmentRow> = {}): OrderAttachmentRow {
  return {
    attachmentDigest: 'a'.repeat(64),
    kind: 'checkout_handoff',
    orderDigest: ORDER.order_digest,
    purchaseOrderId: ORDER.purchase_order_id,
    counterpartyDid: BUYER_DID,
    direction: 'outbound',
    sourceDeviceDid: DEVICE,
    commandId: 'cmd-1',
    recordJson: '{}',
    evidenceJson: '{}',
    createdAt: T0,
    ...over,
  };
}

describe.each([
  {
    name: 'sqlite',
    make: () => {
      const { adapter, close } = sqliteAdapter();
      return {
        repo: new SQLiteOrderAttachmentRepository(adapter) as OrderAttachmentRepository,
        close,
      };
    },
  },
  {
    name: 'memory',
    make: () => ({
      repo: new InMemoryOrderAttachmentRepository() as OrderAttachmentRepository,
      close: () => undefined,
    }),
  },
])('the attachment store ($name)', ({ make }) => {
  let repo: OrderAttachmentRepository;
  let close: () => void;
  beforeEach(() => ({ repo, close } = make()));
  afterEach(() => close());

  it('first writer wins on the digest AND on the command id; rows list per order oldest first; copies never alias', () => {
    expect(repo.put(row())).toBe(true);
    expect(repo.put(row({ recordJson: '{"tampered":1}' }))).toBe(false);
    expect(repo.get('a'.repeat(64))?.recordJson).toBe('{}');
    // A second document under a command that already minted one is refused.
    expect(repo.put(row({ attachmentDigest: 'b'.repeat(64) }))).toBe(false);
    expect(repo.getByCommandId('cmd-1')?.attachmentDigest).toBe('a'.repeat(64));
    // The buyer's rows carry no command id and never collide on it.
    expect(
      repo.put(
        row({
          attachmentDigest: 'c'.repeat(64),
          commandId: null,
          direction: 'inbound',
          createdAt: T0 + 2,
        }),
      ),
    ).toBe(true);
    expect(
      repo.put(
        row({
          attachmentDigest: 'd'.repeat(64),
          commandId: null,
          direction: 'inbound',
          createdAt: T0 + 1,
        }),
      ),
    ).toBe(true);
    expect(repo.listByOrder(ORDER.order_digest).map((r) => r.attachmentDigest)).toEqual([
      'a'.repeat(64),
      'd'.repeat(64),
      'c'.repeat(64),
    ]);
    expect(repo.listByOrder('e'.repeat(64))).toEqual([]);
    const read = repo.get('a'.repeat(64));
    if (read !== null) read.recordJson = 'mutated';
    expect(repo.get('a'.repeat(64))?.recordJson).toBe('{}');
  });
});

/** A supplier node holding ORDER as accepted: receipt + decided reference. */
function supplierNode(
  decide: 'accepted' | 'rejected' | 'reserved' = 'accepted',
  clock: { now: number } = { now: T0 },
): {
  runtime: Pick<CommerceRuntime, 'receipts' | 'orders' | 'nodeDid' | 'now'>;
  stores: { orderAttachments: InMemoryOrderAttachmentRepository };
} {
  const receipts = new InMemoryCommerceReceiptRepository();
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
  const orders = new CommerceOrderStore({
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
  if (decide !== 'reserved') {
    const ack = makeAcknowledgement({
      purchase_order_id: ORDER.purchase_order_id,
      order_digest: ORDER.order_digest,
      ...(decide === 'accepted'
        ? {
            kind: 'accepted',
            supplier_order_id: 'so-1',
            accepted_quote_digest: QUOTE.quote_digest,
            accepted_at: '2026-09-23T10:00:00.000Z',
          }
        : { kind: 'rejected', reason_code: 'out_of_stock' }),
    });
    const loaded = orders.load(BUYER_DID, ORDER.purchase_order_id);
    if (loaded === null) throw new Error('fixture: order not reserved');
    expect(loaded.decide({ acknowledgementJson: JSON.stringify(ack), decidedAt: T0 + 1 }).ok).toBe(
      true,
    );
  }
  return {
    runtime: { receipts, orders, nodeDid: () => SUPPLIER_DID, now: () => clock.now },
    stores: { orderAttachments: new InMemoryOrderAttachmentRepository() },
  };
}

const CHECKOUT = {
  session_ref: 'cs_1',
  url: 'https://pay.example.com/s/cs_1',
  amount: ORDER.approved_total,
};

describe('a connector attaches evidence (supplier side)', () => {
  it('binds to the accepted order, stamps attribution from the CALLER, retains outbound with the command id, and is idempotent by command', () => {
    const { runtime, stores } = supplierNode();
    const first = attachOrderEvidence(runtime, stores, {
      deviceDid: DEVICE,
      provider: 'clover',
      commandId: 'cmd-1',
      orderDigest: ORDER.order_digest,
      kind: 'checkout_handoff',
      payload: {
        ...CHECKOUT,
        source: { kind: 'supplier', device_did: 'did:key:zForged', provider: 'me' },
      } as never,
      expiresAt: EXPIRES,
    });
    // A `source` in the payload is not a field the checkout carries: the shape refuses it? No — unknown
    // payload fields are tolerated on the wire; the ATTACHMENT's source is Core's, from the caller.
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.replayed).toBe(false);
    expect(first.attachment).toMatchObject({
      protocol_version: ORDER.protocol_version,
      purchase_order_id: ORDER.purchase_order_id,
      buyer_did: BUYER_DID,
      supplier_did: SUPPLIER_DID,
      order_digest: ORDER.order_digest,
      kind: 'checkout_handoff',
      source: { kind: 'integration', device_did: DEVICE, provider: 'clover' },
      issued_at: new Date(T0).toISOString(),
      expires_at: EXPIRES,
    });
    expect(readOrderAttachment(first.attachment, hash).ok).toBe(true);
    const stored = stores.orderAttachments.get(first.attachment.attachment_digest);
    expect(stored).toMatchObject({
      direction: 'outbound',
      counterpartyDid: BUYER_DID,
      sourceDeviceDid: DEVICE,
      commandId: 'cmd-1',
      purchaseOrderId: ORDER.purchase_order_id,
    });
    // The order itself did not move.
    expect(runtime.orders.load(BUYER_DID, ORDER.purchase_order_id)?.ref.state).toBe('decided');

    const replay = attachOrderEvidence(runtime, stores, {
      deviceDid: DEVICE,
      provider: 'clover',
      commandId: 'cmd-1',
      orderDigest: ORDER.order_digest,
      kind: 'checkout_handoff',
      payload: {
        ...CHECKOUT,
        source: { kind: 'supplier', device_did: 'did:key:zForged', provider: 'me' },
      } as never,
      expiresAt: EXPIRES,
    });
    expect(replay).toEqual({ ok: true, attachment: first.attachment, replayed: true });
    const conflict = attachOrderEvidence(runtime, stores, {
      deviceDid: DEVICE,
      provider: 'clover',
      commandId: 'cmd-1',
      orderDigest: ORDER.order_digest,
      kind: 'checkout_handoff',
      payload: { ...CHECKOUT, session_ref: 'cs_2' },
      expiresAt: EXPIRES,
    });
    expect(conflict).toMatchObject({ ok: false, status: 409, refusal: 'command_conflict' });
    // The same content under a NEW command id is a NEW document: the id and
    // the issue time are the command's own, so nothing collapses two
    // issuances into one — a connector that means "again" says a new command.
    const again = attachOrderEvidence(runtime, stores, {
      deviceDid: DEVICE,
      provider: 'clover',
      commandId: 'cmd-2',
      orderDigest: ORDER.order_digest,
      kind: 'checkout_handoff',
      payload: CHECKOUT,
      expiresAt: EXPIRES,
    });
    expect(again).toMatchObject({ ok: true, replayed: false });
    expect(again.ok && again.attachment.attachment_digest).not.toBe(
      first.attachment.attachment_digest,
    );
    expect(stores.orderAttachments.listByOrder(ORDER.order_digest)).toHaveLength(2);
  });

  it('refuses an unknown or foreign order (404), an order not accepted (409), a checkout that changes the price (409) and a bad shape (400)', () => {
    const { runtime, stores } = supplierNode();
    expect(
      attachOrderEvidence(runtime, stores, {
        deviceDid: DEVICE,
        provider: 'clover',
        commandId: 'c-1',
        orderDigest: 'f'.repeat(64),
        kind: 'checkout_handoff',
        payload: CHECKOUT,
      }),
    ).toMatchObject({ ok: false, status: 404, refusal: 'unknown_order' });
    expect(
      attachOrderEvidence({ ...runtime, nodeDid: () => 'did:plc:someoneelse' }, stores, {
        deviceDid: DEVICE,
        provider: 'clover',
        commandId: 'c-2',
        orderDigest: ORDER.order_digest,
        kind: 'checkout_handoff',
        payload: CHECKOUT,
      }),
    ).toMatchObject({ ok: false, status: 404, refusal: 'unknown_order' });
    expect(
      attachOrderEvidence(runtime, stores, {
        deviceDid: DEVICE,
        provider: 'clover',
        commandId: 'c-3',
        orderDigest: ORDER.order_digest,
        kind: 'checkout_handoff',
        payload: { ...CHECKOUT, amount: { currency: 'INR', minor_units: '1' } },
      }),
    ).toMatchObject({ ok: false, status: 409, refusal: 'amount_mismatch' });
    expect(
      attachOrderEvidence(runtime, stores, {
        deviceDid: DEVICE,
        provider: 'clover',
        commandId: 'c-4',
        orderDigest: ORDER.order_digest,
        kind: 'checkout_handoff',
        payload: { ...CHECKOUT, url: 'http://pay.example.com/s/1' },
      }),
    ).toMatchObject({
      ok: false,
      status: 400,
      refusal: 'invalid_attachment',
      detail: expect.stringContaining('url'),
    });
    expect(
      attachOrderEvidence(runtime, stores, {
        deviceDid: DEVICE,
        provider: 'Clover!',
        commandId: 'c-5',
        orderDigest: ORDER.order_digest,
        kind: 'checkout_handoff',
        payload: CHECKOUT,
      }),
    ).toMatchObject({
      ok: false,
      status: 400,
      refusal: 'invalid_attachment',
      detail: expect.stringContaining('provider'),
    });
    expect(
      attachOrderEvidence(runtime, stores, {
        deviceDid: DEVICE,
        provider: 'clover',
        commandId: 'c-6',
        orderDigest: ORDER.order_digest,
        kind: 'payment_evidence',
        payload: {
          provider_ref: 'ch_1',
          amount: ORDER.approved_total,
          state: 'settled',
          version: '1',
        },
      }),
    ).toMatchObject({ ok: false, status: 400, refusal: 'invalid_attachment' });
    expect(stores.orderAttachments.listByOrder(ORDER.order_digest)).toEqual([]);
    for (const decide of ['reserved', 'rejected'] as const) {
      const node = supplierNode(decide);
      expect(
        attachOrderEvidence(node.runtime, node.stores, {
          deviceDid: DEVICE,
          provider: 'clover',
          commandId: 'c-7',
          orderDigest: ORDER.order_digest,
          kind: 'fulfilment_evidence',
          payload: { provider_ref: 'job_1', state: 'production_started', version: '1' },
        }),
      ).toMatchObject({ ok: false, status: 409, refusal: 'order_not_accepted' });
    }
  });

  it('the next status carries captured payments and started production as evidence_refs, oldest first, and nothing else', () => {
    const clock = { now: T0 };
    const { runtime, stores } = supplierNode('accepted', clock);
    const attach = (commandId: string, kind: string, payload: unknown): string => {
      clock.now += 1; // each attachment lands a moment after the last
      const out = attachOrderEvidence(runtime, stores, {
        deviceDid: DEVICE,
        provider: 'clover',
        commandId,
        orderDigest: ORDER.order_digest,
        kind,
        payload,
      });
      if (!out.ok) throw new Error(`fixture: ${out.refusal}`);
      return out.attachment.attachment_digest;
    };
    attach('e-1', 'payment_evidence', {
      provider_ref: 'ch_1',
      amount: ORDER.approved_total,
      state: 'authorized',
      version: '1',
    });
    const captured = attach('e-2', 'payment_evidence', {
      provider_ref: 'ch_1',
      amount: ORDER.approved_total,
      state: 'captured',
      version: '2',
    });
    const started = attach('e-3', 'fulfilment_evidence', {
      provider_ref: 'job_1',
      state: 'production_started',
      version: '1',
    });
    attach('e-4', 'fulfilment_evidence', { provider_ref: 'job_1', state: 'ready', version: '2' });
    attach('e-5', 'checkout_handoff', CHECKOUT);
    expect(pendingEvidenceRefs(stores, ORDER.order_digest)).toEqual([captured, started]);
    expect(pendingEvidenceRefs(stores, 'f'.repeat(64))).toEqual([]);
  });
});

/** The buyer's readers: this node holds ORDER, accepted, from SUPPLIER. */
const buyerReaders = {
  readOrder: (counterparty: string, id: string) =>
    counterparty === SUPPLIER_DID && id === ORDER.purchase_order_id ? ORDER : null,
  readAcceptance: (counterparty: string, id: string) =>
    counterparty === SUPPLIER_DID && id === ORDER.purchase_order_id
      ? { acceptedAt: '2026-09-23T10:00:00.000Z' }
      : null,
};

function authored(kind: string, payload: unknown, commandId = 'cmd-x'): OrderAttachment {
  const { runtime, stores } = supplierNode();
  const out = attachOrderEvidence(runtime, stores, {
    deviceDid: DEVICE,
    provider: 'clover',
    commandId,
    orderDigest: ORDER.order_digest,
    kind,
    payload,
    ...(kind === 'checkout_handoff' ? { expiresAt: EXPIRES } : {}),
  });
  if (!out.ok) throw new Error(`fixture: ${out.refusal} ${out.detail ?? ''}`);
  return out.attachment;
}

describe('an attachment arrives (buyer side)', () => {
  it('verifies the sender is the order’s supplier, this node its buyer, the order held and accepted, then retains inbound once', () => {
    const repository = new InMemoryOrderAttachmentRepository();
    const doc = authored('checkout_handoff', CHECKOUT);
    const shared = {
      selfDid: BUYER_DID,
      repository,
      evidenceJson: '{"envelope":1}',
      nowMs: T0 + 5,
      ...buyerReaders,
    };
    const applied = verifyInboundOrderAttachment({
      ...shared,
      senderDid: SUPPLIER_DID,
      attachment: doc,
    });
    expect(applied).toMatchObject({
      outcome: 'applied',
      recordDigest: doc.attachment_digest,
      attachment: doc,
    });
    expect(repository.get(doc.attachment_digest)).toMatchObject({
      direction: 'inbound',
      counterpartyDid: SUPPLIER_DID,
      commandId: null,
      sourceDeviceDid: DEVICE,
      evidenceJson: '{"envelope":1}',
    });
    expect(
      verifyInboundOrderAttachment({ ...shared, senderDid: SUPPLIER_DID, attachment: doc }),
    ).toEqual({ outcome: 'duplicate', recordDigest: doc.attachment_digest });
    expect(
      verifyInboundOrderAttachment({ ...shared, senderDid: 'did:plc:stranger', attachment: doc })
        .outcome,
    ).toBe('not_ours');
    expect(
      verifyInboundOrderAttachment({
        ...shared,
        selfDid: 'did:plc:other',
        senderDid: SUPPLIER_DID,
        attachment: doc,
      }).outcome,
    ).toBe('not_ours');
    expect(
      verifyInboundOrderAttachment({
        ...shared,
        senderDid: SUPPLIER_DID,
        attachment: doc,
        readOrder: () => null,
      }).outcome,
    ).toBe('refused');
    // Order held, acceptance not yet: RETAINED (a fresh store, since the same
    // document was retained above) with no card, awaiting the acknowledgement.
    expect(
      verifyInboundOrderAttachment({
        ...shared,
        repository: new InMemoryOrderAttachmentRepository(),
        senderDid: SUPPLIER_DID,
        attachment: doc,
        readAcceptance: () => null,
      }),
    ).toEqual({
      outcome: 'applied',
      recordDigest: doc.attachment_digest,
      detail: 'awaiting_acceptance',
    });
    expect(
      verifyInboundOrderAttachment({
        ...shared,
        senderDid: SUPPLIER_DID,
        attachment: { ...doc, kind: 'payment_evidence' },
      }).outcome,
    ).toBe('unreadable');
    // A supplier who re-seals a checkout at a different price binds to nothing this buyer holds.
    const repriced = {
      ...doc,
      payload: { ...CHECKOUT, amount: { currency: 'INR', minor_units: '1' } },
    };
    const resealed = {
      ...repriced,
      attachment_digest: tradeRecordDigest('order_attachment', repriced, hash),
    };
    expect(
      verifyInboundOrderAttachment({ ...shared, senderDid: SUPPLIER_DID, attachment: resealed }),
    ).toMatchObject({ outcome: 'refused', detail: expect.stringContaining('total') });
    expect(repository.listByOrder(ORDER.order_digest)).toHaveLength(1);
  });
});

describe('the owner’s two questions', () => {
  function workflowFor(handler?: ReturnType<typeof makeOrderAttachmentDecisionHandler>): {
    workflow: WorkflowService;
    repo: InMemoryWorkflowRepository;
  } {
    const repo = new InMemoryWorkflowRepository();
    const workflow = new WorkflowService({
      repository: repo,
      nowMsFn: () => T0,
      ...(handler !== undefined ? { approvalDecisionHandler: handler } : {}),
    });
    return { workflow, repo };
  }
  /** The buyer's money stores: the khata ledger and the retained attachments. */
  function buyerStores(): {
    tradeDocuments: InMemoryTradeDocumentRepository;
    orderAttachments: InMemoryOrderAttachmentRepository;
  } {
    return {
      tradeDocuments: new InMemoryTradeDocumentRepository(),
      orderAttachments: new InMemoryOrderAttachmentRepository(),
    };
  }
  /** Retain an authored attachment on the buyer the way ingress does, then ask for its card. */
  function landed(
    stores: ReturnType<typeof buyerStores>,
    attachment: OrderAttachment,
    at = T0 + 5,
  ): OrderAttachment {
    stores.orderAttachments.put({
      attachmentDigest: attachment.attachment_digest,
      kind: attachment.kind,
      orderDigest: attachment.order_digest,
      purchaseOrderId: attachment.purchase_order_id,
      counterpartyDid: SUPPLIER_DID,
      direction: 'inbound',
      sourceDeviceDid: DEVICE,
      commandId: null,
      recordJson: JSON.stringify(attachment),
      evidenceJson: '{}',
      createdAt: at,
    });
    return attachment;
  }
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('a checkout link raises one card with the link, the amount and the expiry; evidence other than a captured payment raises none', () => {
    const stores = buyerStores();
    const { workflow, repo } = workflowFor();
    const link = landed(stores, authored('checkout_handoff', CHECKOUT));
    const raised = raiseOrderAttachmentCard(stores, link, T0 + 5, workflow);
    expect(raised).toEqual({
      raised: true,
      taskId: `order-checkout-${link.attachment_digest.slice(0, 32)}`,
    });
    const task = repo.getById(`order-checkout-${link.attachment_digest.slice(0, 32)}`);
    expect(task?.status).toBe(WorkflowTaskState.PendingApproval);
    expect(task?.expires_at).toBe(Math.floor(Date.parse(EXPIRES) / 1000));
    expect(JSON.parse(task?.payload ?? '{}')).toEqual({
      type: ORDER_CHECKOUT_LINK_TYPE,
      attachment_digest: link.attachment_digest,
      purchase_order_id: ORDER.purchase_order_id,
      supplier_did: SUPPLIER_DID,
      provider: 'clover',
      session_ref: 'cs_1',
      url: CHECKOUT.url,
      amount: ORDER.approved_total,
      expires_at: EXPIRES,
    });
    expect(task?.description).toContain('through clover');
    // Again is the same card, not a second one.
    expect(raiseOrderAttachmentCard(stores, link, T0 + 6, workflow)).toEqual(raised);
    expect(
      raiseOrderAttachmentCard(
        stores,
        landed(
          stores,
          authored(
            'payment_evidence',
            {
              provider_ref: 'ch_1',
              amount: ORDER.approved_total,
              state: 'authorized',
              version: '1',
            },
            'a-1',
          ),
        ),
        T0 + 7,
        workflow,
      ),
    ).toEqual({ raised: false, reason: 'not_a_card' });
    expect(
      raiseOrderAttachmentCard(
        stores,
        landed(
          stores,
          authored(
            'fulfilment_evidence',
            { provider_ref: 'job_1', state: 'production_started', version: '1' },
            'f-1',
          ),
        ),
        T0 + 8,
        workflow,
      ),
    ).toEqual({ raised: false, reason: 'not_a_card' });
    expect(raiseOrderAttachmentCard(stores, link, T0 + 9, null)).toEqual({
      raised: false,
      reason: 'no_workflow',
    });
    expect(repo.getByCorrelationId(ORDER.purchase_order_id)).toHaveLength(1);
  });

  it('a newer checkout link supersedes the pending one (one payment link per order); a link that has already lapsed raises nothing', () => {
    const stores = buyerStores();
    const { workflow, repo } = workflowFor();
    const first = landed(stores, authored('checkout_handoff', CHECKOUT, 'l-1'));
    const second = landed(
      stores,
      authored(
        'checkout_handoff',
        { ...CHECKOUT, session_ref: 'cs_2', url: 'https://pay.example.com/s/cs_2' },
        'l-2',
      ),
      T0 + 6,
    );
    const a = raiseOrderAttachmentCard(stores, first, T0 + 5, workflow);
    const b = raiseOrderAttachmentCard(stores, second, T0 + 6, workflow);
    expect(a.raised && b.raised && a.taskId !== b.taskId).toBe(true);
    const pending = repo
      .getByCorrelationId(ORDER.purchase_order_id)
      .filter((t) => t.status === WorkflowTaskState.PendingApproval);
    expect(pending.map((t) => t.id)).toEqual([b.raised ? b.taskId : '']);
    expect(repo.getById(a.raised ? a.taskId : '')?.status).toBe(WorkflowTaskState.Cancelled);
    // Landed after its own expiry: retained evidence, no question.
    const late = landed(
      stores,
      authored('checkout_handoff', { ...CHECKOUT, session_ref: 'cs_3' }, 'l-3'),
      Date.parse(EXPIRES) + 1,
    );
    expect(raiseOrderAttachmentCard(stores, late, Date.parse(EXPIRES) + 1, workflow)).toEqual({
      raised: false,
      reason: 'expired',
    });
    expect(
      repo
        .getByCorrelationId(ORDER.purchase_order_id)
        .filter((t) => t.status === WorkflowTaskState.PendingApproval),
    ).toHaveLength(1);
  });

  it('a captured payment asks ONCE per processor payment, whatever revision reports it, and not at all once the khata records it', () => {
    const stores = buyerStores();
    const { workflow, repo } = workflowFor();
    const v1 = landed(
      stores,
      authored(
        'payment_evidence',
        {
          provider_ref: 'ch_1',
          amount: ORDER.approved_total,
          state: 'captured',
          version: '1',
          method: 'upi',
        },
        'p-1',
      ),
    );
    const first = raiseOrderAttachmentCard(stores, v1, T0 + 5, workflow);
    expect(first.raised).toBe(true);
    const v2 = landed(
      stores,
      authored(
        'payment_evidence',
        {
          provider_ref: 'ch_1',
          amount: ORDER.approved_total,
          state: 'captured',
          version: '2',
          method: 'upi',
        },
        'p-2',
      ),
      T0 + 6,
    );
    expect(raiseOrderAttachmentCard(stores, v2, T0 + 6, workflow)).toEqual(first);
    expect(repo.getByCorrelationId(ORDER.purchase_order_id)).toHaveLength(1);
    const payload = JSON.parse(repo.getById(first.raised ? first.taskId : '')?.payload ?? '{}');
    expect(payload).toMatchObject({
      type: PAYMENT_EVIDENCE_RECORD_TYPE,
      provider_ref: 'ch_1',
      amount: ORDER.approved_total,
      method: 'upi',
      supplier_did: SUPPLIER_DID,
    });
    // The buyer already recorded this payment: no question.
    const note = {
      protocol_version: '1.0',
      payment_note_id: 'pn-1',
      buyer_did: BUYER_DID,
      supplier_did: SUPPLIER_DID,
      amount: ORDER.approved_total,
      method: 'upi',
      external_ref: 'ch_9',
      paid_at: '2026-09-23T10:00:00.000Z',
    };
    const sealed = { ...note, note_digest: tradeRecordDigest('payment_note', note, hash) };
    stores.tradeDocuments.put({
      recordDigest: sealed.note_digest,
      kind: 'payment_note',
      counterpartyDid: SUPPLIER_DID,
      purchaseOrderId: '',
      answersDigest: '',
      direction: 'outbound',
      recordJson: JSON.stringify(sealed),
      evidenceJson: '{}',
      createdAt: T0,
    });
    const other = landed(
      stores,
      authored(
        'payment_evidence',
        { provider_ref: 'ch_9', amount: ORDER.approved_total, state: 'captured', version: '3' },
        'p-3',
      ),
      T0 + 7,
    );
    expect(raiseOrderAttachmentCard(stores, other, T0 + 7, workflowFor().workflow)).toEqual({
      raised: false,
      reason: 'already_recorded',
    });
  });

  it('only the NEWEST revision of a processor payment speaks: a refund withdraws the pending card, an out-of-order capture raises nothing, a zero capture is not a question', () => {
    const stores = buyerStores();
    const { workflow, repo } = workflowFor();
    const captured = landed(
      stores,
      authored(
        'payment_evidence',
        { provider_ref: 'ch_r', amount: ORDER.approved_total, state: 'captured', version: '2' },
        'r-1',
      ),
    );
    const raised = raiseOrderAttachmentCard(stores, captured, T0 + 5, workflow);
    expect(raised.raised).toBe(true);
    // The processor refunds (version 3): the pending question is withdrawn.
    const refunded = landed(
      stores,
      authored(
        'payment_evidence',
        { provider_ref: 'ch_r', amount: ORDER.approved_total, state: 'refunded', version: '3' },
        'r-2',
      ),
      T0 + 6,
    );
    expect(raiseOrderAttachmentCard(stores, refunded, T0 + 6, workflow)).toEqual({
      raised: false,
      reason: 'not_a_card',
    });
    expect(repo.getById(raised.raised ? raised.taskId : '')?.status).toBe(
      WorkflowTaskState.Cancelled,
    );
    // A capture numbered BELOW the refund arrives late: superseded, no card.
    const stale = landed(
      stores,
      authored(
        'payment_evidence',
        { provider_ref: 'ch_r', amount: ORDER.approved_total, state: 'captured', version: '1' },
        'r-3',
      ),
      T0 + 7,
    );
    expect(raiseOrderAttachmentCard(stores, stale, T0 + 7, workflow)).toEqual({
      raised: false,
      reason: 'superseded',
    });
    // A zero capture never leaves the supplier: the validator refuses it at the door.
    const { runtime: supplier, stores: supplierStores } = supplierNode();
    expect(
      attachOrderEvidence(supplier, supplierStores, {
        deviceDid: DEVICE,
        provider: 'clover',
        commandId: 'r-4',
        orderDigest: ORDER.order_digest,
        kind: 'payment_evidence',
        payload: {
          provider_ref: 'ch_z',
          amount: { currency: 'INR', minor_units: '0' },
          state: 'captured',
          version: '1',
        },
      }),
    ).toMatchObject({
      ok: false,
      status: 400,
      refusal: 'invalid_attachment',
      detail: expect.stringContaining('positive'),
    });
    expect(
      repo
        .getByCorrelationId(ORDER.purchase_order_id)
        .filter((t) => t.status === WorkflowTaskState.PendingApproval),
    ).toHaveLength(0);
  });

  it('a yes to "record this as paid?" authors the BUYER’s PaymentNote under the buyer’s key and pushes it; a no authors nothing; a closed money line fails the card and the question can be asked again', async () => {
    const stores = buyerStores();
    const receipts = new InMemoryCommerceReceiptRepository();
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
    receipts.put({
      recordDigest: QUOTE.quote_digest,
      domain: 'quote',
      buyerDid: BUYER_DID,
      quoteId: QUOTE.quote_id,
      purchaseOrderId: '',
      recordJson: JSON.stringify(QUOTE),
      evidenceJson: '{}',
      createdAt: T0,
    });
    const ack = makeAcknowledgement({
      purchase_order_id: ORDER.purchase_order_id,
      order_digest: ORDER.order_digest,
      accepted_quote_digest: QUOTE.quote_digest,
    });
    receipts.put({
      recordDigest: ack.acknowledgement_digest,
      domain: 'acknowledgement',
      buyerDid: BUYER_DID,
      quoteId: QUOTE.quote_id,
      purchaseOrderId: ORDER.purchase_order_id,
      recordJson: JSON.stringify(ack),
      evidenceJson: '{}',
      createdAt: T0,
    });
    const runtime = {
      receipts,
      nodeDid: () => BUYER_DID,
      now: () => T0 + 10,
      money: moneyOpen(stores),
    } as unknown as CommerceRuntime;
    let service: WorkflowService | null = null;
    const { workflow, repo } = workflowFor(
      makeOrderAttachmentDecisionHandler({
        runtime: () => runtime,
        workflow: () => service,
        nowMs: () => T0 + 10,
      }),
    );
    service = workflow;
    const sent: { to: string; kind: string; document: unknown }[] = [];
    let deliver = true;
    installTradeDocumentDispatcher(async (to, kind, document) => {
      sent.push({ to, kind, document });
      return deliver;
    });
    try {
      const evidence = landed(
        stores,
        authored(
          'payment_evidence',
          {
            provider_ref: 'ch_77',
            amount: ORDER.approved_total,
            state: 'captured',
            version: '1',
            method: 'upi',
          },
          'p-9',
        ),
      );
      const raised = raiseOrderAttachmentCard(stores, evidence, T0 + 5, workflow);
      if (!raised.raised) throw new Error('fixture: card not raised');
      workflow.approve(raised.taskId);
      await flush();
      const task = repo.getById(raised.taskId);
      expect(task?.status).toBe(WorkflowTaskState.Completed);
      const notes = stores.tradeDocuments.listByCounterparty(SUPPLIER_DID, 'payment_note');
      expect(notes).toHaveLength(1);
      const note = readPaymentNote(JSON.parse(notes[0]?.recordJson ?? '{}'), hash);
      expect(note.ok && note.note).toMatchObject({
        buyer_did: BUYER_DID,
        supplier_did: SUPPLIER_DID,
        amount: ORDER.approved_total,
        method: 'upi',
        external_ref: 'ch_77',
        order_refs: [ORDER.purchase_order_id],
      });
      expect(notes[0]?.direction).toBe('outbound');
      expect(JSON.parse(task?.result ?? '{}')).toEqual({
        note_digest: note.ok ? note.note.note_digest : '',
        dispatched: true,
      });
      expect(sent).toEqual([
        { to: SUPPLIER_DID, kind: 'payment_note', document: note.ok ? note.note : null },
      ]);

      // The same payment re-reported: the khata already holds it, the yes records nothing new.
      const again = landed(
        stores,
        authored(
          'payment_evidence',
          {
            provider_ref: 'ch_77',
            amount: ORDER.approved_total,
            state: 'captured',
            version: '2',
            method: 'upi',
          },
          'p-9b',
        ),
        T0 + 6,
      );
      expect(raiseOrderAttachmentCard(stores, again, T0 + 6, workflow)).toEqual({
        raised: false,
        reason: 'already_recorded',
      });

      // A no: the card closes, the khata gains nothing.
      const second = landed(
        stores,
        authored(
          'payment_evidence',
          { provider_ref: 'ch_78', amount: ORDER.approved_total, state: 'captured', version: '1' },
          'p-10',
        ),
        T0 + 7,
      );
      const denied = raiseOrderAttachmentCard(stores, second, T0 + 7, workflow);
      if (!denied.raised) throw new Error('fixture');
      workflow.cancel(denied.taskId, 'denied_by_operator');
      await flush();
      expect(stores.tradeDocuments.listByCounterparty(SUPPLIER_DID, 'payment_note')).toHaveLength(
        1,
      );
      expect(sent).toHaveLength(1);

      // A push that fails is recorded as NOT dispatched; the note is still retained.
      deliver = false;
      const third = landed(
        stores,
        authored(
          'payment_evidence',
          { provider_ref: 'ch_79', amount: ORDER.approved_total, state: 'captured', version: '1' },
          'p-11',
        ),
        T0 + 8,
      );
      const undelivered = raiseOrderAttachmentCard(stores, third, T0 + 8, workflow);
      if (!undelivered.raised) throw new Error('fixture');
      workflow.approve(undelivered.taskId);
      await flush();
      expect(JSON.parse(repo.getById(undelivered.taskId)?.result ?? '{}')).toMatchObject({
        dispatched: false,
      });
      expect(stores.tradeDocuments.listByCounterparty(SUPPLIER_DID, 'payment_note')).toHaveLength(
        2,
      );
      deliver = true;

      // The processor refunded after the card was raised: the yes authors nothing.
      const captured = landed(
        stores,
        authored(
          'payment_evidence',
          { provider_ref: 'ch_80', amount: ORDER.approved_total, state: 'captured', version: '1' },
          'p-12',
        ),
        T0 + 9,
      );
      const asked = raiseOrderAttachmentCard(stores, captured, T0 + 9, workflow);
      if (!asked.raised) throw new Error('fixture');
      landed(
        stores,
        authored(
          'payment_evidence',
          { provider_ref: 'ch_80', amount: ORDER.approved_total, state: 'refunded', version: '2' },
          'p-12b',
        ),
        T0 + 10,
      );
      workflow.approve(asked.taskId);
      await flush();
      expect(repo.getById(asked.taskId)?.status).toBe(WorkflowTaskState.Failed);
      expect(repo.getById(asked.taskId)?.error).toContain('evidence_superseded');
      expect(stores.tradeDocuments.listByCounterparty(SUPPLIER_DID, 'payment_note')).toHaveLength(
        2,
      );

      // A yes with the money line closed: nothing is authored, the card says why, and the
      // same processor payment may be asked again under a revision-qualified card.
      (runtime as { money: unknown }).money = moneyClosed();
      const fourth = landed(
        stores,
        authored(
          'payment_evidence',
          { provider_ref: 'ch_81', amount: ORDER.approved_total, state: 'captured', version: '1' },
          'p-13',
        ),
        T0 + 11,
      );
      const closed = raiseOrderAttachmentCard(stores, fourth, T0 + 11, workflow);
      if (!closed.raised) throw new Error('fixture');
      workflow.approve(closed.taskId);
      await flush();
      expect(repo.getById(closed.taskId)?.status).toBe(WorkflowTaskState.Failed);
      expect(repo.getById(closed.taskId)?.error).toContain('money_unavailable');
      const reasked = raiseOrderAttachmentCard(
        stores,
        landed(
          stores,
          authored(
            'payment_evidence',
            {
              provider_ref: 'ch_81',
              amount: ORDER.approved_total,
              state: 'captured',
              version: '2',
            },
            'p-13b',
          ),
          T0 + 12,
        ),
        T0 + 12,
        workflow,
      );
      expect(reasked.raised && reasked.taskId.startsWith(`${closed.taskId}-r`)).toBe(true);
      expect(repo.getById(reasked.raised ? reasked.taskId : '')?.status).toBe(
        WorkflowTaskState.PendingApproval,
      );
      // The owner already said no to ch_78: no re-ask on a decided question.
      expect(raiseOrderAttachmentCard(stores, second, T0 + 13, workflow)).toEqual({
        raised: false,
        reason: 'already_decided',
      });

      // A yes to the checkout card records the act and authors nothing.
      (runtime as { money: unknown }).money = moneyOpen(stores);
      const link = landed(stores, authored('checkout_handoff', CHECKOUT, 'p-14'), T0 + 14);
      const opened = raiseOrderAttachmentCard(stores, link, T0 + 14, workflow);
      if (!opened.raised) throw new Error('fixture');
      workflow.approve(opened.taskId);
      await flush();
      expect(repo.getById(opened.taskId)?.status).toBe(WorkflowTaskState.Completed);
      expect(JSON.parse(repo.getById(opened.taskId)?.result ?? '{}')).toEqual({ opened: true });
      expect(stores.tradeDocuments.listByCounterparty(SUPPLIER_DID, 'payment_note')).toHaveLength(
        2,
      );
    } finally {
      installTradeDocumentDispatcher(null);
    }
  });

  it('an attachment that lands before the acceptance is retained without a card; the acceptance raises it (the seam)', () => {
    const stores = buyerStores();
    const { workflow, repo } = workflowFor();
    const doc = authored('checkout_handoff', CHECKOUT, 'w-1');
    const receipts = new InMemoryCommerceReceiptRepository();
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
    // Ingress with the acceptance not yet retained: applied, no card.
    const verdict = verifyInboundOrderAttachment({
      senderDid: SUPPLIER_DID,
      selfDid: BUYER_DID,
      attachment: doc,
      repository: stores.orderAttachments,
      readOrder: buyerReaders.readOrder,
      readAcceptance: () => null,
      evidenceJson: '{}',
      nowMs: T0 + 5,
    });
    expect(verdict).toEqual({
      outcome: 'applied',
      recordDigest: doc.attachment_digest,
      detail: 'awaiting_acceptance',
    });
    expect(repo.getByCorrelationId(ORDER.purchase_order_id)).toHaveLength(0);
    // The acceptance lands on the kernel side; the seam hands the order to the money line.
    const seen: string[] = [];
    setAcceptanceObserver(({ buyerDid, purchaseOrderId, nowMs }) => {
      seen.push(`${buyerDid}:${purchaseOrderId}`);
      const order = receipts
        .listByOrder(buyerDid, purchaseOrderId)
        .find((r) => r.domain === 'order');
      if (order !== undefined)
        raiseCardsForRetainedAttachments(stores, order.recordDigest, nowMs, workflow);
    });
    try {
      const ack = makeAcknowledgement({
        purchase_order_id: ORDER.purchase_order_id,
        order_digest: ORDER.order_digest,
        accepted_quote_digest: QUOTE.quote_digest,
      });
      retainAcceptedAcknowledgement(
        { receipts } as unknown as CommerceRuntime,
        {
          state: 'accepted',
          acknowledgement: ack,
          buyerDid: BUYER_DID,
          purchaseOrderId: ORDER.purchase_order_id,
        } as never,
        T0 + 6,
      );
      expect(seen).toEqual([`${BUYER_DID}:${ORDER.purchase_order_id}`]);
      const cards = repo.getByCorrelationId(ORDER.purchase_order_id);
      expect(cards.map((t) => t.status)).toEqual([WorkflowTaskState.PendingApproval]);
      expect(JSON.parse(cards[0]?.payload ?? '{}').type).toBe(ORDER_CHECKOUT_LINK_TYPE);
      // Running the sweep again asks nothing twice.
      expect(
        raiseCardsForRetainedAttachments(stores, ORDER.order_digest, T0 + 7, workflow),
      ).toEqual([{ raised: true, taskId: cards[0]?.id }]);
      expect(repo.getByCorrelationId(ORDER.purchase_order_id)).toHaveLength(1);
    } finally {
      setAcceptanceObserver(null);
    }
  });
});
