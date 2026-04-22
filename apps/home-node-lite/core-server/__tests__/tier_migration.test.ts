/**
 * Task 4.74 — legacy tier migration tests.
 *
 * Pins the mapping so `persona_config.ts` (task 4.68) can rely on
 * canonical output and operators get deterministic upgrade behavior.
 */

import {
  HOME_BUCKET_NAMES,
  isCanonicalTier,
  isHomeBucketName,
  isLegacyTier,
  migrateTier,
} from '../src/persona/tier_migration';

describe('migrateTier (task 4.74)', () => {
  describe('canonical pass-through', () => {
    it.each(['default', 'standard', 'sensitive', 'locked'] as const)(
      'leaves %s unchanged',
      (tier) => {
        const out = migrateTier(tier, 'anything');
        expect(out.tier).toBe(tier);
        expect(out.migrated).toBe(false);
        expect(out.original).toBe(tier);
      },
    );
  });

  describe('open → default / standard (name-sensitive)', () => {
    it('open + personal → default', () => {
      const out = migrateTier('open', 'personal');
      expect(out).toEqual({ tier: 'default', migrated: true, original: 'open' });
    });

    it('open + general → default', () => {
      const out = migrateTier('open', 'general');
      expect(out).toEqual({ tier: 'default', migrated: true, original: 'open' });
    });

    it.each(['consumer', 'social', 'work', 'family', 'random-persona'])(
      'open + %s → standard',
      (name) => {
        const out = migrateTier('open', name);
        expect(out).toEqual({ tier: 'standard', migrated: true, original: 'open' });
      },
    );

    it('the home bucket list matches the exported constant', () => {
      // This guards against someone changing HOME_BUCKET_NAMES without
      // updating the tests that depend on the semantics.
      expect(HOME_BUCKET_NAMES).toEqual(['personal', 'general']);
    });
  });

  describe('restricted → sensitive', () => {
    it('regardless of persona name', () => {
      for (const name of ['health', 'random-name', 'personal']) {
        expect(migrateTier('restricted', name)).toEqual({
          tier: 'sensitive',
          migrated: true,
          original: 'restricted',
        });
      }
    });
  });

  describe('unknown tier values', () => {
    it.each(['', 'OPEN', 'Default', 'whatever', 'admin'])(
      'throws on %s',
      (tier) => {
        expect(() => migrateTier(tier, 'persona')).toThrow(/unknown tier/);
      },
    );
  });

  describe('personaName validation', () => {
    it('throws when personaName is empty', () => {
      expect(() => migrateTier('open', '')).toThrow(/personaName is required/);
    });
  });

  describe('result.original preserves input', () => {
    it('exposes the raw legacy string even after migration', () => {
      expect(migrateTier('restricted', 'health').original).toBe('restricted');
      expect(migrateTier('open', 'personal').original).toBe('open');
    });
  });

  describe('helper predicates', () => {
    it('isCanonicalTier matches the 4 canonical values only', () => {
      expect(isCanonicalTier('default')).toBe(true);
      expect(isCanonicalTier('standard')).toBe(true);
      expect(isCanonicalTier('sensitive')).toBe(true);
      expect(isCanonicalTier('locked')).toBe(true);
      expect(isCanonicalTier('open')).toBe(false);
      expect(isCanonicalTier('restricted')).toBe(false);
      expect(isCanonicalTier('')).toBe(false);
    });

    it('isLegacyTier matches only open + restricted', () => {
      expect(isLegacyTier('open')).toBe(true);
      expect(isLegacyTier('restricted')).toBe(true);
      expect(isLegacyTier('default')).toBe(false);
      expect(isLegacyTier('locked')).toBe(false);
    });

    it('isHomeBucketName matches only the configured names', () => {
      expect(isHomeBucketName('personal')).toBe(true);
      expect(isHomeBucketName('general')).toBe(true);
      expect(isHomeBucketName('Personal')).toBe(false); // case-sensitive
      expect(isHomeBucketName('work')).toBe(false);
    });
  });
});
