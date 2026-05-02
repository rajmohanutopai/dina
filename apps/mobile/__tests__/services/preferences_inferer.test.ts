/**
 * Tests for the viewer-preferences inferer. Pins:
 *
 *   - Locale signals propagate to region + languages.
 *   - Platform → devices mapping (ios/ipad/android/macos/web/windows).
 *   - Dietary keyword scan: first-person assertions match, generic
 *     mentions don't (Halal restaurants ≠ user is halal).
 *   - Empty / unknown signals produce omitted fields, not nulls or
 *     empty arrays.
 *   - Pure: same input → same output, no global state.
 */

import {
  inferPreferences,
  type InferenceContext,
} from '../../src/services/preferences_inferer';

function ctx(overrides: Partial<InferenceContext> = {}): InferenceContext {
  return {
    vaultItems: [],
    localeRegion: null,
    localeBcp47: null,
    platform: undefined,
    isIpad: false,
    ...overrides,
  };
}

describe('inferPreferences — region', () => {
  it('forwards localeRegion when present', () => {
    expect(inferPreferences(ctx({ localeRegion: 'IN' })).region).toBe('IN');
  });

  it('omits region when locale carries none', () => {
    expect('region' in inferPreferences(ctx({ localeRegion: null }))).toBe(false);
  });
});

describe('inferPreferences — languages', () => {
  it('seeds with the locale BCP-47 tag when present', () => {
    expect(inferPreferences(ctx({ localeBcp47: 'pt-BR' })).languages).toEqual(['pt-BR']);
  });

  it('omits languages when locale is unavailable', () => {
    expect('languages' in inferPreferences(ctx({ localeBcp47: null }))).toBe(false);
  });
});

describe('inferPreferences — devices', () => {
  it('iOS phone → ios', () => {
    expect(inferPreferences(ctx({ platform: 'ios', isIpad: false })).devices).toEqual([
      'ios',
    ]);
  });

  it('iPad → ipad (so iPad-native apps stay in the rank)', () => {
    expect(inferPreferences(ctx({ platform: 'ios', isIpad: true })).devices).toEqual([
      'ipad',
    ]);
  });

  it('android → android', () => {
    expect(inferPreferences(ctx({ platform: 'android' })).devices).toEqual(['android']);
  });

  it('macos → macos', () => {
    expect(inferPreferences(ctx({ platform: 'macos' })).devices).toEqual(['macos']);
  });

  it('windows → windows', () => {
    expect(inferPreferences(ctx({ platform: 'windows' })).devices).toEqual(['windows']);
  });

  it('web → web', () => {
    expect(inferPreferences(ctx({ platform: 'web' })).devices).toEqual(['web']);
  });

  it('unknown platform → omits devices', () => {
    expect('devices' in inferPreferences(ctx({ platform: undefined }))).toBe(false);
  });
});

describe('inferPreferences — dietary (first-person assertions only)', () => {
  it('matches "I\'m vegan" / "I am vegan"', () => {
    const items = [{ headline: 'note', bodyPreview: "I'm vegan and proud of it" }];
    expect(inferPreferences(ctx({ vaultItems: items })).dietary).toEqual(['vegan']);
    const items2 = [{ headline: 'I am vegan', bodyPreview: '' }];
    expect(inferPreferences(ctx({ vaultItems: items2 })).dietary).toEqual(['vegan']);
  });

  it('does NOT match generic mentions ("vegan options", "halal restaurants")', () => {
    const items = [
      { headline: 'restaurant search', bodyPreview: 'They have vegan options here' },
      { headline: 'travel notes', bodyPreview: 'Lots of halal restaurants nearby' },
    ];
    expect('dietary' in inferPreferences(ctx({ vaultItems: items }))).toBe(false);
  });

  it('matches halal / kosher first-person ("I keep halal", "I follow kosher")', () => {
    const items = [
      { headline: 'reminder', bodyPreview: 'I keep halal so check the cert' },
      { headline: 'note', bodyPreview: 'I follow kosher dietary law' },
    ];
    const out = inferPreferences(ctx({ vaultItems: items })).dietary;
    expect(out?.sort()).toEqual(['halal', 'kosher']);
  });

  it('matches gluten-free via "coeliac" / "celiac" diagnosis terms', () => {
    const items = [
      { headline: 'medical', bodyPreview: "I'm coeliac, must avoid gluten" },
    ];
    expect(inferPreferences(ctx({ vaultItems: items })).dietary).toEqual(['gluten-free']);
  });

  it('matches dairy-free / lactose intolerant', () => {
    const items = [{ headline: 'note', bodyPreview: "I'm lactose intolerant." }];
    expect(inferPreferences(ctx({ vaultItems: items })).dietary).toEqual(['dairy-free']);
  });

  it('matches nut-free via "peanut allergy" / "nut allergy"', () => {
    const items = [
      { headline: 'kid bio', bodyPreview: 'My son has a peanut allergy.' },
    ];
    expect(inferPreferences(ctx({ vaultItems: items })).dietary).toEqual(['nut-free']);
  });

  it('multiple distinct tags in one corpus', () => {
    const items = [
      { headline: 'note', bodyPreview: "I'm vegan." },
      { headline: 'note', bodyPreview: "I'm gluten-free too." },
    ];
    const out = inferPreferences(ctx({ vaultItems: items })).dietary;
    expect(out?.sort()).toEqual(['gluten-free', 'vegan']);
  });

  it('omits dietary entirely when nothing matches', () => {
    const items = [{ headline: 'random', bodyPreview: 'unrelated text' }];
    expect('dietary' in inferPreferences(ctx({ vaultItems: items }))).toBe(false);
  });

  it('returns alphabetically-sorted tags (deterministic across runs)', () => {
    const items = [
      { headline: 'note', bodyPreview: "I'm vegan." },
      { headline: 'note', bodyPreview: "I'm halal." },
      { headline: 'note', bodyPreview: "I'm gluten-free." },
    ];
    expect(inferPreferences(ctx({ vaultItems: items })).dietary).toEqual([
      'gluten-free',
      'halal',
      'vegan',
    ]);
  });
});

describe('inferPreferences — composite output shape', () => {
  it('omits every field with no signal (returns {})', () => {
    expect(inferPreferences(ctx())).toEqual({});
  });

  it('emits only the fields with signal', () => {
    const out = inferPreferences(
      ctx({
        localeBcp47: 'en-IN',
        localeRegion: 'IN',
        platform: 'ios',
        isIpad: false,
      }),
    );
    expect(out).toEqual({
      region: 'IN',
      languages: ['en-IN'],
      devices: ['ios'],
    });
    // Confirm dietary stays absent — important for the keychain
    // merge semantics on first launch.
    expect('dietary' in out).toBe(false);
  });

  it('is pure: identical inputs → identical outputs', () => {
    const c = ctx({
      localeRegion: 'JP',
      localeBcp47: 'ja-JP',
      platform: 'android',
      vaultItems: [{ headline: 'note', bodyPreview: "I'm vegetarian." }],
    });
    expect(inferPreferences(c)).toEqual(inferPreferences(c));
  });
});
