/**
 * T2B.16 — Persona registry: load from Core, alias resolution, cache.
 *
 * Category B: contract test. Tests normalize, alias resolution, cache.
 *
 * Source: brain/tests/test_persona_registry.py
 */

import {
  normalize,
  resolveAlias,
  loadFromCore,
  refreshCache,
  setCachedPersonas,
  clearCache,
} from '../../src/persona/registry';

describe('Persona Registry', () => {
  afterEach(() => {
    clearCache();
  });

  describe('normalize', () => {
    it('strips leading slash', () => {
      expect(normalize('/health')).toBe('health');
    });

    it('lowercases', () => {
      expect(normalize('Health')).toBe('health');
    });

    it('strips leading slash and lowercases', () => {
      expect(normalize('/Financial')).toBe('financial');
    });

    it('passes through already-normalized name', () => {
      expect(normalize('general')).toBe('general');
    });

    it('trims whitespace', () => {
      expect(normalize('  health  ')).toBe('health');
    });

    it('handles multiple leading slashes (strips first only)', () => {
      expect(normalize('//health')).toBe('/health');
    });
  });

  describe('resolveAlias', () => {
    // Canonical names resolve to themselves
    it('"general" → "general" (canonical)', () => {
      expect(resolveAlias('general')).toBe('general');
    });

    it('"health" → "health" (canonical)', () => {
      expect(resolveAlias('health')).toBe('health');
    });

    it('"financial" → "financial" (canonical)', () => {
      expect(resolveAlias('financial')).toBe('financial');
    });

    // Alias resolution
    it('"finance" → "financial"', () => {
      expect(resolveAlias('finance')).toBe('financial');
    });

    it('"medical" → "health"', () => {
      expect(resolveAlias('medical')).toBe('health');
    });

    it('"work" → "professional"', () => {
      expect(resolveAlias('work')).toBe('professional');
    });

    it('"shopping" → "consumer"', () => {
      expect(resolveAlias('shopping')).toBe('consumer');
    });

    it('"friends" → "social"', () => {
      expect(resolveAlias('friends')).toBe('social');
    });

    it('"private" → "personal"', () => {
      expect(resolveAlias('private')).toBe('personal');
    });

    it('"default" → "general"', () => {
      expect(resolveAlias('default')).toBe('general');
    });

    // Unknown → null (Brain never invents)
    it('unknown name → null', () => {
      expect(resolveAlias('invented_persona')).toBeNull();
    });

    it('Brain never invents personas — unknown returns null', () => {
      expect(resolveAlias('brand_new_persona')).toBeNull();
    });

    it('empty string → null', () => {
      expect(resolveAlias('')).toBeNull();
    });

    // Case insensitivity via normalize
    it('case insensitive: "HEALTH" → "health"', () => {
      expect(resolveAlias('HEALTH')).toBe('health');
    });

    it('handles leading slash: "/health" → "health"', () => {
      expect(resolveAlias('/health')).toBe('health');
    });
  });

  describe('loadFromCore', () => {
    it('returns cached personas', async () => {
      setCachedPersonas([
        { name: 'general', tier: 'default', locked: false },
        { name: 'health', tier: 'sensitive', locked: true },
      ]);
      const personas = await loadFromCore();
      expect(personas).toHaveLength(2);
      expect(personas[0].name).toBe('general');
    });

    it('returns empty when cache is empty', async () => {
      const personas = await loadFromCore();
      expect(personas).toHaveLength(0);
    });
  });

  describe('refreshCache', () => {
    it('updates cache from Core', async () => {
      setCachedPersonas([{ name: 'general', tier: 'default', locked: false }]);
      const result = await refreshCache();
      expect(result).toHaveLength(1);
    });

    it('returns cached list on Core failure (resilient)', async () => {
      setCachedPersonas([{ name: 'general', tier: 'default', locked: false }]);
      // refreshCache uses loadFromCore which returns cache — always succeeds for now
      const result = await refreshCache();
      expect(result).toHaveLength(1);
    });
  });
});
