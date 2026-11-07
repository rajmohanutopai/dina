/**
 * The server's backup schedule (USER_BACKUP.md §4.4): once a day when
 * anything changed, and once more on a clean stop when anything changed
 * since the last copy (a hosted Dina stops when idle, HOSTED_DINA.md §7).
 *
 * Off unless `DINA_BACKUP_STORE_URL` names the store. The rules live in
 * `@dina/core` (`backUpIfDue`); this class only schedules them. Logs carry
 * outcomes, counters and sizes, never contents or the backup id.
 */

import {
  backUpIfDue,
  BackupStoreClient,
  deriveBackupIdentity,
  kvBackupStore,
  type BackupDueResult,
} from '@dina/core';

import type { Logger } from '../logger';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Let boot settle before the first look. */
const FIRST_TICK_MS = 5 * 60_000;
/** A stop waits this long for its last copy, then gives up. */
const STOP_BUDGET_MS = 30_000;

export interface BackupSupervisorOptions {
  storeUrl: string;
  masterSeed: Uint8Array;
  did: string;
  handle: string;
  logger: Logger;
}

export class BackupSupervisor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flight: Promise<void> | null = null;
  private stopped = false;
  private readonly run: (everyMs: number) => Promise<BackupDueResult>;

  constructor(private readonly options: BackupSupervisorOptions) {
    const identity = deriveBackupIdentity(options.masterSeed);
    const client = new BackupStoreClient(options.storeUrl, identity);
    const deps = {
      identity,
      client,
      kv: kvBackupStore,
      did: options.did,
      handle: options.handle,
    };
    this.run = (everyMs) => backUpIfDue(deps, { everyMs });
  }

  start(): void {
    if (this.timer !== null || this.stopped) return;
    const loop = (delay: number): void => {
      this.timer = setTimeout(() => {
        void this.tick(DAY_MS).finally(() => {
          if (!this.stopped) loop(HOUR_MS);
        });
      }, delay);
      this.timer.unref?.();
    };
    loop(FIRST_TICK_MS);
  }

  /** The last copy, if anything changed since the one before. Bounded. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.flight;
    let budget: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.tick(0),
      new Promise<void>((resolve) => {
        budget = setTimeout(() => {
          this.options.logger.warn({ event: 'backup.stop_budget_exceeded' });
          resolve();
        }, STOP_BUDGET_MS);
        budget.unref?.();
      }),
    ]);
    if (budget !== undefined) clearTimeout(budget);
  }

  tick(everyMs: number): Promise<void> {
    if (this.flight !== null) return this.flight;
    const run = (async () => {
      try {
        const out = await this.run(everyMs);
        if (out.ran) {
          this.options.logger.info({
            event: 'backup.copy_written',
            counter: out.result.counter,
            size: out.result.size,
            items: out.result.itemCount,
          });
          if (out.result.storeBehind) {
            this.options.logger.warn({ event: 'backup.store_behind', counter: out.result.counter });
          }
        } else if (out.reason === 'unchanged') {
          this.options.logger.info({ event: 'backup.unchanged' });
        }
      } catch (err) {
        this.options.logger.warn({
          event: 'backup.failed',
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.flight = null;
      }
    })();
    this.flight = run;
    return run;
  }
}
