/**
 * The merchant integration surface (docs/JIFFY_MERCHANT_INTEGRATION_PLAN.md
 * §3.2, Piece B) — what a merchant's connector may READ from its own node,
 * and nothing it may decide.
 *
 * WHO CALLS. An integration is a paired device with role `staff` holding
 * owner-created `integration_*` grants (staff_grants.ts). It is admitted by
 * the same gate every staff-operable commerce route uses: a live grant for
 * THIS scope on the supplier install, or refusal. The owner passes as
 * themself. No third caller class exists here: `connector` is the
 * server-split staging-ingest role and is never widened onto commerce.
 *
 * WHAT IS READ. Facts Core itself retained — the published catalogue
 * pointers, the settings records (as a digest), and the supplier's DECIDED
 * order references with their retained acknowledgements. §15.5's rule
 * carries through: an order counts as accepted only when Core recorded the
 * decision and holds the acknowledgement; a runner's word alone is nothing.
 *
 * WHAT LEAVES WITH AN ACCEPTED ORDER. The order as the supplier holds it:
 * totals, accepted lines priced from the bound quote, and the delivery
 * projection — recipient, address, window — because the connector exists to
 * fulfil, and a supplier who cannot see where to deliver has nothing to
 * integrate. This is the supplier's OWN record of a trade the buyer entered
 * with them, read on the supplier's node, under a grant the owner made.
 *
 * WHAT NEVER LEAVES. Negotiation: no quote request, no revision, no
 * counterproposal's terms — a countered order surfaces only as a CLOSED
 * decision with the reason `counterproposal`, and a rejection with its
 * reason code, so the connector can close its own job record (plan §6 Q1).
 * Reserved orders, and the settings' contents — a revision digest lets a
 * caller detect change without reading terms.
 *
 * PURE. Every function here reads the runtime and returns a value; the
 * routes in server/routes/commerce.ts own the HTTP shape and the refusals.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { canonicalJson } from '@dina/protocol';

import { findPublishedItem, publishedCatalogItems } from './published_catalog';
import {
  rehydrateAcknowledgement,
  rehydratePurchaseOrder,
  rehydrateSignedQuote,
} from './rehydrate';
import {
  INTEGRATION_SCOPES,
  checkStaffOperation,
  type IntegrationScope,
  type StaffGrant,
} from './staff_grants';

import type { CatalogDraft } from './catalog_draft_store';
import type { CatalogRowSource } from './catalog_import';
import type { CommerceOrderRef } from './order_refs';
import type { CommerceRuntime } from './runtime';
import type { ReadSettings } from './settings_store';
import type {
  CatalogItem,
  DeliveryProjection,
  Money,
  ProductRef,
  Quantity,
} from '@dina/commerce-protocol';

export type { IntegrationScope } from './staff_grants';

/** Bumped when a field a connector relies on changes meaning; additive fields do not bump it. */
/**
 * The two Core-minted cards Piece C (§3.3) puts to the BUYER's owner. Named
 * here, on the money-free surface, so the workflow routes can fence them
 * (Brain may neither create nor decide one) without reaching the money line
 * that mints them (`order_attachments.ts`).
 */
export const ORDER_CHECKOUT_LINK_TYPE = 'order_checkout_link';
export const PAYMENT_EVIDENCE_RECORD_TYPE = 'payment_evidence_record';

export const INTEGRATION_API_VERSION = 1;

/** Page size bounds for the orders export. */
export const ORDERS_EXPORT_DEFAULT_LIMIT = 50;
export const ORDERS_EXPORT_MAX_LIMIT = 200;

/** A caller a commerce route resolved: the owner, or a staff device to be gated. */
export type IntegrationCaller = { kind: 'owner' } | { kind: 'staff'; deviceDid: string };

export type IntegrationAdmission = { ok: true } | { ok: false; reason: string };

/**
 * The gate. The owner is admitted as themself. A staff device is admitted
 * only on a live grant for exactly this scope on the supplier install —
 * `checkStaffOperation` with no value, because no integration scope is
 * capped; `escalate` cannot arise, and is treated as a refusal if it ever did.
 */
export function admitIntegrationCaller(
  runtime: Pick<CommerceRuntime, 'staffGrants'>,
  caller: IntegrationCaller,
  scope: IntegrationScope,
): IntegrationAdmission {
  if (caller.kind === 'owner') return { ok: true };
  const verdict = checkStaffOperation({
    repository: runtime.staffGrants,
    deviceDid: caller.deviceDid,
    scope,
    installRole: 'supplier',
  });
  return verdict.verdict === 'allow' ? { ok: true } : { ok: false, reason: verdict.reason };
}

function hexDigest(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

/**
 * A settings record as a revision: the digest of its canonical JSON, or null
 * when no record is stored or the stored one does not validate. A connector
 * compares digests to learn that terms changed; it never reads the terms.
 */
export function settingsRevision(read: ReadSettings<unknown>): string | null {
  return read.ok ? hexDigest(canonicalJson(read.settings)) : null;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface IntegrationCatalogView {
  catalogId: string;
  /** `unpublished`: bound to a source (a refresh can run) but no pointer yet. */
  state: 'published' | 'withdrawn' | 'unpublished';
  snapshotSequence: number | null;
  snapshotDigest: string | null;
  publishedAtMs: number | null;
  /** Whether a granted refresh has a source to pull (plan §3.1 A1). */
  bound: boolean;
}

export interface IntegrationStatus {
  apiVersion: number;
  businessDid: string;
  /** The staff device the status is for; null when the owner reads it. */
  deviceDid: string | null;
  /** The caller's live integration grants (a device), or every device's (the owner). */
  grants: {
    deviceDid: string;
    scope: IntegrationScope;
    installs: StaffGrant['installs'];
    createdAt: number;
  }[];
  catalogs: IntegrationCatalogView[];
  settingsRevision: { supplier: string | null; business: string | null };
}

function isIntegrationScope(scope: string): scope is IntegrationScope {
  return (INTEGRATION_SCOPES as readonly string[]).includes(scope);
}

function liveIntegrationGrants(grants: StaffGrant[]): IntegrationStatus['grants'] {
  return grants
    .filter((g) => g.revokedAt === null && isIntegrationScope(g.scope))
    .map((g) => ({
      deviceDid: g.deviceDid,
      scope: g.scope as IntegrationScope,
      installs: g.installs,
      createdAt: g.createdAt,
    }))
    .sort((a, b) => a.deviceDid.localeCompare(b.deviceDid) || a.scope.localeCompare(b.scope));
}

/**
 * Every catalogue the connector can name: the published pointers, plus the
 * bound-but-unpublished ones — a first refresh happens BEFORE a first
 * publication, and a connector that cannot learn its `catalog_id` from the
 * surface cannot ask for one.
 */
function catalogViews(
  runtime: Pick<CommerceRuntime, 'catalogPointers' | 'catalogSourceBindings'>,
): IntegrationCatalogView[] {
  const bound = new Set(runtime.catalogSourceBindings.list().map((b) => b.catalogId));
  const views: IntegrationCatalogView[] = runtime.catalogPointers.list().map((record) => ({
    catalogId: record.catalogId,
    state: record.withdrawn ? ('withdrawn' as const) : ('published' as const),
    snapshotSequence: record.pointer.snapshot_sequence,
    snapshotDigest: record.snapshotDigest,
    publishedAtMs: record.publishedAtMs,
    bound: bound.has(record.catalogId),
  }));
  const published = new Set(views.map((v) => v.catalogId));
  for (const catalogId of bound) {
    if (published.has(catalogId)) continue;
    views.push({
      catalogId,
      state: 'unpublished',
      snapshotSequence: null,
      snapshotDigest: null,
      publishedAtMs: null,
      bound: true,
    });
  }
  return views.sort((a, b) => a.catalogId.localeCompare(b.catalogId));
}

export function buildIntegrationStatus(
  runtime: Pick<
    CommerceRuntime,
    'staffGrants' | 'catalogPointers' | 'catalogSourceBindings' | 'settings' | 'nodeDid'
  >,
  caller: IntegrationCaller,
): IntegrationStatus {
  const grants =
    caller.kind === 'staff'
      ? runtime.staffGrants.listByDevice(caller.deviceDid)
      : runtime.staffGrants.listAll();
  return {
    apiVersion: INTEGRATION_API_VERSION,
    businessDid: runtime.nodeDid(),
    deviceDid: caller.kind === 'staff' ? caller.deviceDid : null,
    grants: liveIntegrationGrants(grants),
    catalogs: catalogViews(runtime),
    settingsRevision: {
      supplier: settingsRevision(runtime.settings.readSupplier()),
      business: settingsRevision(runtime.settings.readBusiness()),
    },
  };
}

// ---------------------------------------------------------------------------
// Orders export
// ---------------------------------------------------------------------------

/** Where a page stopped: the last row's `(decided_at, order_digest)`. */
export interface OrdersCursor {
  decidedAt: number;
  orderDigest: string;
}

const CURSOR_VERSION = 'v1';
const ORDER_DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * The cursor on the wire: `v1.<decided_at>.<order_digest>`. Both parts are
 * already opaque to a caller (a clock and a digest) and the format is
 * readable in a log, so no encoding layer stands between the two. Strict on
 * the way in: anything that is not exactly this shape is refused.
 */
export function encodeOrdersCursor(cursor: OrdersCursor): string {
  return `${CURSOR_VERSION}.${cursor.decidedAt}.${cursor.orderDigest}`;
}

export function parseOrdersCursor(raw: string): OrdersCursor | null {
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== CURSOR_VERSION) return null;
  const decidedAt = Number(parts[1]);
  if (!/^\d{1,16}$/.test(parts[1]) || !Number.isSafeInteger(decidedAt)) return null;
  if (!ORDER_DIGEST_RE.test(parts[2])) return null;
  return { decidedAt, orderDigest: parts[2] };
}

export interface AcceptedOrderLine {
  lineId: string;
  /** The product the order names, as signed on the order line. */
  product: ProductRef;
  /**
   * The item's name in this node's live published catalogue. Absent when no
   * published item matches (withdrawn, or renamed out of the catalogue): the
   * product ref above is the identity, the name only a label.
   */
  name?: string;
  quantity: Quantity;
  /** From the bound quote's line of the same id; absent when the quote record is not held. */
  unitPrice?: Money;
}

export interface OrderDecisionEvent {
  /** sha256(order_digest ‖ acknowledgement_digest): stable across replays and restores. */
  eventId: string;
  decidedAt: number;
  decision: 'accepted' | 'rejected';
  /** `counterproposal` when the supplier answered with a replacement quote. */
  reasonCode?: string;
  buyerDid: string;
  purchaseOrderId: string;
  orderDigest: string;
  quoteDigest: string;
  acknowledgementDigest: string;
  supplierOrderId?: string;
  externalRef?: string;
  /**
   * The accepted order as Core retained it. Null when the decision is a
   * rejection, and null when the order record is not in the receipt store —
   * the event still says a decision happened; it never invents the terms.
   */
  order: {
    totals: Money;
    lines: AcceptedOrderLine[];
    deliveryProjection: DeliveryProjection;
  } | null;
}

export interface OrdersExportPage {
  events: OrderDecisionEvent[];
  /** The cursor of the last event, or null when the page is empty. */
  nextCursor: string | null;
  /** Decided rows whose acknowledgement could not be read, counted never quoted. */
  unreadable: number;
}

function readOrderRecord(
  runtime: Pick<CommerceRuntime, 'receipts'>,
  ref: CommerceOrderRef,
  catalog: readonly CatalogItem[],
): OrderDecisionEvent['order'] {
  // Both receipts come back THROUGH the ingress validators (`rehydrate.ts`),
  // which re-derive each record's digest: a stored order whose bytes no
  // longer match reads as NO order, never as one the export half-believes.
  const orderReceipt = runtime.receipts.get(ref.orderDigest);
  if (orderReceipt === null) return null;
  const order = rehydratePurchaseOrder(orderReceipt.recordJson, sha256);
  if (!order.ok) return null;
  const quoteReceipt = runtime.receipts.get(ref.quoteDigest);
  const quote =
    quoteReceipt === null ? null : rehydrateSignedQuote(quoteReceipt.recordJson, sha256);
  const unitPrices = new Map<string, Money>();
  if (quote !== null && quote.ok) {
    for (const line of quote.value.lines) unitPrices.set(line.line_id, line.unit_price);
  }
  return {
    totals: order.value.approved_total,
    lines: order.value.accepted_lines.map((line) => {
      const unitPrice = unitPrices.get(line.line_id);
      const item = findPublishedItem(catalog, line.product);
      return {
        lineId: line.line_id,
        product: line.product,
        ...(item !== null ? { name: item.name } : {}),
        quantity: line.quantity,
        ...(unitPrice !== undefined ? { unitPrice } : {}),
      };
    }),
    deliveryProjection: order.value.delivery,
  };
}

/**
 * One page of the supplier's decisions, oldest first, strictly after the
 * cursor. Each event is derived from retained rows — the order reference,
 * its acknowledgement, the order and quote receipts — so any page can be
 * re-read and a reconnecting reader loses nothing.
 */
export function listOrderDecisionEvents(
  runtime: Pick<CommerceRuntime, 'orders' | 'receipts'> &
    Partial<Pick<CommerceRuntime, 'catalogPointers' | 'catalogDrafts'>>,
  page: { after: OrdersCursor | null; limit: number },
): OrdersExportPage {
  const refs = runtime.orders.listDecidedAfter(page.after, page.limit);
  // Read once per page: every line's name comes from the same published bytes.
  const catalog =
    runtime.catalogPointers !== undefined && runtime.catalogDrafts !== undefined
      ? publishedCatalogItems({
          catalogPointers: runtime.catalogPointers,
          catalogDrafts: runtime.catalogDrafts,
        })
      : [];
  const events: OrderDecisionEvent[] = [];
  let unreadable = 0;
  let last: CommerceOrderRef | null = null;
  for (const ref of refs) {
    last = ref;
    const read = rehydrateAcknowledgement(ref.acknowledgementJson, sha256);
    if (!read.ok || ref.decidedAt === null) {
      unreadable += 1;
      continue;
    }
    const ack = read.value;
    const accepted = ack.kind === 'accepted';
    events.push({
      eventId: hexDigest(`${ref.orderDigest}\n${ack.acknowledgement_digest}`),
      decidedAt: ref.decidedAt,
      decision: accepted ? 'accepted' : 'rejected',
      ...(ack.kind === 'rejected' && ack.reason_code !== undefined
        ? { reasonCode: ack.reason_code }
        : {}),
      ...(ack.kind === 'counterproposal' ? { reasonCode: 'counterproposal' } : {}),
      buyerDid: ref.buyerDid,
      purchaseOrderId: ref.purchaseOrderId,
      orderDigest: ref.orderDigest,
      quoteDigest: ref.quoteDigest,
      acknowledgementDigest: ack.acknowledgement_digest,
      ...(accepted ? { supplierOrderId: ack.supplier_order_id } : {}),
      ...(ref.externalRef !== null && ref.externalRef !== ''
        ? { externalRef: ref.externalRef }
        : {}),
      order: accepted ? readOrderRecord(runtime, ref, catalog) : null,
    });
  }
  return {
    events,
    nextCursor:
      last === null || last.decidedAt === null
        ? null
        : encodeOrdersCursor({ decidedAt: last.decidedAt, orderDigest: last.orderDigest }),
    unreadable,
  };
}

// ---------------------------------------------------------------------------
// Catalogue: what a refresh reads back (Piece A)
// ---------------------------------------------------------------------------

/**
 * A draft as an integration sees it: identity, state, how it came to be, how
 * many findings the import raised, and the digests an owner will approve or
 * did approve. Never the rows, never the items — a connector that wrote the
 * rows already has them, and one that did not may not read another's.
 */
export interface IntegrationDraftView {
  draftId: string;
  catalogId: string;
  state: CatalogDraft['state'];
  provenanceClass: CatalogDraft['provenanceClass'];
  findingsCount: number;
  /** The snapshot the owner is asked to approve (prepared), or approved. */
  snapshotDigest: string | null;
  snapshotSequence: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export function describeDraftForIntegration(draft: CatalogDraft): IntegrationDraftView {
  return {
    draftId: draft.draftId,
    catalogId: draft.catalogId,
    state: draft.state,
    provenanceClass: draft.provenanceClass,
    findingsCount: draft.findings.length,
    snapshotDigest: draft.approval?.digest ?? draft.held?.snapshot.snapshot_digest ?? null,
    snapshotSequence:
      draft.publication?.pointer.snapshot_sequence ?? draft.held?.pointer.snapshot_sequence ?? null,
    createdAtMs: draft.createdAtMs,
    updatedAtMs: draft.updatedAtMs,
  };
}

/**
 * The digest of what a connector source READ: its columns and every row's
 * values in column order, canonical JSON, sha256. A refresh answers with it
 * so the party that hosts the endpoint can check Dina read the bytes it
 * published; a caller that names an expected digest is refused when the pull
 * disagrees, before any draft is minted.
 */
export function catalogSourceDigest(source: CatalogRowSource): string {
  const table = [
    source.columns,
    ...source.rows.map((row) => source.columns.map((column) => row.get(column))),
  ];
  return hexDigest(canonicalJson(table));
}
