/**
 * Tests for the BCP-47 language-list utility (TN-V2-CTX-004).
 *
 * Mirrors the country-list test surface — same plumbing patterns,
 * different field type. Pins:
 *   - List shape (valid BCP-47 tags, no dupes).
 *   - Lookup map agrees with array.
 *   - getLanguageName: localised → english → raw fallback.
 *   - buildLanguageList: sorts by display name.
 */

import {
  BCP47_LANGUAGE_TAGS,
  BCP47_TAG_SET,
  buildLanguageList,
  clearLanguageListCacheForTest,
  getLanguageName,
} from '../../src/trust/preferences/language_list';

beforeEach(() => {
  clearLanguageListCacheForTest();
});

describe('BCP47_LANGUAGE_TAGS — list shape', () => {
  it('every entry is a valid BCP-47 tag (loose check: lang(-subtag)*)', () => {
    for (const tag of BCP47_LANGUAGE_TAGS) {
      expect(tag).toMatch(/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/);
    }
  });

  it('no duplicates', () => {
    const seen = new Set<string>();
    for (const tag of BCP47_LANGUAGE_TAGS) {
      expect(seen.has(tag)).toBe(false);
      seen.add(tag);
    }
  });

  it('list size is in the expected range (~80)', () => {
    expect(BCP47_LANGUAGE_TAGS.length).toBeGreaterThanOrEqual(60);
    expect(BCP47_LANGUAGE_TAGS.length).toBeLessThanOrEqual(120);
  });

  it('contains canonical anchor tags (en, es, fr, ar, hi, zh-Hans, ja)', () => {
    for (const tag of ['en', 'es', 'fr', 'ar', 'hi', 'zh-Hans', 'ja']) {
      expect(BCP47_LANGUAGE_TAGS).toContain(tag);
    }
  });

  it('includes pt-BR and pt-PT separately (different orthography)', () => {
    expect(BCP47_LANGUAGE_TAGS).toContain('pt-BR');
    expect(BCP47_LANGUAGE_TAGS).toContain('pt-PT');
  });

  it('includes zh-Hans and zh-Hant separately (different scripts)', () => {
    expect(BCP47_LANGUAGE_TAGS).toContain('zh-Hans');
    expect(BCP47_LANGUAGE_TAGS).toContain('zh-Hant');
  });

  it('does NOT include ambiguous bare zh or pt — those would conflate scripts/orthography', () => {
    // We intentionally split zh and pt into their region/script
    // variants because the content differs meaningfully. Including
    // bare 'zh' or 'pt' would let users pick a vague tag that doesn't
    // map to any actual content corpus.
    expect(BCP47_LANGUAGE_TAGS).not.toContain('zh');
    expect(BCP47_LANGUAGE_TAGS).not.toContain('pt');
  });
});

describe('BCP47_TAG_SET — lookup map', () => {
  it('every array entry is in the set', () => {
    for (const tag of BCP47_LANGUAGE_TAGS) {
      expect(BCP47_TAG_SET.has(tag)).toBe(true);
    }
  });

  it('set size matches array size', () => {
    expect(BCP47_TAG_SET.size).toBe(BCP47_LANGUAGE_TAGS.length);
  });

  it('rejects non-list tags', () => {
    expect(BCP47_TAG_SET.has('zh')).toBe(false); // bare zh excluded
    expect(BCP47_TAG_SET.has('xx')).toBe(false);
    expect(BCP47_TAG_SET.has('EN')).toBe(false); // case-sensitive
  });
});

describe('getLanguageName — localisation + fallback', () => {
  it('returns a non-trivial display name for known tags (en locale)', () => {
    const name = getLanguageName('de', 'en');
    expect(name.length).toBeGreaterThan(2);
    expect(name).not.toBe('de');
    // Implementations vary on exact wording but it's a real word.
  });

  it('handles regional tags (pt-BR returns a non-trivial name)', () => {
    const name = getLanguageName('pt-BR', 'en');
    expect(name.length).toBeGreaterThan(0);
    expect(name).not.toBe('pt-BR');
  });

  it('falls back to the static en-name table when Intl.DisplayNames is unavailable', () => {
    // Hermes ships the constructor without the locale data — the
    // static fallback covers every tag in BCP47_LANGUAGE_TAGS so the
    // picker stays readable. Behaviour change paired with the
    // country fallback (TN-V2-CTX-004 fix).
    const original = (Intl as any).DisplayNames;
    delete (Intl as any).DisplayNames;
    try {
      clearLanguageListCacheForTest();
      expect(getLanguageName('de')).toBe('German');
      expect(getLanguageName('en')).toBe('English');
      expect(getLanguageName('zh-Hans')).toBe('Chinese (Simplified)');
    } finally {
      (Intl as any).DisplayNames = original;
      clearLanguageListCacheForTest();
    }
  });

  it('caches the lookup', () => {
    const a = getLanguageName('fr', 'en');
    const b = getLanguageName('fr', 'en');
    expect(b).toBe(a);
  });
});

describe('buildLanguageList — sort + structure', () => {
  it('returns one entry per BCP-47 tag', () => {
    const list = buildLanguageList('en');
    expect(list.length).toBe(BCP47_LANGUAGE_TAGS.length);
  });

  it('every entry has a tag + non-empty displayName', () => {
    const list = buildLanguageList('en');
    for (const entry of list) {
      expect(BCP47_TAG_SET.has(entry.tag)).toBe(true);
      expect(entry.displayName.length).toBeGreaterThan(0);
    }
  });

  it('result is sorted by display name with locale-aware Collator', () => {
    const list = buildLanguageList('en');
    const collator = new Intl.Collator('en');
    for (let i = 1; i < list.length; i++) {
      expect(collator.compare(list[i - 1].displayName, list[i].displayName)).toBeLessThanOrEqual(0);
    }
  });

  it('every output tag is in the input set (no fabrication during sort)', () => {
    const list = buildLanguageList('en');
    for (const entry of list) {
      expect(BCP47_TAG_SET.has(entry.tag)).toBe(true);
    }
  });
});
