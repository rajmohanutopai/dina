/**
 * Task 4.12 — version resolver tests.
 *
 * Verifies priority order (env override > package.json > fallback), the
 * package.json walk, and caching.
 */

import { getServerVersion, resetVersionCache } from '../src/version';

describe('getServerVersion (task 4.12)', () => {
  const originalEnv = process.env['DINA_CORE_VERSION'];

  afterEach(() => {
    // Restore env + cache between tests.
    if (originalEnv === undefined) {
      delete process.env['DINA_CORE_VERSION'];
    } else {
      process.env['DINA_CORE_VERSION'] = originalEnv;
    }
    resetVersionCache();
  });

  it('returns package.json version when env is unset', () => {
    delete process.env['DINA_CORE_VERSION'];
    resetVersionCache();
    const v = getServerVersion();
    // Shape: semver-ish; package.json has "0.0.1" (matches scaffold).
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('DINA_CORE_VERSION env overrides package.json', () => {
    process.env['DINA_CORE_VERSION'] = '9.9.9-release-candidate';
    resetVersionCache();
    expect(getServerVersion()).toBe('9.9.9-release-candidate');
  });

  it('empty env string falls back to package.json (not empty)', () => {
    process.env['DINA_CORE_VERSION'] = '';
    resetVersionCache();
    expect(getServerVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('cache returns the same string across calls', () => {
    resetVersionCache();
    const first = getServerVersion();
    // Change env AFTER first call — cache should not refresh.
    process.env['DINA_CORE_VERSION'] = 'different-now';
    expect(getServerVersion()).toBe(first);
    // But once we reset the cache, the override takes effect.
    resetVersionCache();
    expect(getServerVersion()).toBe('different-now');
  });
});
