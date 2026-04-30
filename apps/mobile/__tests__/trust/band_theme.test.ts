/**
 * Pin invariants for the shared trust-band presentation tokens
 * (`src/trust/band_theme.ts`).
 *
 * The `BAND_COLOUR` + `BAND_LABEL` maps are imported by three
 * surfaces — `subject_card_view.tsx`, `app/trust/[subjectId].tsx`,
 * `app/trust/reviewer/[did].tsx` — so structural drift here breaks
 * the score-badge / mini-band rendering everywhere at once. These
 * tests guard:
 *
 *   1. **Total coverage** — every `TrustBand` union value has a non-
 *      empty entry in BOTH maps. A missing band would render `undefined`
 *      as colour or label, which falls through to the platform default
 *      and reads as a transparent badge or empty string.
 *   2. **Key parity** — the two maps share the same key set, so a
 *      caller can use `BAND_COLOUR[band]` and `BAND_LABEL[band]`
 *      without an existence check. If one map adds a band the other
 *      doesn't, the screen renders mismatched data.
 *   3. **Object.freeze enforcement** — both maps are frozen at module
 *      load. A consumer mutating `BAND_COLOUR.high = '#fff'` would
 *      silently corrupt the source of truth across all consumers; the
 *      freeze + this test pin defends against that.
 *   4. **Distinct colour tokens** — every band maps to a different
 *      colour. Two bands sharing a colour is a UX bug (the user can't
 *      tell `low` from `very-low` at a glance) but typeable as valid.
 *   5. **'unrated' label is the em-dash sentinel** — pinned because the
 *      module docstring documents this explicitly: a label like
 *      `'UNRATED'` reads as a verdict ("we rated it: unrated"), but
 *      the actual semantic is *absence* of verdict. The em-dash
 *      composes correctly with `trustScoreLabel(null)` (which also
 *      yields '—'), so a reader sees consistent absence-of-data
 *      everywhere.
 *   6. **Uppercase label convention** — all rated bands render
 *      uppercased ('HIGH', 'MODERATE', 'LOW', 'VERY LOW'). Pinned so
 *      a future copy edit that lowercases ONE band can't slip past
 *      review.
 *
 * Pure data, no React. Runs under plain Jest.
 */

import { BAND_COLOUR, BAND_LABEL } from '../../src/trust/band_theme';
import { trustScoreLabel, type TrustBand } from '../../src/trust/score_helpers';

const ALL_BANDS: readonly TrustBand[] = [
  'high',
  'moderate',
  'low',
  'very-low',
  'unrated',
] as const;

describe('band_theme — total coverage', () => {
  it.each(ALL_BANDS)('BAND_COLOUR has a non-empty entry for "%s"', (band) => {
    const value = BAND_COLOUR[band];
    expect(typeof value).toBe('string');
    expect(value.length).toBeGreaterThan(0);
  });

  it.each(ALL_BANDS)('BAND_LABEL has a non-empty entry for "%s"', (band) => {
    const value = BAND_LABEL[band];
    expect(typeof value).toBe('string');
    expect(value.length).toBeGreaterThan(0);
  });

  it('BAND_COLOUR has exactly the TrustBand keys (no extras, no gaps)', () => {
    expect(Object.keys(BAND_COLOUR).sort()).toEqual([...ALL_BANDS].sort());
  });

  it('BAND_LABEL has exactly the TrustBand keys (no extras, no gaps)', () => {
    expect(Object.keys(BAND_LABEL).sort()).toEqual([...ALL_BANDS].sort());
  });

  it('BAND_COLOUR and BAND_LABEL share identical key sets', () => {
    expect(Object.keys(BAND_COLOUR).sort()).toEqual(
      Object.keys(BAND_LABEL).sort(),
    );
  });
});

describe('band_theme — frozen invariants', () => {
  it('BAND_COLOUR is frozen', () => {
    expect(Object.isFrozen(BAND_COLOUR)).toBe(true);
  });

  it('BAND_LABEL is frozen', () => {
    expect(Object.isFrozen(BAND_LABEL)).toBe(true);
  });

  it('mutating BAND_COLOUR throws (strict mode)', () => {
    expect(() => {
      (BAND_COLOUR as Record<TrustBand, string>).high = '#000000';
    }).toThrow(TypeError);
  });

  it('mutating BAND_LABEL throws (strict mode)', () => {
    expect(() => {
      (BAND_LABEL as Record<TrustBand, string>).high = 'TAMPERED';
    }).toThrow(TypeError);
  });

  it('adding a new key to BAND_COLOUR throws (strict mode)', () => {
    expect(() => {
      (BAND_COLOUR as unknown as Record<string, string>)['novel-band'] = '#fff';
    }).toThrow(TypeError);
  });

  it('adding a new key to BAND_LABEL throws (strict mode)', () => {
    expect(() => {
      (BAND_LABEL as unknown as Record<string, string>)['novel-band'] = 'NEW';
    }).toThrow(TypeError);
  });
});

describe('band_theme — distinct colour tokens', () => {
  it('every band maps to a different colour token', () => {
    const tokens = ALL_BANDS.map((b) => BAND_COLOUR[b]);
    const unique = new Set(tokens);
    expect(unique.size).toBe(ALL_BANDS.length);
  });
});

describe('band_theme — label content', () => {
  it("'unrated' renders as the em-dash sentinel '—'", () => {
    // Load-bearing copy: 'unrated' MUST be the em-dash so callers
    // composing "trust <BAND_LABEL[band]>" produce "trust —" rather
    // than "trust UNRATED" (which reads as a verdict, not as
    // absence-of-verdict). Documented in band_theme.ts docstring.
    expect(BAND_LABEL.unrated).toBe('—');
  });

  it("'unrated' label matches trustScoreLabel(null) — single source of truth for absence", () => {
    // Cross-check that two surfaces — the band-name label
    // (BAND_LABEL.unrated) and the score-number label
    // (trustScoreLabel(null)) — both produce the same em-dash. A
    // future copy edit that diverges these (e.g. BAND_LABEL.unrated
    // becomes 'N/A') would silently render mixed sentinels in the
    // same row: "trust N/A · score —". Pinning the equality keeps
    // them coupled.
    expect(BAND_LABEL.unrated).toBe(trustScoreLabel(null));
  });

  it("rated bands use uppercase convention ('HIGH', 'MODERATE', 'LOW', 'VERY LOW')", () => {
    expect(BAND_LABEL.high).toBe('HIGH');
    expect(BAND_LABEL.moderate).toBe('MODERATE');
    expect(BAND_LABEL.low).toBe('LOW');
    expect(BAND_LABEL['very-low']).toBe('VERY LOW');
  });

  it('rated band labels are non-empty uppercase strings (regression guard)', () => {
    const ratedBands: readonly TrustBand[] = ['high', 'moderate', 'low', 'very-low'];
    for (const band of ratedBands) {
      const label = BAND_LABEL[band];
      expect(label.length).toBeGreaterThan(0);
      expect(label).toBe(label.toUpperCase());
    }
  });
});
