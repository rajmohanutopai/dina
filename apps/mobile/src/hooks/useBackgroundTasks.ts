/**
 * Background tasks hook — iOS BackgroundFetch + Android WorkManager.
 *
 * Registers background tasks that run when the app is backgrounded:
 *   - Trust cache sync (refresh stale trust scores)
 *   - Staging sweep (expire old items, revert stale leases)
 *   - Outbox retry (retry failed D2D message deliveries)
 *
 * The native task registration is injectable — in production,
 * expo-background-fetch (iOS) and expo-task-manager (Android) provide it.
 * Tests use a mock scheduler.
 *
 * Source: ARCHITECTURE.md Tasks 9.8, 9.9
 */

export type BackgroundTaskName = 'trust_sync' | 'staging_sweep' | 'outbox_retry';

export interface BackgroundTask {
  name: BackgroundTaskName;
  handler: () => Promise<void>;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: number | null;
  lastResult: 'success' | 'failed' | null;
  runCount: number;
}

export interface TaskRegistration {
  name: BackgroundTaskName;
  intervalMinutes: number;
  handler: () => Promise<void>;
}

/** Registered tasks. */
const tasks = new Map<BackgroundTaskName, BackgroundTask>();

/** Injectable native registration function. */
let registerNativeFn: ((name: string, intervalMinutes: number) => Promise<void>) | null = null;

/** Injectable native unregistration function. */
let unregisterNativeFn: ((name: string) => Promise<void>) | null = null;

/**
 * Configure native task registration (expo-background-fetch / expo-task-manager).
 */
export function configureNativeTaskManager(config: {
  register: (name: string, intervalMinutes: number) => Promise<void>;
  unregister: (name: string) => Promise<void>;
}): void {
  registerNativeFn = config.register;
  unregisterNativeFn = config.unregister;
}

/**
 * Register a background task.
 */
export async function registerTask(reg: TaskRegistration): Promise<boolean> {
  const task: BackgroundTask = {
    name: reg.name,
    handler: reg.handler,
    intervalMinutes: reg.intervalMinutes,
    enabled: true,
    lastRunAt: null,
    lastResult: null,
    runCount: 0,
  };

  tasks.set(reg.name, task);

  // Register with native platform
  if (registerNativeFn) {
    try {
      await registerNativeFn(reg.name, reg.intervalMinutes);
    } catch {
      task.enabled = false;
      return false;
    }
  }

  return true;
}

/**
 * Unregister a background task.
 */
export async function unregisterTask(name: BackgroundTaskName): Promise<void> {
  tasks.delete(name);
  if (unregisterNativeFn) {
    await unregisterNativeFn(name);
  }
}

/**
 * Execute a task by name (called by the native scheduler on fire).
 * Returns true if the task ran successfully.
 */
export async function executeTask(name: BackgroundTaskName): Promise<boolean> {
  const task = tasks.get(name);
  if (!task || !task.enabled) return false;

  try {
    await task.handler();
    task.lastRunAt = Date.now();
    task.lastResult = 'success';
    task.runCount++;
    return true;
  } catch {
    task.lastRunAt = Date.now();
    task.lastResult = 'failed';
    task.runCount++;
    return false;
  }
}

/**
 * Register all standard Dina background tasks.
 */
export async function registerAllTasks(handlers: {
  trustSync: () => Promise<void>;
  stagingSweep: () => Promise<void>;
  outboxRetry: () => Promise<void>;
}): Promise<{ registered: number; failed: number }> {
  let registered = 0;
  let failed = 0;

  const taskDefs: TaskRegistration[] = [
    { name: 'trust_sync', intervalMinutes: 60, handler: handlers.trustSync },
    { name: 'staging_sweep', intervalMinutes: 5, handler: handlers.stagingSweep },
    { name: 'outbox_retry', intervalMinutes: 1, handler: handlers.outboxRetry },
  ];

  for (const def of taskDefs) {
    const ok = await registerTask(def);
    if (ok) registered++;
    else failed++;
  }

  return { registered, failed };
}

/**
 * Get the status of all registered tasks.
 */
export function getTaskStatuses(): BackgroundTask[] {
  return [...tasks.values()].map((t) => ({ ...t }));
}

/**
 * Get a single task status.
 */
export function getTaskStatus(name: BackgroundTaskName): BackgroundTask | null {
  const task = tasks.get(name);
  return task ? { ...task } : null;
}

/**
 * Check if all tasks are registered and enabled.
 */
export function allTasksHealthy(): boolean {
  if (tasks.size === 0) return false;
  return [...tasks.values()].every((t) => t.enabled);
}

/**
 * Reset (for testing).
 */
export function resetBackgroundTasks(): void {
  tasks.clear();
  registerNativeFn = null;
  unregisterNativeFn = null;
}
