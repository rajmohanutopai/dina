/**
 * prompt_budget tests.
 */

import {
  PromptBudgetError,
  defaultTokenEstimator,
  packPromptBudget,
  type PromptBudgetInput,
  type PromptSection,
} from '../src/brain/prompt_budget';

function section(overrides: Partial<PromptSection> = {}): PromptSection {
  return { id: 'a', text: 'hello world', ...overrides };
}

describe('defaultTokenEstimator', () => {
  it('empty string → 0', () => {
    expect(defaultTokenEstimator('')).toBe(0);
  });

  it('ceil(chars/4)', () => {
    expect(defaultTokenEstimator('abcd')).toBe(1);
    expect(defaultTokenEstimator('abcde')).toBe(2);
    expect(defaultTokenEstimator('a'.repeat(100))).toBe(25);
  });
});

describe('packPromptBudget — input validation', () => {
  it.each([
    ['zero maxTokens', { maxTokens: 0, sections: [] }],
    ['negative maxTokens', { maxTokens: -1, sections: [] }],
    ['fraction maxTokens', { maxTokens: 1.5, sections: [] }],
    ['negative reserve', { maxTokens: 10, reserveTokens: -1, sections: [] }],
    ['fraction reserve', { maxTokens: 10, reserveTokens: 1.5, sections: [] }],
    ['non-array sections', { maxTokens: 10, sections: 'x' as unknown as PromptSection[] }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      packPromptBudget(bad as unknown as PromptBudgetInput),
    ).toThrow(PromptBudgetError);
  });

  it.each([
    ['null section', [null as unknown as PromptSection]],
    ['missing id', [{ text: 'x' } as unknown as PromptSection]],
    ['empty id', [{ id: '', text: 'x' }]],
    ['non-string text', [{ id: 'a', text: 42 as unknown as string }]],
    ['non-boolean required', [{ id: 'a', text: 'x', required: 1 as unknown as boolean }]],
    ['non-finite priority', [{ id: 'a', text: 'x', priority: Number.POSITIVE_INFINITY }]],
  ] as const)('rejects section — %s', (_l, sections) => {
    expect(() =>
      packPromptBudget({ maxTokens: 10, sections }),
    ).toThrow(/invalid_section/);
  });

  it('duplicate id → duplicate_id', () => {
    expect(() =>
      packPromptBudget({
        maxTokens: 10,
        sections: [section({ id: 'a' }), section({ id: 'a' })],
      }),
    ).toThrow(/duplicate_id/);
  });
});

describe('packPromptBudget — fits entirely', () => {
  it('single section under budget → included, not truncated', () => {
    const r = packPromptBudget({
      maxTokens: 100,
      sections: [section({ id: 'a', text: 'short' })],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.included).toHaveLength(1);
      expect(r.dropped).toEqual([]);
      expect(r.truncated).toBe(false);
    }
  });

  it('empty section list → trivially ok with 0 total', () => {
    const r = packPromptBudget({ maxTokens: 100, sections: [] });
    if (r.ok) {
      expect(r.included).toEqual([]);
      expect(r.totalTokens).toBe(0);
    }
  });

  it('all fit → included preserves input order', () => {
    const sections = [
      section({ id: 'a' }),
      section({ id: 'b' }),
      section({ id: 'c' }),
    ];
    const r = packPromptBudget({ maxTokens: 100, sections });
    if (r.ok) expect(r.included.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('packPromptBudget — truncation', () => {
  it('drops lowest-priority discretionary sections first', () => {
    const r = packPromptBudget({
      maxTokens: 5, // can fit ~20 chars
      sections: [
        section({ id: 'low', text: 'a'.repeat(20), priority: 0 }),
        section({ id: 'high', text: 'b'.repeat(20), priority: 10 }),
      ],
    });
    if (r.ok) {
      expect(r.included.map((s) => s.id)).toEqual(['high']);
      expect(r.dropped.map((s) => s.id)).toEqual(['low']);
      expect(r.truncated).toBe(true);
    }
  });

  it('tied priority → input order wins', () => {
    const r = packPromptBudget({
      maxTokens: 5,
      sections: [
        section({ id: 'first', text: 'a'.repeat(20) }),
        section({ id: 'second', text: 'b'.repeat(20) }),
      ],
    });
    if (r.ok) {
      expect(r.included.map((s) => s.id)).toEqual(['first']);
      expect(r.dropped.map((s) => s.id)).toEqual(['second']);
    }
  });

  it('includes multiple until capacity', () => {
    const r = packPromptBudget({
      maxTokens: 10,
      sections: [
        section({ id: 'a', text: 'a'.repeat(16) }), // 4 tokens
        section({ id: 'b', text: 'b'.repeat(16) }), // 4 tokens
        section({ id: 'c', text: 'c'.repeat(16) }), // 4 tokens — doesn't fit (would total 12)
      ],
    });
    if (r.ok) {
      expect(r.included.map((s) => s.id)).toEqual(['a', 'b']);
      expect(r.totalTokens).toBe(8);
    }
  });

  it('reserveTokens subtracts from effective max', () => {
    const r = packPromptBudget({
      maxTokens: 10,
      reserveTokens: 6,
      sections: [
        section({ id: 'a', text: 'a'.repeat(16) }), // 4 tokens, OK (≤4 remaining)
        section({ id: 'b', text: 'b'.repeat(16) }), // doesn't fit
      ],
    });
    if (r.ok) {
      expect(r.included.map((s) => s.id)).toEqual(['a']);
      expect(r.dropped.map((s) => s.id)).toEqual(['b']);
    }
  });

  it('truncated=false when nothing dropped', () => {
    const r = packPromptBudget({
      maxTokens: 100,
      sections: [section({ id: 'a' })],
    });
    if (r.ok) expect(r.truncated).toBe(false);
  });
});

describe('packPromptBudget — required sections', () => {
  it('required always included, even when larger than discretionary', () => {
    const r = packPromptBudget({
      maxTokens: 10,
      sections: [
        section({ id: 'req', text: 'r'.repeat(16), required: true }), // 4 tokens
        section({ id: 'opt', text: 'o'.repeat(16) }), // 4 tokens
      ],
    });
    if (r.ok) {
      expect(r.included.some((s) => s.id === 'req')).toBe(true);
    }
  });

  it('required overflow alone → over_budget_required', () => {
    const r = packPromptBudget({
      maxTokens: 3,
      sections: [
        section({ id: 'req', text: 'r'.repeat(16), required: true }), // 4 tokens
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('over_budget_required');
      expect(r.requiredTokens).toBe(4);
      expect(r.effectiveMaxTokens).toBe(3);
      expect(r.required).toHaveLength(1);
    }
  });

  it('required uses all budget, discretionary dropped', () => {
    const r = packPromptBudget({
      maxTokens: 5,
      sections: [
        section({ id: 'req', text: 'r'.repeat(16), required: true }), // 4
        section({ id: 'opt', text: 'o'.repeat(16) }), // 4 — doesn't fit after req
      ],
    });
    if (r.ok) {
      expect(r.included.map((s) => s.id)).toEqual(['req']);
      expect(r.dropped.map((s) => s.id)).toEqual(['opt']);
    }
  });
});

describe('packPromptBudget — output shape', () => {
  it('included items ordered by original input position', () => {
    const r = packPromptBudget({
      maxTokens: 100,
      sections: [
        section({ id: 'third', text: 't', priority: 1 }),
        section({ id: 'first', text: 'f', priority: 0, required: true }),
        section({ id: 'second', text: 's', priority: 10 }),
      ],
    });
    if (r.ok) {
      expect(r.included.map((s) => s.id)).toEqual(['third', 'first', 'second']);
    }
  });

  it('PackedSection carries tokens + required + priority', () => {
    const r = packPromptBudget({
      maxTokens: 100,
      sections: [
        section({ id: 'a', text: 'abcd', required: true, priority: 2 }),
      ],
    });
    if (r.ok) {
      expect(r.included[0]!.tokens).toBe(1);
      expect(r.included[0]!.required).toBe(true);
      expect(r.included[0]!.priority).toBe(2);
    }
  });

  it('totalTokens equals sum of included tokens', () => {
    const r = packPromptBudget({
      maxTokens: 100,
      sections: [
        section({ id: 'a', text: 'abcd' }), // 1
        section({ id: 'b', text: 'abcdefgh' }), // 2
      ],
    });
    if (r.ok) expect(r.totalTokens).toBe(3);
  });
});

describe('packPromptBudget — custom estimator', () => {
  it('custom estimator drives token count', () => {
    const r = packPromptBudget({
      maxTokens: 5,
      estimator: () => 4, // every section = 4 tokens
      sections: [
        section({ id: 'a', text: 'unused' }),
        section({ id: 'b', text: 'unused' }),
      ],
    });
    if (r.ok) {
      expect(r.included.map((s) => s.id)).toEqual(['a']);
      expect(r.dropped.map((s) => s.id)).toEqual(['b']);
    }
  });
});
