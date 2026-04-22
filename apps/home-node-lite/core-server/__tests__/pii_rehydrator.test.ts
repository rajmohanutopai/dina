/**
 * pii_rehydrator tests.
 */

import { planPiiRedactions } from '../src/brain/pii_redaction_planner';
import {
  checkRehydrationCoverage,
  rehydratePii,
} from '../src/brain/pii_rehydrator';

describe('rehydratePii — input validation', () => {
  it('throws on non-string text', () => {
    expect(() =>
      rehydratePii(42 as unknown as string, {}),
    ).toThrow(/text/);
  });

  it.each([
    ['null map', null],
    ['non-object map', 'bogus'],
    ['array map', []],
  ] as const)('throws on %s', (_l, bad) => {
    expect(() =>
      rehydratePii('x', bad as unknown as Record<string, string>),
    ).toThrow(/entityMap/);
  });
});

describe('rehydratePii — basic rehydration', () => {
  it('empty map + plain text → text unchanged + zero stats', () => {
    const r = rehydratePii('hello world', {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe('hello world');
      expect(r.stats).toEqual({ hydrated: 0, leftovers: 0, replacements: {} });
    }
  });

  it('single token replaced when covered by map', () => {
    const r = rehydratePii(
      'Hello <ENTITY:MINOR:0>!',
      { '<ENTITY:MINOR:0>': 'Alice' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe('Hello Alice!');
      expect(r.stats.hydrated).toBe(1);
    }
  });

  it('multiple distinct tokens each replaced', () => {
    const r = rehydratePii(
      '<ENTITY:MINOR:0> met <ENTITY:MINOR:1>',
      {
        '<ENTITY:MINOR:0>': 'Alice',
        '<ENTITY:MINOR:1>': 'Bob',
      },
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.text).toBe('Alice met Bob');
    expect(r.stats.hydrated).toBe(2);
  });

  it('same token appearing multiple times replaced each time', () => {
    const r = rehydratePii(
      '<ENTITY:MINOR:0> and <ENTITY:MINOR:0> again',
      { '<ENTITY:MINOR:0>': 'Alice' },
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.text).toBe('Alice and Alice again');
    expect(r.stats.hydrated).toBe(2);
    expect(r.stats.replacements['<ENTITY:MINOR:0>']).toBe(2);
  });

  it('tokens at boundaries handled', () => {
    const r = rehydratePii(
      '<ENTITY:FINANCIAL:0>',
      { '<ENTITY:FINANCIAL:0>': '$100' },
    );
    if (r.ok) expect(r.text).toBe('$100');
  });
});

describe('rehydratePii — leftovers (lenient mode)', () => {
  it('unknown tokens in text kept in place by default', () => {
    const r = rehydratePii(
      'Hello <ENTITY:MINOR:0> and <ENTITY:HEALTH:3>',
      { '<ENTITY:MINOR:0>': 'Alice' },
    );
    if (!r.ok) throw new Error('expected lenient ok');
    expect(r.text).toBe('Hello Alice and <ENTITY:HEALTH:3>');
    expect(r.stats.hydrated).toBe(1);
    expect(r.stats.leftovers).toBe(1);
  });

  it('counts leftovers separately from replacements', () => {
    const r = rehydratePii(
      '<ENTITY:A:0> <ENTITY:B:0> <ENTITY:A:0>',
      { '<ENTITY:A:0>': 'alpha' },
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.stats.hydrated).toBe(2);
    expect(r.stats.leftovers).toBe(1);
    expect(r.text).toBe('alpha <ENTITY:B:0> alpha');
  });
});

describe('rehydratePii — strict mode', () => {
  it('unknown token → unknown_token outcome', () => {
    const r = rehydratePii(
      'Hello <ENTITY:MINOR:0> and <ENTITY:HEALTH:3>',
      { '<ENTITY:MINOR:0>': 'Alice' },
      { strict: true },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unknown_token');
      expect(r.token).toBe('<ENTITY:HEALTH:3>');
    }
  });

  it('strict mode with full coverage succeeds', () => {
    const r = rehydratePii(
      '<ENTITY:A:0>',
      { '<ENTITY:A:0>': 'alpha' },
      { strict: true },
    );
    expect(r.ok).toBe(true);
  });

  it('stats still populated when strict fails', () => {
    const r = rehydratePii(
      '<ENTITY:A:0> <ENTITY:MISSING:0>',
      { '<ENTITY:A:0>': 'alpha' },
      { strict: true },
    );
    expect(r.stats.hydrated).toBe(1);
    expect(r.stats.leftovers).toBe(1);
  });
});

describe('rehydratePii — token format', () => {
  it('non-matching bracket content is left alone', () => {
    const r = rehydratePii(
      '<ENTITY> <entity:x:0> <ENTITY:X:>',
      { '<ENTITY>': 'Should NOT match' },
    );
    if (r.ok) {
      expect(r.text).toBe('<ENTITY> <entity:x:0> <ENTITY:X:>');
      expect(r.stats.hydrated).toBe(0);
    }
  });

  it('token with multi-char type works', () => {
    const r = rehydratePii(
      '<ENTITY:FINANCIAL:0>',
      { '<ENTITY:FINANCIAL:0>': '$42' },
    );
    if (r.ok) expect(r.text).toBe('$42');
  });

  it('token with underscore-bearing type works', () => {
    const r = rehydratePii(
      '<ENTITY:API_KEY:0>',
      { '<ENTITY:API_KEY:0>': 'sk-secret' },
    );
    if (r.ok) expect(r.text).toBe('sk-secret');
  });
});

describe('rehydratePii — no cross-call state', () => {
  it('fresh invocations start with empty stats', () => {
    const map = { '<ENTITY:A:0>': 'x' };
    const r1 = rehydratePii('<ENTITY:A:0>', map);
    const r2 = rehydratePii('<ENTITY:A:0>', map);
    if (r1.ok && r2.ok) {
      expect(r1.stats.hydrated).toBe(1);
      expect(r2.stats.hydrated).toBe(1);
    }
  });
});

describe('checkRehydrationCoverage', () => {
  it('plain text → allCovered: true + no tokens', () => {
    expect(checkRehydrationCoverage('hello', {})).toEqual({
      allCovered: true,
      leftovers: [],
      tokensSeen: [],
    });
  });

  it('all tokens covered → allCovered true', () => {
    const r = checkRehydrationCoverage(
      '<ENTITY:A:0> and <ENTITY:B:0>',
      { '<ENTITY:A:0>': 'x', '<ENTITY:B:0>': 'y' },
    );
    expect(r.allCovered).toBe(true);
    expect(r.tokensSeen.sort()).toEqual(['<ENTITY:A:0>', '<ENTITY:B:0>']);
  });

  it('missing coverage → leftovers array populated', () => {
    const r = checkRehydrationCoverage(
      '<ENTITY:A:0> and <ENTITY:B:0>',
      { '<ENTITY:A:0>': 'x' },
    );
    expect(r.allCovered).toBe(false);
    expect(r.leftovers).toEqual(['<ENTITY:B:0>']);
  });

  it('duplicate tokens de-duplicated', () => {
    const r = checkRehydrationCoverage(
      '<ENTITY:A:0> <ENTITY:A:0>',
      { '<ENTITY:A:0>': 'x' },
    );
    expect(r.tokensSeen).toEqual(['<ENTITY:A:0>']);
  });
});

describe('rehydratePii — round-trip with pii_redaction_planner', () => {
  it('tokenize → rehydrate recovers the original text', () => {
    const text = 'Met Alice and Bob yesterday. Alice brought snacks.';
    const planned = planPiiRedactions(
      text,
      [
        { type: 'minor', confidence: 0.9, span: { start: 4, end: 9 } },     // "Alice"
        { type: 'minor', confidence: 0.9, span: { start: 14, end: 17 } },   // "Bob"
        { type: 'minor', confidence: 0.9, span: { start: 29, end: 34 } },   // "Alice"
      ],
      { defaultMode: 'tokenize' },
    );
    const rehydrated = rehydratePii(planned.redactedText, planned.entityMap);
    if (!rehydrated.ok) throw new Error('expected ok');
    expect(rehydrated.text).toBe(text);
  });

  it('coverage check confirms round-trip completeness', () => {
    const text = 'Alice';
    const planned = planPiiRedactions(
      text,
      [{ type: 'minor', confidence: 0.9, span: { start: 0, end: 5 } }],
      { defaultMode: 'tokenize' },
    );
    const coverage = checkRehydrationCoverage(planned.redactedText, planned.entityMap);
    expect(coverage.allCovered).toBe(true);
  });
});
