/**
 * Smaller deals beneath a larger one: firm options between known partners
 * (COMMITMENT_KERNEL §6 "How linked deals bind", §11 onward sharing, §15
 * step 7). The `commitment.option` D2D family and both nodes' records.
 *
 *   SELLER                                  SHIPPER
 *   request  ── only under the buyer's ──▶  issues a firm option from its
 *               onward-sharing grant         own model (a run that day, a
 *                                            fee, capacity), or declines
 *   holds it ◀── option | decline ───────
 *   takes it up in the same act as the
 *   buyer's yes (bindOnYes), then
 *   acceptance ──── resent until the ───▶  one stored answer: admitted, or
 *                   hold's end + grace       arrived after the grace
 *   bound | lapsed (no fault) ◀─ receipt ─
 *   status_query after the grace ───────▶  the same stored answer
 *
 * The timing rules are `dependent.ts`; this file holds the wire bodies, the
 * stores and the decisions on each node. No I/O beyond the stores: sending is
 * the caller's.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import {
  acceptanceRetry,
  answerAcceptance,
  DEPENDENT_TIMINGS,
  linkState,
  optionFits,
  optionState,
  type OptionAnswer,
  type OptionTerms,
} from './dependent';

import type { NeverCondition, ValueModel } from './value_model';
import type { DatabaseAdapter } from '../storage/db_adapter';

export const OPTION_MESSAGE = 'commitment.option';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long a shipper holds an option it issues, at most (within the 7-day cap). */
export const OPTION_HOLD_MS = 3 * DAY_MS;
/** The shipper's lead time before the run. */
export const OPTION_LEAD_MS = DAY_MS;
/**
 * The least hold worth issuing: room for an offer to the buyer that ends 25
 * hours before the hold (`upperOfferEndsAt`), and an hour to say yes in.
 */
export const MIN_HOLD_MS = DEPENDENT_TIMINGS.buyerYesGraceMs + 2 * HOUR_MS;
/** How often an unanswered acceptance is resent, or a status asked for. */
export const RESEND_EVERY_MS = HOUR_MS;

const ID = /^[a-z0-9_.-]{1,64}$/;
/** A commerce id (an order's, a quote's): printable, no spaces, bounded. */
const LONG_ID = /^[\x21-\x7e]{1,128}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const POSTAL = /^[A-Za-z0-9 -]{3,12}$/;
const MINOR = /^(0|[1-9]\d{0,15})$/;

// ─── Wire bodies ──────────────────────────────────────────────────────────

/** The seller asks: a run on the service day, for so many crates, to a pincode. */
export interface OptionRequestBody {
  v: 1;
  kind: 'request';
  request_id: string;
  service_at: string;
  crates: number;
  /** Present only when the buyer's grant names it (§11); never an address. */
  postal_code?: string;
}

/** The shipper's firm option: binds it if taken up within the hold. */
export interface OptionBody {
  v: 1;
  kind: 'option';
  option_id: string;
  request_id: string;
  service_at: string;
  crates: number;
  /** The fee, in paise, as a decimal string. */
  fee_minor: string;
  currency: 'INR';
  issued_at: string;
  hold_until: string;
  lead_time_s: number;
  /** The shipper's model version the option was checked against (§6 step 1). */
  model_version: number;
}

export type DeclineReason = 'no_run' | 'no_price' | 'full' | 'too_soon' | 'closed';

export interface DeclineBody {
  v: 1;
  kind: 'decline';
  request_id: string;
  reason: DeclineReason;
}

export interface AcceptanceBody {
  v: 1;
  kind: 'acceptance';
  option_id: string;
  accepted_at: string;
}

export interface ReceiptBody {
  v: 1;
  kind: 'receipt';
  option_id: string;
  answer: OptionAnswer['answer'];
  at: string;
}

export interface StatusQueryBody {
  v: 1;
  kind: 'status_query';
  option_id: string;
}

/**
 * The seller tells the buyer a run its order took has ended without fault
 * after binding (§6 step 6): from here the order stands on the quote's own
 * terms, the fallback named by `partner_run`. Never names a party at fault.
 */
export interface FallbackBody {
  v: 1;
  kind: 'fallback';
  purchase_order_id: string;
  quote_id: string;
  alternative_id: string;
  at: string;
}

export type OptionMessage =
  | OptionRequestBody
  | OptionBody
  | DeclineBody
  | AcceptanceBody
  | ReceiptBody
  | StatusQueryBody
  | FallbackBody;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const isIso = (v: unknown): v is string =>
  typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= max;

/** Parse one `commitment.option` body; null for anything malformed. Data, never an instruction. */
export function parseOptionMessage(raw: unknown): OptionMessage | null {
  if (!isRecord(raw) || raw.v !== 1) return null;
  switch (raw.kind) {
    case 'request':
      if (!isId(raw.request_id) || !isIso(raw.service_at) || !isCount(raw.crates, 1000))
        return null;
      if (
        raw.postal_code !== undefined &&
        !(typeof raw.postal_code === 'string' && POSTAL.test(raw.postal_code))
      )
        return null;
      return {
        v: 1,
        kind: 'request',
        request_id: raw.request_id,
        service_at: raw.service_at,
        crates: raw.crates,
        ...(raw.postal_code === undefined ? {} : { postal_code: raw.postal_code as string }),
      };
    case 'option':
      if (
        !isId(raw.option_id) ||
        !isId(raw.request_id) ||
        !isIso(raw.service_at) ||
        !isCount(raw.crates, 1000) ||
        typeof raw.fee_minor !== 'string' ||
        !MINOR.test(raw.fee_minor) ||
        raw.currency !== 'INR' ||
        !isIso(raw.issued_at) ||
        !isIso(raw.hold_until) ||
        !isCount(raw.lead_time_s, 30 * 24 * 3600) ||
        !(
          typeof raw.model_version === 'number' &&
          Number.isSafeInteger(raw.model_version) &&
          raw.model_version >= 0
        )
      )
        return null;
      return {
        v: 1,
        kind: 'option',
        option_id: raw.option_id,
        request_id: raw.request_id,
        service_at: raw.service_at,
        crates: raw.crates,
        fee_minor: raw.fee_minor,
        currency: 'INR',
        issued_at: raw.issued_at,
        hold_until: raw.hold_until,
        lead_time_s: raw.lead_time_s,
        model_version: raw.model_version,
      };
    case 'decline':
      if (!isId(raw.request_id)) return null;
      if (!['no_run', 'no_price', 'full', 'too_soon', 'closed'].includes(String(raw.reason)))
        return null;
      return {
        v: 1,
        kind: 'decline',
        request_id: raw.request_id,
        reason: raw.reason as DeclineReason,
      };
    case 'acceptance':
      if (!isId(raw.option_id) || !isIso(raw.accepted_at)) return null;
      return { v: 1, kind: 'acceptance', option_id: raw.option_id, accepted_at: raw.accepted_at };
    case 'receipt':
      if (!isId(raw.option_id) || !isIso(raw.at)) return null;
      if (raw.answer !== 'admitted' && raw.answer !== 'arrived_after_grace') return null;
      return { v: 1, kind: 'receipt', option_id: raw.option_id, answer: raw.answer, at: raw.at };
    case 'status_query':
      if (!isId(raw.option_id)) return null;
      return { v: 1, kind: 'status_query', option_id: raw.option_id };
    case 'fallback':
      if (
        typeof raw.purchase_order_id !== 'string' ||
        !LONG_ID.test(raw.purchase_order_id) ||
        typeof raw.quote_id !== 'string' ||
        !LONG_ID.test(raw.quote_id) ||
        !(
          typeof raw.alternative_id === 'string' && /^partner_[0-9a-f]{8}$/.test(raw.alternative_id)
        ) ||
        !isIso(raw.at)
      )
        return null;
      return {
        v: 1,
        kind: 'fallback',
        purchase_order_id: raw.purchase_order_id,
        quote_id: raw.quote_id,
        alternative_id: raw.alternative_id,
        at: raw.at,
      };
    default:
      return null;
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The option's timing as `dependent.ts` judges it. */
export function optionTerms(o: OptionBody): OptionTerms {
  return {
    issuedAtMs: Date.parse(o.issued_at),
    holdUntilMs: Date.parse(o.hold_until),
    leadTimeMs: o.lead_time_s * 1000,
    serviceAtMs: Date.parse(o.service_at),
  };
}

/** The calendar day of a moment in a time zone (`YYYY-MM-DD`), for counting a day's crates. */
export function localDateOf(atMs: number, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(atMs));
  } catch {
    return null;
  }
}

// ─── The shipper's node ───────────────────────────────────────────────────

export interface IssuedOption {
  sellerDid: string;
  option: OptionBody;
  serviceDay: string;
  answer: OptionAnswer | null;
}

export class ShipperOptionStore {
  constructor(private readonly db: DatabaseAdapter) {}

  private row(r: Record<string, unknown> | undefined): IssuedOption | null {
    if (r === undefined) return null;
    return {
      sellerDid: String(r.seller_did),
      option: JSON.parse(String(r.option_json)) as OptionBody,
      serviceDay: String(r.service_day),
      answer: r.answer_json === null ? null : (JSON.parse(String(r.answer_json)) as OptionAnswer),
    };
  }

  byRequest(sellerDid: string, requestId: string): IssuedOption | null {
    return this.row(
      this.db.query(`SELECT * FROM commitment_options WHERE seller_did = ? AND request_id = ?`, [
        sellerDid,
        requestId,
      ])[0],
    );
  }

  byOption(sellerDid: string, optionId: string): IssuedOption | null {
    return this.row(
      this.db.query(`SELECT * FROM commitment_options WHERE seller_did = ? AND option_id = ?`, [
        sellerDid,
        optionId,
      ])[0],
    );
  }

  /** Every option for a day, open or admitted (expired ones free their room). */
  onDay(serviceDay: string): IssuedOption[] {
    return this.db
      .query(`SELECT * FROM commitment_options WHERE service_day = ?`, [serviceDay])
      .map((r) => this.row(r) as IssuedOption);
  }

  issue(sellerDid: string, option: OptionBody, serviceDay: string, nowMs: number): void {
    this.db.execute(
      `INSERT INTO commitment_options
         (seller_did, request_id, option_id, option_json, service_day, crates, hold_until, answer_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [
        sellerDid,
        option.request_id,
        option.option_id,
        JSON.stringify(option),
        serviceDay,
        option.crates,
        Date.parse(option.hold_until),
        nowMs,
      ],
    );
  }

  /** Options whose answer is that the acceptance came after the grace (a no-fault lapse). */
  lateAnswers(): IssuedOption[] {
    return this.db
      .query(`SELECT * FROM commitment_options WHERE answer_json LIKE '%arrived_after_grace%'`)
      .map((r) => this.row(r) as IssuedOption);
  }

  /** Store the first answer only: the answer never changes (§6 step 6). */
  answer(sellerDid: string, optionId: string, answer: OptionAnswer): void {
    this.db.execute(
      `UPDATE commitment_options SET answer_json = ?
        WHERE seller_did = ? AND option_id = ? AND answer_json IS NULL`,
      [JSON.stringify(answer), sellerDid, optionId],
    );
  }
}

/** What the shipper's model says about a run: what it costs that day, how many crates fit. */
export interface ShipperModelView {
  model: ValueModel | null;
  closedPersonas: readonly string[];
  /** The owner's asking terms on the Core form: `fee`, in paise, is the run's price. */
  asking: Readonly<Record<string, string>>;
}

/**
 * The shipper's answer to a request: the option already issued for it (a
 * resend gets the same one), or a new firm option from its own model, or a
 * decline. Issuing is the shipper's own commitment, checked here, with the
 * model version recorded. The fee is the price the owner set for a run (the
 * form's asking `fee`), never anything Core works out from the owner's costs
 * (§11); issued with no card, so it must be at or above the least `fee` Core
 * may agree alone. A day with no cost entry is a day with no run.
 */
export function answerOptionRequest(args: {
  store: ShipperOptionStore;
  view: ShipperModelView;
  sellerDid: string;
  request: OptionRequestBody;
  timeZone: string;
  nowMs: number;
  deliveryDayOf: (atMs: number, timeZone: string) => string | null;
}): OptionBody | DeclineBody {
  const { request, store } = args;
  const held = store.byRequest(args.sellerDid, request.request_id);
  if (held !== null) return held.option;
  const decline = (reason: DeclineReason): DeclineBody => ({
    v: 1,
    kind: 'decline',
    request_id: request.request_id,
    reason,
  });
  // A rule in a closed persona may forbid this run: no option until it is open.
  if (args.view.closedPersonas.length > 0) return decline('closed');
  const model = args.view.model;
  const serviceAtMs = Date.parse(request.service_at);
  const day = args.deliveryDayOf(serviceAtMs, args.timeZone);
  const serviceDay = localDateOf(serviceAtMs, args.timeZone);
  const cost = day === null || model === null ? undefined : model.choiceValues.delivery_day?.[day];
  if (model === null || day === null || serviceDay === null || cost === undefined)
    return decline('no_run');
  // The owner's price for a run, held to what Core may agree alone.
  const asking = args.view.asking.fee;
  if (asking === undefined || !MINOR.test(asking)) return decline('no_price');
  const feeMinor = BigInt(asking);
  if (feeMinor < (model.limits.fee?.auto ?? 0n)) return decline('no_price');
  // A never-rule is judged against the run as offered: its day and its fee.
  // A test on any other part is taken to hold, so a rule this code cannot
  // read refuses rather than letting the run by.
  const holdsFor = (c: NeverCondition): boolean => {
    if (c.part === 'delivery_day') return 'choice' in c ? c.choice === day : 'present' in c;
    if (c.part === 'fee') {
      if ('below' in c) return feeMinor < c.below;
      if ('above' in c) return feeMinor > c.above;
      return 'present' in c;
    }
    return true;
  };
  if (model.never.some((rule) => rule.all.length > 0 && rule.all.every(holdsFor)))
    return decline('no_run');
  // Room on that day's run: crates held by options still open or admitted.
  const room = model.capacities?.run;
  if (room === undefined || room.dimension !== 'crates') return decline('full');
  const taken = store
    .onDay(serviceDay)
    .filter(
      (o) =>
        optionState({
          holdUntilMs: Date.parse(o.option.hold_until),
          answer: o.answer,
          nowMs: args.nowMs,
        }) !== 'expired',
    )
    .reduce((sum, o) => sum + BigInt(o.option.crates), 0n);
  if (taken + BigInt(request.crates) > room.amount) return decline('full');
  // The hold: as long as allowed, ending so the grace and the lead time end
  // by the run (§6 step 2), and long enough to offer the buyer anything.
  const latest = serviceAtMs - DEPENDENT_TIMINGS.optionGraceMs - OPTION_LEAD_MS;
  const holdUntilMs = Math.min(args.nowMs + OPTION_HOLD_MS, latest);
  if (holdUntilMs - args.nowMs < MIN_HOLD_MS) return decline('too_soon');
  const terms: OptionTerms = {
    issuedAtMs: args.nowMs,
    holdUntilMs,
    leadTimeMs: OPTION_LEAD_MS,
    serviceAtMs,
  };
  if (optionFits(terms) !== null) return decline('too_soon');
  const option: OptionBody = {
    v: 1,
    kind: 'option',
    option_id: `opt-${bytesToHex(randomBytes(8))}`,
    request_id: request.request_id,
    service_at: request.service_at,
    crates: request.crates,
    fee_minor: feeMinor.toString(10),
    currency: 'INR',
    issued_at: iso(args.nowMs),
    hold_until: iso(holdUntilMs),
    lead_time_s: OPTION_LEAD_MS / 1000,
    model_version: model.version,
  };
  store.issue(args.sellerDid, option, serviceDay, args.nowMs);
  return option;
}

/**
 * The shipper's receipt for an acceptance or a status query: its one stored
 * answer, deciding and storing it on first sight (arrival within the hold's
 * end plus the grace admits). A status query before then has no answer yet:
 * null, and nothing is sent. Unknown option: null.
 */
export function answerOptionTakeUp(args: {
  store: ShipperOptionStore;
  sellerDid: string;
  optionId: string;
  isQuery: boolean;
  nowMs: number;
}): ReceiptBody | null {
  const held = args.store.byOption(args.sellerDid, args.optionId);
  if (held === null) return null;
  const holdUntilMs = Date.parse(held.option.hold_until);
  let answer = held.answer;
  if (answer === null) {
    const expired = optionState({ holdUntilMs, answer: null, nowMs: args.nowMs }) === 'expired';
    if (args.isQuery && !expired) return null;
    answer = answerAcceptance({ stored: null, holdUntilMs, arrivedAtMs: args.nowMs });
    args.store.answer(args.sellerDid, args.optionId, answer);
    answer = args.store.byOption(args.sellerDid, args.optionId)?.answer ?? answer;
  }
  return {
    v: 1,
    kind: 'receipt',
    option_id: args.optionId,
    answer: answer.answer,
    at: iso(answer.atMs),
  };
}

// ─── The seller's node ────────────────────────────────────────────────────

export type LinkRowState = 'asked' | 'held' | 'declined' | 'accepted' | 'bound' | 'lapsed_no_fault';

export interface OptionLink {
  requestId: string;
  shipperDid: string;
  dealRef: string;
  request: OptionRequestBody;
  state: LinkRowState;
  option: OptionBody | null;
  /** When the seller's owner cleared offering a version on this option (§6 step 3). */
  clearedAt: number | null;
  /** The order that took the option up: one option, one order. */
  orderRef: string | null;
  acceptedAt: number | null;
  lastSentAt: number | null;
  answer: OptionAnswer | null;
  cardRaised: boolean;
}

export class SellerOptionStore {
  constructor(private readonly db: DatabaseAdapter) {}

  private row(r: Record<string, unknown> | undefined): OptionLink | null {
    if (r === undefined) return null;
    return {
      requestId: String(r.request_id),
      shipperDid: String(r.shipper_did),
      dealRef: String(r.deal_ref),
      request: JSON.parse(String(r.request_json)) as OptionRequestBody,
      state: String(r.state) as LinkRowState,
      option: r.option_json === null ? null : (JSON.parse(String(r.option_json)) as OptionBody),
      clearedAt: r.cleared_at === null ? null : Number(r.cleared_at),
      orderRef: r.order_ref === null ? null : String(r.order_ref),
      acceptedAt: r.accepted_at === null ? null : Number(r.accepted_at),
      lastSentAt: r.last_sent_at === null ? null : Number(r.last_sent_at),
      answer: r.answer_json === null ? null : (JSON.parse(String(r.answer_json)) as OptionAnswer),
      cardRaised: Number(r.card_raised) === 1,
    };
  }

  get(requestId: string): OptionLink | null {
    return this.row(
      this.db.query(`SELECT * FROM commitment_option_links WHERE request_id = ?`, [requestId])[0],
    );
  }

  byOption(shipperDid: string, optionId: string): OptionLink | null {
    return (
      this.forState(['held', 'accepted', 'bound', 'lapsed_no_fault']).find(
        (l) => l.shipperDid === shipperDid && l.option?.option_id === optionId,
      ) ?? null
    );
  }

  forDeal(dealRef: string): OptionLink[] {
    return this.db
      .query(`SELECT * FROM commitment_option_links WHERE deal_ref = ? ORDER BY request_id`, [
        dealRef,
      ])
      .map((r) => this.row(r) as OptionLink);
  }

  forState(states: readonly LinkRowState[]): OptionLink[] {
    return this.db
      .query(
        `SELECT * FROM commitment_option_links WHERE state IN (${states.map(() => '?').join(', ')})`,
        [...states],
      )
      .map((r) => this.row(r) as OptionLink);
  }

  ask(
    link: { requestId: string; shipperDid: string; dealRef: string; request: OptionRequestBody },
    nowMs: number,
  ): void {
    this.db.execute(
      `INSERT OR IGNORE INTO commitment_option_links
         (request_id, shipper_did, deal_ref, request_json, state, updated_at)
       VALUES (?, ?, ?, ?, 'asked', ?)`,
      [link.requestId, link.shipperDid, link.dealRef, JSON.stringify(link.request), nowMs],
    );
  }

  /** The shipper's option, or its decline, for a request still waiting. */
  settleAsk(requestId: string, option: OptionBody | null, nowMs: number): void {
    this.db.execute(
      `UPDATE commitment_option_links SET state = ?, option_json = ?, updated_at = ?
        WHERE request_id = ? AND state = 'asked'`,
      [
        option === null ? 'declined' : 'held',
        option === null ? null : JSON.stringify(option),
        nowMs,
        requestId,
      ],
    );
  }

  /** The seller's owner cleared offering versions on this option (or the kind is firm). */
  clear(requestId: string, nowMs: number): void {
    this.db.execute(
      `UPDATE commitment_option_links SET cleared_at = ?, updated_at = ?
        WHERE request_id = ? AND state = 'held' AND cleared_at IS NULL`,
      [nowMs, nowMs, requestId],
    );
  }

  /**
   * Take the option up for one order: called inside the caller's transaction
   * that records the buyer's yes, so both links bind in one act (§6 step 5).
   * Only a held, cleared option whose hold has not ended at the seller's
   * time. The same order again (a replayed decision) keeps the first act;
   * another order never takes an option already taken.
   */
  takeUp(requestId: string, orderRef: string, nowMs: number): boolean {
    const link = this.get(requestId);
    if (link === null || link.option === null) return false;
    if (link.orderRef !== null) return link.orderRef === orderRef;
    if (link.state !== 'held' || link.clearedAt === null) return false;
    if (nowMs >= Date.parse(link.option.hold_until)) return false;
    return (
      this.db.run(
        `UPDATE commitment_option_links
            SET state = 'accepted', order_ref = ?, accepted_at = ?, updated_at = ?
          WHERE request_id = ? AND state = 'held' AND order_ref IS NULL`,
        [orderRef, nowMs, nowMs, requestId],
      ) === 1
    );
  }

  sent(requestId: string, nowMs: number): void {
    this.db.execute(`UPDATE commitment_option_links SET last_sent_at = ? WHERE request_id = ?`, [
      nowMs,
      requestId,
    ]);
  }

  /** The shipper's answer: bound, or ended without fault. The first one stands. */
  receipt(requestId: string, answer: OptionAnswer, nowMs: number): void {
    this.db.execute(
      `UPDATE commitment_option_links
          SET answer_json = ?, state = ?, updated_at = ?
        WHERE request_id = ? AND state = 'accepted' AND answer_json IS NULL`,
      [
        JSON.stringify(answer),
        answer.answer === 'admitted' ? 'bound' : 'lapsed_no_fault',
        nowMs,
        requestId,
      ],
    );
  }

  cardRaised(requestId: string): void {
    this.db.execute(`UPDATE commitment_option_links SET card_raised = 1 WHERE request_id = ?`, [
      requestId,
    ]);
  }
}

/**
 * The buyer's onward-sharing grant, as the seller holds it (§6 step 0, §11):
 * which of the buyer's fields may go to which kind of recipient. Only the
 * pincode, and only to shippers, in this build.
 */
export interface OnwardGrant {
  fields: readonly string[];
  recipientRole: string;
}

/**
 * Open smaller deals for one larger deal: one request per known shipper,
 * carrying the buyer's pincode only under the grant. Refused outright when
 * the grant does not allow the pincode to shippers: nothing about the buyer
 * reaches a third party before the buyer agreed. Returns the messages to
 * send, after the requests are stored.
 */
export function askShippers(args: {
  store: SellerOptionStore;
  dealRef: string;
  shippers: readonly string[];
  grant: OnwardGrant | null;
  postalCode: string;
  serviceAt: string;
  crates: number;
  nowMs: number;
}):
  | { ok: true; send: { to: string; body: OptionRequestBody }[] }
  | { ok: false; reason: 'no_grant' | 'no_partner' } {
  if (
    args.grant === null ||
    args.grant.recipientRole !== 'shipper' ||
    !args.grant.fields.includes('postal_code')
  )
    return { ok: false, reason: 'no_grant' };
  if (args.shippers.length === 0) return { ok: false, reason: 'no_partner' };
  // Only a pincode the wire carries; nothing finer, nothing else.
  if (!POSTAL.test(args.postalCode)) return { ok: false, reason: 'no_grant' };
  const send: { to: string; body: OptionRequestBody }[] = [];
  for (const shipper of args.shippers) {
    // One request per shipper per deal, the same on every call.
    const existing = args.store.forDeal(args.dealRef).find((l) => l.shipperDid === shipper);
    if (existing !== undefined) {
      if (existing.state === 'asked') send.push({ to: shipper, body: existing.request });
      continue;
    }
    const request: OptionRequestBody = {
      v: 1,
      kind: 'request',
      request_id: `req-${bytesToHex(randomBytes(8))}`,
      service_at: args.serviceAt,
      crates: args.crates,
      postal_code: args.postalCode,
    };
    args.store.ask(
      { requestId: request.request_id, shipperDid: shipper, dealRef: args.dealRef, request },
      args.nowMs,
    );
    send.push({ to: shipper, body: request });
  }
  return { ok: true, send };
}

/**
 * An option or a decline arriving at the seller: kept only for a request this
 * node made, to that shipper, and only an option that answers the request as
 * asked and fits (§6 step 2). Anything else is dropped.
 */
export function admitOptionAnswer(args: {
  store: SellerOptionStore;
  fromDid: string;
  body: OptionBody | DeclineBody;
  nowMs: number;
}): 'held' | 'declined' | 'refused' {
  const link = args.store.get(args.body.request_id);
  if (link === null || link.shipperDid !== args.fromDid || link.state !== 'asked') return 'refused';
  if (args.body.kind === 'decline') {
    args.store.settleAsk(link.requestId, null, args.nowMs);
    return 'declined';
  }
  const o = args.body;
  if (o.service_at !== link.request.service_at || o.crates !== link.request.crates)
    return 'refused';
  if (optionFits(optionTerms(o)) !== null) return 'refused';
  args.store.settleAsk(link.requestId, o, args.nowMs);
  return 'held';
}

/** A receipt arriving at the seller, for an option it took up from that shipper. */
export function admitReceipt(args: {
  store: SellerOptionStore;
  fromDid: string;
  body: ReceiptBody;
  nowMs: number;
}): OptionLink | null {
  const link = args.store.byOption(args.fromDid, args.body.option_id);
  if (link === null) return null;
  args.store.receipt(
    link.requestId,
    { answer: args.body.answer, atMs: Date.parse(args.body.at) },
    args.nowMs,
  );
  return args.store.get(link.requestId);
}

/**
 * The seller's work on its links, run on a tick and after a restart:
 *
 *   - a request still unanswered is sent again (the caller rechecks that the
 *     shipper is still a known partner the pincode may go to), until it is too
 *     late for any option to fit; then it is closed as declined;
 *   - a link it took up: resend the acceptance until the hold's end plus the
 *     grace, then only ask for status (§6 step 7);
 *   - a link still unknown at the shipper's lead time before the run is due a
 *     card (`cards`); the caller raises it, then marks it raised, so a crash
 *     between the two raises it again rather than never.
 *
 * At most one message per link per `RESEND_EVERY_MS`.
 */
export function optionLinkWork(args: { store: SellerOptionStore; nowMs: number }): {
  send: { to: string; body: OptionRequestBody | AcceptanceBody | StatusQueryBody }[];
  cards: OptionLink[];
} {
  const send: { to: string; body: OptionRequestBody | AcceptanceBody | StatusQueryBody }[] = [];
  const cards: OptionLink[] = [];
  const due = (link: OptionLink): boolean =>
    link.lastSentAt === null || args.nowMs - link.lastSentAt >= RESEND_EVERY_MS;
  for (const link of args.store.forState(['asked'])) {
    // The latest an option could still be issued with room for an offer.
    const lastUseful =
      Date.parse(link.request.service_at) -
      DEPENDENT_TIMINGS.optionGraceMs -
      OPTION_LEAD_MS -
      MIN_HOLD_MS;
    if (args.nowMs >= lastUseful) {
      args.store.settleAsk(link.requestId, null, args.nowMs);
      continue;
    }
    if (!due(link)) continue;
    args.store.sent(link.requestId, args.nowMs);
    send.push({ to: link.shipperDid, body: link.request });
  }
  for (const link of args.store.forState(['accepted'])) {
    if (link.option === null || link.acceptedAt === null) continue;
    const terms = optionTerms(link.option);
    if (
      !link.cardRaised &&
      linkState({ answer: link.answer, option: terms, nowMs: args.nowMs }) ===
        'delivery_unknown_card'
    )
      cards.push(link);
    if (!due(link)) continue;
    const step = acceptanceRetry({
      holdUntilMs: terms.holdUntilMs,
      answered: false,
      nowMs: args.nowMs,
    });
    const body: AcceptanceBody | StatusQueryBody =
      step === 'resend'
        ? {
            v: 1,
            kind: 'acceptance',
            option_id: link.option.option_id,
            accepted_at: iso(link.acceptedAt),
          }
        : { v: 1, kind: 'status_query', option_id: link.option.option_id };
    args.store.sent(link.requestId, args.nowMs);
    send.push({ to: link.shipperDid, body });
  }
  return { send, cards };
}

// ─── Fallbacks applied to orders ──────────────────────────────────────────

export interface OrderFallback {
  buyerDid: string;
  purchaseOrderId: string;
  supplierDid: string;
  quoteId: string;
  alternativeId: string;
  role: 'seller' | 'buyer';
  appliedAt: number;
  noticeSent: boolean;
  /** The order's digest, where known (the seller's rows): the export orders by it. */
  orderDigest: string;
}

/**
 * Orders whose partner run ended without fault after binding: from then on
 * the order stands on its quote's own terms (§6 step 6). Kept on both nodes,
 * keyed by the order (its buyer and id); the seller's row also says whether
 * the buyer has been told.
 */
export class OrderFallbackStore {
  constructor(private readonly db: DatabaseAdapter) {}

  private row(r: Record<string, unknown> | undefined): OrderFallback | null {
    if (r === undefined) return null;
    return {
      buyerDid: String(r.buyer_did),
      purchaseOrderId: String(r.purchase_order_id),
      supplierDid: String(r.supplier_did),
      quoteId: String(r.quote_id),
      alternativeId: String(r.alternative_id),
      role: String(r.role) as 'seller' | 'buyer',
      appliedAt: Number(r.applied_at),
      noticeSent: Number(r.notice_sent) === 1,
      orderDigest: String(r.order_digest ?? ''),
    };
  }

  /** The first record stands. */
  record(f: Omit<OrderFallback, 'noticeSent' | 'orderDigest'> & { orderDigest?: string }): void {
    this.db.execute(
      `INSERT OR IGNORE INTO commitment_order_fallbacks
         (buyer_did, purchase_order_id, supplier_did, quote_id, alternative_id, role, applied_at,
          notice_sent, order_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        f.buyerDid,
        f.purchaseOrderId,
        f.supplierDid,
        f.quoteId,
        f.alternativeId,
        f.role,
        f.appliedAt,
        f.orderDigest ?? '',
      ],
    );
  }

  get(buyerDid: string, purchaseOrderId: string): OrderFallback | null {
    return this.row(
      this.db.query(
        `SELECT * FROM commitment_order_fallbacks WHERE buyer_did = ? AND purchase_order_id = ?`,
        [buyerDid, purchaseOrderId],
      )[0],
    );
  }

  /**
   * Seller rows strictly after a cursor, in the export's own order (the
   * moment, then the order's digest), so a page limit never spends itself on
   * rows the cursor already passed.
   */
  appliedAfter(
    after: { appliedAt: number; orderDigest: string } | null,
    limit: number,
  ): OrderFallback[] {
    return this.db
      .query(
        after === null
          ? `SELECT * FROM commitment_order_fallbacks WHERE role = 'seller'
              ORDER BY applied_at, order_digest LIMIT ?`
          : `SELECT * FROM commitment_order_fallbacks
              WHERE role = 'seller'
                AND (applied_at > ? OR (applied_at = ? AND order_digest > ?))
              ORDER BY applied_at, order_digest LIMIT ?`,
        after === null
          ? [limit]
          : [after.appliedAt, after.appliedAt, after.orderDigest, limit],
      )
      .map((r) => this.row(r) as OrderFallback);
  }

  /** Seller rows whose buyer has not yet been told. */
  untold(): OrderFallback[] {
    return this.db
      .query(`SELECT * FROM commitment_order_fallbacks WHERE role = 'seller' AND notice_sent = 0`)
      .map((r) => this.row(r) as OrderFallback);
  }

  told(buyerDid: string, purchaseOrderId: string): void {
    this.db.execute(
      `UPDATE commitment_order_fallbacks SET notice_sent = 1
        WHERE buyer_did = ? AND purchase_order_id = ?`,
      [buyerDid, purchaseOrderId],
    );
  }
}

/** A partner run's alternative id: fixed by the request, so every revision names it alike. */
export function partnerAlternativeId(requestId: string): string {
  return `partner_${requestId.slice(4, 12)}`;
}

/** The order reference a link keeps: who ordered, and which order. */
export function orderRefOf(buyerDid: string, purchaseOrderId: string): string {
  return `${buyerDid} ${purchaseOrderId}`;
}

export function parseOrderRef(ref: string): { buyerDid: string; purchaseOrderId: string } | null {
  const at = ref.indexOf(' ');
  return at <= 0 ? null : { buyerDid: ref.slice(0, at), purchaseOrderId: ref.slice(at + 1) };
}
