/**
 * Term negotiation (docs/SHELF_SPACE_NEGOTIATION.md §5) — a general way
 * to offer, counter and agree on NAMED TERMS for a resource, with no
 * knowledge of what the resource is. A shelf slot, a co-working desk and
 * a cold-storage bay all use the same documents; a plugin supplies the
 * descriptive `attributes` and the tag vocabulary, Core reads only the
 * `general` block and the terms.
 *
 * Authenticity follows the shipped seam (`reconcile.ts`, revenue_share.ts):
 * records carry content digests and NO signature fields — each document's
 * authenticity is the retained signed D2D envelope it arrived in.
 *
 * Every document is digest-sealed under its own domain in the
 * `dina:commerce:term:v1:` family. A node that does not know these kinds
 * has no lane for them and refuses the push, so nothing is read
 * half-understood (§5.3 "Compatibility"). The decision, termination,
 * settlement and acknowledgement that follow an agreement are the
 * revenue-share documents (revenue_share.ts), pinned to the term proposal
 * by digest; the term-specific rules for them live here
 * (`verifyTermSettlement`, `computeTermAgreementFold`).
 */

import { roundRationalHalfEven } from './arithmetic';
import { bytesToHex, canonicalJson, utf8Bytes } from './canonical';
import {
  isRecord,
  validateDid,
  validateHex64,
  validateId,
  validateIsoUtc,
  validateProtocolVersionShape,
} from './common';
import {
  isCurrencyCode,
  MAX_MONEY_MINOR_UNIT_DIGITS,
  minorUnitsToString,
  moneyMinorUnits,
  validateMoney,
  type Money,
} from './money';
import { validateCanonicalInteger } from './numeric';
import { validateRegionRef, type RegionRef } from './region';
import {
  CASH_HANDLERS,
  computedShareMinor,
  type CashHandler,
  type SettlementNote,
} from './revenue_share';

import type { Sha256Fn } from './digests';

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

export const TERM_DIGEST_PREFIX = 'dina:commerce:term:v1:';

export const TERM_DIGEST_DOMAINS = [
  'term_listing',
  'term_request',
  'term_offer',
  'term_counter',
  'term_receipt',
  'term_agreement_proposal',
] as const;
export type TermDigestDomain = (typeof TERM_DIGEST_DOMAINS)[number];

/** The digest field each term domain excludes from its own input. */
export const TERM_DIGEST_FIELD: Readonly<Record<TermDigestDomain, string>> = {
  term_listing: 'listing_digest',
  term_request: 'request_digest',
  term_offer: 'offer_digest',
  term_counter: 'counter_digest',
  term_receipt: 'receipt_digest',
  term_agreement_proposal: 'proposal_digest',
};

/** Digest a DRAFT (a record without its own digest field). */
export function termRecordDigest(
  domain: TermDigestDomain,
  draft: unknown,
  sha256: Sha256Fn,
): string {
  return bytesToHex(sha256(utf8Bytes(`${TERM_DIGEST_PREFIX}${domain}\n${canonicalJson(draft)}`)));
}

/** Seal a draft: returns the record with its digest field set. */
export function sealTermRecord<T extends Record<string, unknown>>(
  domain: TermDigestDomain,
  draft: T,
  sha256: Sha256Fn,
): T & Record<string, string> {
  return { ...draft, [TERM_DIGEST_FIELD[domain]]: termRecordDigest(domain, draft, sha256) };
}

function digestMismatch(
  domain: TermDigestDomain,
  record: Record<string, unknown>,
  sha256: Sha256Fn,
): string | null {
  const field = TERM_DIGEST_FIELD[domain];
  const draft: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== field) draft[key] = value;
  }
  return termRecordDigest(domain, draft, sha256) === record[field]
    ? null
    : `${field}: does not match the record it sits on`;
}

// ---------------------------------------------------------------------------
// The term table (§5.1) — Core-owned; the other party cannot redefine one
// ---------------------------------------------------------------------------

export type TermKind = 'money' | 'bps';

export interface TermSpec {
  kind: TermKind;
  /** Which way is a concession by the seller. */
  buyerFavours: 'lower' | 'higher';
}

export const TERM_TABLE = {
  /** Rent per period, minor units in the document's currency. */
  fee: { kind: 'money', buyerFavours: 'lower' },
  /** Share of gross sales, basis points 0–10,000. */
  share_bps: { kind: 'bps', buyerFavours: 'lower' },
} as const satisfies Readonly<Record<string, TermSpec>>;

export type TermName = keyof typeof TERM_TABLE;
export const TERM_NAMES: readonly TermName[] = Object.keys(TERM_TABLE).sort() as TermName[];

export function isTermName(value: unknown): value is TermName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TERM_TABLE, value);
}

/** A term's value is a canonical non-negative integer string. */
export interface Term {
  name: TermName;
  value: string;
}

export const MAX_BPS = 10_000;

function validateTermValue(name: TermName, value: unknown, field: string): string | null {
  if (typeof value !== 'string') return `${field}: must be a canonical integer string`;
  const spec = TERM_TABLE[name];
  if (spec.kind === 'money') {
    const err = validateCanonicalInteger(value, MAX_MONEY_MINOR_UNIT_DIGITS);
    return err === null ? null : `${field}: ${err}`;
  }
  const err = validateCanonicalInteger(value, 5);
  if (err !== null) return `${field}: ${err}`;
  return BigInt(value) <= BigInt(MAX_BPS)
    ? null
    : `${field}: basis points exceed ${String(MAX_BPS)}`;
}

/**
 * Terms are a list sorted by name with every table term exactly once —
 * one spelling per set of terms, so two implementations digest the same
 * bytes. A rent-only deal states `share_bps: "0"`, never omits it.
 */
export function validateTerms(terms: unknown, field: string): string | null {
  if (!Array.isArray(terms)) return `${field}: must be an array`;
  if (terms.length !== TERM_NAMES.length) {
    return `${field}: must state every term exactly once (${TERM_NAMES.join(', ')})`;
  }
  for (const [i, term] of terms.entries()) {
    if (!isRecord(term)) return `${field}[${String(i)}]: must be an object`;
    const keys = Object.keys(term);
    if (keys.length !== 2 || !keys.includes('name') || !keys.includes('value')) {
      return `${field}[${String(i)}]: carries exactly name and value`;
    }
    if (term.name !== TERM_NAMES[i]) {
      return `${field}[${String(i)}].name: terms are sorted by name and each table term appears once`;
    }
    const bad = validateTermValue(
      term.name as TermName,
      term.value,
      `${field}[${String(i)}].value`,
    );
    if (bad !== null) return bad;
  }
  return null;
}

/** Read validated terms into a name → bigint map. */
export function termValues(terms: readonly Term[]): Record<TermName, bigint> {
  const out = {} as Record<TermName, bigint>;
  for (const term of terms) out[term.name] = BigInt(term.value);
  return out;
}

/** Build the canonical terms list from a value map. */
export function termsFromValues(values: Record<TermName, bigint>): Term[] {
  return TERM_NAMES.map((name) => ({ name, value: values[name].toString(10) }));
}

/** Does `candidate` meet `target` from the buyer's side, term by term? */
export function termMeetsBuyerTarget(name: TermName, candidate: bigint, target: bigint): boolean {
  return TERM_TABLE[name].buyerFavours === 'lower' ? candidate <= target : candidate >= target;
}

/** A counter's targets: a subset of the table, each value bounded. */
export function validateTermTargets(targets: unknown, field: string): string | null {
  if (!isRecord(targets)) return `${field}: must be an object`;
  const names = Object.keys(targets);
  if (names.length === 0) return `${field}: names at least one term`;
  for (const name of names) {
    if (!isTermName(name)) return `${field}.${name}: is not a term in the table`;
    const bad = validateTermValue(name, targets[name], `${field}.${name}`);
    if (bad !== null) return bad;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The general block (§5.2) — Core-owned conditions, fixed within a chain
// ---------------------------------------------------------------------------

export const TERM_PERIODS = ['monthly', 'weekly'] as const;
export type TermPeriod = (typeof TERM_PERIODS)[number];

export const MAX_EXIT_NOTICE_DAYS = 365;
export const MAX_STOCK_DUTY = 10_000;
/** No term agreement spans more than ten years. */
export const MAX_TERM_SPAN_MONTHS = 120;

export interface TermTrial {
  end: string;
  fee: Money;
}

export interface TermStockDuties {
  min_skus?: number;
  restock_days?: number;
}

export interface TermGeneral {
  tag: string;
  currency: string;
  period: TermPeriod;
  cash_handler: CashHandler;
  start: string;
  /** Carried, never computed by a receiver (§5.2). */
  end: string;
  trial?: TermTrial;
  exit_notice_days: number;
  stock_duties?: TermStockDuties;
}

const GENERAL_KEYS: ReadonlySet<string> = new Set([
  'tag',
  'currency',
  'period',
  'cash_handler',
  'start',
  'end',
  'trial',
  'exit_notice_days',
  'stock_duties',
]);

function boundedInt(value: unknown, field: string, min: number, max: number): string | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? null
    : `${field}: must be an integer in [${String(min)}, ${String(max)}]`;
}

export function validateTermGeneral(value: unknown, field: string): string | null {
  if (!isRecord(value)) return `${field}: must be an object`;
  for (const key of Object.keys(value)) {
    if (!GENERAL_KEYS.has(key)) return `${field}.${key}: is not a general-block field`;
  }
  const g = value as Partial<TermGeneral> & Record<string, unknown>;
  const shape =
    validateId(g.tag, `${field}.tag`) ??
    (isCurrencyCode(g.currency)
      ? null
      : `${field}.currency: must be a three-letter uppercase code`) ??
    ((TERM_PERIODS as readonly string[]).includes(g.period as string)
      ? null
      : `${field}.period: must be monthly or weekly`) ??
    ((CASH_HANDLERS as readonly string[]).includes(g.cash_handler as string)
      ? null
      : `${field}.cash_handler: must be host or vendor`) ??
    validateIsoUtc(g.start, `${field}.start`) ??
    validateIsoUtc(g.end, `${field}.end`) ??
    boundedInt(g.exit_notice_days, `${field}.exit_notice_days`, 0, MAX_EXIT_NOTICE_DAYS);
  if (shape !== null) return shape;
  const start = Date.parse(g.start as string);
  const end = Date.parse(g.end as string);
  if (end <= start) return `${field}.end: must follow start`;
  if (end > Date.parse(addCalendarMonthsUtc(g.start as string, MAX_TERM_SPAN_MONTHS))) {
    return `${field}.end: a term spans at most ${String(MAX_TERM_SPAN_MONTHS)} months`;
  }
  if (g.trial !== undefined) {
    if (!isRecord(g.trial)) return `${field}.trial: must be an object`;
    const trialKeys = Object.keys(g.trial);
    if (trialKeys.some((k) => k !== 'end' && k !== 'fee')) {
      return `${field}.trial: carries only end and fee`;
    }
    const trialError =
      validateIsoUtc(g.trial.end, `${field}.trial.end`) ??
      validateMoney(g.trial.fee) ??
      ((g.trial.fee as Money).currency === g.currency
        ? null
        : `${field}.trial.fee: must be in the general currency`);
    if (trialError !== null) return trialError;
    const trialEnd = Date.parse(g.trial.end as string);
    if (trialEnd <= start || trialEnd > end) {
      return `${field}.trial.end: must fall after start and no later than end`;
    }
  }
  if (g.stock_duties !== undefined) {
    if (!isRecord(g.stock_duties)) return `${field}.stock_duties: must be an object`;
    for (const key of Object.keys(g.stock_duties)) {
      if (key !== 'min_skus' && key !== 'restock_days') {
        return `${field}.stock_duties.${key}: is not a stock duty`;
      }
    }
    const duties = g.stock_duties as TermStockDuties;
    const dutyError =
      (duties.min_skus === undefined
        ? null
        : boundedInt(duties.min_skus, `${field}.stock_duties.min_skus`, 1, MAX_STOCK_DUTY)) ??
      (duties.restock_days === undefined
        ? null
        : boundedInt(duties.restock_days, `${field}.stock_duties.restock_days`, 1, MAX_STOCK_DUTY));
    if (dutyError !== null) return dutyError;
  }
  return null;
}

/**
 * The buyer's ask about conditions (§7.1 step 1). The seller's offer
 * must keep the tag, currency and dates the buyer asked for; it sets the
 * rest (period, cash handler, trial, exit notice, stock duties), and
 * once offered the whole block is fixed for the chain.
 */
export interface TermRequestGeneral {
  tag: string;
  currency: string;
  start: string;
  end: string;
}

export function validateTermRequestGeneral(value: unknown, field: string): string | null {
  if (!isRecord(value)) return `${field}: must be an object`;
  for (const key of Object.keys(value)) {
    if (key !== 'tag' && key !== 'currency' && key !== 'start' && key !== 'end') {
      return `${field}.${key}: a request asks only for tag, currency, start and end`;
    }
  }
  const g = value as Partial<TermRequestGeneral>;
  const shape =
    validateId(g.tag, `${field}.tag`) ??
    (isCurrencyCode(g.currency)
      ? null
      : `${field}.currency: must be a three-letter uppercase code`) ??
    validateIsoUtc(g.start, `${field}.start`) ??
    validateIsoUtc(g.end, `${field}.end`);
  if (shape !== null) return shape;
  if (Date.parse(g.end as string) <= Date.parse(g.start as string))
    return `${field}.end: must follow start`;
  if (
    Date.parse(g.end as string) >
    Date.parse(addCalendarMonthsUtc(g.start as string, MAX_TERM_SPAN_MONTHS))
  ) {
    return `${field}.end: a term spans at most ${String(MAX_TERM_SPAN_MONTHS)} months`;
  }
  return null;
}

/** A deal may be rent only, share only, or both — never neither. A
 *  rent-only deal (share 0) has the vendor hold the takings (§5.6). */
export function validateTermsAgainstGeneral(
  terms: readonly Term[],
  general: TermGeneral,
): string | null {
  const values = termValues(terms);
  if (values.fee === 0n && values.share_bps === 0n)
    return 'terms: fee and share cannot both be zero';
  if (values.share_bps === 0n && general.cash_handler !== 'vendor') {
    return 'terms: a rent-only deal has the vendor hold the takings (cash_handler vendor)';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Date arithmetic (§5.2, §5.6) — one rule, both nodes
// ---------------------------------------------------------------------------

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function canonicalIso(millis: number): string {
  return new Date(millis).toISOString();
}

/**
 * `anchor` plus `months` calendar months in UTC, the day clamped to the
 * target month's last day: 31 January + 1 month = 28 or 29 February. The
 * time of day is kept. Always count from the ANCHOR (never step from a
 * previous result), so boundaries do not drift after a clamp.
 */
export function addCalendarMonthsUtc(anchorIso: string, months: number): string {
  if (!Number.isInteger(months) || months < 0)
    throw new Error('term: months must be a non-negative integer');
  const anchor = new Date(Date.parse(anchorIso));
  const total = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const monthIndex = total % 12;
  const day = Math.min(anchor.getUTCDate(), daysInUtcMonth(year, monthIndex));
  return canonicalIso(
    Date.UTC(
      year,
      monthIndex,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** `anchor` plus `weeks` whole weeks (UTC has no daylight saving). */
export function addWeeksUtc(anchorIso: string, weeks: number): string {
  if (!Number.isInteger(weeks) || weeks < 0)
    throw new Error('term: weeks must be a non-negative integer');
  return canonicalIso(Date.parse(anchorIso) + weeks * WEEK_MS);
}

function periodBoundary(anchorIso: string, period: TermPeriod, k: number): string {
  return period === 'monthly' ? addCalendarMonthsUtc(anchorIso, k) : addWeeksUtc(anchorIso, k);
}

// ---------------------------------------------------------------------------
// Pack identity and attributes
// ---------------------------------------------------------------------------

/** A first-party pack, identified across nodes by id and schema major —
 *  never by publisher DID or CID, which differ between builds (§4). */
export interface TermPackRef {
  plugin_id: string;
  schema_major: number;
}

export function validateTermPackRef(value: unknown, field: string): string | null {
  if (!isRecord(value)) return `${field}: must be an object`;
  if (Object.keys(value).some((k) => k !== 'plugin_id' && k !== 'schema_major')) {
    return `${field}: carries only plugin_id and schema_major`;
  }
  return (
    validateId(value.plugin_id, `${field}.plugin_id`) ??
    boundedInt(value.schema_major, `${field}.schema_major`, 1, 999)
  );
}

export function termPackRefsEqual(a: TermPackRef, b: TermPackRef): boolean {
  return a.plugin_id === b.plugin_id && a.schema_major === b.schema_major;
}

export const MAX_TERM_ATTRIBUTES = 32;
export const MAX_TERM_ATTRIBUTE_TEXT = 200;

/** Descriptive attributes: a flat, bounded record of scalars. The pack's
 *  schema decides which keys and values are legal (checked in Core). */
export type TermAttributes = Record<string, string | number | boolean>;

export function validateTermAttributes(value: unknown, field: string): string | null {
  if (!isRecord(value)) return `${field}: must be an object`;
  const keys = Object.keys(value);
  if (keys.length > MAX_TERM_ATTRIBUTES)
    return `${field}: at most ${String(MAX_TERM_ATTRIBUTES)} attributes`;
  for (const key of keys) {
    const idError = validateId(key, `${field} key`);
    if (idError !== null) return idError;
    const v = value[key];
    if (typeof v === 'string') {
      if (v.length > MAX_TERM_ATTRIBUTE_TEXT)
        return `${field}.${key}: exceeds ${String(MAX_TERM_ATTRIBUTE_TEXT)} characters`;
    } else if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) return `${field}.${key}: numbers are safe integers`;
    } else if (typeof v !== 'boolean') {
      return `${field}.${key}: must be a string, integer or boolean`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/consistent-type-definitions --
 * Type aliases, not interfaces: these feed `termRecordDigest` (typed
 * `unknown` → canonical JSON), the revenue_share.ts precedent. */

/** A slot's physical size: structured numbers only, so no free text in a
 *  public record can carry a price (§6.1). */
export type TermListingSize = {
  width_cm?: number;
  height_cm?: number;
  depth_cm?: number;
  shelves?: number;
};

/**
 * The public listing (§6.1): a CLOSED vocabulary with no money field of
 * any kind and no free text. `validateTermListing` refuses any other
 * field — the leakage rule is the validator, so the store's own
 * publisher and every reader apply the same one.
 */
export type TermListing = {
  protocol_version: string;
  listing_id: string;
  seller_did: string;
  pack: TermPackRef;
  resource_ref: string;
  kind: string;
  size?: TermListingSize;
  region: RegionRef;
  available: { from: string; to: string };
  tags: string[];
  published_at: string;
  listing_digest: string;
};

export type TermRequest = {
  protocol_version: string;
  request_id: string;
  buyer_did: string;
  seller_did: string;
  listing_uri: string;
  listing_digest: string;
  pack: TermPackRef;
  resource_ref: string;
  attributes: TermAttributes;
  general: TermRequestGeneral;
  wanted_terms: Term[];
  issued_at: string;
  /** The buyer's deadline for a first offer; stops request resends. */
  respond_by: string;
  request_digest: string;
};

export type TermOffer = {
  protocol_version: string;
  offer_id: string;
  request_id: string;
  request_digest: string;
  seller_did: string;
  buyer_did: string;
  pack: TermPackRef;
  resource_ref: string;
  attributes: TermAttributes;
  general: TermGeneral;
  terms: Term[];
  issued_at: string;
  valid_until: string;
  revision: number;
  previous_offer_digest?: string;
  offer_digest: string;
};

export type TermCounter = {
  protocol_version: string;
  counter_id: string;
  offer_id: string;
  offer_digest: string;
  buyer_did: string;
  seller_did: string;
  round: number;
  targets: Partial<Record<TermName, string>>;
  issued_at: string;
  respond_by: string;
  counter_digest: string;
};

export const TERM_RECEIPT_OUTCOMES = ['stored', 'held', 'refused'] as const;
export type TermReceiptOutcome = (typeof TERM_RECEIPT_OUTCOMES)[number];

export type TermReceipt = {
  protocol_version: string;
  receipt_id: string;
  /** The digest of the document this receipt answers. */
  of_digest: string;
  outcome: TermReceiptOutcome;
  issued_at: string;
  receipt_digest: string;
};

export type TermAgreementProposal = {
  protocol_version: string;
  proposal_id: string;
  /** The seller of the resource. */
  host_did: string;
  /** The buyer of the resource. */
  vendor_did: string;
  offer_digest: string;
  pack: TermPackRef;
  resource_ref: string;
  general: TermGeneral;
  terms: Term[];
  replaces_proposal_digest?: string;
  proposed_at: string;
  proposal_digest: string;
};
/* eslint-enable @typescript-eslint/consistent-type-definitions */

/** The longest any term deadline may run past its document's issue. */
export const MAX_TERM_DEADLINE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function deadlineWithin(issuedIso: string, deadlineIso: string, field: string): string | null {
  const issued = Date.parse(issuedIso);
  const deadline = Date.parse(deadlineIso);
  if (deadline <= issued) return `${field}: must follow issued_at`;
  if (deadline - issued > MAX_TERM_DEADLINE_DAYS * DAY_MS) {
    return `${field}: at most ${String(MAX_TERM_DEADLINE_DAYS)} days after issued_at`;
  }
  return null;
}

function keysWithin(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return `${field}.${key}: is not a field of this document`;
  }
  return null;
}

const LISTING_FIELDS = [
  'protocol_version',
  'listing_id',
  'seller_did',
  'pack',
  'resource_ref',
  'kind',
  'size',
  'region',
  'available',
  'tags',
  'published_at',
  'listing_digest',
] as const;
const SIZE_FIELDS = ['width_cm', 'height_cm', 'depth_cm', 'shelves'] as const;
export const MAX_LISTING_TAGS = 32;

/**
 * A listing's region: as closed as the rest of the public record. Only
 * `scheme` and `value`; no `custom` scheme (its issuer is free text by another
 * name); and each value in its scheme's own short shape — upper-case letters
 * and digits — so the field cannot carry a sentence, a price or a name. A
 * postcode-shaped word (`RENT 2000`) still fits a postcode; the shape bounds
 * it to a few characters rather than closing it.
 */
const LISTING_REGION_SHAPES: Readonly<Record<string, RegExp>> = {
  /** ISO 3166-1 alpha-2. */
  country: /^[A-Z]{2}$/,
  /** ISO 3166-2: country, hyphen, subdivision. */
  admin_area: /^[A-Z]{2}-[A-Z0-9]{1,3}$/,
  /** A postcode, optionally prefixed by its country; one inner space (SW1A 1AA). */
  postal_area: /^(?:[A-Z]{2}-)?[A-Z0-9]{2,8}(?: [A-Z0-9]{2,4})?$/,
  /** Geohash alphabet, at most 12 characters. */
  geohash: /^[0-9b-hjkmnp-z]{1,12}$/,
};

function validateListingRegion(region: unknown): string | null {
  if (!isRecord(region)) return 'listing.region: must be an object';
  const unknownField = keysWithin(region, ['scheme', 'value'], 'listing.region');
  if (unknownField !== null) return unknownField;
  const shape =
    typeof region.scheme === 'string' && Object.hasOwn(LISTING_REGION_SHAPES, region.scheme)
      ? LISTING_REGION_SHAPES[region.scheme]
      : undefined;
  if (shape === undefined) {
    return 'listing.region.scheme: must be country | admin_area | postal_area | geohash';
  }
  if (typeof region.value !== 'string' || !shape.test(region.value)) {
    return `listing.region.value: not a ${String(region.scheme)} code`;
  }
  return validateRegionRef(region);
}

export function validateTermListing(value: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(value)) return 'listing: must be an object';
  const unknownField = keysWithin(value, LISTING_FIELDS, 'listing');
  if (unknownField !== null) return unknownField;
  const l = value as Partial<TermListing> & Record<string, unknown>;
  const shape =
    validateProtocolVersionShape(l.protocol_version, 'listing.protocol_version') ??
    validateId(l.listing_id, 'listing.listing_id') ??
    validateDid(l.seller_did, 'listing.seller_did') ??
    validateTermPackRef(l.pack, 'listing.pack') ??
    validateId(l.resource_ref, 'listing.resource_ref') ??
    validateId(l.kind, 'listing.kind') ??
    validateListingRegion(l.region) ??
    validateIsoUtc(l.published_at, 'listing.published_at');
  if (shape !== null) return shape;
  if (l.size !== undefined) {
    if (!isRecord(l.size)) return 'listing.size: must be an object';
    const sizeField = keysWithin(l.size, SIZE_FIELDS, 'listing.size');
    if (sizeField !== null) return sizeField;
    for (const key of SIZE_FIELDS) {
      const v = l.size[key];
      if (v !== undefined) {
        const bad = boundedInt(v, `listing.size.${key}`, 1, 100_000);
        if (bad !== null) return bad;
      }
    }
  }
  if (!isRecord(l.available)) return 'listing.available: must be an object';
  const availableField = keysWithin(l.available, ['from', 'to'], 'listing.available');
  if (availableField !== null) return availableField;
  const availableError =
    validateIsoUtc(l.available.from, 'listing.available.from') ??
    validateIsoUtc(l.available.to, 'listing.available.to');
  if (availableError !== null) return availableError;
  if (Date.parse(l.available.to as string) <= Date.parse(l.available.from as string)) {
    return 'listing.available.to: must follow from';
  }
  if (!Array.isArray(l.tags) || l.tags.length === 0 || l.tags.length > MAX_LISTING_TAGS) {
    return `listing.tags: between 1 and ${String(MAX_LISTING_TAGS)} tags`;
  }
  for (const [i, tag] of l.tags.entries()) {
    const bad = validateId(tag, `listing.tags[${String(i)}]`);
    if (bad !== null) return bad;
    if (i > 0 && (l.tags[i - 1] as string) >= tag) return 'listing.tags: sorted and unique';
  }
  return (
    validateHex64(l.listing_digest, 'listing.listing_digest') ??
    digestMismatch('term_listing', l, sha256)
  );
}

const REQUEST_FIELDS = [
  'protocol_version',
  'request_id',
  'buyer_did',
  'seller_did',
  'listing_uri',
  'listing_digest',
  'pack',
  'resource_ref',
  'attributes',
  'general',
  'wanted_terms',
  'issued_at',
  'respond_by',
  'request_digest',
] as const;

/** An AT URI naming the term listing (`at://did/collection/rkey`). */
export function validateListingUri(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    return `${field}: must be a non-empty string of at most 512 characters`;
  }
  return /^at:\/\/did:[a-z0-9]+:[A-Za-z0-9._:%-]+\/[A-Za-z0-9.]+\/[A-Za-z0-9._:~-]+$/.test(value)
    ? null
    : `${field}: must be an at:// URI naming a record`;
}

export function validateTermRequest(value: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(value)) return 'request: must be an object';
  const unknownField = keysWithin(value, REQUEST_FIELDS, 'request');
  if (unknownField !== null) return unknownField;
  const r = value as Partial<TermRequest> & Record<string, unknown>;
  const shape =
    validateProtocolVersionShape(r.protocol_version, 'request.protocol_version') ??
    validateId(r.request_id, 'request.request_id') ??
    validateDid(r.buyer_did, 'request.buyer_did') ??
    validateDid(r.seller_did, 'request.seller_did') ??
    (r.buyer_did !== r.seller_did ? null : 'request: buyer and seller must differ') ??
    validateListingUri(r.listing_uri, 'request.listing_uri') ??
    validateHex64(r.listing_digest, 'request.listing_digest') ??
    validateTermPackRef(r.pack, 'request.pack') ??
    validateId(r.resource_ref, 'request.resource_ref') ??
    validateTermAttributes(r.attributes, 'request.attributes') ??
    validateTermRequestGeneral(r.general, 'request.general') ??
    validateTerms(r.wanted_terms, 'request.wanted_terms') ??
    validateIsoUtc(r.issued_at, 'request.issued_at') ??
    validateIsoUtc(r.respond_by, 'request.respond_by');
  if (shape !== null) return shape;
  if (!(r.listing_uri as string).startsWith(`at://${r.seller_did as string}/`)) {
    return 'request.listing_uri: must name a record in the seller’s own repository';
  }
  return (
    deadlineWithin(r.issued_at as string, r.respond_by as string, 'request.respond_by') ??
    validateHex64(r.request_digest, 'request.request_digest') ??
    digestMismatch('term_request', r, sha256)
  );
}

const OFFER_FIELDS = [
  'protocol_version',
  'offer_id',
  'request_id',
  'request_digest',
  'seller_did',
  'buyer_did',
  'pack',
  'resource_ref',
  'attributes',
  'general',
  'terms',
  'issued_at',
  'valid_until',
  'revision',
  'previous_offer_digest',
  'offer_digest',
] as const;

export function validateTermOffer(value: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(value)) return 'offer: must be an object';
  const unknownField = keysWithin(value, OFFER_FIELDS, 'offer');
  if (unknownField !== null) return unknownField;
  const o = value as Partial<TermOffer> & Record<string, unknown>;
  const shape =
    validateProtocolVersionShape(o.protocol_version, 'offer.protocol_version') ??
    validateId(o.offer_id, 'offer.offer_id') ??
    validateId(o.request_id, 'offer.request_id') ??
    validateHex64(o.request_digest, 'offer.request_digest') ??
    validateDid(o.seller_did, 'offer.seller_did') ??
    validateDid(o.buyer_did, 'offer.buyer_did') ??
    (o.buyer_did !== o.seller_did ? null : 'offer: buyer and seller must differ') ??
    validateTermPackRef(o.pack, 'offer.pack') ??
    validateId(o.resource_ref, 'offer.resource_ref') ??
    validateTermAttributes(o.attributes, 'offer.attributes') ??
    validateTermGeneral(o.general, 'offer.general') ??
    validateTerms(o.terms, 'offer.terms') ??
    validateIsoUtc(o.issued_at, 'offer.issued_at') ??
    validateIsoUtc(o.valid_until, 'offer.valid_until') ??
    boundedInt(o.revision, 'offer.revision', 1, 1_000_000);
  if (shape !== null) return shape;
  const chain =
    o.revision === 1
      ? o.previous_offer_digest === undefined
        ? null
        : 'offer.previous_offer_digest: revision 1 starts the chain'
      : o.previous_offer_digest === undefined
        ? 'offer.previous_offer_digest: required after revision 1'
        : validateHex64(o.previous_offer_digest, 'offer.previous_offer_digest');
  return (
    chain ??
    validateTermsAgainstGeneral(o.terms as Term[], o.general as TermGeneral) ??
    deadlineWithin(o.issued_at as string, o.valid_until as string, 'offer.valid_until') ??
    validateHex64(o.offer_digest, 'offer.offer_digest') ??
    digestMismatch('term_offer', o, sha256)
  );
}

const COUNTER_FIELDS = [
  'protocol_version',
  'counter_id',
  'offer_id',
  'offer_digest',
  'buyer_did',
  'seller_did',
  'round',
  'targets',
  'issued_at',
  'respond_by',
  'counter_digest',
] as const;

export function validateTermCounter(value: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(value)) return 'counter: must be an object';
  const unknownField = keysWithin(value, COUNTER_FIELDS, 'counter');
  if (unknownField !== null) return unknownField;
  const c = value as Partial<TermCounter> & Record<string, unknown>;
  return (
    validateProtocolVersionShape(c.protocol_version, 'counter.protocol_version') ??
    validateId(c.counter_id, 'counter.counter_id') ??
    validateId(c.offer_id, 'counter.offer_id') ??
    validateHex64(c.offer_digest, 'counter.offer_digest') ??
    validateDid(c.buyer_did, 'counter.buyer_did') ??
    validateDid(c.seller_did, 'counter.seller_did') ??
    (c.buyer_did !== c.seller_did ? null : 'counter: buyer and seller must differ') ??
    boundedInt(c.round, 'counter.round', 1, 1_000) ??
    validateTermTargets(c.targets, 'counter.targets') ??
    validateIsoUtc(c.issued_at, 'counter.issued_at') ??
    validateIsoUtc(c.respond_by, 'counter.respond_by') ??
    deadlineWithin(c.issued_at as string, c.respond_by as string, 'counter.respond_by') ??
    validateHex64(c.counter_digest, 'counter.counter_digest') ??
    digestMismatch('term_counter', c, sha256)
  );
}

const RECEIPT_FIELDS = [
  'protocol_version',
  'receipt_id',
  'of_digest',
  'outcome',
  'issued_at',
  'receipt_digest',
] as const;

export function validateTermReceipt(value: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(value)) return 'receipt: must be an object';
  const unknownField = keysWithin(value, RECEIPT_FIELDS, 'receipt');
  if (unknownField !== null) return unknownField;
  const r = value as Partial<TermReceipt> & Record<string, unknown>;
  return (
    validateProtocolVersionShape(r.protocol_version, 'receipt.protocol_version') ??
    validateId(r.receipt_id, 'receipt.receipt_id') ??
    validateHex64(r.of_digest, 'receipt.of_digest') ??
    ((TERM_RECEIPT_OUTCOMES as readonly string[]).includes(r.outcome as string)
      ? null
      : 'receipt.outcome: must be stored, held or refused') ??
    validateIsoUtc(r.issued_at, 'receipt.issued_at') ??
    validateHex64(r.receipt_digest, 'receipt.receipt_digest') ??
    digestMismatch('term_receipt', r, sha256)
  );
}

/** `stored` and `refused` are final; `held` is not (§5.3). */
export function isFinalReceiptOutcome(outcome: TermReceiptOutcome): boolean {
  return outcome !== 'held';
}

const PROPOSAL_FIELDS = [
  'protocol_version',
  'proposal_id',
  'host_did',
  'vendor_did',
  'offer_digest',
  'pack',
  'resource_ref',
  'general',
  'terms',
  'replaces_proposal_digest',
  'proposed_at',
  'proposal_digest',
] as const;

export function validateTermAgreementProposal(value: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(value)) return 'term proposal: must be an object';
  const unknownField = keysWithin(value, PROPOSAL_FIELDS, 'term proposal');
  if (unknownField !== null) return unknownField;
  const p = value as Partial<TermAgreementProposal> & Record<string, unknown>;
  return (
    validateProtocolVersionShape(p.protocol_version, 'term proposal.protocol_version') ??
    validateId(p.proposal_id, 'term proposal.proposal_id') ??
    validateDid(p.host_did, 'term proposal.host_did') ??
    validateDid(p.vendor_did, 'term proposal.vendor_did') ??
    (p.host_did !== p.vendor_did ? null : 'term proposal: host and vendor must differ') ??
    validateHex64(p.offer_digest, 'term proposal.offer_digest') ??
    validateTermPackRef(p.pack, 'term proposal.pack') ??
    validateId(p.resource_ref, 'term proposal.resource_ref') ??
    validateTermGeneral(p.general, 'term proposal.general') ??
    validateTerms(p.terms, 'term proposal.terms') ??
    validateTermsAgainstGeneral(p.terms as Term[], p.general as TermGeneral) ??
    (p.replaces_proposal_digest === undefined
      ? null
      : validateHex64(p.replaces_proposal_digest, 'term proposal.replaces_proposal_digest')) ??
    validateIsoUtc(p.proposed_at, 'term proposal.proposed_at') ??
    validateHex64(p.proposal_digest, 'term proposal.proposal_digest') ??
    digestMismatch('term_agreement_proposal', p, sha256)
  );
}

// ---------------------------------------------------------------------------
// Pairwise rules — both nodes run the same ones
// ---------------------------------------------------------------------------

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** The AT collection a term listing is published under (§6.1). */
export const TERM_LISTING_COLLECTION = 'com.dinakernel.commerce.termListing';

/** Where a listing lives: the seller's repository, keyed by listing id. */
export function termListingUri(listing: Pick<TermListing, 'seller_did' | 'listing_id'>): string {
  return `at://${listing.seller_did}/${TERM_LISTING_COLLECTION}/${listing.listing_id}`;
}

/** A request names a listing; the request must agree with it. */
export function verifyTermRequestAgainstListing(
  request: TermRequest,
  listing: TermListing,
): string | null {
  if (request.listing_digest !== listing.listing_digest)
    return 'request: names a different listing';
  if (request.listing_uri !== termListingUri(listing))
    return 'request: the listing URI names a different record';
  if (request.seller_did !== listing.seller_did)
    return 'request: the seller is not the listing’s publisher';
  if (!termPackRefsEqual(request.pack, listing.pack))
    return 'request: pack differs from the listing';
  if (request.resource_ref !== listing.resource_ref)
    return 'request: resource differs from the listing';
  if (!listing.tags.includes(request.general.tag))
    return 'request: the listing does not want this tag';
  if (request.protocol_version !== listing.protocol_version) {
    return 'request: §9.13 — a conversation pins one protocol version';
  }
  return null;
}

/**
 * The first offer answers a request: same parties, pack and resource, the
 * tag, currency and dates the buyer asked for, and the request's own
 * protocol version (§9.13).
 */
export function verifyTermOfferAgainstRequest(
  offer: TermOffer,
  request: TermRequest,
): string | null {
  if (offer.request_id !== request.request_id || offer.request_digest !== request.request_digest) {
    return 'offer: answers a different request';
  }
  if (offer.protocol_version !== request.protocol_version) {
    return 'offer: §9.13 — a conversation pins one protocol version';
  }
  if (offer.seller_did !== request.seller_did || offer.buyer_did !== request.buyer_did) {
    return 'offer: parties differ from the request';
  }
  if (!termPackRefsEqual(offer.pack, request.pack)) return 'offer: pack differs from the request';
  if (offer.resource_ref !== request.resource_ref)
    return 'offer: resource differs from the request';
  const g = offer.general;
  const want = request.general;
  if (
    g.tag !== want.tag ||
    g.currency !== want.currency ||
    g.start !== want.start ||
    g.end !== want.end
  ) {
    return 'offer: tag, currency and dates must be the ones the request asked for';
  }
  return null;
}

/** Revision N+1 of a chain: same immutables, the head as predecessor. */
export function verifyTermOfferRevision(previous: TermOffer, next: TermOffer): string | null {
  if (next.revision !== previous.revision + 1) return 'offer: revision must follow the head by one';
  if (next.previous_offer_digest !== previous.offer_digest)
    return 'offer: must name the head it revises';
  if (next.offer_id !== previous.offer_id) return 'offer: a revision keeps the offer id';
  if (
    next.protocol_version !== previous.protocol_version ||
    next.request_id !== previous.request_id ||
    next.request_digest !== previous.request_digest ||
    next.seller_did !== previous.seller_did ||
    next.buyer_did !== previous.buyer_did ||
    next.resource_ref !== previous.resource_ref ||
    !termPackRefsEqual(next.pack, previous.pack) ||
    !sameJson(next.attributes, previous.attributes) ||
    !sameJson(next.general, previous.general)
  ) {
    return 'offer: protocol version, parties, pack, resource, attributes and general are fixed within a chain';
  }
  return null;
}

/** A counter names the head of a chain it may counter. */
export function verifyTermCounterAgainstOffer(
  counter: TermCounter,
  offer: TermOffer,
): string | null {
  if (counter.offer_id !== offer.offer_id || counter.offer_digest !== offer.offer_digest) {
    return 'counter: names a different offer';
  }
  if (counter.protocol_version !== offer.protocol_version) {
    return 'counter: §9.13 — a conversation pins one protocol version';
  }
  if (counter.buyer_did !== offer.buyer_did || counter.seller_did !== offer.seller_did) {
    return 'counter: parties differ from the offer';
  }
  return null;
}

/**
 * A proposal equals its offer, field by field (§7.1 step 5): pack,
 * resource, general and terms, with host = seller and vendor = buyer.
 */
export function verifyTermProposalAgainstOffer(
  proposal: TermAgreementProposal,
  offer: TermOffer,
): string | null {
  if (proposal.offer_digest !== offer.offer_digest) return 'term proposal: names a different offer';
  if (proposal.protocol_version !== offer.protocol_version) {
    return 'term proposal: §9.13 — a conversation pins one protocol version';
  }
  if (proposal.host_did !== offer.seller_did || proposal.vendor_did !== offer.buyer_did) {
    return 'term proposal: parties differ from the offer';
  }
  if (!termPackRefsEqual(proposal.pack, offer.pack))
    return 'term proposal: pack differs from the offer';
  if (proposal.resource_ref !== offer.resource_ref)
    return 'term proposal: resource differs from the offer';
  if (!sameJson(proposal.general, offer.general))
    return 'term proposal: general differs from the offer';
  if (!sameJson(proposal.terms, offer.terms)) return 'term proposal: terms differ from the offer';
  return null;
}

/** A renewal: same parties and resource, starting where the old one ends. */
export function verifyTermRenewal(
  previous: TermAgreementProposal,
  renewal: TermAgreementProposal,
): string | null {
  if (renewal.replaces_proposal_digest !== previous.proposal_digest)
    return 'renewal: names a different agreement';
  if (renewal.host_did !== previous.host_did || renewal.vendor_did !== previous.vendor_did) {
    return 'renewal: parties differ from the agreement it renews';
  }
  if (
    renewal.resource_ref !== previous.resource_ref ||
    !termPackRefsEqual(renewal.pack, previous.pack)
  ) {
    return 'renewal: resource differs from the agreement it renews';
  }
  if (renewal.general.tag !== previous.general.tag) return 'renewal: keeps the tag';
  if (renewal.general.start !== previous.general.end)
    return 'renewal: starts where the renewed agreement ends';
  return null;
}

/** §5.5 — after the trial, a termination honours the exit notice. */
export function verifyTermTerminationNotice(args: {
  general: TermGeneral;
  terminatedAt: string;
  effectiveAt: string;
}): string | null {
  const terminated = Date.parse(args.terminatedAt);
  const effective = Date.parse(args.effectiveAt);
  if (effective < terminated) return 'termination: never takes effect before it is issued';
  const inTrial =
    args.general.trial !== undefined && terminated < Date.parse(args.general.trial.end);
  if (inTrial) return null;
  if (effective - terminated < args.general.exit_notice_days * DAY_MS) {
    return `termination: takes effect at least ${String(args.general.exit_notice_days)} days after it is issued`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The period schedule (§5.6)
// ---------------------------------------------------------------------------

export interface TermPeriodSlot {
  kind: 'trial' | 'regular';
  /** The period as charged (cut at the ended instant if it falls inside). */
  start: string;
  end: string;
  /** The full scheduled period, for proration. */
  full_start: string;
  full_end: string;
  /** The fee due for this (possibly cut) period, minor units. */
  fee_due_minor: string;
}

/**
 * The schedule both nodes derive (§5.6):
 *
 * - a trial, if any, is one period [start, trial.end) with full fee
 *   `trial.fee`;
 * - regular periods run from the anchor (trial.end, else start); boundary
 *   k is anchor + k calendar months (or k weeks), always counted from the
 *   anchor, with month-end clamping;
 * - the ENDED instant is `end`, or an earlier termination's effective
 *   time; the period containing it is cut there and none starts at or
 *   after it;
 * - a cut period's fee is full × cut / full in milliseconds, one
 *   half-even rounding.
 */
export function deriveTermSchedule(args: {
  general: TermGeneral;
  terms: readonly Term[];
  endedAt?: string;
}): TermPeriodSlot[] {
  const { general } = args;
  const end = Date.parse(general.end);
  // `end` itself is a cut: a term that stops mid-period charges that
  // period pro rata, exactly as an early termination does.
  const ended = args.endedAt === undefined ? end : Math.min(end, Date.parse(args.endedAt));
  const slots: TermPeriodSlot[] = [];
  const slot = (kind: 'trial' | 'regular', from: number, fullTo: number, fullFee: bigint): void => {
    const to = Math.min(fullTo, ended);
    if (to <= from) return;
    const fee =
      to === fullTo
        ? fullFee
        : roundRationalHalfEven(fullFee * BigInt(to - from), BigInt(fullTo - from));
    slots.push({
      kind,
      start: canonicalIso(from),
      end: canonicalIso(to),
      full_start: canonicalIso(from),
      full_end: canonicalIso(fullTo),
      fee_due_minor: fee.toString(10),
    });
  };
  let anchorIso = general.start;
  if (general.trial !== undefined) {
    slot(
      'trial',
      Date.parse(general.start),
      Date.parse(general.trial.end),
      moneyMinorUnits(general.trial.fee),
    );
    anchorIso = general.trial.end;
  }
  const regularFee = termValues(args.terms).fee;
  for (let k = 0; ; k += 1) {
    const from = Date.parse(periodBoundary(anchorIso, general.period, k));
    if (from >= ended) break;
    slot('regular', from, Date.parse(periodBoundary(anchorIso, general.period, k + 1)), regularFee);
  }
  return slots;
}

/** The scheduled slot a note's period must match, if any. */
export function findTermPeriod(
  schedule: readonly TermPeriodSlot[],
  periodStart: string,
  periodEnd: string,
): TermPeriodSlot | null {
  const from = Date.parse(periodStart);
  const to = Date.parse(periodEnd);
  return (
    schedule.find((slot) => Date.parse(slot.start) === from && Date.parse(slot.end) === to) ?? null
  );
}

/**
 * The pairwise checks a settlement note owes a TERM agreement (§5.6):
 * the period is one scheduled (or cut) slot, the share is derived from
 * `share_bps`, `fee_due` is derived from the schedule, one currency, and
 * a rent-only deal reports zero gross.
 */
export function verifyTermSettlement(args: {
  note: SettlementNote;
  proposal: TermAgreementProposal;
  endedAt?: string;
}): string | null {
  const { note, proposal } = args;
  if (note.proposal_digest !== proposal.proposal_digest)
    return 'settlement: answers a different agreement';
  if (note.protocol_version !== proposal.protocol_version) {
    return 'settlement: §9.13 — a conversation pins one protocol version';
  }
  if (note.fee_due === undefined) return 'settlement: a term agreement’s note states fee_due';
  const currency = proposal.general.currency;
  if (
    note.gross_sales.currency !== currency ||
    note.computed_share.currency !== currency ||
    note.fee_due.currency !== currency
  ) {
    return 'settlement: currency differs from the agreement';
  }
  const values = termValues(proposal.terms);
  if (values.share_bps === 0n && moneyMinorUnits(note.gross_sales) !== 0n) {
    return 'settlement: a rent-only deal reports zero gross';
  }
  const share = computedShareMinor(moneyMinorUnits(note.gross_sales), Number(values.share_bps));
  if (moneyMinorUnits(note.computed_share) !== share) {
    // No figure in the reason: it reaches logs, and the share and fee are the deal's.
    return 'settlement.computed_share: does not match gross × share_bps (half-even)';
  }
  const schedule = deriveTermSchedule({
    general: proposal.general,
    terms: proposal.terms,
    ...(args.endedAt !== undefined ? { endedAt: args.endedAt } : {}),
  });
  const slot = findTermPeriod(schedule, note.period_start, note.period_end);
  if (slot === null) return 'settlement: the period is not one the agreement schedules';
  if (note.fee_due.minor_units !== slot.fee_due_minor) {
    return "settlement.fee_due: not this period's fee";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The fold (§5.6) — who owes whom, signed, per period
// ---------------------------------------------------------------------------

export interface TermFoldInput {
  cash_handler: CashHandler;
  currency: string;
  /** Accepted settlements of the latest revision per period. */
  settlements: { gross_minor: string; share_minor: string; fee_minor: string }[];
}

export type TermFoldResult =
  | {
      ok: true;
      direction: 'vendor_owes_host' | 'host_owes_vendor' | 'even';
      owed_minor: string;
      gross_minor: string;
      share_minor: string;
      fee_minor: string;
      settlement_count: number;
    }
  | { ok: false; error: string };

/**
 * Per period, in minor units:
 *
 * - `vendor` holds the takings: the vendor owes the host fee + share;
 * - `host` holds them: net = gross − share − fee; above zero the host
 *   owes the vendor net, below zero the vendor owes the host −net.
 *
 * Periods add signed (positive = host owes vendor). Every total is held
 * to the money magnitude bound; overflow is a refusal, never wraparound.
 */
export function computeTermAgreementFold(input: TermFoldInput): TermFoldResult {
  let gross = 0n;
  let share = 0n;
  let fee = 0n;
  let hostOwes = 0n;
  for (const [i, s] of input.settlements.entries()) {
    for (const [field, minor] of [
      ['gross', s.gross_minor],
      ['share', s.share_minor],
      ['fee', s.fee_minor],
    ] as const) {
      const bad = validateMoney({ currency: input.currency, minor_units: minor });
      if (bad !== null)
        return { ok: false, error: `fold.settlements[${String(i)}].${field}: ${bad}` };
    }
    const g = BigInt(s.gross_minor);
    const sh = BigInt(s.share_minor);
    const f = BigInt(s.fee_minor);
    if (sh > g)
      return { ok: false, error: `fold.settlements[${String(i)}]: the share exceeds the gross` };
    gross += g;
    share += sh;
    fee += f;
    hostOwes += input.cash_handler === 'vendor' ? -(f + sh) : g - sh - f;
  }
  const magnitude = hostOwes < 0n ? -hostOwes : hostOwes;
  const texts = [magnitude, gross, share, fee].map((v) => minorUnitsToString(v).value);
  if (texts.some((t) => t === null))
    return { ok: false, error: 'fold: totals exceed the representable bound' };
  return {
    ok: true,
    direction: hostOwes > 0n ? 'host_owes_vendor' : hostOwes < 0n ? 'vendor_owes_host' : 'even',
    owed_minor: texts[0] as string,
    gross_minor: texts[1] as string,
    share_minor: texts[2] as string,
    fee_minor: texts[3] as string,
    settlement_count: input.settlements.length,
  };
}
