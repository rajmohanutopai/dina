/**
 * REAL_LIFE_FIXES_2 §6.1 — need and exhaustion reach the classifier, "I need
 * someone to talk to" is isolation only when it ends there, and Dina offering
 * herself as company is caught without catching ordinary sentences.
 */

import { isCompanyOffer } from '../../src/guardian/anti_her';
import { classifyDeterministic, mayBeEmotional } from '../../src/guardian/anti_her_classify';
import { removeSentences } from '../../src/guardian/guard_scan';

describe('cues that call the classifier', () => {
  it.each([
    'Been awake all night with the twins and I am drained',
    "I can't sleep and my head won't stop",
    'Could you keep me company for a bit',
    'I am so exhausted after the shift',
  ])('"%s" reaches the classifier', (text) => {
    expect(mayBeEmotional(text)).toBe(true);
  });

  it('a plain task does not', () => {
    expect(mayBeEmotional('What time does the pharmacy open on Sunday?')).toBe(false);
  });
});

describe('"I need someone to talk to"', () => {
  it.each(['I just need someone to talk to.', 'honestly i need somebody to listen tonight', 'I need anyone to talk to right now'])(
    '"%s" is isolation',
    (text) => {
      expect(classifyDeterministic(text).category).toBe('isolation');
    },
  );

  it.each(['I need someone to talk to the bank about the loan', 'I need somebody to talk to my landlord for me'])(
    '"%s" is a task, not isolation',
    (text) => {
      expect(classifyDeterministic(text).category).not.toBe('isolation');
    },
  );
});

describe('Dina offering herself as company', () => {
  it.each([
    "I'm here.",
    "And if the quiet is what you need tonight, I'm here.",
    'Talk to me about the baby, how she sleeps, what she does.',
    'You can talk to me anytime you like.',
    "I'll stay up with you until it gets light.",
    "I'm right here with you.",
    'I can keep you company while you wait.',
  ])('"%s" is an offer', (sentence) => {
    expect(isCompanyOffer(sentence)).toBe(true);
  });

  it.each([
    'When you talk to me, what you say stays on your phone.',
    "I'm here to help you find a plumber: Vinod is listed as yours.",
    'Talk to your sister; she said she is up early.',
    'The bus stop is right here on the map.',
  ])('"%s" is not', (sentence) => {
    expect(isCompanyOffer(sentence)).toBe(false);
  });
});

describe('removing sentences keeps the layout', () => {
  it('drops only the named sentence and keeps paragraphs and lists', () => {
    const text = 'First, call your mum.\n\n- Draft a text\n- Set a reminder\n\nI\'m here. Sleep when you can.';
    expect(removeSentences(text, ["I'm here."])).toBe('First, call your mum.\n\n- Draft a text\n- Set a reminder\n\nSleep when you can.');
  });
});

describe('removing a sentence leaves nested lists alone', () => {
  it('keeps indentation elsewhere', () => {
    const text = 'Steps:\n- Call\n  - mum first\nTalk to me anytime.';
    expect(removeSentences(text, ['Talk to me anytime.'])).toBe('Steps:\n- Call\n  - mum first');
  });
});
