/**
 * Active guided-demo state — unit tests (boot-recovery metadata).
 */

import { kvGet, kvSet, resetKVStore } from '../../src/kv/store';
import {
  ACTIVE_DEMO_KEY,
  getActiveDemo,
  setActiveDemo,
  updateActiveDemoStep,
  clearActiveDemo,
  hasActiveDemo,
} from '../../src/scope/active_demo';

describe('active guided-demo state', () => {
  beforeEach(() => resetKVStore());

  it('returns null when no demo is active', async () => {
    expect(await getActiveDemo()).toBeNull();
    expect(await hasActiveDemo()).toBe(false);
  });

  it('round-trips a demo record', async () => {
    await setActiveDemo({ activeDemoScope: 'guided_demo:run1', startedAt: 1000, step: 'remember_emma' });
    expect(await getActiveDemo()).toEqual({
      activeDemoScope: 'guided_demo:run1',
      startedAt: 1000,
      step: 'remember_emma',
    });
    expect(await hasActiveDemo()).toBe(true);
  });

  it('updateActiveDemoStep changes only the step', async () => {
    await setActiveDemo({ activeDemoScope: 'guided_demo:run1', startedAt: 1000, step: 'a' });
    await updateActiveDemoStep('b');
    expect((await getActiveDemo())?.step).toBe('b');
    expect((await getActiveDemo())?.startedAt).toBe(1000);
  });

  it('updateActiveDemoStep is a no-op when no demo is active', async () => {
    await updateActiveDemoStep('b');
    expect(await getActiveDemo()).toBeNull();
  });

  it('clearActiveDemo removes the record and is idempotent', async () => {
    await setActiveDemo({ activeDemoScope: 'guided_demo:run1', startedAt: 1, step: '' });
    await clearActiveDemo();
    expect(await getActiveDemo()).toBeNull();
    await clearActiveDemo(); // idempotent
    expect(await getActiveDemo()).toBeNull();
  });

  it('setActiveDemo rejects a non-demo scope', async () => {
    await expect(
      setActiveDemo({ activeDemoScope: 'user' as never, startedAt: 1, step: '' }),
    ).rejects.toThrow(/must be a guided_demo scope/);
  });

  it('getActiveDemo returns null for corrupt JSON', async () => {
    await kvSet(ACTIVE_DEMO_KEY, '{not json');
    expect(await getActiveDemo()).toBeNull();
  });

  it('getActiveDemo returns null for a record with an invalid/non-demo scope', async () => {
    await kvSet(ACTIVE_DEMO_KEY, JSON.stringify({ activeDemoScope: 'user', startedAt: 1, step: '' }));
    expect(await getActiveDemo()).toBeNull();
    await kvSet(ACTIVE_DEMO_KEY, JSON.stringify({ activeDemoScope: 'guided_demo:', startedAt: 1 }));
    expect(await getActiveDemo()).toBeNull();
  });

  it('tolerates a record missing startedAt/step', async () => {
    await kvSet(ACTIVE_DEMO_KEY, JSON.stringify({ activeDemoScope: 'guided_demo:run1' }));
    expect(await getActiveDemo()).toEqual({
      activeDemoScope: 'guided_demo:run1',
      startedAt: 0,
      step: '',
    });
  });
});
