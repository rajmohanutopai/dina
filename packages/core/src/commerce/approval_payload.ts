/**
 * What a human approved, bound to what will execute (§15.2, §15.2b, FR-P5).
 *
 * THE ATTACK THIS EXISTS TO STOP. A card says "500 chairs, ₹50,000, delivered
 * to the Bangalore yard, from ChairMaker". The owner taps approve. Between the
 * tap and the send, something — a re-planned order, a mutated store row, a
 * compromised Brain, a replayed workflow task — hands the executor a different
 * order. Every downstream check still passes, because each one validates the
 * order it was given. Nothing compares it to what was on the card.
 *
 * So approval mints a PAYLOAD covering every field §15.2 names, and a digest
 * over it. Execution rebuilds the payload from the order it is about to send
 * and compares digests. A single changed byte in any bound field breaks the
 * comparison, and the executor refuses.
 *
 * WHY THE PAYLOAD AND NOT JUST `order_digest`. The order digest covers the
 * order. It does not cover WHICH INSTALL is about to send it, which capability,
 * which manifest CID, which config revision, or which principal approved under
 * what authority — and a swap of any of those is a different act by a different
 * actor with the same paperwork. §15.2 lists them for that reason, and a
 * binding that omitted them would pass a bait-and-switch that changed the
 * runner rather than the goods.
 *
 * WHY THIS IS NOT A §9.12 WIRE DIGEST. The ten frozen domains are RECORDS that
 * cross the wire between businesses. An approval payload never leaves the
 * node: it is local evidence binding what a human saw to what the machine did.
 * Widening the frozen list to hold it would put a private record in a public
 * vocabulary and break the frozen vectors. It gets its own domain instead, the
 * same way §10.2's content commitments do.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not decide whether approval was
 * REQUIRED, does not evaluate policy, and does not authorize anything. It
 * answers exactly one question — "is this the thing that was approved?" — and
 * a module that also answered "may this proceed?" would let a policy change
 * quietly relax a binding check.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { canonicalJson } from '@dina/commerce-protocol';

import type {
  ApprovalSourceBinding,
  Money,
  PurchaseOrderProposal,
  Quantity,
} from '@dina/commerce-protocol';

/**
 * Domain separation for approval bindings. Distinct from §9.12's ten wire
 * domains, so a payload digested here can never collide with a record digest.
 */
const APPROVAL_PREFIX = 'dina:commerce:approval:v1:';

/**
 * The authority domains this node records for its own two acts (§7.2, §15.2).
 *
 * NAMED CONSTANTS, not literals at the call sites, because these are the values
 * an auditor reads back and the values a staff grant would be scoped against.
 * They are CORE-SIDE: §7.2 says caller-supplied body fields establish none of
 * these identities, so the domain of an act is something this node states about
 * itself rather than something a surface passes in.
 */
export const BUYER_ORDER_AUTHORITY_DOMAIN = 'buyer.order_submission';
export const SUPPLIER_ORDER_AUTHORITY_DOMAIN = 'supplier.order_acceptance';

/** Who approved, and under what authority (§7.2, §15.2). */
export interface ApprovingPrincipal {
  /** The human. Absent when policy auto-approved — see `policyRevision`. */
  principalDid: string | null;
  /** The authority domain the approval was granted under. */
  authorityDomain: string;
  /**
   * The policy revision that auto-approved, when no principal did.
   *
   * §15.2b: auto-acceptance records the same payload against the POLICY
   * REVISION instead of a principal. Both fields are bound, so a payload
   * approved by a person cannot later be presented as policy-approved or the
   * reverse — the two are different accountability stories and must not share
   * a digest.
   */
  policyRevision: string | null;
}

/**
 * §6.4 (TRADE_FIRST_STRATEGY) — the approval's origin/version discriminator.
 * Absent = the shipped v1 payload, whose digest bytes are frozen. Present =
 * v2: `vouchedBy` (the owner DID or the staff device DID) sits INSIDE the
 * canonical payload, so it is inside the integrity digest — a stripped or
 * altered attribution changes what was approved. Staff-origin approvals
 * REQUIRE v2; past the attribution boundary, minting is v2-exclusive.
 */
export interface ApprovalAttribution {
  version: 2;
  vouchedBy: string;
}

/** The plugin instance that will act (§15.2, FR-P2). */
export interface ActingInstall {
  installId: string;
  capabilityId: string;
  manifestCid: string;
  installScopeHash: string;
  configRevision: string;
}

/** A line as the card displayed it — identity AND the label a human read. */
export interface ApprovedLine {
  lineId: string;
  /** Canonical product identity, rendered the way the index renders it. */
  productKey: string;
  /**
   * The label shown on the card.
   *
   * BOUND ON PURPOSE, even though it carries no protocol meaning. §15.2 says
   * "product references AND DISPLAYED LABELS": a swap that keeps the
   * identifier and changes the words is a swap of what the human believed
   * they were buying, and binding only the identifier would let a card lie
   * about its own contents.
   */
  displayedLabel: string;
  quantity: Quantity;
  /**
   * The per-line price the card showed, or null when the quote priced only a
   * total.
   *
   * It comes from the CONTEXT, not the order: a `PurchaseOrderLine` carries
   * identity and quantity, and the money lives in the quote. A first draft
   * bound `approved_total` on every line, which made three lines look like
   * three identical prices and would have let a genuine per-line change pass
   * unnoticed. Null is an explicit absence, distinct from a zero — and
   * distinct again from a line the card never priced at all, which the
   * builder REFUSES rather than binds.
   */
  linePrice: Money | null;
}

export interface BuyerApprovalPayload {
  kind: 'buyer_order';
  actingBusinessDid: string;
  principal: ApprovingPrincipal;
  supplierDid: string;
  serviceUri: string;
  lines: ApprovedLine[];
  charges: { code: string; amount: Money }[];
  currency: string;
  approvedTotal: Money;
  /** The §9.0 projection digest, not the address — the card showed a place. */
  deliveryProjectionDigest: string;
  quoteId: string;
  quoteDigest: string;
  quoteRevision: number;
  quoteExpiresAt: string;
  termsDigest: string;
  purchaseOrderId: string;
  orderDigest: string;
  idempotencyKey: string;
  install: ActingInstall;
  /**
   * §2.1 (photo lanes) — the source binding, INSIDE the payload so it is
   * inside the integrity digest: a stripped or altered binding changes the
   * digest the card was approved under. Absent on legacy approvals; a
   * photo-minted approval carries every field, and hydration refuses a
   * partial one rather than downgrading it to legacy.
   */
  source?: ApprovalSourceBinding;
  /** §6.4 v2 attribution — see `ApprovalAttribution`. */
  attribution?: ApprovalAttribution;
}

export interface SupplierApprovalPayload {
  kind: 'supplier_acknowledgement';
  actingBusinessDid: string;
  principal: ApprovingPrincipal;
  buyerDid: string;
  purchaseOrderId: string;
  orderDigest: string;
  /** The quote being accepted, or the replacement quote on a counter. */
  quoteDigest: string;
  acknowledgementKind: string;
  install: ActingInstall;
  /**
   * Present only on a cancellation RESOLUTION (§15.2b). A resolution rules on
   * a specific status head, and binding that head is what stops a resolution
   * approved against one chain position being applied at another.
   */
  cancellation: {
    cancellationId: string;
    cancellationDigest: string;
    resultKind: string;
    statusDigestAtResolution: string;
    resultDigest: string;
  } | null;
  /** §6.4 v2 attribution — see `ApprovalAttribution`. */
  attribution?: ApprovalAttribution;
}

export type ApprovalPayload = BuyerApprovalPayload | SupplierApprovalPayload;

/**
 * The protocol's own canonicalizer, imported rather than rewritten.
 *
 * An approval digest is something an operator may recompute by hand while
 * investigating a refusal, and they should get the protocol's answer. Two
 * canonicalizers in one process is one more than can be kept in step — and
 * the first draft of this file had exactly that, a private copy whose comment
 * claimed it was the imported one.
 */
function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * The digest a card is approved under.
 *
 * The approval PREFIX separates these from every §9.12 wire digest. It does
 * NOT additionally repeat the payload kind: `kind` is a required literal field
 * on both payload types, so it is already inside the canonical bytes, and a
 * prefix component duplicating a payload field is a second spelling of one
 * rule. A mutation proved the point — deleting the kind from the prefix broke
 * nothing, because nothing depended on it.
 */
export function approvalDigest(payload: ApprovalPayload): string {
  return hex(sha256(new TextEncoder().encode(`${APPROVAL_PREFIX}\n${canonicalJson(payload)}`)));
}

/** Everything §15.2 binds that the ORDER itself does not carry. */
export interface BuyerApprovalContext {
  actingBusinessDid: string;
  principal: ApprovingPrincipal;
  serviceUri: string;
  /** Label per line id, as the card rendered it. */
  displayedLabels: Record<string, string>;
  /** Canonical product key per line id, as the index renders identity. */
  productKeys: Record<string, string>;
  /**
   * Per-line price the card displayed, keyed by line id.
   *
   * Every line must appear. `null` means the card deliberately showed no
   * per-line price (some quotes price only a total); ABSENT means the card
   * never said, which is a different thing and is refused. Collapsing the two
   * is how a §15.2 field stops being bound without anyone noticing.
   */
  linePrices: Record<string, Money | null>;
  charges: { code: string; amount: Money }[];
  quoteRevision: number;
  quoteExpiresAt: string;
  install: ActingInstall;
  /** §2.1 photo lanes — carried into the payload when present. */
  source?: ApprovalSourceBinding;
  /** §6.4 — carried into the payload (and so the digest) when present. */
  attribution?: ApprovalAttribution;
}

/**
 * A built payload, or the §15.2 fields the card failed to supply.
 *
 * A UNION rather than a payload with placeholders. The first version filled
 * missing labels and product keys with the empty string, and a test caught
 * what that costs: when the card supplies neither side of a comparison, the
 * field is bound to a CONSTANT and carries no information — the payload looks
 * §15.2-compliant and binds nothing. Refusing to build is the only version of
 * this that cannot quietly under-bind.
 */
export type BuiltBuyerApproval =
  | { ok: true; payload: BuyerApprovalPayload }
  | { ok: false; missing: string[] };

/**
 * Build the payload a buyer card is approved under.
 *
 * ORDER-DERIVED FIELDS COME FROM THE ORDER, never from the caller. A builder
 * that accepted the total as an argument would let the card and the order
 * disagree from the start, and the binding would then faithfully protect the
 * wrong number.
 */
export function buildBuyerApprovalPayload(
  order: PurchaseOrderProposal,
  context: BuyerApprovalContext,
): BuiltBuyerApproval {
  const missing: string[] = [];
  for (const line of order.accepted_lines) {
    const id = line.line_id;
    if (context.displayedLabels[id] === undefined) missing.push(`displayedLabels[${id}]`);
    if (context.productKeys[id] === undefined) missing.push(`productKeys[${id}]`);
    if (!(id in context.linePrices)) missing.push(`linePrices[${id}]`);
  }
  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    payload: {
      kind: 'buyer_order',
      actingBusinessDid: context.actingBusinessDid,
      principal: context.principal,
      supplierDid: order.supplier_did,
      serviceUri: context.serviceUri,
      lines: order.accepted_lines.map((line) => ({
        lineId: line.line_id,
        productKey: context.productKeys[line.line_id] ?? '',
        displayedLabel: context.displayedLabels[line.line_id] ?? '',
        quantity: line.quantity,
        linePrice: context.linePrices[line.line_id] ?? null,
      })),
      charges: context.charges,
      currency: order.approved_total.currency,
      approvedTotal: order.approved_total,
      deliveryProjectionDigest: order.delivery.projection_digest,
      quoteId: order.quote_id,
      quoteDigest: order.quote_digest,
      quoteRevision: context.quoteRevision,
      quoteExpiresAt: context.quoteExpiresAt,
      termsDigest: order.accepted_terms_digest,
      purchaseOrderId: order.purchase_order_id,
      orderDigest: order.order_digest,
      idempotencyKey: order.idempotency_key,
      install: context.install,
      ...(context.source === undefined ? {} : { source: context.source }),
      ...(context.attribution === undefined ? {} : { attribution: context.attribution }),
    },
  };
}

/**
 * The verdict when an executor checks what it is about to do against what was
 * approved.
 */
export type BindingVerdict =
  | { ok: true }
  | {
      ok: false;
      /**
       * The first bound field that differs, named.
       *
       * Named on purpose, and safe to name: both sides of this comparison are
       * the OWNER's own data, so there is nothing to disclose, and an operator
       * told only "binding failed" cannot tell a genuine attack from a bug in
       * the card renderer.
       */
      field: string;
      reason: string;
    };

/** Every bound leaf, flattened, so a mismatch can be named rather than guessed. */
function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value === null || typeof value !== 'object') {
    out.set(prefix, canonicalJson(value));
    return;
  }
  if (Array.isArray(value)) {
    out.set(`${prefix}.length`, String(value.length));
    value.forEach((v, i) => flatten(v, `${prefix}[${String(i)}]`, out));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    flatten(v, prefix === '' ? k : `${prefix}.${k}`, out);
  }
}

/**
 * Compare what is about to execute against what was approved.
 *
 * THE DIGEST IS THE VERDICT; the field walk only explains it. Deciding on the
 * walk instead would mean the answer depended on the walker's coverage, and a
 * field the walker forgot would silently stop being bound. Here a digest
 * mismatch is always a refusal, even in the impossible case where the walk
 * finds nothing to blame.
 */
export function verifyApprovalBinding(
  approved: ApprovalPayload,
  executing: ApprovalPayload,
): BindingVerdict {
  if (approvalDigest(approved) === approvalDigest(executing)) return { ok: true };

  if (approved.kind !== executing.kind) {
    return {
      ok: false,
      field: 'kind',
      reason: `approved a ${approved.kind} and is executing a ${executing.kind}`,
    };
  }

  const before = new Map<string, string>();
  const after = new Map<string, string>();
  flatten(approved, '', before);
  flatten(executing, '', after);

  for (const [field, value] of before) {
    const now = after.get(field);
    if (now === undefined)
      return { ok: false, field, reason: 'field is missing from the payload about to execute' };
    if (now !== value) {
      return { ok: false, field, reason: `approved ${value}, about to execute ${now}` };
    }
  }
  for (const field of after.keys()) {
    if (!before.has(field)) {
      return { ok: false, field, reason: 'field appeared after approval' };
    }
  }

  // UNREACHABLE BY CONSTRUCTION, and kept deliberately. The walk stores
  // `canonicalJson` of every leaf, the same bytes the digest is taken over, so
  // any digest difference has a leaf to blame — a mutation that made this
  // branch return `ok: true` survived every test, which is the honest evidence
  // that nothing reaches it. It stays because the function must return
  // something here, and the only safe something is a refusal: a fall-through
  // that answered `ok` would turn a digest mismatch into an approval.
  return {
    ok: false,
    field: '(digest)',
    reason: 'approval digest does not match, though no bound field could be named',
  };
}

/** Everything §15.2b binds that the acknowledgement itself does not carry. */
export interface SupplierApprovalContext {
  actingBusinessDid: string;
  principal: ApprovingPrincipal;
  buyerDid: string;
  purchaseOrderId: string;
  orderDigest: string;
  quoteDigest: string;
  acknowledgementKind: string;
  install: ActingInstall;
  cancellation?: SupplierApprovalPayload['cancellation'];
  /** §6.4 — carried into the payload (and so the digest) when present. */
  attribution?: ApprovalAttribution;
}

export function buildSupplierApprovalPayload(
  context: SupplierApprovalContext,
): SupplierApprovalPayload {
  return {
    kind: 'supplier_acknowledgement',
    actingBusinessDid: context.actingBusinessDid,
    principal: context.principal,
    buyerDid: context.buyerDid,
    purchaseOrderId: context.purchaseOrderId,
    orderDigest: context.orderDigest,
    quoteDigest: context.quoteDigest,
    acknowledgementKind: context.acknowledgementKind,
    install: context.install,
    cancellation: context.cancellation ?? null,
    ...(context.attribution === undefined ? {} : { attribution: context.attribution }),
  };
}
