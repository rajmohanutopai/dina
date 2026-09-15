/**
 * §5.D — the words the Trade screen puts on a payment row for the country
 * pack's rail check. Dina-owned copy over Core's state and the schema's enum;
 * every combination has words, and none of them is the runner's text.
 */

import { railCheckLabel, reminderReason } from '../../app/trade';

import type { TradeInboxItemDto } from '@dina/core';

type Check = NonNullable<TradeInboxItemDto['rail_check']>;

describe('railCheckLabel', () => {
  it('names every state, and every answer of an answered check', () => {
    const t = (check: Check): string => railCheckLabel(check);
    expect(t({ state: 'awaiting_owner', task_id: 't' })).toBe('Rail check waiting for your approval in Activity');
    expect(t({ state: 'asked', task_id: 't' })).toBe('Rail check asked — awaiting the runner');
    expect(t({ state: 'answered', task_id: 't', answer: 'settled' })).toBe('Rail says: settled');
    expect(t({ state: 'answered', task_id: 't', answer: 'pending' })).toBe('Rail says: not yet settled');
    expect(t({ state: 'answered', task_id: 't', answer: 'failed' })).toBe('Rail says: payment failed');
    expect(t({ state: 'answered', task_id: 't', answer: 'unknown' })).toBe('Rail could not confirm this payment');
    // An answered check with no answer key reads as unconfirmed, never as settled.
    expect(t({ state: 'answered', task_id: 't' })).toBe('Rail could not confirm this payment');
    expect(t({ state: 'closed', task_id: 't' })).toBe('Rail check did not complete');
  });
});

/**
 * §5.D / TRADE_FIRST §4.5 — a refusal to send a reminder is a FACT the owner
 * can act on, in Dina's words. Every reason names something they can fix.
 */
describe('reminderReason', () => {
  /**
   * Every reason the ROUTE and the HOOK can answer with, so the list cannot
   * drift into wording for codes nothing emits (or silence for codes something
   * does). The route's refusals are `no_derived_due`, `nothing_outstanding`,
   * `no_retained_order` and `unfoldable`; the hook's are `no_channel`,
   * `no_active_pack`, `pack_has_no_reminder`, `no_workflow` and `refused`.
   */
  it.each([
    ['no_channel', 'Trade details'],
    ['no_active_pack', 'country pack'],
    ['pack_has_no_reminder', 'country pack'],
    ['no_derived_due', 'statement'],
    ['nothing_outstanding', 'owe'],
    ['no_retained_order', 'order'],
    ['unfoldable', 'statement'],
    ['no_workflow', 'starting up'],
  ])('turns %s into something the owner can act on', (reason, words) => {
    expect(reminderReason(reason)).toContain(words);
  });

  it('never leaves an unknown reason unexplained', () => {
    const words = reminderReason('some_new_reason');
    expect(words).toContain('some_new_reason');
    expect(words.length).toBeGreaterThan(20);
  });
});
