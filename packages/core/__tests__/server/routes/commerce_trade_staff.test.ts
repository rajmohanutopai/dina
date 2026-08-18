/**
 * The staff slice at the routes (TRADE_FIRST_STRATEGY §6.3–§6.5): a
 * staff device receipting a delivery on the BUYER node — presence
 * first, then the deterministic gate pricing the receipt from the
 * bound quote, with under-cap allow, over-cap escalation to an owner
 * card, and the ceremony routes staying owner-only.
 */

import { createHash } from 'node:crypto';

import { tradeRecordDigest, type Sha256Fn } from '@dina/commerce-protocol';

import { InMemoryAttributionBoundaryRepository } from '../../../src/commerce/attribution_boundary';
import { InMemoryCatalogDraftRepository } from '../../../src/commerce/catalog_draft_store';
import { InMemoryOrderApprovalRepository } from '../../../src/commerce/order_approvals';
import { InMemoryOrderDraftRepository } from '../../../src/commerce/order_draft_store';
import {
  clearOwnerPresence,
  installStaffPresenceVerifier,
} from '../../../src/commerce/owner_presence';
import { InMemoryCommerceReceiptRepository } from '../../../src/commerce/receipts';
import { getCommerceRuntime, installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { InMemoryStaffGrantRepository } from '../../../src/commerce/staff_grants';
import { InMemoryStaffPinRepository } from '../../../src/commerce/staff_pins';
import { InMemoryTenderRepository } from '../../../src/commerce/tender';
import {
  InMemoryTradeDocumentRepository,
  verifyInboundDeliveryNote,
} from '../../../src/commerce/trade_ledger';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';
import {
  BUYER_DID,
  SUPPLIER_DID,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
} from '../../commerce/helpers';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());
const OWNER_CAP = 'test-owner-capability-secret';
const STAFF_DID = 'did:key:zstaffclerk';
const STAFF_PIN = '4321';
const T0 = 1_800_000_000_000;

const REQUEST = makeQuoteRequest();
const QUOTE = makeSignedQuote(REQUEST); // 100 each @ ₹5.00/each
const ORDER = makeOrder(QUOTE, REQUEST.delivery.projection);

let router: CoreRouter;
let tradeDocs: InMemoryTradeDocumentRepository;
let staffGrants: InMemoryStaffGrantRepository;
let boundary: InMemoryAttributionBoundaryRepository;
let orderDrafts: InMemoryOrderDraftRepository;
let noteDigest: string;

function owner(path: string, body?: Record<string, unknown>): CoreRequest {
  return {
    method: body === undefined ? 'GET' : 'POST',
    path,
    query: {},
    headers: {},
    body: body ?? {},
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    callerDID: 'did:key:owner',
    ownerCapability: OWNER_CAP,
  } as unknown as CoreRequest;
}

function staff(path: string, body?: Record<string, unknown>): CoreRequest {
  return {
    method: body === undefined ? 'GET' : 'POST',
    path,
    query: {},
    headers: {},
    body: body ?? {},
    rawBody: new Uint8Array(),
    params: {},
    // Handler-level harness: dispatch directly with the resolved caller
    // identity. The signed pipeline's role→'staff' mapping and the authz
    // matrix are pinned by __tests__/auth/staff_caller.test.ts.
    trustedInProcess: true,
    callerType: 'staff',
    callerDID: STAFF_DID,
  } as unknown as CoreRequest;
}

function putGrant(maxMinor: string): void {
  staffGrants.put({
    deviceDid: STAFF_DID,
    scope: 'commerce_receive_goods',
    maxOrderMinorUnits: maxMinor,
    currency: 'INR',
    installs: 'buyer',
    createdAt: T0,
    revokedAt: null,
  });
}

async function provePresence(): Promise<void> {
  const proven = await router.handle(
    staff('/v1/commerce/trade/staff-presence', { pin: STAFF_PIN }),
  );
  expect(proven.status).toBe(200);
}

const receiptBody = (accepted: string): Record<string, unknown> => ({
  delivery_note_digest: noteDigest,
  lines: [{ line_id: 'l1', accepted_quantity: { value: accepted, unit_code: 'each' }, reason_code: 'short' }],
});

beforeEach(() => {
  // THIS node is the BUYER: it retained the order + bound quote and has
  // an inbound delivery note from the supplier awaiting receipt.
  setNodeDID(BUYER_DID);
  tradeDocs = new InMemoryTradeDocumentRepository();
  staffGrants = new InMemoryStaffGrantRepository();
  const receipts = new InMemoryCommerceReceiptRepository();
  receipts.put({
    recordDigest: ORDER.order_digest,
    domain: 'order',
    buyerDid: ORDER.buyer_did,
    quoteId: ORDER.quote_id,
    purchaseOrderId: ORDER.purchase_order_id,
    recordJson: JSON.stringify(ORDER),
    evidenceJson: '{}',
    createdAt: T0,
  });
  receipts.put({
    recordDigest: QUOTE.quote_digest,
    domain: 'quote',
    buyerDid: QUOTE.buyer_did,
    quoteId: QUOTE.quote_id,
    purchaseOrderId: '',
    recordJson: JSON.stringify(QUOTE),
    evidenceJson: '{}',
    createdAt: T0,
  });
  boundary = new InMemoryAttributionBoundaryRepository();
  orderDrafts = new InMemoryOrderDraftRepository();
  installCommerceRuntime({
    tradeDocuments: tradeDocs,
    staffGrants,
    receipts,
    attributionBoundary: boundary,
    catalogDrafts: new InMemoryCatalogDraftRepository(),
    orderDrafts,
    orderApprovals: new InMemoryOrderApprovalRepository(),
    tenders: new InMemoryTenderRepository(),
    staffPins: new InMemoryStaffPinRepository(),
    pendingDecisions: { list: () => [], get: () => null, clear: () => false },
    runInTransaction: (body: () => void) => body(),
    nodeDid: () => BUYER_DID,
    // The REAL clock: the draft routes stamp with Date.now(), and a
    // presence stamp proved at a fixture instant would read as future.
    now: () => Date.now(),
  } as unknown as CommerceRuntime);

  const noteDraft = {
    protocol_version: '1.0',
    delivery_note_id: 'dn-staff-1',
    purchase_order_id: ORDER.purchase_order_id,
    order_digest: ORDER.order_digest,
    supplier_order_id: 'so-1',
    lines: [{ line_id: 'l1', delivered_quantity: { value: '60', unit_code: 'each' } }],
    dispatched_at: '2026-08-17T09:00:00.000Z',
  };
  const note = { ...noteDraft, note_digest: tradeRecordDigest('delivery_note', noteDraft, hash) };
  const ingested = verifyInboundDeliveryNote({
    senderDid: SUPPLIER_DID,
    selfDid: BUYER_DID,
    note,
    repository: tradeDocs,
    readOrder: (id) => (id === ORDER.purchase_order_id ? ORDER : null),
    evidenceJson: '{}',
    nowMs: Date.now(),
  });
  expect(ingested.outcome).toBe('applied');
  noteDigest = note.note_digest;

  installStaffPresenceVerifier(async (deviceDid, pin) => deviceDid === STAFF_DID && pin === STAFF_PIN);
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installCommerceRuntime(null);
  installStaffPresenceVerifier(null);
  clearOwnerPresence();
  setWorkflowService(null);
});

describe('the ceremony routes stay owner-only in the handler too', () => {
  it('owner creates, lists and revokes; a staff caller is refused', async () => {
    const created = await router.handle(
      owner('/v1/commerce/staff-grants', {
        device_did: STAFF_DID,
        scope: 'commerce_receive_goods',
        installs: 'buyer',
        max_order_minor_units: '30000',
        currency: 'INR',
        pin: STAFF_PIN,
      }),
    );
    expect(created.status).toBe(200);
    const listed = await router.handle({
      ...owner('/v1/commerce/staff-grants', undefined),
      query: { device_did: STAFF_DID },
    } as unknown as CoreRequest);
    expect(listed.status).toBe(200);
    expect((listed.body as { grants: unknown[] }).grants).toHaveLength(1);

    const staffAttempt = await router.handle(
      staff('/v1/commerce/staff-grants', {
        device_did: STAFF_DID,
        scope: 'commerce_confirm',
        installs: 'both',
      }),
    );
    expect(staffAttempt.status).toBe(403);

    const revoked = await router.handle(
      owner('/v1/commerce/staff-grants/revoke', { device_did: STAFF_DID }),
    );
    expect(revoked.status).toBe(200);
    expect(staffGrants.listByDevice(STAFF_DID)[0]?.revokedAt).not.toBeNull();
  });

  it('the FIRST grant requires a PIN; later grants may omit it (the record stands)', async () => {
    const bare = await router.handle(
      owner('/v1/commerce/staff-grants', {
        device_did: STAFF_DID,
        scope: 'commerce_confirm',
        installs: 'both',
      }),
    );
    expect(bare.status).toBe(400);
    expect((bare.body as { error: string }).error).toBe('pin_required');

    const first = await router.handle(
      owner('/v1/commerce/staff-grants', {
        device_did: STAFF_DID,
        scope: 'commerce_confirm',
        installs: 'both',
        pin: STAFF_PIN,
      }),
    );
    expect(first.status).toBe(200);

    // A second scope for the SAME device rides the standing PIN.
    const second = await router.handle(
      owner('/v1/commerce/staff-grants', {
        device_did: STAFF_DID,
        scope: 'commerce_receive_goods',
        installs: 'buyer',
        max_order_minor_units: '30000',
        currency: 'INR',
      }),
    );
    expect(second.status).toBe(200);
    expect(staffGrants.listByDevice(STAFF_DID)).toHaveLength(2);
  });

  it('a malformed grant is refused before storage', async () => {
    const missingCap = await router.handle(
      owner('/v1/commerce/staff-grants', {
        device_did: STAFF_DID,
        scope: 'commerce_submit',
        installs: 'buyer',
      }),
    );
    expect(missingCap.status).toBe(400);
    const cappedConfirm = await router.handle(
      owner('/v1/commerce/staff-grants', {
        device_did: STAFF_DID,
        scope: 'commerce_confirm',
        installs: 'buyer',
        max_order_minor_units: '1',
        currency: 'INR',
      }),
    );
    expect(cappedConfirm.status).toBe(400);
    expect(staffGrants.listByDevice(STAFF_DID)).toHaveLength(0);
  });
});

describe('staff presence at the route', () => {
  it('proves with the right PIN only, and only for staff callers', async () => {
    const wrong = await router.handle(staff('/v1/commerce/trade/staff-presence', { pin: 'nope' }));
    expect(wrong.status).toBe(403);
    await provePresence();
    const asOwner = await router.handle(
      owner('/v1/commerce/trade/staff-presence', { pin: STAFF_PIN }),
    );
    expect(asOwner.status).toBe(403);
  });
});

describe('POST /v1/commerce/trade/delivery-receipt as staff (§6.5)', () => {
  it('refuses without presence, even with a live grant', async () => {
    putGrant('30000');
    const denied = await router.handle(
      staff('/v1/commerce/trade/delivery-receipt', receiptBody('55')),
    );
    expect(denied.status).toBe(403);
    expect(String((denied.body as { reason: string }).reason)).toContain('presence');
  });

  it('under the cap: the receipt issues exactly as the owner path would', async () => {
    putGrant('30000'); // 55 × 500 = 27500 ≤ 30000
    await provePresence();
    const issued = await router.handle(
      staff('/v1/commerce/trade/delivery-receipt', receiptBody('55')),
    );
    expect(issued.status).toBe(200);
    expect(tradeDocs.answersTo(noteDigest, 'delivery_receipt')).toHaveLength(1);
  });

  it('over the cap: 202 pending_approval, an idempotent owner card, and NO receipt stored', async () => {
    const workflowRepo = new InMemoryWorkflowRepository();
    setWorkflowService(new WorkflowService({ repository: workflowRepo }));
    putGrant('20000'); // 27500 > 20000
    await provePresence();
    const first = await router.handle(
      staff('/v1/commerce/trade/delivery-receipt', receiptBody('55')),
    );
    expect(first.status).toBe(202);
    const taskId = (first.body as { task_id: string }).task_id;
    expect(taskId).not.toBe('');
    const again = await router.handle(
      staff('/v1/commerce/trade/delivery-receipt', receiptBody('55')),
    );
    expect((again.body as { task_id: string }).task_id).toBe(taskId);
    expect(tradeDocs.answersTo(noteDigest, 'delivery_receipt')).toHaveLength(0);
  });

  it("owner approval of the card lets the SAME receipt through; a DIFFERENT value raises its own card", async () => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const workflow = new WorkflowService({ repository: workflowRepo });
    setWorkflowService(workflow);
    putGrant('20000');
    await provePresence();
    const card = await router.handle(
      staff('/v1/commerce/trade/delivery-receipt', receiptBody('55')),
    );
    expect(card.status).toBe(202);
    const taskId = (card.body as { task_id: string }).task_id;
    workflow.approve(taskId);

    // A retry at a DIFFERENT value is a different question — its own card,
    // never the approved one's authority.
    const different = await router.handle(
      staff('/v1/commerce/trade/delivery-receipt', receiptBody('60')),
    );
    expect(different.status).toBe(202);
    expect((different.body as { task_id: string }).task_id).not.toBe(taskId);

    // The approved value proceeds; the one-answer rule then closes the note.
    const issued = await router.handle(
      staff('/v1/commerce/trade/delivery-receipt', receiptBody('55')),
    );
    expect(issued.status).toBe(200);
    expect(tradeDocs.answersTo(noteDigest, 'delivery_receipt')).toHaveLength(1);
    const replay = await router.handle(
      staff('/v1/commerce/trade/delivery-receipt', receiptBody('55')),
    );
    expect(replay.status).toBe(409);
  });

  it('over the cap with NO workflow service refuses outright — fail closed', async () => {
    putGrant('20000');
    await provePresence();
    const denied = await router.handle(
      staff('/v1/commerce/trade/delivery-receipt', receiptBody('55')),
    );
    expect(denied.status).toBe(403);
  });

  it('an unpriceable receipt refuses BEFORE the cap comparison', async () => {
    putGrant('30000');
    await provePresence();
    const denied = await router.handle(
      staff('/v1/commerce/trade/delivery-receipt', {
        delivery_note_digest: noteDigest,
        lines: [{ line_id: 'ghost', accepted_quantity: { value: '1', unit_code: 'each' } }],
      }),
    );
    expect(denied.status).toBe(409);
    expect(tradeDocs.answersTo(noteDigest, 'delivery_receipt')).toHaveLength(0);
  });

  it('a revoked grant refuses even with fresh presence', async () => {
    putGrant('30000');
    staffGrants.revokeDevice(STAFF_DID, T0);
    await provePresence();
    const denied = await router.handle(
      staff('/v1/commerce/trade/delivery-receipt', receiptBody('55')),
    );
    expect(denied.status).toBe(403);
    expect(String((denied.body as { reason: string }).reason)).toContain('grant');
  });

  it('the owner path is untouched by the staff gate', async () => {
    const issued = await router.handle(
      owner('/v1/commerce/trade/delivery-receipt', receiptBody('55')),
    );
    expect(issued.status).toBe(200);
  });

  it('a staff caller on an owner-only trade route (delivery-note) is refused', async () => {
    putGrant('30000');
    await provePresence();
    const denied = await router.handle(
      staff('/v1/commerce/trade/delivery-note', {
        counterparty_did: SUPPLIER_DID,
        purchase_order_id: ORDER.purchase_order_id,
        supplier_order_id: 'so-1',
        lines: [],
      }),
    );
    expect(denied.status).toBe(403);
  });
});

describe('GET /v1/commerce/trade/unanswered as staff (§6.3)', () => {
  it('readable with a live grant, refused without one', async () => {
    const noGrant = await router.handle({
      ...staff('/v1/commerce/trade/unanswered', undefined),
      query: { counterparty_did: SUPPLIER_DID },
    } as unknown as CoreRequest);
    expect(noGrant.status).toBe(403);
    putGrant('30000');
    const withGrant = await router.handle({
      ...staff('/v1/commerce/trade/unanswered', undefined),
      query: { counterparty_did: SUPPLIER_DID },
    } as unknown as CoreRequest);
    expect(withGrant.status).toBe(200);
    expect((withGrant.body as { delivery_notes: unknown[] }).delivery_notes).toHaveLength(1);
  });
});

describe('the first staff grant crosses the attribution boundary (§6.4)', () => {
  it('grant + grandfather index commit together; a later grant does not re-cross', async () => {
    // A v1 vouch ceremony's digest sits in the order-draft store — the
    // pre-staff history the crossing must keep readable.
    orderDrafts.put({
      draftId: 'od-1',
      abandoned: false,
      ceremonyCounter: 1,
      extractionDigest: 'e'.repeat(64),
      lines: [
        {
          lineId: 'l1',
          vouch: { generation: 1, ceremony: 1, receiptDigest: 'f'.repeat(64), vouchedBy: null },
        },
      ],
      requirements: [],
      conversations: [],
      createdAtMs: T0,
      updatedAtMs: T0,
    } as never);

    expect(boundary.crossedAt()).toBeNull();
    const created = await router.handle(
      owner('/v1/commerce/staff-grants', {
        device_did: STAFF_DID,
        scope: 'commerce_confirm',
        installs: 'both',
        pin: STAFF_PIN,
      }),
    );
    expect(created.status).toBe(200);
    const crossedAt = boundary.crossedAt();
    expect(crossedAt).not.toBeNull();
    expect(boundary.isGrandfathered('f'.repeat(64))).toBe(true);

    // A second grant on an already-crossed node leaves history alone.
    const again = await router.handle(
      owner('/v1/commerce/staff-grants', {
        device_did: 'did:key:zsecondclerk',
        scope: 'commerce_confirm',
        installs: 'buyer',
        pin: '9876',
      }),
    );
    expect(again.status).toBe(200);
    expect(boundary.crossedAt()).toBe(crossedAt);
    expect(staffGrants.listByDevice('did:key:zsecondclerk')).toHaveLength(1);
  });
});

describe('the §7 order inbox and the confirm/submit gates', () => {
  const HEX = 'a'.repeat(64);

  function confirmableDraft(): never {
    return {
      draftId: 'odr-staff-1',
      manifest: [{ artifact_id: 'img-1', content_hash: HEX, page_index: 0 }],
      extraction: { model: 'gpt-4o-mini', schemaVersion: 'order-lines-1' },
      extractionDigest: HEX,
      lines: [
        {
          lineId: 'line-1',
          text: '20 dining chairs - oak',
          pageIndex: 0,
          fields: { quantity: '20', product_hint: 'dining chairs oak' },
          provenance: { quantity: 'accepted', product_hint: 'accepted' },
          resolution: {
            kind: 'resolved',
            product: { scheme: 'manufacturer_sku', value: 'CM-CHAIR-1', issuer_did: SUPPLIER_DID },
            supplierDid: SUPPLIER_DID,
            flaggedNewSupplier: false,
          },
          generation: 1,
          assignmentGeneration: 0,
          vouch: null,
          deferred: false,
          evidence: null,
          submittedIn: null,
        },
      ],
      requirements: [],
      conversations: [],
      ceremonyCounter: 0,
      abandoned: false,
      createdAtMs: T0,
      updatedAtMs: T0,
    } as never;
  }

  it('the inbox filters to the grant install roles for staff and shows everything to the owner', async () => {
    orderDrafts.put(confirmableDraft());
    // A supplier-side item beside the buyer-side ones.
    const runtime = { pending: true };
    void runtime;
    const ownerView = await router.handle({
      ...owner('/v1/commerce/trade/inbox', undefined),
      query: {},
    } as unknown as CoreRequest);
    expect(ownerView.status).toBe(200);
    const ownerItems = (ownerView.body as { items: { kind: string; role: string }[] }).items;
    // pending_confirm (buyer) + unreceipted_delivery from the harness note
    // (inbound at the buyer).
    expect(ownerItems.map((i) => i.kind).sort()).toEqual([
      'pending_confirm',
      'unreceipted_delivery',
    ]);

    // A SUPPLIER-scoped grant sees neither buyer item.
    staffGrants.put({
      deviceDid: STAFF_DID,
      scope: 'commerce_receive_goods',
      maxOrderMinorUnits: '30000',
      currency: 'INR',
      installs: 'supplier',
      createdAt: T0,
      revokedAt: null,
    });
    const supplierView = await router.handle({
      ...staff('/v1/commerce/trade/inbox', undefined),
      query: {},
    } as unknown as CoreRequest);
    expect(supplierView.status).toBe(200);
    expect((supplierView.body as { items: unknown[] }).items).toHaveLength(0);

    // A buyer-scoped grant sees them.
    staffGrants.put({
      deviceDid: STAFF_DID,
      scope: 'commerce_receive_goods',
      maxOrderMinorUnits: '30000',
      currency: 'INR',
      installs: 'buyer',
      createdAt: T0,
      revokedAt: null,
    });
    const buyerView = await router.handle({
      ...staff('/v1/commerce/trade/inbox', undefined),
      query: {},
    } as unknown as CoreRequest);
    expect((buyerView.body as { items: unknown[] }).items).toHaveLength(2);
  });

  it('staff confirm: gated on commerce_confirm, and the vouch is ATTRIBUTED to the device (§6.4)', async () => {
    orderDrafts.put(confirmableDraft());
    await provePresence();

    // No grant: the gate refuses before the ceremony.
    const ungranted = await router.handle(
      staff('/v1/commerce/orders/drafts/confirm', { draft_id: 'odr-staff-1' }),
    );
    expect(ungranted.status).toBe(403);

    // Through the CEREMONY route, which crosses the attribution boundary
    // in the same transaction — the invariant that makes every staff
    // vouch v2-attributed by construction.
    const granted = await router.handle(
      owner('/v1/commerce/staff-grants', {
        device_did: STAFF_DID,
        scope: 'commerce_confirm',
        installs: 'buyer',
        pin: STAFF_PIN,
      }),
    );
    expect(granted.status).toBe(200);
    expect(boundary.crossedAt()).not.toBeNull();
    const confirmed = await router.handle(
      staff('/v1/commerce/orders/drafts/confirm', { draft_id: 'odr-staff-1' }),
    );
    expect(confirmed.status).toBe(200);
    const draft = orderDrafts.get('odr-staff-1');
    expect(draft?.lines[0]?.vouch?.vouchedBy).toBe(STAFF_DID);
  });

  it('staff submit-scope operations refuse without a commerce_submit grant — 403 BEFORE any 404', async () => {
    await provePresence();
    // The grant-existence check runs before the pending lookup, so an
    // ungranted device cannot probe which decisions exist.
    for (const [path, body] of [
      ['/v1/commerce/orders/decide', { buyer_did: BUYER_DID, purchase_order_id: 'po-x', approve: true }],
      ['/v1/commerce/orders/drafts/approve', { draft_id: 'odr-none', conversation_id: 'c-none' }],
      ['/v1/commerce/orders/drafts/submit', { draft_id: 'odr-none', conversation_id: 'c-none' }],
    ] as const) {
      const resp = await router.handle(staff(path, body as Record<string, unknown>));
      expect(resp.status).toBe(403);
      expect((resp.body as { reason: string }).reason).toContain('no live staff grant');
    }
  });
});

describe('POST /v1/commerce/orders/decide as staff (§6.5 commerce_submit, supplier side)', () => {
  function putSubmitGrant(maxMinor: string): void {
    staffGrants.put({
      deviceDid: STAFF_DID,
      scope: 'commerce_submit',
      maxOrderMinorUnits: maxMinor,
      currency: 'INR',
      installs: 'both',
      createdAt: T0,
      revokedAt: null,
    });
  }

  /** Arm a pending decision the stubbed runtime serves and clears. */
  function armPending(buyerDid: string, purchaseOrderId: string): { cleared: string[] } {
    const cleared: string[] = [];
    const runtime = getCommerceRuntime();
    if (runtime === null) throw new Error('no runtime');
    (runtime as unknown as Record<string, unknown>).pendingDecisions = {
      list: () => [{ buyerDid, purchaseOrderId, createdAt: T0 }],
      get: (b: string, p: string) =>
        b === buyerDid && p === purchaseOrderId && !cleared.includes(`${b}:${p}`)
          ? { buyerDid, purchaseOrderId, createdAt: T0 }
          : null,
      clear: (b: string, p: string) => {
        cleared.push(`${b}:${p}`);
        return true;
      },
    };
    return { cleared };
  }

  it('under the cap: the DECLINE proceeds (gated identically to accept) and clears the card', async () => {
    putSubmitGrant('50000'); // the retained ORDER totals exactly 50000
    await provePresence();
    const { cleared } = armPending(ORDER.buyer_did, ORDER.purchase_order_id);
    const resp = await router.handle(
      staff('/v1/commerce/orders/decide', {
        buyer_did: ORDER.buyer_did,
        purchase_order_id: ORDER.purchase_order_id,
        approve: false,
      }),
    );
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ ok: true, decided: false });
    expect(cleared).toEqual([`${ORDER.buyer_did}:${ORDER.purchase_order_id}`]);
  });

  it('over the cap: 202, and the owner card is keyed to (buyer, order) — buyer B cannot ride buyer A\'s approval', async () => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const workflow = new WorkflowService({ repository: workflowRepo });
    setWorkflowService(workflow);
    putSubmitGrant('20000'); // 50000 > 20000 → escalate
    await provePresence();
    armPending(ORDER.buyer_did, ORDER.purchase_order_id);

    const first = await router.handle(
      staff('/v1/commerce/orders/decide', {
        buyer_did: ORDER.buyer_did,
        purchase_order_id: ORDER.purchase_order_id,
        approve: false,
      }),
    );
    expect(first.status).toBe(202);
    const taskId = (first.body as { task_id: string }).task_id;
    workflow.approve(taskId);

    // A SECOND buyer submits an order with the SAME purchase-order id.
    // The PO id is buyer-chosen, so the approved card must not cover it:
    // its subject carries the buyer DID.
    const otherBuyer = 'did:key:zOtherBuyerSamePoId';
    armPending(otherBuyer, ORDER.purchase_order_id);
    const crossBuyer = await router.handle(
      staff('/v1/commerce/orders/decide', {
        buyer_did: otherBuyer,
        purchase_order_id: ORDER.purchase_order_id,
        approve: false,
      }),
    );
    expect(crossBuyer.status).toBe(202);
    expect((crossBuyer.body as { task_id: string }).task_id).not.toBe(taskId);

    // The APPROVED buyer's retry proceeds.
    armPending(ORDER.buyer_did, ORDER.purchase_order_id);
    const retry = await router.handle(
      staff('/v1/commerce/orders/decide', {
        buyer_did: ORDER.buyer_did,
        purchase_order_id: ORDER.purchase_order_id,
        approve: false,
      }),
    );
    expect(retry.status).toBe(200);
  });
});

describe('the §6.4 PIN registry, end to end', () => {
  it('the ceremony mints the PIN; the runtime-installed Argon2id verifier proves with it', async () => {
    // Drop the harness fake: re-installing the runtime restores the REAL
    // verifier the composition root installs — PIN records + core argon2id.
    const runtime = getCommerceRuntime();
    if (runtime === null) throw new Error('runtime missing');
    installCommerceRuntime(runtime);

    // First grant WITHOUT a pin refuses: a grant with no presence path
    // is dead authority.
    const pinless = await router.handle(
      owner('/v1/commerce/staff-grants', {
        device_did: 'did:key:zpinclerk',
        scope: 'commerce_confirm',
        installs: 'buyer',
      }),
    );
    expect(pinless.status).toBe(400);
    expect((pinless.body as { error: string }).error).toBe('pin_required');

    const granted = await router.handle(
      owner('/v1/commerce/staff-grants', {
        device_did: 'did:key:zpinclerk',
        scope: 'commerce_confirm',
        installs: 'buyer',
        pin: '271828',
      }),
    );
    expect(granted.status).toBe(200);

    const wrong = await router.handle({
      ...staff('/v1/commerce/trade/staff-presence', { pin: '999999' }),
      callerDID: 'did:key:zpinclerk',
    } as unknown as CoreRequest);
    expect(wrong.status).toBe(403);
    const right = await router.handle({
      ...staff('/v1/commerce/trade/staff-presence', { pin: '271828' }),
      callerDID: 'did:key:zpinclerk',
    } as unknown as CoreRequest);
    expect(right.status).toBe(200);

    // Revoking the device removes the record: the same PIN proves nothing.
    const revoked = await router.handle(
      owner('/v1/commerce/staff-grants/revoke', { device_did: 'did:key:zpinclerk' }),
    );
    expect(revoked.status).toBe(200);
    const after = await router.handle({
      ...staff('/v1/commerce/trade/staff-presence', { pin: '271828' }),
      callerDID: 'did:key:zpinclerk',
    } as unknown as CoreRequest);
    expect(after.status).toBe(403);
  });
});
