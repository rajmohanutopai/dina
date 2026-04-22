/**
 * PreferenceExtractor tests (PC-BRAIN-12 + PC-TEST-01).
 *
 * Mirrors main-dina's `brain/tests/test_preference_extractor.py`
 * (TST-BRAIN-890..895). Regex-based extractor — no I/O, no LLM.
 * The JavaScript regex adaptation drops Python's scoped inline
 * flags and relies on character classes + the outer /i flag; these
 * tests pin the resulting behaviour so a future refactor can't
 * regress the case-sensitivity anchor on the name group.
 */

import {
  PreferenceExtractor,
  type PreferenceCandidate,
} from '../../src/enrichment/preference_extractor';

function extract(text: string): PreferenceCandidate[] {
  return new PreferenceExtractor().extract(text);
}

// ---------------------------------------------------------------------------
// TST-BRAIN-890..895
// ---------------------------------------------------------------------------

describe('PreferenceExtractor (PC-TEST-01)', () => {
  it('TST-BRAIN-890: direct form — "my <role> <Name>"', () => {
    const out = extract('My dentist Dr Carl is on April 19');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual<PreferenceCandidate>({
      role: 'dentist',
      name: 'Dr Carl',
      categories: ['dental'],
    });
  });

  it('TST-BRAIN-891: is form — "my <role> is <Name>" (dedup collapses overlapping direct)', () => {
    // The `is` form is more specific than the direct form, and both
    // patterns match here. Dedup by (role, lowercased-name) must
    // collapse them into a single candidate — not two.
    const out = extract('my dentist is Dr Carl');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Dr Carl');
    expect(out[0].role).toBe('dentist');
  });

  it('TST-BRAIN-892: multiple roles + case-insensitive role token', () => {
    const out = extract(
      'My mechanic Raj is closed Sunday; my lawyer Kate Jones is good; ' +
        'my physio Aaron helps my knee; my THERAPIST Dr Patel is kind.',
    );
    const byRole = new Map(out.map((c) => [c.role, c]));
    expect(byRole.get('mechanic')).toMatchObject({
      name: 'Raj',
      categories: ['automotive'],
    });
    expect(byRole.get('lawyer')).toMatchObject({
      name: 'Kate Jones',
      categories: ['legal'],
    });
    expect(byRole.get('physio')).toMatchObject({
      name: 'Aaron',
      categories: ['physiotherapy'],
    });
    // Uppercase `THERAPIST` still matches — outer /i flag covers the
    // role alternation.
    expect(byRole.get('therapist')).toMatchObject({
      name: 'Dr Patel',
      categories: ['mental_health'],
    });
  });

  it('TST-BRAIN-893: dedup same (role, name) pair across repeated mentions', () => {
    const out = extract('My dentist Dr Carl was booked. I saw my dentist Dr Carl again on Friday.');
    // Only one candidate despite two direct matches.
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual<PreferenceCandidate>({
      role: 'dentist',
      name: 'Dr Carl',
      categories: ['dental'],
    });
  });

  it('TST-BRAIN-894: no match when role is absent', () => {
    // `dentistry` isn't a known role. `gazillionaire` isn't either.
    // The role alternation uses a known-roles whitelist, so neither
    // token triggers a match — the name group never gets evaluated.
    const out = extract('dentistry stuff, gazillionaire Bob');
    expect(out).toEqual([]);
  });

  it('TST-BRAIN-895: name group does not grab trailing lowercase words', () => {
    // The case-sensitive name group (via character class) is what
    // anchors the stop. "my dentist Dr Carl is on April 19" must
    // capture "Dr Carl", NOT "Dr Carl is on April 19" — "is" is
    // lowercase and fails the [A-Z] at the start of a name word.
    const out = extract('my dentist Dr Carl is on April 19');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Dr Carl');
    expect(out[0].name).not.toContain('is on April 19');
    expect(out[0].name).not.toContain('April'); // stops at "is"
  });
});

// ---------------------------------------------------------------------------
// Defensive / bonus coverage
// ---------------------------------------------------------------------------

describe('PreferenceExtractor — additional behaviours', () => {
  it('empty / whitespace text → []', () => {
    expect(extract('')).toEqual([]);
    expect(extract('   \n')).toEqual([]);
  });

  it('role token must be a whole word (not a prefix match)', () => {
    // "dental" is a CATEGORY not a role; "dentistry" is not a role;
    // a word like "mydent" is not a role either. None should fire.
    const out = extract('my dental hygienist Bob helped; mydentistbob helped.');
    // Note: "hygienist" is not a role so no match even though Bob
    // follows it. `my dental` on its own is not a role token.
    expect(out).toEqual([]);
  });

  it('`with` form — "my <role> <filler> with <Name>"', () => {
    const out = extract('My dentist appointment with Dr Carl went well.');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      role: 'dentist',
      name: 'Dr Carl',
      categories: ['dental'],
    });
  });

  it('`with` form tolerates short filler — "my lawyer consultation with Kate Jones"', () => {
    const out = extract('My lawyer consultation with Kate Jones was useful.');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      role: 'lawyer',
      name: 'Kate Jones',
      categories: ['legal'],
    });
  });

  it('multi-word category role (accountant/cpa) returns multi-element categories', () => {
    const out = extract('my accountant Linda is terrific');
    expect(out[0].categories).toEqual(['tax', 'accounting']);
    const cpa = extract('my cpa Linda is terrific');
    expect(cpa[0].categories).toEqual(['tax', 'accounting']);
  });

  it('preserves first-seen name casing in the emitted candidate', () => {
    const out = extract('My dentist Dr Carl is on April 19');
    expect(out[0].name).toBe('Dr Carl');
    // Lowercased form of the name is used internally for dedup but
    // MUST NOT leak out — the contact-lookup step is case-insensitive.
    expect(out[0].name).not.toBe('dr carl');
  });

  it('two distinct people for the same role both surface', () => {
    const out = extract(
      'My dentist Dr Carl left the practice. My dentist Dr Patel is now in charge.',
    );
    expect(out.map((c) => c.name).sort()).toEqual(['Dr Carl', 'Dr Patel']);
  });

  it('regex state does NOT leak across calls (global-flag lastIndex reset)', () => {
    // If `lastIndex` weren't reset at the top of `extract`, a second
    // call with a shorter input would start searching from a stale
    // offset and miss matches. This test is the regression guard.
    const ex = new PreferenceExtractor();
    expect(ex.extract('my dentist Dr Carl')).toHaveLength(1);
    expect(ex.extract('my dentist Dr Carl')).toHaveLength(1);
    expect(ex.extract('my dentist Dr Carl')).toHaveLength(1);
  });

  it('knownRoles returns a sorted list of all role words', () => {
    const roles = new PreferenceExtractor().knownRoles;
    // Sanity: some well-known ones appear, sorted.
    expect(roles).toContain('dentist');
    expect(roles).toContain('lawyer');
    expect(roles).toContain('cpa');
    const sorted = [...roles].sort();
    expect(roles).toEqual(sorted);
  });
});
