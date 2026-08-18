/**
 * Owner-only catalog-draft client (PHOTO_COMMERCE_LANES_DESIGN §4) — the
 * seller screens' dispatch, on the same REAL boundary as
 * `InProcessOwnerRunClient`: a separate client from the Brain-shared
 * `CoreClient`, stamping the boot-minted owner capability, so Brain has no
 * reference to a dispatch the owner-only draft routes would admit.
 *
 * The methods mirror the routes one-to-one and add nothing: Core builds,
 * validates, gates and signs; the screens render what Core answers.
 */

import type { CatalogDraft } from '../commerce/catalog_draft_store';
import type { OrderConversation, OrderDraft, OrderDraftLine } from '../commerce/order_draft_store';
import type { CoreRequest, CoreResponse, CoreRouter } from '../server/router';

export interface PhotoCaptureResult {
  ok: true;
  draft_id: string;
  manifest: { artifact_id: string; content_hash: string; page_index: number }[];
  authorization_id: string;
  provider: string;
}

export interface DraftAnswer {
  ok: true;
  draft: CatalogDraft;
}

export class OwnerCommerceHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The route's own error key — screens branch on it (`no_user_presence`,
     *  `identifier_claimed`, `no_egress_broker`, …). */
    readonly errorKey: string,
  ) {
    super(message);
    this.name = 'OwnerCommerceHttpError';
  }
}

function buildOwnerReq(overrides: Partial<CoreRequest>): CoreRequest {
  return {
    method: 'POST',
    path: '/',
    query: {},
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(),
    params: {},
    // The same two-part owner marker the run client documents: trustedInProcess
    // skips the network auth pipeline in-process, and the unforgeable
    // ownerCapability is what the route guard actually verifies.
    trustedInProcess: true,
    callerType: 'owner',
    ...overrides,
  };
}

function expectOk<T>(res: CoreResponse, ctx: string): T {
  if (res.status < 200 || res.status >= 300) {
    const key = (res.body as { error?: string } | undefined)?.error ?? 'error';
    throw new OwnerCommerceHttpError(
      `OwnerCommerceClient: ${ctx} failed ${String(res.status)} — ${key}`,
      res.status,
      key,
    );
  }
  return res.body as T;
}

export class InProcessOwnerCommerceClient {
  constructor(
    private readonly router: CoreRouter,
    private readonly ownerCapability: string,
  ) {}

  private stamp(overrides: Partial<CoreRequest>): CoreRequest {
    return buildOwnerReq({ ...overrides, ownerCapability: this.ownerCapability });
  }

  private async post<T>(path: string, body: Record<string, unknown>, ctx: string): Promise<T> {
    const res = await this.router.handle(this.stamp({ method: 'POST', path, body }));
    return expectOk<T>(res, ctx);
  }

  async listDrafts(catalogId: string): Promise<{ drafts: CatalogDraft[] }> {
    const res = await this.router.handle(
      this.stamp({
        method: 'GET',
        path: '/v1/commerce/catalog/drafts',
        query: { catalog_id: catalogId },
      }),
    );
    return expectOk<{ drafts: CatalogDraft[] }>(res, 'listDrafts');
  }

  /** §4.1 capture: pages in, artifacts + a single-use authorization out. */
  async photoCapture(catalogId: string, pagesBase64: readonly string[]): Promise<PhotoCaptureResult> {
    return this.post('/v1/commerce/catalog/drafts/photo_capture', {
      catalog_id: catalogId,
      pages: pagesBase64,
    }, 'photoCapture');
  }

  /** §3 + §5: extract through the gate, draft created with its §2.1 chain. */
  async photoExtract(args: {
    catalogId: string;
    draftId: string;
    authorizationId: string;
  }): Promise<DraftAnswer> {
    return this.post('/v1/commerce/catalog/drafts/photo_extract', {
      catalog_id: args.catalogId,
      draft_id: args.draftId,
      authorization_id: args.authorizationId,
    }, 'photoExtract');
  }

  /** §5 step 4 — set a cell, clear it (value null), or remove a row (column null). */
  async repair(args: {
    draftId: string;
    row: number;
    column: string | null;
    value: string | null;
  }): Promise<DraftAnswer> {
    return this.post('/v1/commerce/catalog/drafts/repair', {
      draft_id: args.draftId,
      row: args.row,
      column: args.column,
      value: args.value,
    }, 'repair');
  }

  /** Accept named `{item.field}` refs, each currently `proposed`. */
  async accept(draftId: string, fields: readonly string[]): Promise<DraftAnswer> {
    return this.post('/v1/commerce/catalog/drafts/accept', { draft_id: draftId, fields }, 'accept');
  }

  /** Inline value correction on an assembled item — one field per call. */
  async edit(args: { draftId: string; field: string; value: unknown }): Promise<DraftAnswer> {
    return this.post('/v1/commerce/catalog/drafts/edit', {
      draft_id: args.draftId,
      field: args.field,
      value: args.value,
    }, 'edit');
  }

  /** §10 item 9 — prove a person is here. Never stored, never echoed. */
  async provePresence(passphrase: string): Promise<{ ok: true }> {
    return this.post('/v1/commerce/catalog/drafts/presence', { passphrase }, 'provePresence');
  }

  async confirm(draftId: string): Promise<DraftAnswer> {
    return this.post('/v1/commerce/catalog/drafts/confirm', { draft_id: draftId }, 'confirm');
  }

  async prepare(draftId: string): Promise<DraftAnswer> {
    return this.post('/v1/commerce/catalog/drafts/prepare', { draft_id: draftId }, 'prepare');
  }

  /** The owner names the EXACT snapshot they reviewed. */
  async approve(draftId: string, approvedSnapshotDigest: string): Promise<DraftAnswer> {
    return this.post('/v1/commerce/catalog/drafts/approve', {
      draft_id: draftId,
      approved_snapshot_digest: approvedSnapshotDigest,
    }, 'approve');
  }

  async publish(draftId: string): Promise<DraftAnswer> {
    return this.post('/v1/commerce/catalog/drafts/publish', { draft_id: draftId }, 'publish');
  }

  /** §4.2/§6 — erase the draft, its photographs, and its unpublished claims. */
  async erase(draftId: string): Promise<{ erased: string }> {
    return this.post('/v1/commerce/catalog/drafts/erase', { draft_id: draftId }, 'erase');
  }

  /** §6 — a stored page's stripped bytes, for the photograph-beside-values screens. */
  async photoPage(artifactId: string): Promise<{ mime: string; bytes_base64: string }> {
    const res = await this.router.handle(
      this.stamp({
        method: 'GET',
        path: '/v1/commerce/catalog/drafts/photo_page',
        query: { artifact_id: artifactId },
      }),
    );
    return expectOk<{ mime: string; bytes_base64: string }>(res, 'photoPage');
  }

  // -------------------------------------------------------------------------
  // The BUYER lane (§5) — the order-draft screens' dispatch, same boundary.
  // -------------------------------------------------------------------------

  /** §5.0 capture, ORDER lane: pages in, artifacts + authorization out. */
  async orderPhotoCapture(pagesBase64: readonly string[]): Promise<PhotoCaptureResult> {
    return this.post('/v1/commerce/orders/drafts/photo_capture', { pages: pagesBase64 }, 'orderPhotoCapture');
  }

  /** §3 + §5.0: extract through the gate; the draft carries its §2.1 chain. */
  async orderPhotoExtract(args: { draftId: string; authorizationId: string }): Promise<OrderDraftAnswer> {
    return this.post('/v1/commerce/orders/drafts/photo_extract', {
      draft_id: args.draftId,
      authorization_id: args.authorizationId,
    }, 'orderPhotoExtract');
  }

  async orderDrafts(): Promise<{ drafts: OrderDraftSummary[] }> {
    const res = await this.router.handle(
      this.stamp({ method: 'GET', path: '/v1/commerce/orders/drafts', query: {} }),
    );
    return expectOk<{ drafts: OrderDraftSummary[] }>(res, 'orderDrafts');
  }

  async orderDraft(draftId: string): Promise<OrderDraftAnswer> {
    const res = await this.router.handle(
      this.stamp({
        method: 'GET',
        path: '/v1/commerce/orders/drafts/get',
        query: { draft_id: draftId },
      }),
    );
    return expectOk<OrderDraftAnswer>(res, 'orderDraft');
  }

  /** §5.1 matrix rows — one method per row, the route enforces the rule. */
  async orderRepairLine(args: {
    draftId: string;
    lineId: string;
    field: string;
    value: string;
  }): Promise<OrderDraftAnswer> {
    return this.post('/v1/commerce/orders/drafts/line/repair', {
      draft_id: args.draftId,
      line_id: args.lineId,
      field: args.field,
      value: args.value,
    }, 'orderRepairLine');
  }

  async orderResolveLine(args: {
    draftId: string;
    lineId: string;
    resolution: OrderDraftLine['resolution'];
    evidence?: OrderDraftLine['evidence'];
  }): Promise<OrderDraftAnswer> {
    return this.post('/v1/commerce/orders/drafts/line/resolve', {
      draft_id: args.draftId,
      line_id: args.lineId,
      resolution: args.resolution,
      ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
    }, 'orderResolveLine');
  }

  async orderDeferLine(draftId: string, lineId: string): Promise<OrderDraftAnswer> {
    return this.post('/v1/commerce/orders/drafts/line/defer', {
      draft_id: draftId,
      line_id: lineId,
    }, 'orderDeferLine');
  }

  async orderAcceptFields(
    draftId: string,
    refs: readonly { lineId: string; field: string }[],
  ): Promise<OrderDraftAnswer> {
    return this.post('/v1/commerce/orders/drafts/accept_fields', {
      draft_id: draftId,
      refs: refs.map((ref) => ({ line_id: ref.lineId, field: ref.field })),
    }, 'orderAcceptFields');
  }

  async orderRequirement(args: {
    draftId: string;
    key: string;
    action: 'edit' | 'accept' | 'omit' | 'reinstate';
    value?: string;
  }): Promise<OrderDraftAnswer> {
    return this.post('/v1/commerce/orders/drafts/requirement', {
      draft_id: args.draftId,
      key: args.key,
      action: args.action,
      ...(args.value !== undefined ? { value: args.value } : {}),
    }, 'orderRequirement');
  }

  /** §5.3 — the ceremony. Presence UNCONDITIONAL on this lane. */
  async orderConfirm(draftId: string): Promise<OrderDraftAnswer> {
    return this.post('/v1/commerce/orders/drafts/confirm', { draft_id: draftId }, 'orderConfirm');
  }

  async orderReopen(draftId: string, conversationId: string): Promise<OrderDraftAnswer> {
    return this.post('/v1/commerce/orders/drafts/reopen', {
      draft_id: draftId,
      conversation_id: conversationId,
    }, 'orderReopen');
  }

  async orderAbandon(draftId: string): Promise<OrderDraftAnswer> {
    return this.post('/v1/commerce/orders/drafts/abandon', { draft_id: draftId }, 'orderAbandon');
  }

  /** §5.4 stage 1 — Core builds and sends the request; the gate is the rule. */
  async orderRequestQuote(args: {
    draftId: string;
    supplierDid: string;
    projection: Record<string, unknown>;
  }): Promise<OrderSendAnswer> {
    return this.post('/v1/commerce/orders/drafts/request-quote', {
      draft_id: args.draftId,
      supplier_did: args.supplierDid,
      projection: args.projection,
    }, 'orderRequestQuote');
  }

  /** §5.4 stage 4 — Core builds the order; the card renders what it answers. */
  async orderApprove(args: {
    draftId: string;
    conversationId: string;
    quoteId: string;
    projection: Record<string, unknown>;
  }): Promise<OrderApproveAnswer> {
    return this.post('/v1/commerce/orders/drafts/approve', {
      draft_id: args.draftId,
      conversation_id: args.conversationId,
      quote_id: args.quoteId,
      projection: args.projection,
    }, 'orderApprove');
  }

  /**
   * §5.1's submission protocol — the named orchestrator. A `refused` or
   * `transient` class arrives on a non-2xx status but IS the answer the
   * screen renders ("couldn't send — the quote lapsed", "couldn't reach
   * the courier"), so a classified outcome never throws; only an
   * unclassified failure does.
   */
  async orderSubmit(args: {
    draftId: string;
    conversationId: string;
  }): Promise<OrderSubmitAnswer> {
    const res = await this.router.handle(
      this.stamp({
        method: 'POST',
        path: '/v1/commerce/orders/drafts/submit',
        body: { draft_id: args.draftId, conversation_id: args.conversationId },
      }),
    );
    const classified = res.body as OrderSubmitAnswer | undefined;
    if (classified !== undefined && typeof classified.dispatch_class === 'string') {
      return classified;
    }
    return expectOk<OrderSubmitAnswer>(res, 'orderSubmit');
  }

  // -------------------------------------------------------------------------
  // The trade surface (TRADE_FIRST_STRATEGY §4, §7)
  // -------------------------------------------------------------------------

  async tradeInbox(): Promise<{ items: TradeInboxItemDto[] }> {
    const res = await this.router.handle(
      this.stamp({ method: 'GET', path: '/v1/commerce/trade/inbox' }),
    );
    return expectOk<{ items: TradeInboxItemDto[] }>(res, 'tradeInbox');
  }

  async tradeStatement(
    counterpartyDid: string,
    currency: string,
    /** Required when the pair trades BOTH ways (`role_required` answers the bare call). */
    role?: 'buyer' | 'supplier',
  ): Promise<TradeStatementAnswer> {
    const res = await this.router.handle(
      this.stamp({
        method: 'GET',
        path: '/v1/commerce/trade/statement',
        query: {
          counterparty_did: counterpartyDid,
          currency,
          ...(role !== undefined ? { role } : {}),
        },
      }),
    );
    return expectOk<TradeStatementAnswer>(res, 'tradeStatement');
  }

  async issueDeliveryNote(args: {
    counterpartyDid: string;
    purchaseOrderId: string;
    supplierOrderId: string;
    lines: unknown[];
  }): Promise<TradeDocumentAnswer> {
    return this.post(
      '/v1/commerce/trade/delivery-note',
      {
        counterparty_did: args.counterpartyDid,
        purchase_order_id: args.purchaseOrderId,
        supplier_order_id: args.supplierOrderId,
        lines: args.lines,
      },
      'issueDeliveryNote',
    );
  }

  async issueDeliveryReceipt(args: {
    deliveryNoteDigest: string;
    lines: unknown[];
  }): Promise<TradeDocumentAnswer> {
    return this.post(
      '/v1/commerce/trade/delivery-receipt',
      { delivery_note_digest: args.deliveryNoteDigest, lines: args.lines },
      'issueDeliveryReceipt',
    );
  }

  async issuePaymentNote(args: {
    supplierDid: string;
    amount: { currency: string; minor_units: string };
    method: string;
  }): Promise<TradeDocumentAnswer> {
    return this.post(
      '/v1/commerce/trade/payment-note',
      { supplier_did: args.supplierDid, amount: args.amount, method: args.method },
      'issuePaymentNote',
    );
  }

  async acknowledgePayment(args: {
    paymentNoteDigest: string;
    kind: 'received' | 'disputed';
    amountReceived?: { currency: string; minor_units: string };
  }): Promise<TradeDocumentAnswer> {
    return this.post(
      '/v1/commerce/trade/payment-ack',
      {
        payment_note_digest: args.paymentNoteDigest,
        kind: args.kind,
        ...(args.amountReceived !== undefined ? { amount_received: args.amountReceived } : {}),
      },
      'acknowledgePayment',
    );
  }

  async booksExport(currency: string): Promise<{ voucher_count: number; xml: string }> {
    const res = await this.router.handle(
      this.stamp({ method: 'GET', path: '/v1/commerce/trade/books-export', query: { currency } }),
    );
    return expectOk<{ voucher_count: number; xml: string }>(res, 'booksExport');
  }

  // -------------------------------------------------------------------------
  // Invites (§8)
  // -------------------------------------------------------------------------

  async mintInvite(args: {
    direction: 'i_supply_you' | 'you_supply_me';
    serviceRkeys: readonly string[];
    /** Absent = Core's standard trade pair; surfaces never name capabilities. */
    capabilities?: readonly string[];
    /** §8 cold leg: dispatch the offer over the relay to this DID too. */
    sendToDid?: string;
  }): Promise<{ offer: Record<string, unknown>; code: string; cold_dispatched?: boolean }> {
    return this.post(
      '/v1/commerce/invites',
      {
        direction: args.direction,
        service_rkeys: args.serviceRkeys,
        ...(args.capabilities !== undefined ? { capabilities: args.capabilities } : {}),
        ...(args.sendToDid !== undefined ? { send_to_did: args.sendToDid } : {}),
      },
      'mintInvite',
    );
  }

  /** §8 cold leg, standalone: (re)send a minted open offer to a DID. */
  async sendInvite(args: { nonce: string; toDid: string }): Promise<{ ok: true; dispatched: boolean }> {
    return this.post(
      '/v1/commerce/invites/send',
      { nonce: args.nonce, to_did: args.toDid },
      'sendInvite',
    );
  }

  async redeemInvite(args: {
    code: string;
    serviceRkeys: readonly string[];
  }): Promise<{ ok: true; resent: boolean }> {
    return this.post(
      '/v1/commerce/invites/redeem',
      { code: args.code, service_rkeys: args.serviceRkeys },
      'redeemInvite',
    );
  }

  async listInvites(): Promise<{ invites: InviteListEntry[] }> {
    const res = await this.router.handle(
      this.stamp({ method: 'GET', path: '/v1/commerce/invites' }),
    );
    return expectOk<{ invites: InviteListEntry[] }>(res, 'listInvites');
  }

  async acceptHeldInvite(args: {
    nonce: string;
    serviceRkeys: readonly string[];
  }): Promise<{ ok: true }> {
    return this.post(
      '/v1/commerce/invites/accept-held',
      { nonce: args.nonce, service_rkeys: args.serviceRkeys },
      'acceptHeldInvite',
    );
  }

  // -------------------------------------------------------------------------
  // Staff grants (§6)
  // -------------------------------------------------------------------------

  async createStaffGrant(args: {
    deviceDid: string;
    scope: 'commerce_confirm' | 'commerce_submit' | 'commerce_receive_goods';
    installs: 'buyer' | 'supplier' | 'both';
    maxOrderMinorUnits?: string;
    currency?: string;
    pin?: string;
  }): Promise<{ ok: true }> {
    return this.post(
      '/v1/commerce/staff-grants',
      {
        device_did: args.deviceDid,
        scope: args.scope,
        installs: args.installs,
        ...(args.maxOrderMinorUnits !== undefined
          ? { max_order_minor_units: args.maxOrderMinorUnits }
          : {}),
        ...(args.currency !== undefined ? { currency: args.currency } : {}),
        ...(args.pin !== undefined ? { pin: args.pin } : {}),
      },
      'createStaffGrant',
    );
  }

  async listStaffGrants(deviceDid: string): Promise<{ grants: StaffGrantEntry[] }> {
    const res = await this.router.handle(
      this.stamp({
        method: 'GET',
        path: '/v1/commerce/staff-grants',
        query: { device_did: deviceDid },
      }),
    );
    return expectOk<{ grants: StaffGrantEntry[] }>(res, 'listStaffGrants');
  }

  async revokeStaffGrants(deviceDid: string): Promise<{ ok: true }> {
    return this.post('/v1/commerce/staff-grants/revoke', { device_did: deviceDid }, 'revokeStaffGrants');
  }
}

export interface OrderDraftAnswer {
  ok: true;
  draft: OrderDraft;
  state: 'open' | 'awaiting_answers' | 'closed';
}

export interface OrderDraftSummary {
  draft_id: string;
  state: 'open' | 'awaiting_answers' | 'closed';
  lines: number;
  conversations: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface OrderSendAnswer {
  ok: true;
  conversation_id: string;
  request_id: string;
  request_digest: string;
  snapshot_digest: string;
}

export interface OrderApproveAnswer {
  ok: true;
  approval_id: string;
  purchase_order_id: string;
  approved: Record<string, unknown>;
  expires_at: number;
  /** §5.5 — per line, beside the decision it informs. */
  divergence: { line_id: string; verdict: Record<string, unknown> }[];
}

export interface OrderSubmitAnswer {
  ok?: boolean;
  dispatch_class: 'confirmed' | 'uncertain' | 'transient' | 'refused';
  intent_id: string;
  [extra: string]: unknown;
}

export interface TradeInboxItemDto {
  kind: string;
  role: 'buyer' | 'supplier';
  subject: string;
  counterparty_did: string;
  created_at: number;
}

export interface TradeStatementAnswer {
  ok: true;
  statement: Record<string, unknown>;
  dues: { purchase_order_id: string; due_at: string; amount: { currency: string; minor_units: string }; overdue: boolean }[];
  /** THIS node's side of the folded ledger (§4.4 — one fold per orientation). */
  role: 'buyer' | 'supplier';
}

export interface TradeDocumentAnswer {
  ok: true;
  document: Record<string, unknown>;
  dispatched: boolean;
}

export interface InviteListEntry {
  role: 'inviter' | 'redeemer';
  state: 'offered' | 'held' | 'redeemed' | 'active' | 'revoked';
  direction: 'i_supply_you' | 'you_supply_me';
  counterparty_did: string;
  activation_proven: boolean;
  expires_at: number;
  created_at: number;
  /** Present ONLY on held cold offers — the accept key. */
  nonce?: string;
}

export interface StaffGrantEntry {
  scope: string;
  installs: string;
  max_order_minor_units: string;
  currency: string;
  created_at: number;
  revoked_at: number | null;
}

export type { OrderConversation, OrderDraft, OrderDraftLine };
