/**
 * tier_classifier tests (GAP.md #26 closure).
 */

import type { SensitiveSignal } from '../src/brain/sensitive_signals';
import {
  DEFAULT_TIER_RULES,
  classifyTier,
  dominantTierForSignalType,
  strictestTier,
  tierAtLeast,
  tierFromSignals,
  type Tier,
  type TierClassification,
  type TierRule,
} from '../src/brain/tier_classifier';

function signal(
  type: SensitiveSignal['type'],
  confidence: number,
): SensitiveSignal {
  return { type, confidence };
}

describe('tierFromSignals (pure)', () => {
  it('empty → general with no-signals rationale', () => {
    const r = tierFromSignals([]);
    expect(r.tier).toBe('general');
    expect(r.rationale).toBe('no-signals-above-threshold');
    expect(r.signals).toEqual([]);
  });

  it.each([
    ['credential high-conf', [signal('credential', 0.95)], 'local_only', 'credential'],
    ['credential low-conf stays elevated', [signal('credential', 0.6)], 'elevated', 'moderate-signal'],
    ['health strong → sensitive', [signal('health', 0.9)], 'sensitive', 'high-confidence-protected-category'],
    ['financial strong → sensitive', [signal('financial', 0.85)], 'sensitive', 'high-confidence-protected-category'],
    ['minor strong → sensitive', [signal('minor', 0.8)], 'sensitive', 'minor-or-legal'],
    ['legal strong → sensitive', [signal('legal', 0.85)], 'sensitive', 'minor-or-legal'],
    ['location 0.7 → elevated', [signal('location', 0.7)], 'elevated', 'moderate-signal'],
    ['only weak (0.4) → general', [signal('health', 0.4)], 'general', 'no-signals-above-threshold'],
  ] as const)('%s', (_label, signals, tier, rationale) => {
    const r = tierFromSignals(signals);
    expect(r.tier).toBe(tier);
    expect(r.rationale).toBe(rationale);
  });

  it('highest-tier rule wins when multiple fire', () => {
    const r = tierFromSignals([
      signal('health', 0.5),     // moderate → elevated
      signal('credential', 0.95), // strong → local_only (stricter)
    ]);
    expect(r.tier).toBe('local_only');
  });

  it('accepts a caller-supplied rule set', () => {
    const customRules: TierRule[] = [
      {
        tier: 'sensitive',
        name: 'any-location',
        match: (sigs) => sigs.some((s) => s.type === 'location'),
      },
    ];
    const r = tierFromSignals(
      [signal('location', 0.1)],
      customRules,
    );
    expect(r.tier).toBe('sensitive');
    expect(r.rationale).toBe('any-location');
  });

  it('preserves the signals array in the outcome (defensive copy)', () => {
    const src = [signal('health', 0.9)];
    const r = tierFromSignals(src);
    expect(r.signals).toEqual(src);
    // Mutating the outcome must not alter the source array.
    r.signals.push(signal('financial', 0.1));
    expect(src).toHaveLength(1);
  });
});

describe('classifyTier (full pipeline)', () => {
  it('benign text → general', () => {
    const r = classifyTier('The weather is nice today.');
    expect(r.tier).toBe('general');
    expect(r.signals).toEqual([]);
  });

  it('credential text → local_only', () => {
    const r = classifyTier('API token: sk-ant-abcdefghij1234567890');
    expect(r.tier).toBe('local_only');
    expect(r.rationale).toBe('credential');
  });

  it('health diagnosis → sensitive', () => {
    const r = classifyTier('I was diagnosed with depression last year.');
    expect(r.tier).toBe('sensitive');
    expect(r.rationale).toBe('high-confidence-protected-category');
  });

  it('financial account number → sensitive', () => {
    const r = classifyTier('My account number 4111111111111111 was charged');
    expect(r.tier).toBe('sensitive');
  });

  it('bare location coord → elevated (location tops out at 0.9 but not in sensitive rule)', () => {
    const r = classifyTier('At 37.7749,-122.4194 now');
    expect(r.tier).toBe('elevated');
  });

  it('minor + health mix → sensitive (stricter wins)', () => {
    const r = classifyTier('My daughter was diagnosed with anxiety');
    expect(r.tier).toBe('sensitive');
  });

  it('disable detector propagates from opts', () => {
    const text = 'Account 4111111111111111';
    const withFinancial = classifyTier(text);
    const withoutFinancial = classifyTier(text, { disable: ['financial'] });
    expect(withFinancial.tier).toBe('sensitive');
    expect(withoutFinancial.tier).toBe('general');
  });

  it('custom rules override defaults', () => {
    const customRules: TierRule[] = [
      {
        tier: 'local_only',
        name: 'always-max',
        match: () => true,
      },
    ];
    const r = classifyTier('benign', { rules: customRules });
    expect(r.tier).toBe('local_only');
  });
});

describe('strictestTier', () => {
  it.each([
    ['general', 'elevated', 'elevated'],
    ['elevated', 'sensitive', 'sensitive'],
    ['sensitive', 'local_only', 'local_only'],
    ['local_only', 'general', 'local_only'],
    ['general', 'general', 'general'],
  ] as const)('strictestTier(%s, %s) = %s', (a, b, expected) => {
    expect(strictestTier(a as Tier, b as Tier)).toBe(expected);
  });
});

describe('tierAtLeast', () => {
  it('compares correctly across all tiers', () => {
    expect(tierAtLeast('general', 'general')).toBe(true);
    expect(tierAtLeast('general', 'elevated')).toBe(false);
    expect(tierAtLeast('elevated', 'general')).toBe(true);
    expect(tierAtLeast('sensitive', 'elevated')).toBe(true);
    expect(tierAtLeast('local_only', 'sensitive')).toBe(true);
    expect(tierAtLeast('sensitive', 'local_only')).toBe(false);
  });
});

describe('dominantTierForSignalType', () => {
  it('credential → local_only', () => {
    expect(dominantTierForSignalType('credential')).toBe('local_only');
  });
  it('health → sensitive', () => {
    expect(dominantTierForSignalType('health')).toBe('sensitive');
  });
  it('financial → sensitive', () => {
    expect(dominantTierForSignalType('financial')).toBe('sensitive');
  });
  it('legal → sensitive', () => {
    expect(dominantTierForSignalType('legal')).toBe('sensitive');
  });
  it('minor → sensitive', () => {
    expect(dominantTierForSignalType('minor')).toBe('sensitive');
  });
  it('location → elevated (never reaches sensitive in default rules)', () => {
    expect(dominantTierForSignalType('location')).toBe('elevated');
  });
});

describe('DEFAULT_TIER_RULES integrity', () => {
  it('every rule has a name + match function + valid tier', () => {
    for (const rule of DEFAULT_TIER_RULES) {
      expect(typeof rule.name).toBe('string');
      expect(rule.name.length).toBeGreaterThan(0);
      expect(typeof rule.match).toBe('function');
      expect(['general', 'elevated', 'sensitive', 'local_only']).toContain(rule.tier);
    }
  });

  it('rule names are unique', () => {
    const names = DEFAULT_TIER_RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('TierClassification type surface', () => {
  it('outcome always has tier + rationale + signals', () => {
    const r: TierClassification = classifyTier('some text');
    expect(r.tier).toBeDefined();
    expect(r.rationale).toBeDefined();
    expect(Array.isArray(r.signals)).toBe(true);
  });
});
