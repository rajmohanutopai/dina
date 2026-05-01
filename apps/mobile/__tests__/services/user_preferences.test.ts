/**
 * Tests for the viewer profile preferences service (TN-V2-CTX-001).
 *
 * Pins:
 *   - Loyalty Law: storage stays in keychain — no network paths.
 *   - First-read defaults derived from device locale (region + lang).
 *   - Save → load round-trip preserves chosen values verbatim.
 *   - Forward-compat: future-version row missing a field reads with
 *     default for that field.
 *   - Backward-compat: row with unknown extra fields tolerates them.
 *   - Validation: per-field guards reject malformed values without
 *     crashing the loader.
 *   - Corruption recovery: invalid JSON in the keychain → defaults.
 *   - Clear: wipes the row, next load returns defaults again.
 */

import * as Keychain from 'react-native-keychain';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';

import {
  clearUserPreferences,
  defaultPreferences,
  loadUserPreferences,
  mutateUserPreferences,
  saveUserPreferences,
  type UserPreferences,
} from '../../src/services/user_preferences';

const SERVICE_KEY = 'dina.user_preferences';

// Hold the original Intl so each test can stub it with a known locale
// — without this the tests pick up whatever locale the CI runner has,
// which makes the "first-read defaults" assertions flaky.
const ORIGINAL_INTL = global.Intl;

function stubLocale(localeStr: string): void {
  // Build a minimal Intl shim. Only `DateTimeFormat().resolvedOptions().locale`
  // is consulted by the service, so we only need to fake that path.
  (global as any).Intl = {
    ...ORIGINAL_INTL,
    DateTimeFormat: function () {
      return {
        resolvedOptions: () => ({ locale: localeStr }),
      };
    },
  };
}

function restoreLocale(): void {
  (global as any).Intl = ORIGINAL_INTL;
}

beforeEach(() => {
  resetKeychainMock();
  // Default to en-US so any test that doesn't explicitly stub the
  // locale gets a deterministic baseline.
  stubLocale('en-US');
});

afterEach(() => {
  restoreLocale();
});

describe('defaultPreferences — device-locale derivation', () => {
  it('derives region from BCP-47 region subtag (en-US → US)', () => {
    stubLocale('en-US');
    const def = defaultPreferences();
    expect(def.region).toBe('US');
    expect(def.languages).toEqual(['en-US']);
  });

  it('preserves regional language tags in the languages array (pt-BR)', () => {
    stubLocale('pt-BR');
    const def = defaultPreferences();
    expect(def.region).toBe('BR');
    expect(def.languages).toEqual(['pt-BR']);
  });

  it('canonicalises locale case (en-us → en-US, EN-US → en-US)', () => {
    // BCP-47 convention: language subtag lowercase, region subtag
    // uppercase. Most platforms emit canonical form, but we defend
    // anyway since `Intl` implementations vary.
    stubLocale('en-us');
    expect(defaultPreferences().languages).toEqual(['en-US']);
    stubLocale('EN-US');
    expect(defaultPreferences().languages).toEqual(['en-US']);
  });

  it('handles bare-language locales (no region subtag)', () => {
    stubLocale('en');
    const def = defaultPreferences();
    expect(def.region).toBeNull();
    expect(def.languages).toEqual(['en']);
  });

  it('falls back to no-locale defaults when Intl throws', () => {
    // Truly-degraded environments (older Hermes, jsc-without-Intl)
    // should still boot — the service returns null/empty defaults
    // rather than crashing.
    (global as any).Intl = {
      ...ORIGINAL_INTL,
      DateTimeFormat: function () {
        throw new Error('Intl unavailable');
      },
    };
    const def = defaultPreferences();
    expect(def.region).toBeNull();
    expect(def.languages).toEqual([]);
  });

  it('non-locale fields default to empty/null regardless of locale', () => {
    stubLocale('en-US');
    const def = defaultPreferences();
    expect(def.budget).toEqual({});
    expect(def.devices).toEqual([]);
    expect(def.dietary).toEqual([]);
    expect(def.accessibility).toEqual([]);
  });
});

describe('loadUserPreferences — first read', () => {
  it('returns defaults when keychain has no row', async () => {
    stubLocale('en-US');
    const prefs = await loadUserPreferences();
    expect(prefs).toEqual({
      region: 'US',
      budget: {},
      devices: [],
      languages: ['en-US'],
      dietary: [],
      accessibility: [],
    });
  });

  it('returns defaults if keychain access throws (degraded environment)', async () => {
    stubLocale('en-US');
    const original = Keychain.getGenericPassword;
    (Keychain as any).getGenericPassword = jest
      .fn()
      .mockRejectedValue(new Error('keychain unavailable'));
    try {
      const prefs = await loadUserPreferences();
      expect(prefs.region).toBe('US');
    } finally {
      (Keychain as any).getGenericPassword = original;
    }
  });

  it('returns defaults when stored blob is not valid JSON', async () => {
    // Simulates corruption — should never happen in practice but
    // we want to never throw on read. A subsequent save will overwrite.
    await Keychain.setGenericPassword('x', 'NOT_JSON{{{', { service: SERVICE_KEY });
    const prefs = await loadUserPreferences();
    expect(prefs).toEqual(defaultPreferences());
  });

  it('returns defaults when stored blob is JSON but not a record', async () => {
    // String, array, null are all valid JSON but not the record shape
    // the parser expects. Fall back to defaults rather than coerce —
    // a saved top-level array would be a wire-format violation.
    await Keychain.setGenericPassword('x', '"a string"', { service: SERVICE_KEY });
    expect(await loadUserPreferences()).toEqual(defaultPreferences());
    await Keychain.setGenericPassword('x', '[1, 2, 3]', { service: SERVICE_KEY });
    expect(await loadUserPreferences()).toEqual(defaultPreferences());
    await Keychain.setGenericPassword('x', 'null', { service: SERVICE_KEY });
    expect(await loadUserPreferences()).toEqual(defaultPreferences());
    await Keychain.setGenericPassword('x', '42', { service: SERVICE_KEY });
    expect(await loadUserPreferences()).toEqual(defaultPreferences());
  });
});

describe('saveUserPreferences — round-trip', () => {
  it('preserves a fully-populated profile through save → load', async () => {
    const written: UserPreferences = {
      region: 'IN',
      budget: { 'office_furniture/chair': '$$', 'electronics/laptop': '$$$' },
      devices: ['ios', 'macos'],
      languages: ['en-IN', 'hi-IN'],
      dietary: ['vegetarian'],
      accessibility: ['screen-reader'],
    };
    await saveUserPreferences(written);
    const read = await loadUserPreferences();
    expect(read).toEqual(written);
  });

  it('preserves explicit-empty arrays (user cleared a multi-select)', async () => {
    // Critical for the "I removed all my dietary tags" case: the
    // saved blob has `dietary: []`, on read we MUST honour the
    // explicit empty rather than falling back to a default. Our
    // contract is "field-present-with-empty != field-absent".
    const written: UserPreferences = {
      region: null,
      budget: {},
      devices: [],
      languages: [],
      dietary: [],
      accessibility: [],
    };
    await saveUserPreferences(written);
    const read = await loadUserPreferences();
    expect(read).toEqual(written);
    expect(read.languages).toEqual([]);
  });

  it('preserves explicit-null region (user opted out of region filtering)', async () => {
    stubLocale('en-US'); // device locale would default to 'US'
    const written: UserPreferences = {
      ...defaultPreferences(),
      region: null,
    };
    await saveUserPreferences(written);
    const read = await loadUserPreferences();
    expect(read.region).toBeNull();
    // device-locale default is 'US' — but the saved row pinned null,
    // so the read must NOT resurrect 'US' from the default.
  });

  it('rejects invalid budget tiers — coerces to no entry, not "$"', async () => {
    // Defensive: a caller passing a bad tier shouldn't poison the
    // stored row with a garbage value. The parser drops the entry.
    const blob = JSON.stringify({
      region: 'US',
      budget: {
        'electronics/laptop': '$$',
        'office_furniture/chair': '$$$$', // invalid (4 dollar signs)
        '': '$', // invalid empty category key
      },
      devices: [],
      languages: [],
      dietary: [],
      accessibility: [],
    });
    await Keychain.setGenericPassword('x', blob, { service: SERVICE_KEY });
    const read = await loadUserPreferences();
    expect(read.budget).toEqual({ 'electronics/laptop': '$$' });
  });

  it('rejects invalid enum values in array fields', async () => {
    // Invalid devices / dietary / accessibility entries are dropped
    // silently — same defensive posture as the budget parser.
    const blob = JSON.stringify({
      region: 'US',
      budget: {},
      devices: ['ios', 'unknown-platform', 42, 'android'],
      languages: ['en-US'],
      dietary: ['vegan', 'fictional-diet'],
      accessibility: ['wheelchair', null],
    });
    await Keychain.setGenericPassword('x', blob, { service: SERVICE_KEY });
    const read = await loadUserPreferences();
    expect(read.devices).toEqual(['ios', 'android']);
    expect(read.dietary).toEqual(['vegan']);
    expect(read.accessibility).toEqual(['wheelchair']);
  });

  it('de-duplicates repeated entries in array fields', async () => {
    // A buggy settings UI could submit the same value twice; the
    // parser's job is to make sure the stored row is canonical.
    const blob = JSON.stringify({
      devices: ['ios', 'ios', 'android'],
      languages: ['en-US', 'en-US'],
      dietary: ['vegan', 'vegan'],
      accessibility: ['wheelchair', 'wheelchair'],
    });
    await Keychain.setGenericPassword('x', blob, { service: SERVICE_KEY });
    const read = await loadUserPreferences();
    expect(read.devices).toEqual(['ios', 'android']);
    expect(read.languages).toEqual(['en-US']);
    expect(read.dietary).toEqual(['vegan']);
    expect(read.accessibility).toEqual(['wheelchair']);
  });

  it('rejects malformed BCP-47 language tags', async () => {
    const blob = JSON.stringify({
      languages: ['en-US', 'not a tag!', '', '   ', 'pt-BR'],
    });
    await Keychain.setGenericPassword('x', blob, { service: SERVICE_KEY });
    const read = await loadUserPreferences();
    expect(read.languages).toEqual(['en-US', 'pt-BR']);
  });

  it('canonicalises language tag case on read', async () => {
    const blob = JSON.stringify({ languages: ['EN-us', 'pt-BR', 'fr'] });
    await Keychain.setGenericPassword('x', blob, { service: SERVICE_KEY });
    const read = await loadUserPreferences();
    expect(read.languages).toEqual(['en-US', 'pt-BR', 'fr']);
  });

  it('rejects non-ISO-3166 region values', async () => {
    // `region` is exactly two uppercase ASCII letters. Lowercase,
    // 3-letter, numeric, etc. all coerce to null.
    for (const bad of ['us', 'usa', '12', 'U', '', 'U S']) {
      const blob = JSON.stringify({ region: bad });
      await Keychain.setGenericPassword('x', blob, { service: SERVICE_KEY });
      expect((await loadUserPreferences()).region).toBeNull();
    }
  });

  it('saving rejects malformed input the same way load does', async () => {
    // Defence-in-depth: a buggy caller passing junk to save() shouldn't
    // poison the keystore. The parser runs on save too.
    await saveUserPreferences({
      region: 'usa' as any, // invalid
      budget: { '': '$' as any }, // invalid empty category
      devices: ['unknown-platform'] as any, // invalid value
      languages: ['en-US', 'not a tag'],
      dietary: ['fictional-diet'] as any,
      accessibility: ['wheelchair'],
    });
    const read = await loadUserPreferences();
    expect(read.region).toBeNull();
    expect(read.budget).toEqual({});
    expect(read.devices).toEqual([]);
    expect(read.languages).toEqual(['en-US']);
    expect(read.dietary).toEqual([]);
    expect(read.accessibility).toEqual(['wheelchair']);
  });
});

describe('forward-compat: missing fields take per-field defaults', () => {
  it('a row with no `accessibility` field still loads', async () => {
    // Simulates an older app version that wrote a row without the
    // `accessibility` field. The newer build adds it back from
    // device-locale defaults (which is empty for accessibility).
    const blob = JSON.stringify({
      region: 'US',
      budget: {},
      devices: [],
      languages: ['en-US'],
      dietary: [],
      // accessibility deliberately absent
    });
    await Keychain.setGenericPassword('x', blob, { service: SERVICE_KEY });
    const read = await loadUserPreferences();
    expect(read.accessibility).toEqual([]);
    // The other present fields round-trip verbatim.
    expect(read.region).toBe('US');
    expect(read.languages).toEqual(['en-US']);
  });

  it('a row with no language fields takes device-locale defaults', async () => {
    stubLocale('pt-BR');
    const blob = JSON.stringify({
      region: 'BR',
      // languages absent — older row from before language UI shipped
    });
    await Keychain.setGenericPassword('x', blob, { service: SERVICE_KEY });
    const read = await loadUserPreferences();
    expect(read.languages).toEqual(['pt-BR']);
  });
});

describe('backward-compat: unknown fields tolerated', () => {
  it('unknown keys in the stored blob are ignored on read', async () => {
    // A future build wrote a `theme: "dark"` field this build doesn't
    // know. It's not in the type, but reading the row must not throw.
    const blob = JSON.stringify({
      region: 'US',
      budget: {},
      devices: [],
      languages: ['en-US'],
      dietary: [],
      accessibility: [],
      theme: 'dark',
      futureField: { nested: true },
    });
    await Keychain.setGenericPassword('x', blob, { service: SERVICE_KEY });
    const read = await loadUserPreferences();
    expect(read.region).toBe('US');
    // No assertion on the unknown fields — the loader returns the
    // strict-typed shape, so they're invisible to callers. They're
    // silently dropped on next save (acceptable: the user is on the
    // newer build, which doesn't know what theme="dark" meant).
    expect((read as any).theme).toBeUndefined();
  });
});

describe('clearUserPreferences', () => {
  it('wipes the row — next load returns defaults', async () => {
    await saveUserPreferences({
      region: 'IN',
      budget: { 'office/chair': '$$' },
      devices: ['ios'],
      languages: ['hi-IN'],
      dietary: ['vegetarian'],
      accessibility: [],
    });
    expect((await loadUserPreferences()).region).toBe('IN');
    await clearUserPreferences();
    stubLocale('en-US');
    expect(await loadUserPreferences()).toEqual(defaultPreferences());
  });

  it('is idempotent — clearing an empty row does not throw', async () => {
    await expect(clearUserPreferences()).resolves.not.toThrow();
    await expect(clearUserPreferences()).resolves.not.toThrow();
  });
});

describe('mutateUserPreferences — race-safe functional updates', () => {
  // The motivating scenario: user taps "iOS" then "Android" rapidly
  // in a multi-select. With a naive `save({...profile, devices:[...]})`,
  // the second call captures the same stale `profile` from before
  // the first save resolved → iOS lost. `mutate(updater)` reads the
  // latest snapshot inside the queued task, so the second updater
  // sees the first's effect.

  it('two concurrent mutates compose — neither update is lost', async () => {
    // Pre-seed empty so we can watch the array grow.
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: [],
      dietary: [],
      accessibility: [],
    });

    // Fire both mutates BEFORE awaiting either. They queue in order.
    const a = mutateUserPreferences((p) => ({ ...p, devices: [...p.devices, 'ios'] }));
    const b = mutateUserPreferences((p) => ({ ...p, devices: [...p.devices, 'android'] }));
    await Promise.all([a, b]);

    const final = await loadUserPreferences();
    expect(final.devices).toEqual(['ios', 'android']);
  });

  it('high-concurrency stress: 10 mutates compose into 10 entries', async () => {
    // Pin the queue actually serializes — without it, lost updates
    // would manifest as a final array shorter than 10.
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: [
        // Pre-seed languages so we can demonstrate composition on
        // any field (devices is bounded to 7 valid values, so we
        // use languages here for a 10-toggle stress test).
      ],
      dietary: [],
      accessibility: [],
    });

    const tags = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ja', 'ko', 'zh'];
    const promises = tags.map((tag) =>
      mutateUserPreferences((p) => ({ ...p, languages: [...p.languages, tag] })),
    );
    await Promise.all(promises);

    const final = await loadUserPreferences();
    // All 10 tags landed; order matches enqueue order. Tags are
    // already lowercase (so canonicaliseLanguageTag is a no-op on
    // each), so the final array equals the input verbatim.
    expect(final.languages).toEqual(tags);
    expect(final.languages.length).toBe(10);
  });

  it('a failed mutate does not poison the queue — subsequent mutates still run', async () => {
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: [],
      dietary: [],
      accessibility: [],
    });

    // Stub keychain to fail ONCE then succeed. The first mutate's
    // task should reject; the second must still resolve and apply.
    const original = (
      await import('react-native-keychain')
    ).setGenericPassword;
    let calls = 0;
    const RNKeychain = await import('react-native-keychain');
    (RNKeychain as any).setGenericPassword = jest
      .fn()
      .mockImplementation((...args: unknown[]) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('keychain busy'));
        return (original as any)(...args);
      });

    try {
      const failing = mutateUserPreferences((p) => ({
        ...p,
        devices: [...p.devices, 'ios'],
      }));
      const succeeding = mutateUserPreferences((p) => ({
        ...p,
        devices: [...p.devices, 'android'],
      }));
      await expect(failing).rejects.toThrow('keychain busy');
      await expect(succeeding).resolves.toBeUndefined();

      const final = await loadUserPreferences();
      // Only 'android' landed — 'ios' was rolled back by the failed
      // keystore write. The queue stayed alive after the failure.
      expect(final.devices).toEqual(['android']);
    } finally {
      (RNKeychain as any).setGenericPassword = original;
    }
  });

  it('mutate runs validation — invalid updater output is sanitised', async () => {
    await saveUserPreferences({
      region: 'US',
      budget: {},
      devices: [],
      languages: [],
      dietary: [],
      accessibility: [],
    });
    // Updater that returns junk — region invalid, devices contains
    // an unknown value. Defence-in-depth: parsePreferences runs on
    // the result, so junk is quietly dropped rather than persisted.
    await mutateUserPreferences((p) => ({
      ...p,
      region: 'usa' as any, // invalid
      devices: ['ios', 'unknown-platform'] as any,
    }));
    const final = await loadUserPreferences();
    expect(final.region).toBeNull(); // 'usa' coerced to null
    expect(final.devices).toEqual(['ios']); // 'unknown-platform' dropped
  });
});

describe('Loyalty Law guarantee — local-only storage', () => {
  it('is keystore-resident: no network or AppView calls', async () => {
    // Black-box guarantee — any code path that reaches outside the
    // device must go through fetch() / xhr / axios. None of those
    // are imported here. This test exists to flag a violation if
    // someone refactors and starts reaching out (e.g., to "sync" prefs).
    const fetchSpy = jest.fn();
    const original = (global as any).fetch;
    (global as any).fetch = fetchSpy;
    try {
      await saveUserPreferences({
        region: 'US',
        budget: {},
        devices: [],
        languages: ['en-US'],
        dietary: [],
        accessibility: [],
      });
      await loadUserPreferences();
      await clearUserPreferences();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (global as any).fetch = original;
    }
  });

  it('uses the dedicated keychain service key (no namespace collision)', async () => {
    // Pinned because a future refactor renaming the service constant
    // would silently leave old rows orphaned and the new service
    // sharing a namespace with another module would cross-contaminate.
    await saveUserPreferences({
      region: 'US',
      budget: {},
      devices: [],
      languages: ['en-US'],
      dietary: [],
      accessibility: [],
    });
    const row = await Keychain.getGenericPassword({ service: SERVICE_KEY });
    expect(row).not.toBe(false);
    if (row !== false) {
      expect(JSON.parse(row.password).region).toBe('US');
    }
  });
});
