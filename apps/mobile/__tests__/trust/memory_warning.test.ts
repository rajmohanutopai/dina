/**
 * Memory-warning wiring test (TN-MOB-006).
 *
 * The eviction logic itself is tested in
 * `@dina/core/__tests__/trust/cache.test.ts`. This file only verifies
 * the platform glue:
 *   - register subscribes to `AppState.memoryWarning`
 *   - the registered handler shrinks the cache to MEMORY_WARNING_TARGET
 *   - the returned subscription has a working `remove()`
 */

import { AppState } from 'react-native';
import {
  cacheTrustScore,
  trustCacheSize,
  resetTrustCache,
  MEMORY_WARNING_TARGET,
  type TrustScore,
} from '../../../../packages/core/src/trust/cache';
import { resetKVStore } from '../../../../packages/core/src/kv/store';
import { registerTrustCacheMemoryWarning } from '../../src/trust/memory_warning';

describe('registerTrustCacheMemoryWarning (TN-MOB-006)', () => {
  beforeEach(async () => {
    resetTrustCache();
    resetKVStore();
  });

  function makeScore(did: string, score: number): TrustScore {
    return { did, score, attestationCount: 0, lastUpdated: Date.now() };
  }

  it('subscribes to AppState.memoryWarning and returns a subscription', () => {
    const spy = jest.spyOn(AppState, 'addEventListener');
    const sub = registerTrustCacheMemoryWarning();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe('memoryWarning');
    expect(typeof sub.remove).toBe('function');
    sub.remove();
    spy.mockRestore();
  });

  it('handler shrinks cache to MEMORY_WARNING_TARGET when fired', async () => {
    let captured: ((s: unknown) => void) | null = null;
    const spy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(((_evt: string, fn: (s: unknown) => void) => {
        captured = fn;
        return { remove: () => undefined };
      }) as unknown as typeof AppState.addEventListener);

    registerTrustCacheMemoryWarning();
    expect(captured).not.toBeNull();

    // Fill the cache past the eviction target.
    const overshoot = MEMORY_WARNING_TARGET + 12;
    for (let i = 0; i < overshoot; i++) {
      await cacheTrustScore(makeScore(`did:plc:${i.toString().padStart(3, '0')}`, 0.5));
    }
    expect(trustCacheSize()).toBe(overshoot);

    // Fire the captured handler — exactly what the OS would do under
    // memory pressure. The handler kicks the async eviction.
    (captured as unknown as () => void)();
    // Yield to the event loop so the void-promise-chain inside the
    // handler finishes its KV deletes before we assert.
    await new Promise((r) => setImmediate(r));

    expect(trustCacheSize()).toBe(MEMORY_WARNING_TARGET);
    spy.mockRestore();
  });
});
