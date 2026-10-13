/**
 * REAL_LIFE_FIXES_2 §3 — a claimed action is rewritten from its receipt, or
 * replaced when nothing backs it. Inputs differ from the scenario suite.
 */

import { checkActionClaims, receiptsFromToolCalls, type ActionReceipt } from '../../src/guardian/action_claims';

const sentToPriya: ActionReceipt = { action: 'send', status: 'done', targets: ['Priya'], object: 'Please renew my gym membership' };
const none = { thisTurn: [] as ActionReceipt[], earlier: [] as ActionReceipt[] };

describe('claims with no receipt', () => {
  it.each([
    "I've cancelled your gym membership.",
    'I have deleted the old note about the jacket.',
    "I've paid the electricity bill.",
    'I booked the table for eight.',
  ])('"%s" becomes "I haven\'t done that."', (claim) => {
    const out = checkActionClaims(`Sure. ${claim} Anything else on the list?`, none);
    expect(out.text).toBe("Sure. I haven't done that. Anything else on the list?");
    expect(out.unbacked).toBe(1);
  });
});

describe('claims are rewritten from the receipt, never judged by wording', () => {
  it('a send claim says what was actually sent', () => {
    const out = checkActionClaims("I've sent Priya a request to cancel my gym membership.", { thisTurn: [sentToPriya], earlier: [] });
    expect(out.text).toBe('Sent to Priya: "Please renew my gym membership"');
  });

  it('a claim naming someone no receipt has is unbacked', () => {
    const out = checkActionClaims("I've sent it to Omar.", { thisTurn: [sentToPriya], earlier: [] });
    expect(out.text).toBe("I haven't done that.");
  });

  it('a draft waiting is said to be waiting', () => {
    const waiting: ActionReceipt = { ...sentToPriya, status: 'waiting' };
    const out = checkActionClaims("I've sent Priya the message.", { thisTurn: [waiting], earlier: [] });
    expect(out.text).toBe('Waiting for your OK: a message to Priya: "Please renew my gym membership"');
  });

  it('only the false sentence goes in a mixed turn', () => {
    const saved: ActionReceipt = { action: 'save', status: 'done', targets: ['work'], object: 'standup moved to 9:30' };
    const out = checkActionClaims("I saved that. I've also emailed your manager.", { thisTurn: [saved], earlier: [] });
    expect(out.text).toBe('Saved to Work: "standup moved to 9:30" I haven\'t done that.');
  });
});

describe('earlier receipts back only claims that refer back', () => {
  const earlier = { thisTurn: [] as ActionReceipt[], earlier: [sentToPriya] };
  it.each(["I've already sent it to Priya.", 'I sent it to Priya earlier.'])('"%s" backs onto last turn', (claim) => {
    expect(checkActionClaims(claim, earlier).text).toBe('Already sent to Priya earlier: "Please renew my gym membership"');
  });

  it('a fresh claim with no receipt this turn is unbacked', () => {
    expect(checkActionClaims("I've sent it to Priya.", earlier).text).toBe("I haven't done that.");
  });
});

describe('not claims', () => {
  it.each([
    "I've ordered the list by date.",
    "I haven't sent anything yet.",
    'The draft reads "I\'ve paid you back".',
    'I can send it to Priya if you like.',
  ])('"%s" stands', (text) => {
    expect(checkActionClaims(text, none).text).toBe(text);
  });
});

describe('receipts from tool calls', () => {
  it('reads send, save and reminder results; ignores failures', () => {
    const r = receiptsFromToolCalls([
      { name: 'send_message', arguments: {}, outcome: { success: true, result: { status: 'sent', recipient_name: 'Priya', text: 'hi' } } },
      { name: 'remember', arguments: { words: 'the gate code is 4471' }, outcome: { success: true, result: { status: 'stored', personas: ['general'] } } },
      { name: 'schedule_reminder', arguments: {}, outcome: { success: true, result: { status: 'scheduled', reminders: [{ status: 'scheduled', message: 'Bin day', due_at_ms: 1 }] } } },
      { name: 'send_message', arguments: {}, outcome: { success: false } },
    ]);
    expect(r.map((x) => `${x.action}:${x.status}`)).toEqual(['send:done', 'save:done', 'reminder:done']);
  });
});

describe('stopping a standing reply or a budget (REAL_LIFE_FIXES_2 §14, §15)', () => {
  it('a successful cancel backs "I\'ve cancelled…"; without one it is unbacked', () => {
    const receipts = receiptsFromToolCalls([
      { name: 'standing_reply', arguments: { action: 'cancel', id: 'standing-1' }, outcome: { success: true, result: { revoked: true } } },
    ]);
    const ok = checkActionClaims("I've cancelled your away reply.", { thisTurn: receipts, earlier: [] });
    expect(ok.text).toBe('Stopped: the automatic reply');
    expect(ok.unbacked).toBe(0);
    const none = checkActionClaims("I've cancelled your away reply.", { thisTurn: [], earlier: [] });
    expect(none.unbacked).toBe(1);
    // Paying or booking is never Dina's to do.
    expect(checkActionClaims("I've booked the table.", { thisTurn: receipts, earlier: [] }).unbacked).toBe(1);
  });
});

it('two stops in one turn each back their own claim', () => {
  const receipts = receiptsFromToolCalls([
    { name: 'standing_reply', arguments: { action: 'cancel', id: 's1' }, outcome: { success: true, result: { revoked: true } } },
    { name: 'spend_allowance', arguments: { action: 'cancel', id: 'a1' }, outcome: { success: true, result: { revoked: true } } },
  ]);
  const out = checkActionClaims("I've stopped your away reply. I've also cancelled the shopping agent's budget.", { thisTurn: receipts, earlier: [] });
  expect(out.unbacked).toBe(0);
  expect(out.text).toBe("Stopped: the automatic reply Stopped: the agent's spending budget");
});
