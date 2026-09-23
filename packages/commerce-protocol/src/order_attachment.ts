/**
 * OrderAttachment (JIFFY_MERCHANT_INTEGRATION_PLAN §3.3, Piece C) — evidence
 * a supplier's INTEGRATION attaches to an accepted order and pushes to the
 * buyer: a hosted checkout link, a payment processor's state, a production
 * or carrier state. It is attributed to the connector that authored it and
 * is never a buyer's or a supplier's act: it advances no `OrderState`, folds
 * into no khata balance, and records no payment. A buyer who wants the
 * khata to say "paid" authors a `PaymentNote` under their own key, and the
 * evidence is what they looked at first.
 *
 * Construction discipline, identical to the khata documents beside it:
 *
 * - Digest-sealed under the trade family, `dina:commerce:trade:v1:
 *   order_attachment`, its own field excluded from its own preimage. No
 *   signature field: authenticity is the retained signed D2D envelope.
 * - The validator refuses rather than defaults, and tolerates unknown fields
 *   (§9.13). Binding to the order — identities, id, digest, conversation
 *   version, and for a checkout the accepted total — is a pairwise verifier
 *   both nodes run against the order THEY retained.
 * - `source` is present on every attachment and names an integration. A
 *   receiver has no way to check the named device signed anything — the
 *   envelope is the supplier node's — so the field is ATTRIBUTION the
 *   supplier node asserts, shown as such, and a document that claims any
 *   other author is refused on shape.
 */

import {
  isRecord,
  isoUtcMillis,
  validateDid,
  validateHex64,
  validateId,
  validateIsoUtc,
  validateProtocolVersionShape,
  verifyConversationVersion,
} from './common';
import { moneyMinorUnits, validateMoney, type Money } from './money';
import { verifyTradeRecordDigest } from './trade_digest';
import { MAX_EXTERNAL_REF_LENGTH, PAYMENT_METHODS, type PaymentMethod } from './trade_documents';

import type { Sha256Fn } from './digests';
import type { PurchaseOrderProposal } from './order';

// ---------------------------------------------------------------------------
// Vocabularies and bounds
// ---------------------------------------------------------------------------

export const ORDER_ATTACHMENT_KINDS = [
  'checkout_handoff',
  'payment_evidence',
  'fulfilment_evidence',
] as const;
export type OrderAttachmentKind = (typeof ORDER_ATTACHMENT_KINDS)[number];

export const PAYMENT_EVIDENCE_STATES = ['authorized', 'captured', 'refunded', 'failed'] as const;
export type PaymentEvidenceState = (typeof PAYMENT_EVIDENCE_STATES)[number];

export const FULFILMENT_EVIDENCE_STATES = [
  'production_started',
  'ready',
  'handed_to_carrier',
] as const;
export type FulfilmentEvidenceState = (typeof FULFILMENT_EVIDENCE_STATES)[number];

/** A checkout URL: HTTPS, a dotted host, no credentials, no whitespace. */
export const MAX_ATTACHMENT_URL_LENGTH = 2048;
const HTTPS_URL =
  // eslint-disable-next-line no-control-regex -- control and bidi characters are the refusal
  /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?::([1-9]\d{0,4}))?(?:[/?#][^\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]*)?$/;

/** The processor a connector fronts, as a lowercase token — attribution, never authority. */
const PROVIDER_TOKEN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A processor's monotonic revision counter for one `provider_ref`: decimal, no leading zero. */
export const MAX_EVIDENCE_VERSION_DIGITS = 9;
const VERSION_COUNTER = /^[1-9][0-9]{0,8}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrderAttachmentSource {
  kind: 'integration';
  /** The paired integration device that authored the attachment. */
  device_did: string;
  provider: string;
}

export interface CheckoutHandoffPayload {
  session_ref: string;
  url: string;
  /** MUST equal the accepted order's total — a checkout never changes price. */
  amount: Money;
}

export interface PaymentEvidencePayload {
  provider_ref: string;
  amount: Money;
  state: PaymentEvidenceState;
  version: string;
  /** How the buyer paid, when the processor knows — informs a later PaymentNote. */
  method?: PaymentMethod;
}

export interface FulfilmentEvidencePayload {
  provider_ref: string;
  state: FulfilmentEvidenceState;
  version: string;
}

interface OrderAttachmentBase {
  protocol_version: string;
  attachment_id: string;
  purchase_order_id: string;
  buyer_did: string;
  supplier_did: string;
  /** Binds to the accepted order this node retained. */
  order_digest: string;
  source: OrderAttachmentSource;
  issued_at: string;
  expires_at?: string;
  attachment_digest: string;
}

export type OrderAttachment = OrderAttachmentBase &
  (
    | { kind: 'checkout_handoff'; payload: CheckoutHandoffPayload }
    | { kind: 'payment_evidence'; payload: PaymentEvidencePayload }
    | { kind: 'fulfilment_evidence'; payload: FulfilmentEvidencePayload }
  );

export type ReadOrderAttachment =
  | { ok: true; attachment: OrderAttachment }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateBoundedText(value: unknown, field: string, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    return `${field}: must be a non-empty string of at most ${max} characters`;
  }
  // eslint-disable-next-line no-control-regex -- control characters are the refusal
  if (/[\u0000-\u001f\u007f]/.test(value)) return `${field}: must not contain control characters`;
  return null;
}

function validateVersionCounter(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || !VERSION_COUNTER.test(value)) {
    return `${field}: must be a decimal counter of at most ${MAX_EVIDENCE_VERSION_DIGITS} digits with no leading zero`;
  }
  return null;
}

function validateSource(value: unknown): string | null {
  if (!isRecord(value)) return 'attachment.source: must be an object';
  if (value.kind !== 'integration') return 'attachment.source.kind: must be integration';
  const err = validateDid(value.device_did, 'attachment.source.device_did');
  if (err) return err;
  if (typeof value.provider !== 'string' || !PROVIDER_TOKEN.test(value.provider)) {
    return 'attachment.source.provider: must be a lowercase token of at most 64 characters';
  }
  return null;
}

function validatePayload(kind: OrderAttachmentKind, payload: unknown): string | null {
  if (!isRecord(payload)) return 'attachment.payload: must be an object';
  switch (kind) {
    case 'checkout_handoff': {
      const err =
        validateBoundedText(
          payload.session_ref,
          'attachment.payload.session_ref',
          MAX_EXTERNAL_REF_LENGTH,
        ) ?? validateMoney(payload.amount);
      if (err) return err;
      const urlMatch =
        typeof payload.url === 'string' && payload.url.length <= MAX_ATTACHMENT_URL_LENGTH
          ? HTTPS_URL.exec(payload.url)
          : null;
      if (urlMatch === null || (urlMatch[1] !== undefined && Number(urlMatch[1]) > 65535)) {
        return 'attachment.payload.url: must be an https URL with a host, a real port and no credentials or control characters';
      }
      if (moneyMinorUnits(payload.amount as Money) === 0n) {
        return 'attachment.payload.amount: must be positive';
      }
      return null;
    }
    case 'payment_evidence': {
      const err =
        validateBoundedText(
          payload.provider_ref,
          'attachment.payload.provider_ref',
          MAX_EXTERNAL_REF_LENGTH,
        ) ??
        validateMoney(payload.amount) ??
        validateVersionCounter(payload.version, 'attachment.payload.version');
      if (err) return err;
      if (!(PAYMENT_EVIDENCE_STATES as readonly string[]).includes(payload.state as string)) {
        return `attachment.payload.state: must be one of ${PAYMENT_EVIDENCE_STATES.join(' | ')}`;
      }
      // A zero payment is not a payment (the PaymentNote a yes would author refuses it too).
      if (moneyMinorUnits(payload.amount as Money) === 0n) {
        return 'attachment.payload.amount: must be positive';
      }
      if (
        payload.method !== undefined &&
        !(PAYMENT_METHODS as readonly string[]).includes(payload.method as string)
      ) {
        return `attachment.payload.method: when present, must be one of ${PAYMENT_METHODS.join(' | ')}`;
      }
      return null;
    }
    case 'fulfilment_evidence': {
      const err =
        validateBoundedText(
          payload.provider_ref,
          'attachment.payload.provider_ref',
          MAX_EXTERNAL_REF_LENGTH,
        ) ?? validateVersionCounter(payload.version, 'attachment.payload.version');
      if (err) return err;
      if (!(FULFILMENT_EVIDENCE_STATES as readonly string[]).includes(payload.state as string)) {
        return `attachment.payload.state: must be one of ${FULFILMENT_EVIDENCE_STATES.join(' | ')}`;
      }
      return null;
    }
  }
}

export function validateOrderAttachment(value: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(value)) return 'attachment: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(value.protocol_version, 'attachment.protocol_version'),
    validateId(value.attachment_id, 'attachment.attachment_id'),
    validateId(value.purchase_order_id, 'attachment.purchase_order_id'),
    validateDid(value.buyer_did, 'attachment.buyer_did'),
    validateDid(value.supplier_did, 'attachment.supplier_did'),
    validateHex64(value.order_digest, 'attachment.order_digest'),
    validateSource(value.source),
    validateIsoUtc(value.issued_at, 'attachment.issued_at'),
  ];
  for (const err of checks) if (err) return err;
  if (value.expires_at !== undefined) {
    const err = validateIsoUtc(value.expires_at, 'attachment.expires_at');
    if (err) return err;
    if (isoUtcMillis(value.expires_at as string) <= isoUtcMillis(value.issued_at as string)) {
      return 'attachment.expires_at: must be after issued_at';
    }
  }
  if (!(ORDER_ATTACHMENT_KINDS as readonly string[]).includes(value.kind as string)) {
    return `attachment.kind: must be one of ${ORDER_ATTACHMENT_KINDS.join(' | ')}`;
  }
  const payloadError = validatePayload(value.kind as OrderAttachmentKind, value.payload);
  if (payloadError) return payloadError;
  return verifyTradeRecordDigest('order_attachment', value, sha256);
}

export function readOrderAttachment(value: unknown, sha256: Sha256Fn): ReadOrderAttachment {
  const error = validateOrderAttachment(value, sha256);
  return error === null ? { ok: true, attachment: value as OrderAttachment } : { ok: false, error };
}

// ---------------------------------------------------------------------------
// Pairwise: the attachment against the order THIS node retained
// ---------------------------------------------------------------------------

/** The order fields an attachment is bound AGAINST — what both nodes hold. */
export type OrderAttachmentBinding = Pick<
  PurchaseOrderProposal,
  | 'purchase_order_id'
  | 'order_digest'
  | 'buyer_did'
  | 'supplier_did'
  | 'protocol_version'
  | 'approved_total'
>;

/**
 * Binds an attachment to the retained order: same conversation (id, digest,
 * parties, §9.13 version), and a checkout that names the ACCEPTED total to
 * the paisa — a payment link can never change price or currency.
 */
export function verifyOrderAttachmentAgainstOrder(
  attachment: OrderAttachment,
  order: OrderAttachmentBinding,
): string | null {
  if (attachment.purchase_order_id !== order.purchase_order_id) {
    return 'attachment: purchase_order_id does not match the retained order';
  }
  if (attachment.order_digest !== order.order_digest) {
    return 'attachment: order_digest does not match the retained order';
  }
  if (attachment.buyer_did !== order.buyer_did || attachment.supplier_did !== order.supplier_did) {
    return 'attachment: parties do not match the retained order';
  }
  const version = verifyConversationVersion(
    order.protocol_version,
    attachment.protocol_version,
    'attachment',
  );
  if (version) return version;
  if (attachment.kind === 'checkout_handoff') {
    const { amount } = attachment.payload;
    if (
      amount.currency !== order.approved_total.currency ||
      moneyMinorUnits(amount) !== moneyMinorUnits(order.approved_total)
    ) {
      return 'attachment: a checkout amount must equal the accepted order total';
    }
  }
  return null;
}
