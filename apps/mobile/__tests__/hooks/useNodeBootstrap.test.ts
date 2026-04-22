/**
 * useNodeBootstrap module contract — the non-React surface of the
 * bootstrap hook. We can't render Expo Router in jest-node, but these
 * two helpers ARE what the service-settings screen and other screens
 * call to read the live node + the boot-time degradations.
 *
 * Issue #14 regressed here: a second hook instance mounting AFTER the
 * first boot returned `degradations: []` instead of the cached list,
 * so the banner disappeared even though the running node was still
 * degraded. This suite pins the contract the hook now upholds via
 * `getBootDegradations()`.
 */

import { getBootedNode, getBootDegradations } from '../../src/hooks/useNodeBootstrap';

describe('useNodeBootstrap module singleton — initial state', () => {
  it('getBootedNode returns null before any boot runs', () => {
    expect(getBootedNode()).toBeNull();
  });

  it('getBootDegradations returns an empty array before any boot runs', () => {
    const list = getBootDegradations();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(0);
  });

  it('getBootDegradations returns a defensive copy (mutating it does not poison the cache)', () => {
    const a = getBootDegradations();
    a.push({ code: 'fake', message: 'fake' });
    const b = getBootDegradations();
    expect(b).toHaveLength(0);
  });
});
