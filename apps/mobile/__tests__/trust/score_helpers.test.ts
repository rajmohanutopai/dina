/**
 * Mobile trust score-helper tests (TN-MOB-002 + TN-MOB-003).
 *
 * The protocol-side primitives are exhaustively tested in
 * `@dina/protocol/__tests__/score_bands.test.ts` and
 * `identifier_parser.test.ts`. This file only covers the mobile
 * facade additions: bandDisplayName / bandColorToken /
 * trustDisplayFor + the re-export wiring.
 */

import {
  BAND_HIGH,
  BAND_MODERATE,
  bandColorToken,
  bandDisplayName,
  parseIdentifier,
  trustBandFor,
  trustDisplayFor,
  trustScoreLabel,
  type TrustBand,
} from '../../src/trust/score_helpers';

describe('mobile score_helpers — facade re-exports (TN-MOB-002/003)', () => {
  it('re-exports trustBandFor from protocol', () => {
    expect(trustBandFor(0.85)).toBe('high');
    expect(trustBandFor(null)).toBe('unrated');
  });

  it('re-exports trustScoreLabel from protocol', () => {
    expect(trustScoreLabel(0.78)).toBe('78');
    expect(trustScoreLabel(null)).toBe('—');
  });

  it('re-exports the identifier parser from protocol (TN-MOB-003)', () => {
    expect(parseIdentifier('10.1038/nature12373')?.type).toBe('doi');
    expect(parseIdentifier('B07XJ8C8F5')?.type).toBe('asin');
    expect(parseIdentifier('hello')).toBeNull();
  });

  it('re-exports the band thresholds — pinning numeric values guards drift', () => {
    expect(BAND_HIGH).toBe(0.8);
    expect(BAND_MODERATE).toBe(0.5);
  });
});

describe('bandDisplayName (mobile-specific UX)', () => {
  it('returns capitalised, human-friendly labels for every band', () => {
    const cases: Array<[TrustBand, string]> = [
      ['high', 'High trust'],
      ['moderate', 'Moderate trust'],
      ['low', 'Low trust'],
      ['very-low', 'Very low trust'],
      ['unrated', 'Unrated'],
    ];
    for (const [band, label] of cases) {
      expect(bandDisplayName(band)).toBe(label);
    }
  });
});

describe('bandColorToken (theme-token mapping)', () => {
  it('maps each band to its anti-dark-pattern theme token', () => {
    // Pinning the mapping protects against silent UX regressions
    // (e.g. "low trust" colour shifting from caution → danger and
    // suddenly screaming red at users for a 0.4 score).
    expect(bandColorToken('high')).toBe('success');
    expect(bandColorToken('moderate')).toBe('neutral');
    expect(bandColorToken('low')).toBe('caution');
    expect(bandColorToken('very-low')).toBe('danger');
    expect(bandColorToken('unrated')).toBe('muted');
  });
});

describe('trustDisplayFor — one-shot helper for card render sites', () => {
  it('packages a high-trust score', () => {
    const d = trustDisplayFor(0.92);
    expect(d.score).toBe(92);
    expect(d.label).toBe('92');
    expect(d.band).toBe('high');
    expect(d.bandName).toBe('High trust');
    expect(d.colorToken).toBe('success');
  });

  it('packages a moderate-trust score', () => {
    const d = trustDisplayFor(0.6);
    expect(d.band).toBe('moderate');
    expect(d.colorToken).toBe('neutral');
    expect(d.score).toBe(60);
  });

  it('packages a very-low-trust score with danger token', () => {
    const d = trustDisplayFor(0.05);
    expect(d.band).toBe('very-low');
    expect(d.colorToken).toBe('danger');
    expect(d.score).toBe(5);
  });

  it('packages an unrated score with em-dash + muted token', () => {
    const d = trustDisplayFor(null);
    expect(d.score).toBeNull();
    expect(d.label).toBe('—');
    expect(d.band).toBe('unrated');
    expect(d.bandName).toBe('Unrated');
    expect(d.colorToken).toBe('muted');
  });

  it('clamps overshoot before display (defensive)', () => {
    const d = trustDisplayFor(1.4);
    expect(d.score).toBe(100);
    expect(d.band).toBe('high');
  });

  it('treats undefined the same as unrated', () => {
    const d = trustDisplayFor(undefined);
    expect(d.label).toBe('—');
    expect(d.band).toBe('unrated');
  });
});
