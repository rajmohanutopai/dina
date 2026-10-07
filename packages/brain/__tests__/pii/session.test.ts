/**
 * One call's token table (docs/PII_ARCHITECTURE_V2.md §4).
 */

import { NameMatcher } from '../../src/pii/names';
import { PiiSession } from '../../src/pii/session';

const people = new NameMatcher([
  { group: 1, names: ['Emma Watson', 'Emma', 'Em'] },
  { group: 2, names: ['Sancho'] },
]);

describe('PiiSession', () => {
  it('two different emails in two texts get two tokens, and each restores to its own value', () => {
    // The old router scrubbed each message on its own and both became [EMAIL_1].
    const s = new PiiSession();
    const a = s.scrub('write to alice@example.com');
    const b = s.scrub('and to bob@example.org');
    expect(a).toBe('write to [EMAIL_1]');
    expect(b).toBe('and to [EMAIL_2]');
    expect(s.rehydrate('[EMAIL_2] then [EMAIL_1]')).toBe('bob@example.org then alice@example.com');
  });

  it('the same value keeps one token across texts', () => {
    const s = new PiiSession();
    expect(s.scrub('alice@example.com')).toBe('[EMAIL_1]');
    expect(s.scrub('again alice@example.com')).toBe('again [EMAIL_1]');
    expect(s.size).toBe(1);
  });

  it('known names become PERSON tokens; one person keeps one number across forms', () => {
    const s = new PiiSession(people);
    expect(s.scrub('Emma Watson called. Emma said Sancho is late, and em agreed.')).toBe(
      '[PERSON_1] called. [PERSON_1_2] said [PERSON_2] is late, and [PERSON_1_3] agreed.',
    );
    // Each form restores exactly as written, lower case included.
    expect(s.rehydrate('[PERSON_1_3] and [PERSON_1_2] and [PERSON_1]')).toBe(
      'em and Emma and Emma Watson',
    );
  });

  it('a possessive keeps its ending outside the token', () => {
    const s = new PiiSession(people);
    expect(s.scrub("Emma's birthday")).toBe("[PERSON_1]'s birthday");
  });

  it('a longer pattern span wins over a name inside it', () => {
    const s = new PiiSession(people);
    expect(s.scrub('mail emma@example.com')).toBe('mail [EMAIL_1]');
  });

  it('restores longest tokens first, so [PERSON_1_2] and [PERSON_11] are never cut short', () => {
    const many = new NameMatcher(
      Array.from({ length: 11 }, (_, i) => ({
        group: i + 1,
        names: [`Name${String.fromCharCode(65 + i)}x`],
      })),
    );
    const s = new PiiSession(many);
    const text = Array.from({ length: 11 }, (_, i) => `Name${String.fromCharCode(65 + i)}x`).join(
      ' ',
    );
    const scrubbed = s.scrub(text);
    expect(scrubbed).toContain('[PERSON_11]');
    expect(s.rehydrate(scrubbed)).toBe(text);
  });

  it('a bare token the model wrote without brackets is restored when it stands alone', () => {
    const s = new PiiSession(people);
    s.scrub('Sancho and alice@example.com');
    expect(s.rehydrate('Ask PERSON_1 to email EMAIL_1.')).toBe(
      'Ask Sancho to email alice@example.com.',
    );
    // Not inside a longer word or token.
    expect(s.rehydrate('XPERSON_1 PERSON_1_9 PERSON_10')).toBe('XPERSON_1 PERSON_1_9 PERSON_10');
  });

  it('text that already holds tokens is not scrubbed inside them, and their numbers are never reused', () => {
    const s = new PiiSession(new NameMatcher([{ group: 1, names: ['Person'] }]));
    expect(s.scrub('[PERSON_1] met Person at [EMAIL_3]')).toBe(
      '[PERSON_1] met [PERSON_2] at [EMAIL_3]',
    );
    // The token we did not mint is left as it is on the way back.
    expect(s.rehydrate('[PERSON_1] and [PERSON_2]')).toBe('[PERSON_1] and Person');
    // Only the numbers in use are skipped: EMAIL_3 is taken, EMAIL_1 is free.
    expect(s.scrub('x@example.com')).toBe('[EMAIL_1]');
    expect(s.scrub('y@example.com')).toBe('[EMAIL_2]');
    expect(s.scrub('z@example.com')).toBe('[EMAIL_4]');
  });

  it('scrubs and restores every string inside tool arguments', () => {
    const s = new PiiSession(people);
    const args = s.scrubDeep({ to: 'alice@example.com', notes: ['Sancho'], n: 3 });
    expect(args).toEqual({ to: '[EMAIL_1]', notes: ['[PERSON_1]'], n: 3 });
    expect(s.rehydrateDeep({ query: '[PERSON_1] birthday', list: ['[EMAIL_1]'] })).toEqual({
      query: 'Sancho birthday',
      list: ['alice@example.com'],
    });
  });

  it('dates and amounts are left alone', () => {
    const s = new PiiSession(people);
    expect(s.scrub('Pay $40 on 12 May 2026 at 3pm')).toBe('Pay $40 on 12 May 2026 at 3pm');
  });

  it('clear forgets every value', () => {
    const s = new PiiSession(people);
    s.scrub('Sancho');
    s.clear();
    expect(s.size).toBe(0);
    expect(s.rehydrate('[PERSON_1]')).toBe('[PERSON_1]');
  });
});

describe('dual review round 1', () => {
  it('F2: a literal token in a later text never comes back as an earlier value, when set aside first', () => {
    const s = new PiiSession();
    s.reserve(['write to a@x.com', 'what does [EMAIL_1] mean?']);
    expect(s.scrub('write to a@x.com')).toBe('write to [EMAIL_2]');
    expect(s.scrub('what does [EMAIL_1] mean?')).toBe('what does [EMAIL_1] mean?');
    expect(s.rehydrate('[EMAIL_1] vs [EMAIL_2]')).toBe('[EMAIL_1] vs a@x.com');
  });

  it("F2: a person's other form never takes a suffix already in the text", () => {
    // The path Codex reproduced: Emma is scrubbed first, then a later text holds
    // a literal [PERSON_1_2] (not ours) next to another form of Emma.
    const s = new PiiSession(new NameMatcher([{ group: 1, names: ['Emma', 'Em'] }]));
    expect(s.scrub('Emma')).toBe('[PERSON_1]');
    expect(s.scrub('[PERSON_1_2] Em')).toBe('[PERSON_1_2] [PERSON_1_3]');
    expect(s.rehydrate('[PERSON_1_2] [PERSON_1_3] [PERSON_1]')).toBe('[PERSON_1_2] Em Emma');
  });

  it('F2: a number used by a token set aside up front (alias forms too) is skipped', () => {
    const s = new PiiSession(
      new NameMatcher([
        { group: 1, names: ['Emma'] },
        { group: 2, names: ['Sancho'] },
      ]),
    );
    s.reserve(['[PERSON_1_2] is not ours']);
    expect(s.scrub('Emma and Sancho')).toBe('[PERSON_2] and [PERSON_3]');
  });

  it('R2-2: a huge number in the text never pushes counters past exact integers', () => {
    const s = new PiiSession();
    s.reserve(['see [EMAIL_9007199254740991]']);
    expect(s.scrub('a@example.com and b@example.com')).toBe('[EMAIL_1] and [EMAIL_2]');
    expect(s.rehydrate('[EMAIL_1] [EMAIL_2] [EMAIL_9007199254740991]')).toBe(
      'a@example.com b@example.com [EMAIL_9007199254740991]',
    );
  });

  it('F4: a restored value that looks like a token is not read again', () => {
    const s = new PiiSession(new NameMatcher([{ group: 1, names: ['Emma'] }]));
    const scrubbed = s.scrub('PERSON_1@example.com Emma');
    expect(scrubbed).toBe('[EMAIL_1] [PERSON_1]');
    expect(s.rehydrate(scrubbed)).toBe('PERSON_1@example.com Emma');
  });
});
