/**
 * Task 4.26 — pairing-code path bypass tests.
 */

import {
  isPairingBypassPath,
  PAIRING_BYPASS_PREFIXES,
  getBypassCategories,
} from '../src/auth/pairing_bypass';

describe('isPairingBypassPath (task 4.26)', () => {
  it('accepts paths under /v1/pair/', () => {
    expect(isPairingBypassPath('/v1/pair/initiate')).toBe(true);
    expect(isPairingBypassPath('/v1/pair/complete')).toBe(true);
    expect(isPairingBypassPath('/v1/pair/x')).toBe(true);
  });

  it('rejects the bare prefix without a trailing segment', () => {
    // `/v1/pair/` alone (no sub-path) doesn't match a real route; treat
    // as NOT a bypass so a typo doesn't accidentally accept a random
    // handler registered at that exact path.
    expect(isPairingBypassPath('/v1/pair/')).toBe(false);
  });

  it('rejects unrelated prefixes that merely start with "pair"', () => {
    expect(isPairingBypassPath('/v1/pair-not-ours')).toBe(false);
    expect(isPairingBypassPath('/pair/initiate')).toBe(false); // wrong version
    expect(isPairingBypassPath('/v2/pair/initiate')).toBe(false); // future version
  });

  it('rejects /v1/vault and other real routes', () => {
    expect(isPairingBypassPath('/v1/vault/store')).toBe(false);
    expect(isPairingBypassPath('/v1/did/sign')).toBe(false);
    expect(isPairingBypassPath('/healthz')).toBe(false);
    expect(isPairingBypassPath('/readyz')).toBe(false);
    expect(isPairingBypassPath('/admin/export')).toBe(false);
  });

  it('rejects empty path', () => {
    expect(isPairingBypassPath('')).toBe(false);
  });
});

describe('PAIRING_BYPASS_PREFIXES constant', () => {
  it('is a frozen array (no runtime mutation)', () => {
    expect(Object.isFrozen(PAIRING_BYPASS_PREFIXES)).toBe(true);
  });

  it('contains exactly the one pairing prefix today', () => {
    expect([...PAIRING_BYPASS_PREFIXES]).toEqual(['/v1/pair/']);
  });
});

describe('getBypassCategories', () => {
  it('reports the pairing category for /readyz consumption', () => {
    const cats = getBypassCategories();
    expect(cats.pairing).toEqual(['/v1/pair/']);
  });
});
