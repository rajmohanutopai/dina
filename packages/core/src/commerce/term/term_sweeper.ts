/**
 * The clock for term negotiation (SHELF_SPACE_NEGOTIATION §5.3, §9): resends
 * until a final receipt, give-ups, documents held for a prerequisite, lapsed
 * cards and the brand's loop; then the directory upkeep (listings the policy no
 * longer backs withdrawn, public records still standing removed). One pass at start — "at every start" a held
 * document is tried again — then every minute. Reads the CURRENT runtime each
 * tick, so it follows a runtime installed or replaced after it starts.
 */

import { getCommerceRuntime } from '../runtime';

import { reconcileTermListings } from './term_listing_repo';

export interface TermSweeperOptions {
  intervalMs?: number;
  onError?: (err: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class TermSweeper {
  private handle: unknown = null;
  private reconciling = false;

  constructor(private readonly options: TermSweeperOptions = {}) {}

  start(): void {
    if (this.handle !== null) return;
    this.runTick();
    const every = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.handle = every(() => this.runTick(), this.options.intervalMs ?? 60_000);
    (this.handle as { unref?: () => void } | null)?.unref?.();
  }

  stop(): void {
    if (this.handle === null) return;
    const clear =
      this.options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.handle);
    this.handle = null;
  }

  /**
   * One pass. The engine's sweep is synchronous, so two never interleave; the
   * directory upkeep after it is I/O, and at most one runs at a time.
   */
  runTick(): void {
    const terms = getCommerceRuntime()?.terms ?? null;
    try {
      terms?.sweep();
    } catch (err) {
      this.options.onError?.(err);
    }
    if (terms === null || this.reconciling) return;
    this.reconciling = true;
    void reconcileTermListings(terms)
      .catch((err: unknown) => this.options.onError?.(err))
      .finally(() => {
        this.reconciling = false;
      });
  }
}
