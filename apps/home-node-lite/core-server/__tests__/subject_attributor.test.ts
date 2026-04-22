/**
 * subject_attributor tests (GAP.md #23 closure).
 */

import {
  DEFAULT_MARGIN_REQUIRED,
  attributeSubject,
  type Contact,
} from '../src/brain/subject_attributor';

const alice: Contact = { id: 'c-alice', fullName: 'Alice Smith' };
const bob: Contact = { id: 'c-bob', fullName: 'Bob Jones', aliases: ['Bobby'] };
const carol: Contact = { id: 'c-carol', fullName: 'Carol' };

describe('attributeSubject — input handling', () => {
  it('empty string → unknown', () => {
    const r = attributeSubject('');
    expect(r.subject.kind).toBe('unknown');
    expect(r.confidence).toBe(0);
    expect(r.evidence).toEqual([]);
  });

  it('whitespace-only → unknown', () => {
    const r = attributeSubject('   ');
    expect(r.subject.kind).toBe('unknown');
  });

  it('non-string → unknown', () => {
    const r = attributeSubject(null as unknown as string);
    expect(r.subject.kind).toBe('unknown');
  });

  it('no contacts + no pronouns → unknown', () => {
    const r = attributeSubject('The meeting happens tomorrow.');
    expect(r.subject.kind).toBe('unknown');
  });
});

describe('attributeSubject — self-subject', () => {
  it('first-person dominant → self', () => {
    const r = attributeSubject('I have my review tomorrow. I need to prepare.');
    expect(r.subject.kind).toBe('self');
    expect(r.confidence).toBe(1);
    expect(r.evidence.filter((e) => e.kind === 'self_pronoun').length).toBeGreaterThan(0);
  });

  it('single "I" with no competing subject → self', () => {
    const r = attributeSubject('I went home');
    expect(r.subject.kind).toBe('self');
  });

  it('self beats contact when self count clears the margin', () => {
    // self = 4 (I, my, I, my); contact = 2 (Alice Smith full-name).
    // 4 >= 2 * 1.5 = 3 → self wins.
    const r = attributeSubject(
      'I have my meeting with Alice Smith. I will finalise my slides.',
      { contacts: [alice] },
    );
    expect(r.subject.kind).toBe('self');
  });
});

describe('attributeSubject — group-subject', () => {
  it('plural first-person → group', () => {
    const r = attributeSubject('We should meet. Our plan needs review.');
    expect(r.subject.kind).toBe('group');
    expect(r.confidence).toBe(1);
  });

  it('self + group balanced → unknown by margin', () => {
    // self=2 (I, I); group=2 (We, Our). 2 < 2 * 1.5 → unknown.
    const r = attributeSubject(
      'I will check. We need to decide. Our plan matters. I follow up.',
    );
    expect(r.subject.kind).toBe('unknown');
  });
});

describe('attributeSubject — contact-subject', () => {
  it('full name match attributes to the contact', () => {
    const r = attributeSubject("Alice Smith's birthday is tomorrow", {
      contacts: [alice],
    });
    expect(r.subject.kind).toBe('contact');
    if (r.subject.kind === 'contact') {
      expect(r.subject.contactId).toBe('c-alice');
    }
  });

  it('weighting: full name (2.0) beats single-token pronouns (1.0)', () => {
    const r = attributeSubject(
      "Alice Smith is coming. I will be there.",
      { contacts: [alice] },
    );
    // contact = 2.0 (fullname), self = 1.0 (I). Margin = 2.0 / 1.0 = 2.0 >= 1.5 → winner.
    expect(r.subject.kind).toBe('contact');
  });

  it('alias matches as single-token with weight 1.0', () => {
    const r = attributeSubject('Bobby sent the email', { contacts: [bob] });
    expect(r.subject.kind).toBe('contact');
    expect(r.evidence.filter((e) => e.match === 'Bobby').length).toBe(1);
  });

  it('first-token of fullName auto-matches as single-token', () => {
    const r = attributeSubject('Carol called at 3pm', { contacts: [carol] });
    expect(r.subject.kind).toBe('contact');
  });

  it('requireFullName disables single-token matches', () => {
    const r = attributeSubject('Alice called me', {
      contacts: [alice],
      requireFullName: true,
    });
    // Only "Alice" appears — full name "Alice Smith" doesn't match.
    // Self pronoun "me" scores 1. No contact signal. Winner = self.
    expect(r.subject.kind).toBe('self');
  });

  it('fullName match does not double-count the first-token overlap', () => {
    const r = attributeSubject('Alice Smith filed the report', {
      contacts: [alice],
    });
    const aliceEvidence = r.evidence.filter((e) => e.contactId === 'c-alice');
    // Should be 1 entry (full name) — NOT 2 (fullname + first-token overlap).
    expect(aliceEvidence).toHaveLength(1);
    expect(aliceEvidence[0]!.match).toBe('Alice Smith');
  });

  it('multiple contacts: higher-scoring one wins', () => {
    const r = attributeSubject(
      "Alice Smith and Alice met. Bob sent one email.",
      { contacts: [alice, bob] },
    );
    expect(r.subject.kind).toBe('contact');
    if (r.subject.kind === 'contact') {
      expect(r.subject.contactId).toBe('c-alice');
    }
  });

  it('contact name is case-insensitive', () => {
    const r = attributeSubject('ALICE SMITH was here', { contacts: [alice] });
    expect(r.subject.kind).toBe('contact');
  });

  it('name does not match inside a larger word', () => {
    // "Carol" inside "Caroline" must NOT match.
    const r = attributeSubject('Caroline sent the file', { contacts: [carol] });
    expect(r.subject.kind).toBe('unknown');
  });
});

describe('attributeSubject — margin + unknown', () => {
  it('below margin returns unknown', () => {
    // self=1, group=1. Margin 1.5 → neither wins.
    const r = attributeSubject('I think we should');
    expect(r.subject.kind).toBe('unknown');
  });

  it('marginRequired option tightens the margin', () => {
    // self=2, contact=1. Default margin would pick self.
    // marginRequired=3 raises the bar — 2 < 1 × 3 → unknown.
    const r = attributeSubject('I told Alice Smith about it once', {
      contacts: [alice],
      marginRequired: 3,
    });
    expect(r.subject.kind).toBe('unknown');
  });

  it('marginRequired option loosens the margin', () => {
    // self=1, contact=1 via Alice single-token.
    // Default margin 1.5 → unknown. marginRequired=1 → winner by alpha (contact first in scores? actually the map order).
    // The test: when margin is LOWER (1.0), a 1:1 tie also doesn't win because winner < runner * 1 is "< or =" — equal-score case, winner ISN'T strictly greater, but our code says < runner * margin, so 1 < 1 is false, we DO pick the winner.
    const r = attributeSubject('I told Alice once', {
      contacts: [alice],
      marginRequired: 1,
    });
    expect(['self', 'contact']).toContain(r.subject.kind);
    // Whichever side won, confidence should be 0.5 for a 1:1 split.
    expect(r.confidence).toBeCloseTo(0.5, 5);
  });
});

describe('attributeSubject — evidence', () => {
  it('evidence is ordered by document position', () => {
    const r = attributeSubject('Alice met I talked to Bob Jones.', {
      contacts: [alice, bob],
    });
    const positions = r.evidence.map((e) => e.span.start);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it('evidence spans match the original text', () => {
    const text = 'Alice called me';
    const r = attributeSubject(text, { contacts: [alice] });
    for (const e of r.evidence) {
      expect(text.slice(e.span.start, e.span.end)).toBe(e.match);
    }
  });

  it('every evidence entry has non-zero weight', () => {
    const r = attributeSubject('I met Alice', { contacts: [alice] });
    for (const e of r.evidence) expect(e.weight).toBeGreaterThan(0);
  });
});

describe('attributeSubject — contact validation', () => {
  it('rejects empty contact id', () => {
    expect(() =>
      attributeSubject('anything', {
        contacts: [{ id: '', fullName: 'Nobody' } as Contact],
      }),
    ).toThrow(/Contact\.id/);
  });

  it('rejects empty fullName', () => {
    expect(() =>
      attributeSubject('anything', {
        contacts: [{ id: 'x', fullName: '   ' } as Contact],
      }),
    ).toThrow(/fullName/);
  });
});

describe('constants', () => {
  it('DEFAULT_MARGIN_REQUIRED = 1.5', () => {
    expect(DEFAULT_MARGIN_REQUIRED).toBe(1.5);
  });
});
