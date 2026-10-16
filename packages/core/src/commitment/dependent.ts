/**
 * Deals that rest on smaller deals (COMMITMENT_KERNEL §6, "How linked deals
 * bind"; §15 step 7) — the timing and binding rules, as pure functions.
 *
 * A version of an offer may rest on ONE option: a firm, signed promise from a
 * third party (the shipper) that holds until a stated time. The rules here
 * make "bound together or not at all" hold across offline nodes:
 *
 *   - DATES FIT: the option's hold, its delivery grace and the shipper's lead
 *     time all end before the day the service is performed; the hold is
 *     within the protocol's 7-day cap.
 *   - THE UPPER OFFER HOLDS FOR LESS: the offer to the buyer ends a margin
 *     before the hold, longer than the buyer's 24-hour yes grace, so a yes
 *     signed in time reaches the seller while the option still holds.
 *   - ONE ACT BINDS BOTH: the buyer's yes and the seller's acceptance of the
 *     option are recorded in one transaction, on the seller's signed time,
 *     before the hold ends; otherwise neither binds, and a second-choice
 *     version named by the buyer binds instead, or the deal lapses.
 *   - THE SHIPPER'S ANSWER SETTLES DELIVERY: an acceptance admitted by the
 *     hold's end plus the grace binds; one arriving later ends the option
 *     without fault; expiry needs no message, and never undoes an admitted
 *     acceptance.
 *
 * PURE: no I/O, no clock.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEPENDENT_TIMINGS = {
  /** The relay's keep: how long a buyer's yes may take to arrive. */
  buyerYesGraceMs: 24 * HOUR_MS,
  /** Twice the relay's keep: the acceptance's resend life, and the option's delivery grace. */
  optionGraceMs: 48 * HOUR_MS,
  /** The protocol's cap on any deadline (`term.ts`). */
  maxHoldMs: 7 * DAY_MS,
} as const;

/** A firm option as the seller holds it: when it was issued, how long it holds. */
export interface OptionTerms {
  issuedAtMs: number;
  holdUntilMs: number;
  /** The shipper's lead time before the service day. */
  leadTimeMs: number;
  /** The day the service is performed (day Z), as a moment. */
  serviceAtMs: number;
}

export type OptionFitRefusal =
  | 'malformed'
  | 'hold_too_long'
  | 'hold_not_after_issue'
  | 'service_too_soon';

/**
 * Does an option's timing fit? The hold must lie after issue and within the
 * 7-day cap, and the hold, the grace and the lead time must all end before
 * the service day, so the shipper knows before then whether it is bound.
 */
export function optionFits(o: OptionTerms): OptionFitRefusal | null {
  // Whole, safe moments and a lead time of zero or more, or nothing is judged.
  const moments = [o.issuedAtMs, o.holdUntilMs, o.serviceAtMs, o.leadTimeMs];
  if (!moments.every((m) => Number.isSafeInteger(m) && m >= 0)) return 'malformed';
  if (o.holdUntilMs <= o.issuedAtMs) return 'hold_not_after_issue';
  if (o.holdUntilMs - o.issuedAtMs > DEPENDENT_TIMINGS.maxHoldMs) return 'hold_too_long';
  if (o.holdUntilMs + DEPENDENT_TIMINGS.optionGraceMs + o.leadTimeMs > o.serviceAtMs)
    return 'service_too_soon';
  return null;
}

/**
 * When the offer to the buyer must end: a margin before the option's hold,
 * longer than the buyer's yes grace — here the yes grace plus one hour — so a
 * yes signed before the offer ends always reaches the seller in time. Null
 * when the hold is too close to leave room for an offer at all.
 */
export function upperOfferEndsAt(o: OptionTerms, nowMs: number): number | null {
  const endsAt = offerEndOf(o);
  return endsAt > nowMs ? endsAt : null;
}

/** The moment the offer to the buyer resting on this option ends, whenever asked. */
export function offerEndOf(o: OptionTerms): number {
  return o.holdUntilMs - DEPENDENT_TIMINGS.buyerYesGraceMs - HOUR_MS;
}

/** A version the buyer may say yes to, and the option it rests on, if any. */
export interface VersionChoice {
  versionId: string;
  /** The option this version rests on; absent: it rests on none. */
  option?: OptionTerms;
}

export type BindOutcome =
  /** Both links bind now: the version, and the acceptance of its option (if any). */
  | { outcome: 'bind'; versionId: string; acceptOption: boolean }
  /** Neither the first nor a second choice can bind: the deal lapses, and the buyer is told. */
  | { outcome: 'lapse'; reason: 'hold_ended' | 'offer_ended' };

/**
 * The buyer's yes reaches the seller (one local transaction): bind the first
 * choice if its option's hold has not ended at the seller's signed time, and
 * the yes was signed before the offer ended; else the second choice the yes
 * named, on the same test; else lapse. A version resting on no option binds
 * whenever the offer was open.
 */
export function bindOnYes(args: {
  first: VersionChoice;
  second?: VersionChoice;
  /** When the buyer signed its yes. */
  yesSignedAtMs: number;
  /** When the offer to the buyer ended. */
  offerEndsAtMs: number;
  /** The seller's signed time, now. */
  nowMs: number;
}): BindOutcome {
  if (args.yesSignedAtMs > args.offerEndsAtMs) return { outcome: 'lapse', reason: 'offer_ended' };
  const fits = (v: VersionChoice): boolean =>
    v.option === undefined || args.nowMs < v.option.holdUntilMs;
  if (fits(args.first))
    return {
      outcome: 'bind',
      versionId: args.first.versionId,
      acceptOption: args.first.option !== undefined,
    };
  if (args.second !== undefined && fits(args.second))
    return {
      outcome: 'bind',
      versionId: args.second.versionId,
      acceptOption: args.second.option !== undefined,
    };
  return { outcome: 'lapse', reason: 'hold_ended' };
}

/** The shipper's one stored answer to an acceptance (step 6). */
export type OptionAnswer =
  | { answer: 'admitted'; atMs: number }
  /** Arrived after the hold's end plus the grace: the option ends without fault. */
  | { answer: 'arrived_after_grace'; atMs: number };

/**
 * The shipper's answer to an acceptance arriving now. The first answer stored
 * is the answer forever: a resend or a query gets the same one. Never an
 * error for the seller to act on twice.
 */
export function answerAcceptance(args: {
  stored: OptionAnswer | null;
  holdUntilMs: number;
  arrivedAtMs: number;
}): OptionAnswer {
  if (args.stored !== null) return args.stored;
  // The shipper cannot check a signed time inside the grace, so arrival
  // decides: in effect the option can be taken up until the hold's end plus
  // the grace, and the shipper prices it so (§6 step 1). The seller's own
  // rule (bindOnYes) is what keeps its acceptance inside the hold.
  return args.arrivedAtMs <= args.holdUntilMs + DEPENDENT_TIMINGS.optionGraceMs
    ? { answer: 'admitted', atMs: args.arrivedAtMs }
    : { answer: 'arrived_after_grace', atMs: args.arrivedAtMs };
}

export type OptionState = 'open' | 'admitted' | 'expired';

/**
 * An option's state on the shipper's node: admitted once an acceptance was
 * admitted (never undone by expiry); expired at the hold's end plus the
 * grace with none admitted (its capacity freed); open before then.
 */
export function optionState(args: {
  holdUntilMs: number;
  answer: OptionAnswer | null;
  nowMs: number;
}): OptionState {
  if (args.answer?.answer === 'admitted') return 'admitted';
  return args.nowMs > args.holdUntilMs + DEPENDENT_TIMINGS.optionGraceMs ? 'expired' : 'open';
}

/**
 * The seller's view of a link it accepted: bound when the shipper admitted
 * it; broken without fault when the shipper says it arrived after the grace
 * (the fallback applies); unknown while no answer has come — and past the
 * lead time before the service day, the seller's owner gets a card.
 */
export function linkState(args: {
  answer: OptionAnswer | null;
  option: OptionTerms;
  nowMs: number;
}): 'bound' | 'lapsed_no_fault' | 'delivery_unknown' | 'delivery_unknown_card' {
  if (args.answer?.answer === 'admitted') return 'bound';
  if (args.answer?.answer === 'arrived_after_grace') return 'lapsed_no_fault';
  return args.nowMs >= args.option.serviceAtMs - args.option.leadTimeMs
    ? 'delivery_unknown_card'
    : 'delivery_unknown';
}

/** Should the seller still resend its acceptance, or only ask for status (step 7)? */
export function acceptanceRetry(args: {
  holdUntilMs: number;
  answered: boolean;
  nowMs: number;
}): 'resend' | 'query' | 'done' {
  if (args.answered) return 'done';
  return args.nowMs <= args.holdUntilMs + DEPENDENT_TIMINGS.optionGraceMs ? 'resend' : 'query';
}
