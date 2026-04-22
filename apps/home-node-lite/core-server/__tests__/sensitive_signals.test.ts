/**
 * sensitive_signals tests (GAP.md #18 closure).
 */

import {
  buildPatternDetector,
  credentialDetector,
  detectSensitiveSignals,
  financialDetector,
  healthDetector,
  legalDetector,
  locationDetector,
  minorDetector,
  summariseSignals,
  type SensitiveSignal,
  type SensitiveSignalType,
  type SignalDetector,
} from '../src/brain/sensitive_signals';

describe('detectSensitiveSignals — input handling', () => {
  it('returns [] for empty string', () => {
    expect(detectSensitiveSignals('')).toEqual([]);
  });

  it('returns [] for non-string input', () => {
    expect(detectSensitiveSignals(null as unknown as string)).toEqual([]);
    expect(detectSensitiveSignals(42 as unknown as string)).toEqual([]);
  });

  it('returns empty for benign text', () => {
    expect(detectSensitiveSignals('the weather is nice today')).toEqual([]);
  });
});

describe('health detector', () => {
  it('strong signals match with 0.9', () => {
    const signals = healthDetector.detect('Was diagnosed with depression last year.');
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0]!.type).toBe('health');
    expect(signals.some((s) => s.confidence === 0.9)).toBe(true);
  });

  it('medication-suffix match with 0.7', () => {
    const signals = healthDetector.detect('Prescription: metoprolol 50mg and atorvastatin');
    // atorvastatin → statin suffix hit.
    expect(signals.some((s) => s.match === 'atorvastatin' && s.confidence === 0.7)).toBe(true);
  });

  it('catches common 3-char-stem drugs (fluoxetine, losartan, ibuprofen)', () => {
    const signals = healthDetector.detect(
      'Daily fluoxetine; losartan; ibuprofen as needed',
    );
    const matches = new Set(signals.filter((s) => s.confidence === 0.7).map((s) => s.match));
    expect(matches.has('fluoxetine')).toBe(true);
    expect(matches.has('losartan')).toBe(true);
    expect(matches.has('ibuprofen')).toBe(true);
  });

  it('weak context match with 0.5', () => {
    const signals = healthDetector.detect('Visiting the clinic tomorrow for bloodwork.');
    const weak = signals.filter((s) => s.confidence === 0.5);
    expect(weak.length).toBeGreaterThan(0);
  });

  it('span covers the matched range', () => {
    const text = 'I have been diagnosed';
    const signals = healthDetector.detect(text);
    const diag = signals.find((s) => s.match === 'diagnosed');
    expect(diag).toBeDefined();
    expect(text.slice(diag!.span!.start, diag!.span!.end)).toBe('diagnosed');
  });
});

describe('financial detector', () => {
  it('account-number-like digit runs match', () => {
    const signals = financialDetector.detect('Account 4532015112830366 was charged');
    expect(signals.some((s) => s.match === '4532015112830366')).toBe(true);
  });

  it('money amounts match', () => {
    const signals = financialDetector.detect('Paid $1,250.00 yesterday');
    expect(signals.length).toBeGreaterThan(0);
  });

  it('routing/account terms match with 0.9', () => {
    const signals = financialDetector.detect('Please send to the following routing number');
    expect(signals.some((s) => s.confidence === 0.9)).toBe(true);
  });

  it('does not match benign number-less text', () => {
    expect(financialDetector.detect('the cat sat on the mat')).toEqual([]);
  });
});

describe('credential detector', () => {
  it('matches sk- prefixed API keys', () => {
    const signals = credentialDetector.detect('key: sk-ant-1234567890abcdefghij');
    expect(signals.some((s) => s.match!.startsWith('sk-'))).toBe(true);
    expect(signals.find((s) => s.match!.startsWith('sk-'))!.confidence).toBe(0.95);
  });

  it('matches GitHub ghp_ tokens', () => {
    const signals = credentialDetector.detect('token=ghp_abcdefghijklmnopqrstuv');
    expect(signals.some((s) => s.match!.startsWith('ghp_'))).toBe(true);
  });

  it('matches explicit password/secret markers', () => {
    const signals = credentialDetector.detect('password: hunter2secret');
    const explicit = signals.filter((s) => s.confidence === 0.85);
    expect(explicit.length).toBeGreaterThan(0);
  });

  it('matches PEM block header with confidence 1.0', () => {
    const signals = credentialDetector.detect('-----BEGIN RSA PRIVATE KEY-----\nxyz');
    expect(signals.some((s) => s.confidence === 1.0)).toBe(true);
  });

  it('never leaks across separate inputs (regex state reset)', () => {
    // Global regex state could bleed between calls if the detector
    // shared a single RegExp instance — pin with two calls, first
    // exhausting the pattern, second must still match.
    const token = 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaa';
    const first = credentialDetector.detect(token);
    const second = credentialDetector.detect(token);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(first.length);
  });
});

describe('legal detector', () => {
  it('matches privileged/attorney-client markers strongly', () => {
    const signals = legalDetector.detect('Attorney-Client privileged and confidential memo');
    expect(signals.some((s) => s.confidence === 0.85)).toBe(true);
  });

  it('matches lawsuit terms with moderate confidence', () => {
    const signals = legalDetector.detect('The custody hearing is next week');
    expect(signals.length).toBeGreaterThan(0);
  });
});

describe('minor detector (conservative bias)', () => {
  it('matches "my child" family markers', () => {
    const signals = minorDetector.detect('My daughter had a great day');
    const match = signals.find((s) => /my\s+daughter/i.test(s.match!));
    expect(match).toBeDefined();
    expect(match!.confidence).toBe(0.6);
  });

  it('matches school context weakly', () => {
    const signals = minorDetector.detect('Preschool pickup at 3pm');
    expect(signals.some((s) => s.confidence === 0.4)).toBe(true);
  });

  it('does not match adult contexts', () => {
    expect(minorDetector.detect('my colleague joined the call').length).toBe(0);
  });
});

describe('location detector', () => {
  it('matches decimal lat/long pair strongly', () => {
    const signals = locationDetector.detect('Meet at 37.7749,-122.4194');
    expect(signals.length).toBe(1);
    expect(signals[0]!.confidence).toBe(0.9);
  });

  it('matches US street-address shape', () => {
    const signals = locationDetector.detect('Send it to 123 Market Street');
    expect(signals.some((s) => s.match!.includes('Market Street'))).toBe(true);
  });
});

describe('detectSensitiveSignals orchestration', () => {
  it('runs every built-in detector', () => {
    const text =
      'my daughter was diagnosed, account 4111111111111111, sk-mykeyabcdefghij1234567890, Attorney-client memo';
    const signals = detectSensitiveSignals(text);
    const types = new Set(signals.map((s) => s.type));
    expect(types.has('minor')).toBe(true);
    expect(types.has('health')).toBe(true);
    expect(types.has('financial')).toBe(true);
    expect(types.has('credential')).toBe(true);
    expect(types.has('legal')).toBe(true);
  });

  it('disable removes a detector', () => {
    const signals = detectSensitiveSignals('was diagnosed with anxiety', {
      disable: ['health'],
    });
    expect(signals.filter((s) => s.type === 'health')).toEqual([]);
  });

  it('extraDetectors run alongside built-ins', () => {
    const customType = 'health' as SensitiveSignalType; // re-using type to avoid widening
    const custom: SignalDetector = {
      type: customType,
      detect: () => [{ type: customType, confidence: 0.5 }],
    };
    const signals = detectSensitiveSignals('hello', { extraDetectors: [custom] });
    expect(signals.some((s) => s.confidence === 0.5 && s.type === customType)).toBe(true);
  });

  it('minConfidence filters out low-confidence signals', () => {
    const text = 'visiting the clinic, maybe my kid too';
    const all = detectSensitiveSignals(text);
    const highOnly = detectSensitiveSignals(text, { minConfidence: 0.7 });
    expect(highOnly.length).toBeLessThan(all.length);
    expect(highOnly.every((s) => s.confidence >= 0.7)).toBe(true);
  });
});

describe('buildPatternDetector', () => {
  it('composes a detector from regex+confidence pairs', () => {
    const det = buildPatternDetector('location', [[/\bhelloworld\b/g, 0.5]]);
    const out = det('say helloworld please');
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe(0.5);
    expect(out[0]!.match).toBe('helloworld');
  });

  it('span indices are correct for the matched range', () => {
    const det = buildPatternDetector('health', [[/\bfoo\b/g, 0.9]]);
    const text = 'bar foo baz';
    const out = det(text);
    expect(text.slice(out[0]!.span!.start, out[0]!.span!.end)).toBe('foo');
  });

  it('handles non-global patterns with single match', () => {
    const det = buildPatternDetector('health', [[/foo/, 0.5]]);
    const out = det('foo foo foo');
    expect(out).toHaveLength(1);
  });

  it('handles global patterns with many matches', () => {
    const det = buildPatternDetector('health', [[/foo/g, 0.5]]);
    const out = det('foo foo foo');
    expect(out).toHaveLength(3);
  });
});

describe('summariseSignals', () => {
  it('returns zero counts for empty input', () => {
    const s = summariseSignals([]);
    for (const type of ['health', 'financial', 'legal', 'minor', 'credential', 'location'] as const) {
      expect(s[type]).toEqual({ count: 0, maxConfidence: 0 });
    }
  });

  it('counts per-type and keeps max confidence', () => {
    const signals: SensitiveSignal[] = [
      { type: 'health', confidence: 0.5 },
      { type: 'health', confidence: 0.9 },
      { type: 'financial', confidence: 0.7 },
    ];
    const out = summariseSignals(signals);
    expect(out.health).toEqual({ count: 2, maxConfidence: 0.9 });
    expect(out.financial).toEqual({ count: 1, maxConfidence: 0.7 });
    expect(out.legal.count).toBe(0);
  });
});
