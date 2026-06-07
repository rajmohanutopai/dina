/**
 * Guided-demo controller — app-side wrapper over the core orchestration engine.
 * Rehydration is mocked (it pulls in the native storage layer); the engine
 * (scope + active-demo + cleanup) is real.
 */

// Mock BEFORE importing the controller so the native storage chain
// (rehydrate → storage/init → op-sqlite) never loads. The start path calls
// refreshCachesForCurrentScope; the teardown path calls rehydrateUserScopeCaches
// — distinct jest.fns so each call site is asserted independently.
jest.mock('../../src/guided_demo/rehydrate', () => ({
  refreshCachesForCurrentScope: jest.fn(async () => undefined),
  rehydrateUserScopeCaches: jest.fn(async () => undefined),
}));

import {
  currentDataScope,
  resetDataScope,
  setGuidedDemoIdFactory,
  resetGuidedDemoIdFactory,
  getActiveDemo,
  clearScopedCleanups,
  registerScopedCleanup,
} from '@dina/core';

import {
  beginGuidedDemo,
  beginEmpty,
  endGuidedDemoAndRefresh,
} from '../../src/guided_demo/controller';
import {
  refreshCachesForCurrentScope,
  rehydrateUserScopeCaches,
} from '../../src/guided_demo/rehydrate';
import { resetKVStore } from '../../../core/src/kv/store';

describe('guided demo controller', () => {
  beforeEach(() => {
    resetKVStore();
    resetDataScope();
    clearScopedCleanups();
    setGuidedDemoIdFactory(() => 'run1');
    (rehydrateUserScopeCaches as jest.Mock).mockClear();
    (refreshCachesForCurrentScope as jest.Mock).mockClear();
    // A no-op cleanup so endGuidedDemo's teardown has a table to run.
    registerScopedCleanup({ table: 'reminders', deleteScope: () => 0 });
  });
  afterEach(() => {
    clearScopedCleanups();
    resetGuidedDemoIdFactory();
  });

  it('beginGuidedDemo enters the demo scope + persists the recovery record', async () => {
    const scope = await beginGuidedDemo(1000);
    expect(scope).toBe('guided_demo:run1');
    expect(currentDataScope()).toBe('guided_demo:run1');
    expect((await getActiveDemo())?.activeDemoScope).toBe('guided_demo:run1');
  });

  it('beginGuidedDemo swaps the in-memory caches to the demo scope on start', async () => {
    await beginGuidedDemo(1000);
    // The start path must refresh caches so the demo Chat/Reminders hide the
    // user's real data (functional invariant #2), not just on teardown.
    expect(refreshCachesForCurrentScope).toHaveBeenCalledTimes(1);
  });

  it('beginEmpty stays on the user scope', () => {
    beginEmpty();
    expect(currentDataScope()).toBe('user');
  });

  it('endGuidedDemoAndRefresh tears down, returns to user, and rehydrates caches', async () => {
    await beginGuidedDemo(1);
    await endGuidedDemoAndRefresh();
    expect(currentDataScope()).toBe('user');
    expect(await getActiveDemo()).toBeNull();
    expect(rehydrateUserScopeCaches).toHaveBeenCalledTimes(1);
  });
});
