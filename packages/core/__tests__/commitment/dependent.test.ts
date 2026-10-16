/**
 * COMMITMENT_KERNEL §6 "How linked deals bind", §15 step 7 — the timing and
 * binding rules for a deal resting on one firm option.
 *
 *   D-01  the worked timeline: hold t0+3d, offer to the buyer ends t0+1d,
 *         admitted or expired at t0+5d, lead time over at t0+6d, day Z fits;
 *   D-02  dates must fit: a day Z one hour too early is refused; a hold over
 *         the 7-day cap, or not after issue, is refused; so is a moment that
 *         is not a whole, safe number, or a negative lead time;
 *   D-03  one act binds both: a yes at the last moment binds the version and
 *         the option; a yes after the hold binds the named second choice, or
 *         lapses; a yes signed after the offer ended lapses;
 *   D-04  the shipper's answer: an acceptance at the end of the grace is
 *         admitted; one moment later arrives after the grace (no fault); the
 *         first stored answer is given to every resend; arrival decides,
 *         since the shipper cannot check a signed time;
 *   D-05  expiry needs no message and never undoes an admitted acceptance;
 *         the seller resends within the grace, then only asks; an unanswered
 *         link becomes a card at the lead time before day Z.
 */

import {
  acceptanceRetry,
  answerAcceptance,
  bindOnYes,
  DEPENDENT_TIMINGS,
  linkState,
  optionFits,
  optionState,
  upperOfferEndsAt,
} from '../../src/commitment/dependent';

const H = 60 * 60 * 1000;
const D = 24 * H;
const t0 = Date.parse('2026-11-02T09:00:00Z');
const option = { issuedAtMs: t0, holdUntilMs: t0 + 3 * D, leadTimeMs: D, serviceAtMs: t0 + 6 * D };

describe('deals resting on one option', () => {
  it('D-01: the worked timeline', () => {
    expect(optionFits(option)).toBeNull();
    const offerEnds = upperOfferEndsAt(option, t0);
    expect(offerEnds).not.toBeNull();
    // Ends a margin before the hold that is longer than the buyer's 24-hour grace.
    expect(option.holdUntilMs - (offerEnds as number)).toBeGreaterThan(
      DEPENDENT_TIMINGS.buyerYesGraceMs,
    );
    expect(optionState({ holdUntilMs: option.holdUntilMs, answer: null, nowMs: t0 + 5 * D })).toBe(
      'open',
    );
    expect(
      optionState({ holdUntilMs: option.holdUntilMs, answer: null, nowMs: t0 + 5 * D + 1 }),
    ).toBe('expired');
  });

  it('D-02: dates must fit', () => {
    expect(optionFits({ ...option, serviceAtMs: t0 + 6 * D - H })).toBe('service_too_soon');
    expect(optionFits({ ...option, holdUntilMs: t0 + 7 * D + 1, serviceAtMs: t0 + 20 * D })).toBe(
      'hold_too_long',
    );
    expect(optionFits({ ...option, holdUntilMs: t0 })).toBe('hold_not_after_issue');
    expect(optionFits({ ...option, leadTimeMs: -D })).toBe('malformed');
    expect(optionFits({ ...option, serviceAtMs: Number.NaN })).toBe('malformed');
    expect(optionFits({ ...option, holdUntilMs: Number.POSITIVE_INFINITY })).toBe('malformed');
    // No room left for an offer to the buyer.
    expect(
      upperOfferEndsAt(option, option.holdUntilMs - DEPENDENT_TIMINGS.buyerYesGraceMs),
    ).toBeNull();
  });

  it('D-03: one act binds both, or neither', () => {
    const offerEndsAtMs = upperOfferEndsAt(option, t0) as number;
    const first = { versionId: 'tue', option };
    const second = { versionId: 'standard' };
    // A yes signed at the last moment, arriving a day later: the hold still runs.
    expect(
      bindOnYes({
        first,
        yesSignedAtMs: offerEndsAtMs,
        offerEndsAtMs,
        nowMs: offerEndsAtMs + DEPENDENT_TIMINGS.buyerYesGraceMs,
      }),
    ).toEqual({ outcome: 'bind', versionId: 'tue', acceptOption: true });
    // The hold has ended when the yes arrives: the named second choice binds.
    expect(
      bindOnYes({ first, second, yesSignedAtMs: t0, offerEndsAtMs, nowMs: option.holdUntilMs }),
    ).toEqual({
      outcome: 'bind',
      versionId: 'standard',
      acceptOption: false,
    });
    expect(
      bindOnYes({ first, yesSignedAtMs: t0, offerEndsAtMs, nowMs: option.holdUntilMs }),
    ).toEqual({
      outcome: 'lapse',
      reason: 'hold_ended',
    });
    expect(
      bindOnYes({
        first,
        second,
        yesSignedAtMs: offerEndsAtMs + 1,
        offerEndsAtMs,
        nowMs: offerEndsAtMs + 2,
      }),
    ).toEqual({
      outcome: 'lapse',
      reason: 'offer_ended',
    });
  });

  it("D-04: the shipper's answer settles delivery, and never changes", () => {
    const graceEnd = option.holdUntilMs + DEPENDENT_TIMINGS.optionGraceMs;
    const admitted = answerAcceptance({
      stored: null,
      holdUntilMs: option.holdUntilMs,
      arrivedAtMs: graceEnd,
    });
    expect(admitted).toEqual({ answer: 'admitted', atMs: graceEnd });
    const late = answerAcceptance({
      stored: null,
      holdUntilMs: option.holdUntilMs,
      arrivedAtMs: graceEnd + 1,
    });
    expect(late.answer).toBe('arrived_after_grace');
    // A resend, even a late one, gets the answer first stored.
    expect(
      answerAcceptance({
        stored: admitted,
        holdUntilMs: option.holdUntilMs,
        arrivedAtMs: graceEnd + D,
      }),
    ).toBe(admitted);
    // Arrival within the grace decides, whatever the signed time says.
    expect(
      answerAcceptance({
        stored: null,
        holdUntilMs: option.holdUntilMs,
        arrivedAtMs: option.holdUntilMs + H,
      }).answer,
    ).toBe('admitted');
  });

  it('D-05: expiry, resends and the unknown link', () => {
    const graceEnd = option.holdUntilMs + DEPENDENT_TIMINGS.optionGraceMs;
    const admitted = { answer: 'admitted' as const, atMs: graceEnd };
    expect(
      optionState({ holdUntilMs: option.holdUntilMs, answer: admitted, nowMs: graceEnd + 10 * D }),
    ).toBe('admitted');
    expect(
      acceptanceRetry({ holdUntilMs: option.holdUntilMs, answered: false, nowMs: graceEnd }),
    ).toBe('resend');
    expect(
      acceptanceRetry({ holdUntilMs: option.holdUntilMs, answered: false, nowMs: graceEnd + 1 }),
    ).toBe('query');
    expect(acceptanceRetry({ holdUntilMs: option.holdUntilMs, answered: true, nowMs: t0 })).toBe(
      'done',
    );
    expect(linkState({ answer: null, option, nowMs: graceEnd - H })).toBe('delivery_unknown');
    expect(linkState({ answer: null, option, nowMs: option.serviceAtMs - option.leadTimeMs })).toBe(
      'delivery_unknown_card',
    );
    expect(linkState({ answer: admitted, option, nowMs: t0 })).toBe('bound');
    expect(
      linkState({
        answer: { answer: 'arrived_after_grace', atMs: graceEnd + 1 },
        option,
        nowMs: t0,
      }),
    ).toBe('lapsed_no_fault');
  });
});
