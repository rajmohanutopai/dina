/**
 * Task 5.34 — EntityVault tests.
 */

import {
  EntityVault,
  tokenise,
  type DetectedEntity,
  type TokeniseOutcome,
} from '../src/brain/entity_vault';

function e(
  type: DetectedEntity['type'],
  start: number,
  end: number,
  value: string,
): DetectedEntity {
  return { type, start, end, value };
}

describe('tokenise (task 5.34)', () => {
  describe('happy path', () => {
    it('replaces a single entity with a type-scoped token', () => {
      const out = tokenise('Hello Alice', [e('PERSON', 6, 11, 'Alice')]);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.result.scrubbedText).toBe('Hello <PERSON_1>');
      expect(out.result.vault.get('<PERSON_1>')).toBe('Alice');
    });

    it('multiple entities of same type get incrementing indices', () => {
      const out = tokenise('Alice met Bob at lunch', [
        e('PERSON', 0, 5, 'Alice'),
        e('PERSON', 10, 13, 'Bob'),
      ]);
      if (!out.ok) throw new Error('expected ok');
      expect(out.result.scrubbedText).toBe(
        '<PERSON_1> met <PERSON_2> at lunch',
      );
      expect(out.result.vault.get('<PERSON_1>')).toBe('Alice');
      expect(out.result.vault.get('<PERSON_2>')).toBe('Bob');
    });

    it('type indices are per-type (PERSON_1 and EMAIL_1 coexist)', () => {
      const out = tokenise('Alice a@b.com', [
        e('PERSON', 0, 5, 'Alice'),
        e('EMAIL', 6, 13, 'a@b.com'),
      ]);
      if (!out.ok) throw new Error('expected ok');
      expect(out.result.scrubbedText).toBe('<PERSON_1> <EMAIL_1>');
    });

    it('repeated occurrences of same value reuse the same token', () => {
      const out = tokenise('Alice said Alice knows Alice', [
        e('PERSON', 0, 5, 'Alice'),
        e('PERSON', 11, 16, 'Alice'),
        e('PERSON', 23, 28, 'Alice'),
      ]);
      if (!out.ok) throw new Error('expected ok');
      expect(out.result.scrubbedText).toBe(
        '<PERSON_1> said <PERSON_1> knows <PERSON_1>',
      );
      expect(out.result.vault.size).toBe(1);
      expect(out.result.counts.PERSON).toBe(1);
    });

    it('mixed types preserve surrounding text exactly', () => {
      const input = '[NOTE] Alice (a@x.com) called +1-555-0100 yesterday';
      const out = tokenise(input, [
        e('PERSON', 7, 12, 'Alice'),
        e('EMAIL', 14, 21, 'a@x.com'),
        e('PHONE', 30, 41, '+1-555-0100'),
      ]);
      if (!out.ok) throw new Error('expected ok');
      expect(out.result.scrubbedText).toBe(
        '[NOTE] <PERSON_1> (<EMAIL_1>) called <PHONE_1> yesterday',
      );
    });

    it('counts reports per-type tally', () => {
      const out = tokenise('Alice Bob a@b.com c@d.com', [
        e('PERSON', 0, 5, 'Alice'),
        e('PERSON', 6, 9, 'Bob'),
        e('EMAIL', 10, 17, 'a@b.com'),
        e('EMAIL', 18, 25, 'c@d.com'),
      ]);
      if (!out.ok) throw new Error('expected ok');
      expect(out.result.counts).toEqual({ PERSON: 2, EMAIL: 2 });
    });

    it('empty entity list returns the original text + empty vault', () => {
      const out = tokenise('unchanged text', []);
      if (!out.ok) throw new Error('expected ok');
      expect(out.result.scrubbedText).toBe('unchanged text');
      expect(out.result.vault.size).toBe(0);
    });

    it('empty text + empty entities works', () => {
      const out = tokenise('', []);
      if (!out.ok) throw new Error('expected ok');
      expect(out.result.scrubbedText).toBe('');
    });

    it('entity at text boundary (start=0 or end=length)', () => {
      const out = tokenise('Alice', [e('PERSON', 0, 5, 'Alice')]);
      if (!out.ok) throw new Error('expected ok');
      expect(out.result.scrubbedText).toBe('<PERSON_1>');
    });

    it('input order irrelevant — sorted by span internally', () => {
      const out = tokenise('Alice met Bob', [
        e('PERSON', 10, 13, 'Bob'),
        e('PERSON', 0, 5, 'Alice'),
      ]);
      if (!out.ok) throw new Error('expected ok');
      // Earliest (Alice at 0) is PERSON_1; Bob at 10 is PERSON_2.
      expect(out.result.scrubbedText).toBe('<PERSON_1> met <PERSON_2>');
    });
  });

  describe('rejections', () => {
    it('overlapping spans → overlapping_spans', () => {
      // Both entity values are real substrings; the spans overlap
      // (0–5 "Alice" overlaps 3–8 "ceBob"). Catches the genuine
      // overlap guard rather than tripping out_of_bounds first.
      const out: TokeniseOutcome = tokenise('AliceBob', [
        e('PERSON', 0, 5, 'Alice'),
        e('PERSON', 3, 8, 'ceBob'),
      ]);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('overlapping_spans');
    });

    it('invalid entity type → invalid_entity_type', () => {
      const out = tokenise('x', [
        { type: 'GARBAGE' as DetectedEntity['type'], start: 0, end: 1, value: 'x' },
      ]);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_entity_type');
    });

    it.each([
      ['start < 0', { type: 'PERSON' as const, start: -1, end: 5, value: 'x' }],
      ['end > textLen', { type: 'PERSON' as const, start: 0, end: 99, value: 'x' }],
      ['start >= end', { type: 'PERSON' as const, start: 5, end: 5, value: '' }],
      ['fractional offset', { type: 'PERSON' as const, start: 0.5, end: 5, value: 'x' }],
    ])('rejects %s with out_of_bounds', (_label, entity) => {
      const out = tokenise('12345', [entity]);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('out_of_bounds');
    });

    it('value mismatch at span → out_of_bounds', () => {
      const out = tokenise('Hello Alice', [e('PERSON', 6, 11, 'Bob')]);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('out_of_bounds');
    });

    it('non-string text → out_of_bounds', () => {
      const out = tokenise(null as unknown as string, []);
      expect(out.ok).toBe(false);
    });
  });
});

describe('EntityVault — rehydrate (task 5.34)', () => {
  describe('round-trip', () => {
    it('rehydrate(scrubbed) === original', () => {
      const input = 'Alice (a@x.com) called +1-555-0100';
      const out = tokenise(input, [
        e('PERSON', 0, 5, 'Alice'),
        e('EMAIL', 7, 14, 'a@x.com'),
        e('PHONE', 23, 34, '+1-555-0100'),
      ]);
      if (!out.ok) throw new Error('expected ok');
      expect(out.result.vault.rehydrate(out.result.scrubbedText)).toBe(input);
    });

    it('rehydrate inside LLM-generated text', () => {
      const out = tokenise('Hello Alice, meet Bob', [
        e('PERSON', 6, 11, 'Alice'),
        e('PERSON', 18, 21, 'Bob'),
      ]);
      if (!out.ok) throw new Error('expected ok');
      const llmOut =
        'Summary: <PERSON_1> should contact <PERSON_2> regarding the meeting.';
      expect(out.result.vault.rehydrate(llmOut)).toBe(
        'Summary: Alice should contact Bob regarding the meeting.',
      );
    });

    it('unknown tokens are left as-is (no crash, no leak)', () => {
      const out = tokenise('Alice', [e('PERSON', 0, 5, 'Alice')]);
      if (!out.ok) throw new Error('expected ok');
      // LLM hallucinated <PERSON_99> — not in vault.
      expect(out.result.vault.rehydrate('Hello <PERSON_99> and <PERSON_1>')).toBe(
        'Hello <PERSON_99> and Alice',
      );
    });

    it('empty input returns empty', () => {
      const vault = new EntityVault();
      expect(vault.rehydrate('')).toBe('');
    });

    it('text without any tokens returns unchanged', () => {
      const vault = new EntityVault();
      expect(vault.rehydrate('nothing to replace')).toBe('nothing to replace');
    });

    it('non-string input returns empty string safely', () => {
      const vault = new EntityVault();
      expect(vault.rehydrate(null as unknown as string)).toBe('');
    });
  });

  describe('vault isolation + security', () => {
    it('concurrent vaults do not cross-contaminate', () => {
      const a = tokenise('Alice', [e('PERSON', 0, 5, 'Alice')]);
      const b = tokenise('Bob', [e('PERSON', 0, 3, 'Bob')]);
      if (!a.ok || !b.ok) throw new Error('expected ok');
      expect(a.result.vault.rehydrate('<PERSON_1>')).toBe('Alice');
      expect(b.result.vault.rehydrate('<PERSON_1>')).toBe('Bob');
    });

    it('JSON.stringify throws — vault refuses serialisation', () => {
      const out = tokenise('Alice', [e('PERSON', 0, 5, 'Alice')]);
      if (!out.ok) throw new Error('expected ok');
      expect(() => JSON.stringify(out.result.vault)).toThrow(
        /refuse to serialise/,
      );
    });

    it('toString redacts values — only counts leak', () => {
      const out = tokenise('Alice a@b.com', [
        e('PERSON', 0, 5, 'Alice'),
        e('EMAIL', 6, 13, 'a@b.com'),
      ]);
      if (!out.ok) throw new Error('expected ok');
      const s = out.result.vault.toString();
      expect(s).toContain('PERSON:1');
      expect(s).toContain('EMAIL:1');
      // Original values MUST NOT appear.
      expect(s).not.toContain('Alice');
      expect(s).not.toContain('a@b.com');
    });

    it('util.inspect hook also produces redacted output', () => {
      const out = tokenise('Alice', [e('PERSON', 0, 5, 'Alice')]);
      if (!out.ok) throw new Error('expected ok');
      const inspectFn = (out.result.vault as unknown as Record<symbol, () => string>)[
        Symbol.for('nodejs.util.inspect.custom')
      ];
      expect(typeof inspectFn).toBe('function');
      const redacted = inspectFn.call(out.result.vault);
      expect(redacted).not.toContain('Alice');
    });
  });

  describe('countsByType', () => {
    it('reports per-type tally by iterating tokens', () => {
      const out = tokenise('Alice Bob a@x.com', [
        e('PERSON', 0, 5, 'Alice'),
        e('PERSON', 6, 9, 'Bob'),
        e('EMAIL', 10, 17, 'a@x.com'),
      ]);
      if (!out.ok) throw new Error('expected ok');
      expect(out.result.vault.countsByType()).toEqual({
        PERSON: 2,
        EMAIL: 1,
      });
    });

    it('returns {} for an empty vault', () => {
      const vault = new EntityVault();
      expect(vault.countsByType()).toEqual({});
    });
  });

  describe('realistic scrub+LLM+rehydrate flow', () => {
    it('works end-to-end over a plausible cloud LLM roundtrip', () => {
      const original =
        'Meeting with Alice (a@x.com) at 3pm. Tell Bob (b@y.com) too.';
      // Compute offsets dynamically so a whitespace tweak doesn't
      // invalidate the test fixture.
      const spans: Array<[string, DetectedEntity['type']]> = [
        ['Alice', 'PERSON'],
        ['a@x.com', 'EMAIL'],
        ['Bob', 'PERSON'],
        ['b@y.com', 'EMAIL'],
      ];
      const entities: DetectedEntity[] = [];
      let cursor = 0;
      for (const [value, type] of spans) {
        const start = original.indexOf(value, cursor);
        entities.push(e(type, start, start + value.length, value));
        cursor = start + value.length;
      }
      const out = tokenise(original, entities);
      if (!out.ok) throw new Error('expected ok');
      expect(out.result.scrubbedText).toBe(
        'Meeting with <PERSON_1> (<EMAIL_1>) at 3pm. Tell <PERSON_2> (<EMAIL_2>) too.',
      );
      // Cloud LLM echoes + restructures — references persist.
      const llmResponse =
        'Action items:\n- Confirm with <PERSON_1> at <EMAIL_1>\n- Loop in <PERSON_2> (<EMAIL_2>)';
      expect(out.result.vault.rehydrate(llmResponse)).toBe(
        'Action items:\n- Confirm with Alice at a@x.com\n- Loop in Bob (b@y.com)',
      );
    });
  });
});
