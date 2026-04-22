/**
 * T2.92 — Process supervisor: start, monitor, restart Core + Brain.
 *
 * Source: ARCHITECTURE.md Task 2.92
 */

import {
  ProcessSupervisor,
  type ProcessConfig,
  type SupervisorCallbacks,
} from '../../src/process/supervisor';

function mockProcess(
  name: string,
  opts?: { failStart?: boolean; healthURL?: string },
): ProcessConfig {
  let running = false;
  return {
    name,
    healthURL: opts?.healthURL ?? `http://localhost:8100/healthz`,
    startFn: async () => {
      if (opts?.failStart) throw new Error(`${name} failed to start`);
      running = true;
    },
    stopFn: async () => {
      running = false;
    },
    healthCheckIntervalMs: 60_000, // long interval — we'll trigger checks manually
    maxRestartAttempts: 3,
    initialBackoffMs: 1, // 1ms for fast tests
    maxBackoffMs: 10,
  };
}

function mockFetch(healthy: boolean) {
  return jest.fn(async () => ({
    ok: healthy,
    status: healthy ? 200 : 503,
  })) as unknown as typeof globalThis.fetch;
}

describe('ProcessSupervisor', () => {
  let supervisor: ProcessSupervisor;

  afterEach(() => {
    supervisor?.reset();
  });

  describe('register + start', () => {
    it('starts a process and sets state to running', async () => {
      supervisor = new ProcessSupervisor();
      supervisor.register(mockProcess('core'));

      await supervisor.start('core');

      const status = supervisor.getStatus('core');
      expect(status.state).toBe('running');
      expect(status.upSince).toBeTruthy();
      expect(status.restartCount).toBe(0);
    });

    it('rejects duplicate registration', () => {
      supervisor = new ProcessSupervisor();
      supervisor.register(mockProcess('core'));
      expect(() => supervisor.register(mockProcess('core'))).toThrow('already registered');
    });

    it('throws for unknown process', () => {
      supervisor = new ProcessSupervisor();
      expect(supervisor.start('unknown')).rejects.toThrow('not registered');
    });

    it('start is idempotent when already running', async () => {
      let startCount = 0;
      supervisor = new ProcessSupervisor();
      supervisor.register({
        ...mockProcess('core'),
        startFn: async () => {
          startCount++;
        },
      });

      await supervisor.start('core');
      await supervisor.start('core');
      expect(startCount).toBe(1);
    });
  });

  describe('stop', () => {
    it('stops a running process', async () => {
      supervisor = new ProcessSupervisor();
      supervisor.register(mockProcess('core'));
      await supervisor.start('core');

      await supervisor.stop('core');
      expect(supervisor.getStatus('core').state).toBe('stopped');
      expect(supervisor.getStatus('core').upSince).toBeNull();
    });

    it('stop is idempotent', async () => {
      supervisor = new ProcessSupervisor();
      supervisor.register(mockProcess('core'));
      await supervisor.stop('core'); // already stopped
      expect(supervisor.getStatus('core').state).toBe('stopped');
    });
  });

  describe('startAll / stopAll', () => {
    it('starts and stops all registered processes', async () => {
      supervisor = new ProcessSupervisor();
      supervisor.register(mockProcess('core'));
      supervisor.register(mockProcess('brain'));

      await supervisor.startAll();

      const statuses = supervisor.getAllStatuses();
      expect(statuses).toHaveLength(2);
      expect(statuses.every((s) => s.state === 'running')).toBe(true);

      await supervisor.stopAll();
      const stopped = supervisor.getAllStatuses();
      expect(stopped.every((s) => s.state === 'stopped')).toBe(true);
    });
  });

  describe('health check', () => {
    it('returns true for healthy process', async () => {
      supervisor = new ProcessSupervisor(undefined, mockFetch(true));
      supervisor.register(mockProcess('core'));
      await supervisor.start('core');

      const healthy = await supervisor.checkHealth('core');
      expect(healthy).toBe(true);
    });

    it('returns false for unhealthy process', async () => {
      supervisor = new ProcessSupervisor(undefined, mockFetch(false));
      supervisor.register(mockProcess('core'));
      await supervisor.start('core');

      const healthy = await supervisor.checkHealth('core');
      expect(healthy).toBe(false);
    });

    it('returns false on fetch error', async () => {
      const failFetch = jest.fn(async () => {
        throw new Error('connection refused');
      }) as unknown as typeof globalThis.fetch;
      supervisor = new ProcessSupervisor(undefined, failFetch);
      supervisor.register(mockProcess('core'));
      await supervisor.start('core');

      const healthy = await supervisor.checkHealth('core');
      expect(healthy).toBe(false);
    });
  });

  describe('crash + auto-restart', () => {
    it('restarts on start failure', async () => {
      const events: string[] = [];
      const callbacks: SupervisorCallbacks = {
        onCrash: (name) => events.push(`crash:${name}`),
        onRestart: (name, attempt) => events.push(`restart:${name}:${attempt}`),
      };

      let failCount = 0;
      supervisor = new ProcessSupervisor(callbacks);
      supervisor.register({
        ...mockProcess('core'),
        startFn: async () => {
          failCount++;
          if (failCount <= 1) throw new Error('startup crash');
        },
        initialBackoffMs: 1,
      });

      await supervisor.start('core');

      // Wait for restart to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(events).toContain('crash:core');
      expect(events).toContain('restart:core:1');
      expect(supervisor.getStatus('core').state).toBe('running');
      expect(supervisor.getStatus('core').restartCount).toBe(1);
    });

    it('gives up after max attempts', async () => {
      const events: string[] = [];
      supervisor = new ProcessSupervisor({
        onGiveUp: (name, attempts) => events.push(`giveup:${name}:${attempts}`),
      });

      supervisor.register({
        ...mockProcess('core'),
        startFn: async () => {
          throw new Error('always fails');
        },
        maxRestartAttempts: 2,
        initialBackoffMs: 1,
        maxBackoffMs: 1,
      });

      await supervisor.start('core');

      // Wait for restart attempts to exhaust
      await new Promise((r) => setTimeout(r, 100));

      expect(supervisor.getStatus('core').state).toBe('given_up');
      expect(events.some((e) => e.startsWith('giveup:'))).toBe(true);
    });
  });

  describe('handleUnhealthy', () => {
    it('crashes after 3 consecutive health failures', async () => {
      const events: string[] = [];
      supervisor = new ProcessSupervisor({
        onCrash: (name) => events.push(`crash:${name}`),
      });
      supervisor.register(mockProcess('core'));
      await supervisor.start('core');

      // 3 consecutive failures → crash
      await supervisor.handleUnhealthy('core');
      await supervisor.handleUnhealthy('core');
      await supervisor.handleUnhealthy('core');

      // Wait for restart attempt
      await new Promise((r) => setTimeout(r, 50));

      expect(events).toContain('crash:core');
    });

    it('does not crash on 2 failures', async () => {
      supervisor = new ProcessSupervisor();
      supervisor.register(mockProcess('core'));
      await supervisor.start('core');

      await supervisor.handleUnhealthy('core');
      await supervisor.handleUnhealthy('core');

      expect(supervisor.getStatus('core').state).toBe('running');
    });
  });

  describe('callbacks', () => {
    it('fires onStart callback', async () => {
      const started: string[] = [];
      supervisor = new ProcessSupervisor({ onStart: (n) => started.push(n) });
      supervisor.register(mockProcess('core'));

      await supervisor.start('core');
      expect(started).toEqual(['core']);
    });

    it('fires onStop callback', async () => {
      const stopped: string[] = [];
      supervisor = new ProcessSupervisor({ onStop: (n) => stopped.push(n) });
      supervisor.register(mockProcess('core'));
      await supervisor.start('core');

      await supervisor.stop('core');
      expect(stopped).toEqual(['core']);
    });

    it('fires onHealthy callback on successful check', async () => {
      const healthy: string[] = [];
      supervisor = new ProcessSupervisor({ onHealthy: (n) => healthy.push(n) }, mockFetch(true));
      supervisor.register(mockProcess('core'));
      await supervisor.start('core');

      await supervisor.checkHealth('core');
      expect(healthy).toEqual(['core']);
    });
  });
});
