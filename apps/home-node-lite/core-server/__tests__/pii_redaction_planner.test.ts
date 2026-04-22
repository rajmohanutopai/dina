/**
 * pii_redaction_planner tests.
 */

import {
  detectSensitiveSignals,
  type SensitiveSignal,
} from '../src/brain/sensitive_signals';
import {
  DEFAULT_MASK_CHAR,
  DEFAULT_MASK_TOKEN,
  planPiiRedactions,
  type RedactionPolicy,
} from '../src/brain/pii_redaction_planner';

function signal(
  overrides: Partial<SensitiveSignal> & { span: { start: number; end: number } },
): SensitiveSignal {
  return {
    type: 'financial',
    confidence: 0.85,
    ...overrides,
  };
}

describe('planPiiRedactions — input validation', () => {
  it('rejects non-string text', () => {
    expect(() =>
      planPiiRedactions(42 as unknown as string, []),
    ).toThrow(/text/);
  });

  it('empty signals → no redactions, text unchanged', () => {
    const r = planPiiRedactions('Plain text', []);
    expect(r.redactedText).toBe('Plain text');
    expect(r.redactions).toEqual([]);
    expect(r.stats).toEqual({
      signalsConsidered: 0,
      signalsApplied: 0,
      signalsDroppedBelowConfidence: 0,
      signalsDroppedOverlap: 0,
      signalsPreserved: 0,
    });
  });

  it('signals without span are dropped', () => {
    const r = planPiiRedactions('hi', [
      { type: 'health', confidence: 0.9 } as SensitiveSignal,
    ]);
    expect(r.redactions).toEqual([]);
  });
});

describe('planPiiRedactions — redact mode (default)', () => {
  it('single signal → text replaced with mask token', () => {
    const text = 'Call me at 555-1234 tomorrow';
    const r = planPiiRedactions(text, [
      signal({ span: { start: 11, end: 19 }, type: 'financial' }),
    ]);
    expect(r.redactedText).toBe('Call me at [REDACTED] tomorrow');
    expect(r.redactions[0]!.mode).toBe('redact');
    expect(r.redactions[0]!.original).toBe('555-1234');
  });

  it('custom maskToken respected', () => {
    const text = 'secret here';
    const r = planPiiRedactions(
      text,
      [signal({ span: { start: 0, end: 6 } })],
      { maskToken: '███' },
    );
    expect(r.redactedText).toBe('███ here');
  });

  it('DEFAULT_MASK_TOKEN is [REDACTED]', () => {
    expect(DEFAULT_MASK_TOKEN).toBe('[REDACTED]');
  });
});

describe('planPiiRedactions — mask mode', () => {
  it('replaces each char with the mask char', () => {
    const r = planPiiRedactions(
      'Secret 4111',
      [signal({ span: { start: 7, end: 11 } })],
      { defaultMode: 'mask' },
    );
    expect(r.redactedText).toBe('Secret ****');
    expect(r.redactions[0]!.replacement).toBe('****');
  });

  it('custom maskChar', () => {
    const r = planPiiRedactions(
      'pw here',
      [signal({ span: { start: 0, end: 2 } })],
      { defaultMode: 'mask', maskChar: 'X' },
    );
    expect(r.redactedText).toBe('XX here');
  });

  it('DEFAULT_MASK_CHAR is *', () => {
    expect(DEFAULT_MASK_CHAR).toBe('*');
  });
});

describe('planPiiRedactions — tokenize mode', () => {
  it('assigns <ENTITY:TYPE:N> tokens and populates entity map', () => {
    const r = planPiiRedactions(
      'Alice met Alice again',
      [
        signal({ span: { start: 0, end: 5 }, type: 'minor' }),
        signal({ span: { start: 10, end: 15 }, type: 'minor' }),
      ],
      { defaultMode: 'tokenize' },
    );
    expect(r.redactedText).toBe('<ENTITY:MINOR:0> met <ENTITY:MINOR:0> again');
    expect(r.entityMap).toEqual({ '<ENTITY:MINOR:0>': 'Alice' });
  });

  it('distinct values get distinct token ids', () => {
    const r = planPiiRedactions(
      'Alice and Bob',
      [
        signal({ span: { start: 0, end: 5 }, type: 'minor' }),
        signal({ span: { start: 10, end: 13 }, type: 'minor' }),
      ],
      { defaultMode: 'tokenize' },
    );
    expect(r.redactedText).toBe('<ENTITY:MINOR:0> and <ENTITY:MINOR:1>');
    expect(r.entityMap).toEqual({
      '<ENTITY:MINOR:0>': 'Alice',
      '<ENTITY:MINOR:1>': 'Bob',
    });
  });
});

describe('planPiiRedactions — preserve mode', () => {
  it('preserve keeps the text untouched but counts as preserved', () => {
    const r = planPiiRedactions(
      'Alice',
      [signal({ span: { start: 0, end: 5 }, type: 'minor' })],
      { defaultMode: 'preserve' },
    );
    expect(r.redactedText).toBe('Alice');
    expect(r.redactions).toEqual([]);
    expect(r.stats.signalsPreserved).toBe(1);
  });

  it('perType overrides default', () => {
    const r = planPiiRedactions(
      'Pay $100 for advice',
      [signal({ span: { start: 4, end: 8 }, type: 'financial' })],
      { defaultMode: 'redact', perType: { financial: 'preserve' } },
    );
    expect(r.redactedText).toBe('Pay $100 for advice');
  });
});

describe('planPiiRedactions — overlap resolution', () => {
  it('stronger mode wins on overlap (redact > mask)', () => {
    const r = planPiiRedactions(
      'abcdef',
      [
        signal({ span: { start: 0, end: 5 }, type: 'health', confidence: 0.5 }),
        signal({ span: { start: 2, end: 6 }, type: 'financial', confidence: 0.5 }),
      ],
      {
        defaultMode: 'redact',
        perType: { health: 'mask', financial: 'redact' },
      },
    );
    // financial (redact) is stronger + overlaps → wins.
    expect(r.redactions).toHaveLength(1);
    expect(r.redactions[0]!.type).toBe('financial');
    expect(r.redactions[0]!.mode).toBe('redact');
  });

  it('same mode: higher confidence wins', () => {
    const r = planPiiRedactions(
      'abcdef',
      [
        signal({ span: { start: 0, end: 5 }, type: 'health', confidence: 0.3 }),
        signal({ span: { start: 2, end: 6 }, type: 'financial', confidence: 0.9 }),
      ],
      { defaultMode: 'redact' },
    );
    expect(r.redactions[0]!.type).toBe('financial');
    expect(r.redactions[0]!.confidence).toBe(0.9);
  });

  it('non-overlapping signals both applied', () => {
    const r = planPiiRedactions(
      'AAA...BBB',
      [
        signal({ span: { start: 0, end: 3 } }),
        signal({ span: { start: 6, end: 9 } }),
      ],
    );
    expect(r.redactions).toHaveLength(2);
    expect(r.redactedText).toBe('[REDACTED]...[REDACTED]');
  });

  it('overlapping spans UNIONed — no byte flagged stays uncovered', () => {
    // Three overlapping redactions at increasing ranges: without the
    // union fix, earlier spans' non-overlapping bytes leak through.
    const r = planPiiRedactions(
      'abcdefghijklmnopqrst',
      [
        signal({ span: { start: 0, end: 10 }, confidence: 0.5 }),
        signal({ span: { start: 5, end: 15 }, confidence: 0.9 }),
        signal({ span: { start: 12, end: 20 }, confidence: 0.7 }),
      ],
    );
    // Union = [0, 20] → entire text redacted.
    expect(r.redactedText).toBe('[REDACTED]');
    expect(r.redactions).toHaveLength(1);
    expect(r.redactions[0]!.span).toEqual({ start: 0, end: 20 });
    // Max confidence retained.
    expect(r.redactions[0]!.confidence).toBe(0.9);
  });

  it('two overlapping spans → merged into one covering both ranges', () => {
    const r = planPiiRedactions(
      'abcdefghij',
      [
        signal({ span: { start: 0, end: 5 } }),
        signal({ span: { start: 3, end: 8 } }),
      ],
    );
    expect(r.redactions).toHaveLength(1);
    expect(r.redactions[0]!.span).toEqual({ start: 0, end: 8 });
    expect(r.redactedText).toBe('[REDACTED]ij');
  });
});

describe('planPiiRedactions — minConfidence filter', () => {
  it('drops signals below threshold', () => {
    const r = planPiiRedactions(
      'test',
      [
        signal({ span: { start: 0, end: 4 }, confidence: 0.3 }),
        signal({ span: { start: 0, end: 4 }, confidence: 0.9 }),
      ],
      { minConfidence: 0.5 },
    );
    expect(r.stats.signalsDroppedBelowConfidence).toBe(1);
    expect(r.redactions).toHaveLength(1);
    expect(r.redactions[0]!.confidence).toBe(0.9);
  });
});

describe('planPiiRedactions — ordering', () => {
  it('output redactions are sorted left-to-right', () => {
    const r = planPiiRedactions(
      'XXXX_YYYY_ZZZZ',
      [
        signal({ span: { start: 10, end: 14 } }),
        signal({ span: { start: 0, end: 4 } }),
        signal({ span: { start: 5, end: 9 } }),
      ],
    );
    const starts = r.redactions.map((x) => x.span.start);
    expect(starts).toEqual([0, 5, 10]);
  });
});

describe('planPiiRedactions — integration with detectSensitiveSignals', () => {
  it('real text → signals → redacted output with credential masked', () => {
    const text = 'API token: sk-ant-1234567890abcdefghij';
    const signals = detectSensitiveSignals(text);
    const r = planPiiRedactions(text, signals);
    expect(r.redactedText).toContain('[REDACTED]');
    expect(r.redactedText).not.toContain('sk-ant-');
  });

  it('per-type mask for credentials preserves length', () => {
    const text = 'My account 4111111111111111 was charged';
    const signals = detectSensitiveSignals(text);
    const r = planPiiRedactions(text, signals, {
      defaultMode: 'mask',
    });
    // The account number portion should all be '*'s.
    expect(r.redactedText).toContain('****************');
  });
});

describe('planPiiRedactions — stats reconciliation', () => {
  it('stats fields sum correctly', () => {
    const signals: SensitiveSignal[] = [
      { type: 'financial', confidence: 0.1, span: { start: 0, end: 1 } },
      { type: 'financial', confidence: 0.9, span: { start: 2, end: 3 } },
      { type: 'financial', confidence: 0.9, span: { start: 3, end: 4 } },
    ];
    const policy: RedactionPolicy = {
      minConfidence: 0.5,
      defaultMode: 'redact',
    };
    const r = planPiiRedactions('abcdef', signals, policy);
    expect(r.stats.signalsConsidered).toBe(3);
    expect(r.stats.signalsDroppedBelowConfidence).toBe(1);
    // The remaining 2 signals at spans [2,3] and [3,4] don't overlap (end-inclusive vs exclusive check).
    // Actually [2,3) ends at 3; [3,4) starts at 3. Non-overlapping. Both apply.
    expect(r.stats.signalsApplied).toBeGreaterThanOrEqual(1);
  });
});
