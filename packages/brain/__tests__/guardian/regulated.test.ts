/** REAL_LIFE_FIXES_2 §6.2 — verdicts and figures need the evidence, not the model's knowledge. */

import { checkRegulated, evidenceFromToolResults } from '../../src/guardian/regulated';

const NOW = Date.UTC(2026, 9, 9, 12); // 9 Oct 2026

describe('verdict words', () => {
  it('a verdict the evidence does not hold is removed, with who decides', () => {
    const out = checkRegulated('Your fasting glucose was 5.9. That is in the normal range.', {
      question: 'Is my fasting glucose okay?',
      evidence: ['fasting glucose 5.9 on 2 October'],
      nowMs: NOW,
      whoDecides: 'Dr Okafor',
    });
    expect(out.text).toBe('Your fasting glucose was 5.9.\n\nFor what this means for you, ask Dr Okafor.');
    expect(out.removed).toBe(1);
  });

  it('a verdict with no number is still removed', () => {
    const out = checkRegulated('Good news: you are no longer pre-diabetic.', { question: 'how is my sugar', evidence: ['HbA1c 5.8 in July'], nowMs: NOW });
    expect(out.removed).toBe(1);
  });

  it("is replaced by the one note that says it, so another person's result is not borrowed", () => {
    const out = checkRegulated('Dr Iyer wrote that you are diabetic.', {
      question: 'what did Dr Iyer say about diabetes?',
      evidence: ['Dr Iyer: your father is diabetic; you are not'],
      nowMs: NOW,
    });
    expect(out.text).toBe('Your notes say: "Dr Iyer: your father is diabetic; you are not"');
    expect(out.quoted).toBe(1);
  });
});

describe('figures', () => {
  it('a trend from stored numbers stays', () => {
    const reply = 'Your HbA1c fell from 6.4 to 5.8, a drop of 0.6.';
    expect(checkRegulated(reply, { question: 'is my HbA1c better?', evidence: ['HbA1c 6.4 in January', 'HbA1c 5.8 in July'], nowMs: NOW }).text).toBe(reply);
  });

  it('a deadline the evidence does not give is removed', () => {
    const out = checkRegulated('File the luggage claim within 21 days. Keep the reference.', {
      question: 'help with my lost luggage claim',
      evidence: ['baggage reference LIS-TP-48213'],
      nowMs: NOW,
    });
    expect(out.text.startsWith('Keep the reference.')).toBe(true);
    expect(out.removed).toBe(1);
  });

  it('days overdue computed from a stored date and today stay', () => {
    const reply = 'The refund is overdue by 4 days.';
    const out = checkRegulated(reply, { question: 'did my refund come?', evidence: ['on 30 September the shop said the refund comes in 5 days'], nowMs: NOW });
    expect(out.text).toBe(reply);
  });

  it('a non-regulated turn is untouched', () => {
    const reply = 'The bus takes 25 minutes and costs ₹40.';
    expect(checkRegulated(reply, { question: 'how long is the bus?', evidence: [], nowMs: NOW }).text).toBe(reply);
  });
});

it('evidence items are the separate string values of tool results', () => {
  expect(evidenceFromToolResults([{ items: [{ body: 'a' }, { body: 'b', n: 3 }] }, 'c'])).toEqual(['a', 'b', 'c']);
});
