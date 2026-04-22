/**
 * Process supervisor — monitors and restarts Core + Brain processes.
 *
 * The UI process starts and watches both Core (port 8100) and Brain (port 8200).
 * If either crashes or becomes unhealthy, the supervisor restarts it.
 *
 * Features:
 *   - Health check polling (configurable interval)
 *   - Auto-restart on crash (within 5s)
 *   - Exponential backoff on repeated failures (1s → 2s → 4s → 8s → max 30s)
 *   - Max restart attempts before giving up
 *   - Event callbacks: onStart, onStop, onCrash, onRestart, onGiveUp
 *
 * On mobile: Core runs in a foreground service (Android) or separate JS
 * context (iOS). Brain runs in the main JS context. The supervisor
 * coordinates their lifecycle.
 *
 * Source: ARCHITECTURE.md Task 2.92
 */

export type ProcessState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'crashed'
  | 'restarting'
  | 'given_up';

export interface ProcessConfig {
  name: string;
  healthURL: string;
  startFn: () => Promise<void>;
  stopFn: () => Promise<void>;
  healthCheckIntervalMs?: number;
  maxRestartAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface ProcessStatus {
  name: string;
  state: ProcessState;
  restartCount: number;
  lastHealthCheck: number;
  lastCrash: number | null;
  upSince: number | null;
}

export interface SupervisorCallbacks {
  onStart?: (name: string) => void;
  onStop?: (name: string) => void;
  onCrash?: (name: string, error: string) => void;
  onRestart?: (name: string, attempt: number) => void;
  onGiveUp?: (name: string, attempts: number) => void;
  onHealthy?: (name: string) => void;
}

import { HEALTH_CHECK_TIMEOUT_MS, UNHEALTHY_THRESHOLD, MS_SECOND } from '../constants';

const DEFAULT_HEALTH_INTERVAL_MS = 10 * MS_SECOND;
const DEFAULT_MAX_RESTART_ATTEMPTS = 10;
const DEFAULT_INITIAL_BACKOFF_MS = MS_SECOND;
const DEFAULT_MAX_BACKOFF_MS = 30 * MS_SECOND;

export class ProcessSupervisor {
  private readonly processes: Map<string, ManagedProcess> = new Map();
  private readonly callbacks: SupervisorCallbacks;

  /** Injectable fetch for health checks. */
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(callbacks?: SupervisorCallbacks, fetchFn?: typeof globalThis.fetch) {
    this.callbacks = callbacks ?? {};
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  /** Register a process to be supervised. */
  register(config: ProcessConfig): void {
    if (this.processes.has(config.name)) {
      throw new Error(`supervisor: process "${config.name}" already registered`);
    }

    this.processes.set(config.name, {
      config: {
        ...config,
        healthCheckIntervalMs: config.healthCheckIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
        maxRestartAttempts: config.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS,
        initialBackoffMs: config.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
        maxBackoffMs: config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      },
      state: 'stopped',
      restartCount: 0,
      consecutiveFailures: 0,
      lastHealthCheck: 0,
      lastCrash: null,
      upSince: null,
      healthTimer: null,
    });
  }

  /** Start a registered process. */
  async start(name: string): Promise<void> {
    const proc = this.getProcess(name);
    if (proc.state === 'running' || proc.state === 'starting') return;

    proc.state = 'starting';

    try {
      await proc.config.startFn();
      proc.state = 'running';
      proc.upSince = Date.now();
      proc.consecutiveFailures = 0;
      this.callbacks.onStart?.(name);
      this.startHealthChecks(name);
    } catch (err) {
      proc.state = 'crashed';
      proc.lastCrash = Date.now();
      this.callbacks.onCrash?.(name, err instanceof Error ? err.message : String(err));
      await this.attemptRestart(name);
    }
  }

  /** Stop a registered process. */
  async stop(name: string): Promise<void> {
    const proc = this.getProcess(name);
    this.stopHealthChecks(name);

    if (proc.state === 'stopped') return;

    try {
      await proc.config.stopFn();
    } catch {
      // Best-effort stop
    }
    proc.state = 'stopped';
    proc.upSince = null;
    this.callbacks.onStop?.(name);
  }

  /** Start all registered processes. */
  async startAll(): Promise<void> {
    for (const name of this.processes.keys()) {
      await this.start(name);
    }
  }

  /** Stop all registered processes. */
  async stopAll(): Promise<void> {
    for (const name of this.processes.keys()) {
      await this.stop(name);
    }
  }

  /** Get the status of a process. */
  getStatus(name: string): ProcessStatus {
    const proc = this.getProcess(name);
    return {
      name,
      state: proc.state,
      restartCount: proc.restartCount,
      lastHealthCheck: proc.lastHealthCheck,
      lastCrash: proc.lastCrash,
      upSince: proc.upSince,
    };
  }

  /** Get status of all processes. */
  getAllStatuses(): ProcessStatus[] {
    return [...this.processes.keys()].map((name) => this.getStatus(name));
  }

  /** Check health of a process (single check, public for testing). */
  async checkHealth(name: string): Promise<boolean> {
    const proc = this.getProcess(name);
    proc.lastHealthCheck = Date.now();

    try {
      const response = await this.fetchFn(proc.config.healthURL, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      const healthy = response.ok;
      if (healthy) {
        proc.consecutiveFailures = 0;
        this.callbacks.onHealthy?.(name);
      }
      return healthy;
    } catch {
      return false;
    }
  }

  /** Manually trigger a health-check failure → restart cycle. For testing. */
  async handleUnhealthy(name: string): Promise<void> {
    const proc = this.getProcess(name);
    proc.consecutiveFailures++;

    if (proc.consecutiveFailures >= UNHEALTHY_THRESHOLD) {
      proc.state = 'crashed';
      proc.lastCrash = Date.now();
      this.callbacks.onCrash?.(name, 'Health check failed 3 consecutive times');
      this.stopHealthChecks(name);
      await this.attemptRestart(name);
    }
  }

  /** Clear all state (for testing). */
  reset(): void {
    for (const name of this.processes.keys()) {
      this.stopHealthChecks(name);
    }
    this.processes.clear();
  }

  // ---------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------

  private getProcess(name: string): ManagedProcess {
    const proc = this.processes.get(name);
    if (!proc) throw new Error(`supervisor: process "${name}" not registered`);
    return proc;
  }

  private async attemptRestart(name: string): Promise<void> {
    const proc = this.getProcess(name);

    if (proc.restartCount >= proc.config.maxRestartAttempts!) {
      proc.state = 'given_up';
      this.callbacks.onGiveUp?.(name, proc.restartCount);
      return;
    }

    proc.state = 'restarting';
    proc.restartCount++;

    const backoff = Math.min(
      proc.config.initialBackoffMs! * Math.pow(2, proc.restartCount - 1),
      proc.config.maxBackoffMs!,
    );

    this.callbacks.onRestart?.(name, proc.restartCount);

    await sleep(backoff);

    if (proc.state !== 'restarting') return; // stop() was called during backoff

    await this.start(name);
  }

  private startHealthChecks(name: string): void {
    const proc = this.getProcess(name);
    this.stopHealthChecks(name);

    proc.healthTimer = setInterval(async () => {
      if (proc.state !== 'running') return;
      const healthy = await this.checkHealth(name);
      if (!healthy) {
        await this.handleUnhealthy(name);
      }
    }, proc.config.healthCheckIntervalMs!);
  }

  private stopHealthChecks(name: string): void {
    const proc = this.processes.get(name);
    if (proc?.healthTimer) {
      clearInterval(proc.healthTimer);
      proc.healthTimer = null;
    }
  }
}

interface ManagedProcess {
  config: Required<ProcessConfig>;
  state: ProcessState;
  restartCount: number;
  consecutiveFailures: number;
  lastHealthCheck: number;
  lastCrash: number | null;
  upSince: number | null;
  healthTimer: ReturnType<typeof setInterval> | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
