/**
 * Trust-score band tests (TN-MOB-002).
 *
 * Boundary cases: every band threshold is `>=` so the threshold value
 * itself maps to the higher band. Tests pin those boundaries so a
 * future "off by ε" refactor that flipped to `>` would break here.
 */

import {
  BAND_HIGH,
  BAND_LOW,
  BAND_MODERATE,
  trustBandFor,
  trustScoreDisplay,
  trustScoreLabel,
} from '../src/index';

describe('trustBandFor (TN-MOB-002)', () => {
  it('classifies high band at and above 0.8', () => {
    expect(trustBandFor(BAND_HIGH)).toBe('high');
    expect(trustBandFor(0.95)).toBe('high');
    expect(trustBandFor(1.0)).toBe('high');
  });

  it('classifies moderate band [0.5, 0.8)', () => {
    expect(trustBandFor(BAND_MODERATE)).toBe('moderate');
    expect(trustBandFor(0.65)).toBe('moderate');
    expect(trustBandFor(0.799)).toBe('moderate');
  });

  it('classifies low band [0.3, 0.5)', () => {
    expect(trustBandFor(BAND_LOW)).toBe('low');
    expect(trustBandFor(0.4)).toBe('low');
    expect(trustBandFor(0.499)).toBe('low');
  });

  it('classifies very-low band [0, 0.3)', () => {
    expect(trustBandFor(0)).toBe('very-low');
    expect(trustBandFor(0.1)).toBe('very-low');
    expect(trustBandFor(0.299)).toBe('very-low');
  });

  it('returns unrated for null / undefined / NaN / Infinity', () => {
    expect(trustBandFor(null)).toBe('unrated');
    expect(trustBandFor(undefined)).toBe('unrated');
    expect(trustBandFor(NaN)).toBe('unrated');
    expect(trustBandFor(Infinity)).toBe('unrated');
  });
});

describe('trustScoreDisplay (TN-MOB-002)', () => {
  it('rounds [0, 1] to integer percentage', () => {
    expect(trustScoreDisplay(0)).toBe(0);
    expect(trustScoreDisplay(1)).toBe(100);
    expect(trustScoreDisplay(0.5)).toBe(50);
    expect(trustScoreDisplay(0.785)).toBe(79);
    expect(trustScoreDisplay(0.784)).toBe(78);
  });

  it('clamps overshoot to [0, 100] (defensive — wire spec is [0, 1])', () => {
    expect(trustScoreDisplay(1.5)).toBe(100);
    expect(trustScoreDisplay(-0.2)).toBe(0);
  });

  it('returns null for null / undefined / NaN / Infinity', () => {
    expect(trustScoreDisplay(null)).toBeNull();
    expect(trustScoreDisplay(undefined)).toBeNull();
    expect(trustScoreDisplay(NaN)).toBeNull();
    expect(trustScoreDisplay(-Infinity)).toBeNull();
  });
});

describe('trustScoreLabel (TN-MOB-002)', () => {
  it('formats valid scores as integer strings', () => {
    expect(trustScoreLabel(0.78)).toBe('78');
    expect(trustScoreLabel(0)).toBe('0');
    expect(trustScoreLabel(1)).toBe('100');
  });

  it('returns em-dash for null / undefined (unrated UX)', () => {
    expect(trustScoreLabel(null)).toBe('—');
    expect(trustScoreLabel(undefined)).toBe('—');
  });

  it('returns em-dash for non-finite numbers', () => {
    expect(trustScoreLabel(NaN)).toBe('—');
    expect(trustScoreLabel(Infinity)).toBe('—');
  });
});
