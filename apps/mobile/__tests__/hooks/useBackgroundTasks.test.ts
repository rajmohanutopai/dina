/**
 * T9.8 + T9.9 — Background tasks: iOS BackgroundFetch + Android WorkManager.
 *
 * Source: ARCHITECTURE.md Tasks 9.8, 9.9
 */

import {
  registerTask,
  unregisterTask,
  executeTask,
  registerAllTasks,
  getTaskStatuses,
  getTaskStatus,
  allTasksHealthy,
  configureNativeTaskManager,
  resetBackgroundTasks,
  type TaskRegistration,
} from '../../src/hooks/useBackgroundTasks';

describe('Background Tasks Hook (9.8 + 9.9)', () => {
  beforeEach(() => resetBackgroundTasks());

  describe('registerTask', () => {
    it('registers a task', async () => {
      const ok = await registerTask({
        name: 'trust_sync',
        intervalMinutes: 60,
        handler: async () => {},
      });

      expect(ok).toBe(true);
      const status = getTaskStatus('trust_sync');
      expect(status).not.toBeNull();
      expect(status!.enabled).toBe(true);
      expect(status!.runCount).toBe(0);
    });

    it('calls native registration when configured', async () => {
      const registered: string[] = [];
      configureNativeTaskManager({
        register: async (name) => {
          registered.push(name);
        },
        unregister: async () => {},
      });

      await registerTask({ name: 'staging_sweep', intervalMinutes: 5, handler: async () => {} });

      expect(registered).toContain('staging_sweep');
    });

    it('disables task if native registration fails', async () => {
      configureNativeTaskManager({
        register: async () => {
          throw new Error('not supported');
        },
        unregister: async () => {},
      });

      const ok = await registerTask({
        name: 'trust_sync',
        intervalMinutes: 60,
        handler: async () => {},
      });

      expect(ok).toBe(false);
      expect(getTaskStatus('trust_sync')!.enabled).toBe(false);
    });
  });

  describe('unregisterTask', () => {
    it('removes a task', async () => {
      await registerTask({ name: 'trust_sync', intervalMinutes: 60, handler: async () => {} });
      await unregisterTask('trust_sync');

      expect(getTaskStatus('trust_sync')).toBeNull();
    });

    it('calls native unregistration', async () => {
      const unregistered: string[] = [];
      configureNativeTaskManager({
        register: async () => {},
        unregister: async (name) => {
          unregistered.push(name);
        },
      });

      await registerTask({ name: 'staging_sweep', intervalMinutes: 5, handler: async () => {} });
      await unregisterTask('staging_sweep');

      expect(unregistered).toContain('staging_sweep');
    });
  });

  describe('executeTask', () => {
    it('runs handler and tracks result', async () => {
      let ran = false;
      await registerTask({
        name: 'trust_sync',
        intervalMinutes: 60,
        handler: async () => {
          ran = true;
        },
      });

      const ok = await executeTask('trust_sync');

      expect(ok).toBe(true);
      expect(ran).toBe(true);

      const status = getTaskStatus('trust_sync')!;
      expect(status.lastResult).toBe('success');
      expect(status.runCount).toBe(1);
      expect(status.lastRunAt).toBeTruthy();
    });

    it('tracks failure', async () => {
      await registerTask({
        name: 'staging_sweep',
        intervalMinutes: 5,
        handler: async () => {
          throw new Error('sweep failed');
        },
      });

      const ok = await executeTask('staging_sweep');

      expect(ok).toBe(false);
      expect(getTaskStatus('staging_sweep')!.lastResult).toBe('failed');
      expect(getTaskStatus('staging_sweep')!.runCount).toBe(1);
    });

    it('returns false for unknown task', async () => {
      expect(await executeTask('trust_sync')).toBe(false);
    });

    it('returns false for disabled task', async () => {
      configureNativeTaskManager({
        register: async () => {
          throw new Error('fail');
        },
        unregister: async () => {},
      });
      await registerTask({ name: 'trust_sync', intervalMinutes: 60, handler: async () => {} });

      expect(await executeTask('trust_sync')).toBe(false);
    });
  });

  describe('registerAllTasks', () => {
    it('registers all 3 standard tasks', async () => {
      const result = await registerAllTasks({
        trustSync: async () => {},
        stagingSweep: async () => {},
        outboxRetry: async () => {},
      });

      expect(result.registered).toBe(3);
      expect(result.failed).toBe(0);
      expect(getTaskStatuses()).toHaveLength(3);
    });

    it('counts failures', async () => {
      configureNativeTaskManager({
        register: async () => {
          throw new Error('fail');
        },
        unregister: async () => {},
      });

      const result = await registerAllTasks({
        trustSync: async () => {},
        stagingSweep: async () => {},
        outboxRetry: async () => {},
      });

      expect(result.failed).toBe(3);
    });

    it('trust_sync runs at 60-minute interval', async () => {
      await registerAllTasks({
        trustSync: async () => {},
        stagingSweep: async () => {},
        outboxRetry: async () => {},
      });

      expect(getTaskStatus('trust_sync')!.intervalMinutes).toBe(60);
      expect(getTaskStatus('staging_sweep')!.intervalMinutes).toBe(5);
      expect(getTaskStatus('outbox_retry')!.intervalMinutes).toBe(1);
    });
  });

  describe('allTasksHealthy', () => {
    it('false when no tasks registered', () => {
      expect(allTasksHealthy()).toBe(false);
    });

    it('true when all tasks enabled', async () => {
      await registerAllTasks({
        trustSync: async () => {},
        stagingSweep: async () => {},
        outboxRetry: async () => {},
      });

      expect(allTasksHealthy()).toBe(true);
    });

    it('false when any task disabled', async () => {
      configureNativeTaskManager({
        register: async (name) => {
          if (name === 'outbox_retry') throw new Error('fail');
        },
        unregister: async () => {},
      });

      await registerAllTasks({
        trustSync: async () => {},
        stagingSweep: async () => {},
        outboxRetry: async () => {},
      });

      expect(allTasksHealthy()).toBe(false);
    });
  });
});
